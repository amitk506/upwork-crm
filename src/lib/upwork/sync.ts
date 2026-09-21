import 'server-only'

import { createHash } from 'node:crypto'

import { createAdminClient } from '@/lib/supabase/admin'
import type { UpRoom } from '@/lib/database.types'
import { allActiveProfiles, loadProfile } from './profiles'
import { mcpTransport } from './transport-mcp'
import { resolveByAlternation } from './alternation'
import { uploaderUserId } from './attachments'
import type { DirectionSource } from './direction'
import { replyStateRow } from './reply-state'
import { inferDirection } from './direction'
import { SELF_IMPOSED } from './limits'
import { UpworkPolicyError, type CallPriority, type Message, type Room } from './types'

/**
 * Pulling conversations from every connected Upwork profile.
 *
 * Upwork has no webhooks — none of their six official SDKs ship a subscription
 * router — so this polls. The cost is kept low by a single observation: the
 * room list already carries each conversation's latest message id, so ONE
 * request per profile detects new activity everywhere. Only rooms whose latest
 * message actually changed are fetched.
 *
 * Steady state for 8 profiles at 60s: 8 requests/minute ≈ 11.5k/day, against a
 * 20k/day background cutoff and Upwork's published 40k. Message fetches only
 * happen when something was actually said.
 */

export type SyncResult = {
  profiles: number
  rooms: number
  changedRooms: number
  /** Rooms fetched only to establish a reply state the mirror had lost. */
  hydratedRooms: number
  /** Rooms whose reply state was written this pass. */
  observed: number
  messages: number
  /** Messages re-attributed by the room-wide pass. Costs no Upwork requests. */
  attributed: number
  /** Proposals refreshed. Hourly at most, so usually zero. */
  proposals: number
  skipped: string[]
  failures: string[]
}

function bodySha(body: string): string {
  return createHash('sha256').update(body.trim()).digest('hex')
}

/**
 * One pass over every connected profile.
 *
 * `priority` matters: background runs stop at a lower daily ceiling so an
 * unattended loop can never consume the budget a person clicking Refresh needs.
 */
export async function syncAllProfiles(priority: CallPriority = 'background'): Promise<SyncResult> {
  const supabase = createAdminClient()
  const profiles = await allActiveProfiles()

  const result: SyncResult = {
    profiles: profiles.length,
    rooms: 0,
    changedRooms: 0,
    hydratedRooms: 0,
    observed: 0,
    messages: 0,
    attributed: 0,
    proposals: 0,
    skipped: [],
    failures: [],
  }

  for (const profile of profiles) {
    try {
      const acting = await loadProfile(profile.id)

      // Paged, because listRooms caps at 100 and the agency has more
      // conversations than that. A background tick reads one page — it cannot
      // afford two without breaching the daily cutoff — while a person clicking
      // Refresh reads deeper, which is the only way a conversation past position
      // 100 ever enters the mirror. See limits.ts for the arithmetic.
      const maxPages =
        priority === 'interactive'
          ? SELF_IMPOSED.roomPagesInteractive
          : SELF_IMPOSED.roomPagesBackground

      const rooms: Room[] = []
      let cursor: string | undefined

      for (let read = 0; read < maxPages; read++) {
        const page = await mcpTransport.listRooms(acting, { limit: 100, cursor, priority })
        rooms.push(...page.items)
        if (!page.hasNextPage || !page.endCursor) break
        cursor = page.endCursor
      }

      const page = { items: rooms }
      result.rooms += page.items.length

      // An empty room list is an alarm, not a quiet day.
      //
      // Upwork changed this response shape without notice and the reader, being
      // defensive, returned zero rooms instead of failing. Every tick then said
      // "0 changed" and looked healthy while the inbox froze for nine hours. A
      // profile that has conversations on record and suddenly reports none is
      // reporting a broken contract with the API, so it is surfaced as a failure.
      if (page.items.length === 0) {
        const { count } = await supabase
          .from('room_profiles')
          .select('room_id', { count: 'exact', head: true })
          .eq('profile_id', profile.id)

        if ((count ?? 0) > 0) {
          result.failures.push(
            `${profile.label}: Upwork returned no conversations, but the portal holds ${count}. ` +
              `The response shape may have changed again — check listRooms in transport-mcp.ts.`,
          )
        }
      }

      const { data: existing } = await supabase
        .from('up_rooms')
        .select('room_id, latest_story_id')

      const previous = new Map(
        (existing ?? []).map((r) => [r.room_id as string, r.latest_story_id as string | null]),
      )

      // The whole budget story: one request told us which conversations moved.
      const changed = page.items.filter((room) => previous.get(room.roomId) !== room.latestStoryId)

      // Rooms that did not move but whose reply state we have never established.
      // Needed because up_messages expires on Upwork's 24h caching rule while a
      // quiet conversation's latest_story_id never changes — so without this the
      // meter would go blind on exactly the conversations that have gone silent.
      //
      // The candidates come from the DATABASE, not from `page.items`. listRooms
      // returns at most 100 rooms newest-first, and up_rooms holds far more, so
      // filtering a live page could never reach a conversation that had slipped
      // past position 100 — 22 of them were stuck with no reply state and no way
      // to acquire one. Capped per tick against the background budget.
      const changedIds = new Set(changed.map((r) => r.roomId))

      const { data: stale } = await supabase.rpc('rooms_needing_reply_state', {
        p_profile_id: profile.id,
        p_limit: SELF_IMPOSED.hydrateRoomsPerTick,
      })

      const hydrate = (stale ?? [])
        .filter((room) => !changedIds.has(room.room_id))
        .map((room) => ({
          roomId: room.room_id,
          roomName: room.room_name,
          lastVisitedAt: room.last_visited_at,
        }))

      await supabase.from('up_rooms').upsert(page.items.map(toRoomRow), { onConflict: 'room_id' })

      const now = new Date().toISOString()
      await supabase.from('room_profiles').upsert(
        page.items.map((room) => ({
          room_id: room.roomId,
          profile_id: profile.id,
          last_seen_at: now,
        })),
        { onConflict: 'room_id,profile_id' },
      )

      for (const room of [...changed, ...hydrate]) {
        const fetched = await mcpTransport.listMessages(acting, room.roomId, {
          limit: 100,
          priority,
        })
        const messages = await resolveDirections(fetched, room)

        if (messages.length > 0) {
          await supabase
            .from('up_messages')
            .upsert(messages.map(toMessageRow), { onConflict: 'story_id' })
          result.messages += messages.length
        }

        // Record what we now know about who spoke last. This outlives the
        // message bodies on purpose — it is a fact the portal derived, not a
        // copy of an Upwork response, so keeping it does not extend the cache.
        await supabase
          .from('room_reply_state')
          .upsert(replyStateRow(room.roomId, messages), { onConflict: 'room_id' })
        result.observed++
      }

      result.changedRooms += changed.length
      result.hydratedRooms += hydrate.length

      // Proposals, at most hourly. They are the only bridge from a conversation
      // to a job post, and they move far too slowly to be worth a request every
      // tick — see proposalRefreshMinutes in limits.ts.
      if (await proposalsAreStale(acting.orgUid)) {
        const proposals = await mcpTransport.listProposals(acting, { priority })
        if (proposals.length > 0) {
          await supabase.from('up_proposals').upsert(
            proposals.map((p) => ({
              proposal_id: p.proposalId,
              org_uid: acting.orgUid,
              job_id: p.jobId,
              job_title: p.jobTitle,
              status: p.status,
              status_label: p.statusLabel,
              rate_amount: p.rateAmount,
              rate_currency: p.rateCurrency,
              created_at_upwork: p.createdAt,
              fetched_at: new Date().toISOString(),
            })),
            { onConflict: 'proposal_id' },
          )
          result.proposals += proposals.length
        }
      }
    } catch (err) {
      // A budget refusal is not a failure — it is the limiter doing its job, and
      // it should read differently in the logs from a broken profile.
      if (err instanceof UpworkPolicyError && err.reason === 'daily_budget_exhausted') {
        result.skipped.push(`${profile.label}: ${err.message}`)
        break // the budget is shared; no point trying the rest
      }

      // One bad profile must never stop the others syncing.
      result.failures.push(
        `${profile.label}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  // Rooms that did not change this tick still get their attribution revisited.
  // Free — it reads stored rows and calls nothing — so it runs even when the
  // budget stopped the profile loop early.
  try {
    const { updated } = await backfillDirections()
    result.attributed = updated
  } catch (err) {
    result.failures.push(`attribution: ${err instanceof Error ? err.message : String(err)}`)
  }

  return result
}

async function resolveDirections(
  messages: Message[],
  room: { roomId: string; roomName: string | null; lastVisitedAt: string | null },
): Promise<Message[]> {
  if (messages.length === 0) return messages

  const { data: sent } = await createAdminClient()
    .from('sent_messages')
    .select('body_sha')
    .eq('room_id', room.roomId)

  const sentHashes = new Set((sent ?? []).map((s) => s.body_sha as string))

  // Our own Upwork identities. An attachment uploaded by one of these is
  // certainly ours; by anyone else, certainly not.
  const { data: ourProfiles } = await createAdminClient()
    .from('upwork_profiles')
    .select('upwork_user_id')
    .is('revoked_at', null)

  const ourUpworkIds = new Set(
    (ourProfiles ?? []).map((p) => p.upwork_user_id).filter((id): id is string => Boolean(id)),
  )

  const perMessage = messages.map((message) => {
    if (message.isSystem) return message

    // Upwork names no sender on a message, but since Aug 2026 it names the
    // uploader on an attached file. That is the only certain attribution the
    // messaging API offers, and it is worth taking ahead of every guess below:
    // measured on live data, 153 client messages were being shown as ours while
    // their own attachments said plainly who sent them.
    const uploader = uploaderUserId(message.attachments)
    if (uploader) {
      const mine = ourUpworkIds.has(uploader)
      return {
        ...message,
        direction: mine ? ('outbound' as const) : ('inbound' as const),
        directionSource: 'attachment_author' as const,
        isOutbound: mine,
      }
    }

    const { direction, source } = inferDirection({
      body: message.body,
      sentAt: message.sentAt,
      sentFromPortal: Boolean(message.body) && sentHashes.has(bodySha(message.body!)),
      roomName: room.roomName,
      lastVisitedAt: room.lastVisitedAt,
    })

    return { ...message, direction, directionSource: source, isOutbound: direction === 'outbound' }
  })

  // Then fill the gaps by looking at the room as a whole. Per-message signals
  // resolve about a quarter of real traffic on their own, which is not enough to
  // answer "is anyone waiting on us".
  // Corrections are applied TWICE, and both matter.
  //
  // First, before the room-wide pass, so a correction acts as an ANCHOR.
  // alternation.ts propagates outward from messages whose side is known, so one
  // person fixing one message now repairs the whole burst and turn around it —
  // rather than leaving them to correct six messages by hand, one at a time.
  //
  // Then again afterwards, because the pass would otherwise be free to overwrite
  // the very thing it was seeded with. A person's answer outranks the guess it
  // informed.
  const seeded = await applyCorrections(sortByTime(perMessage), room.roomId)
  const inferred = withOutboundFlag(resolveByAlternation(seeded))
  return applyCorrections(inferred, room.roomId)
}

/**
 * Overlay what a person told us on top of what the portal worked out.
 *
 * Applied at the very end of every path that writes direction — see 0027. The
 * portal cannot tell that a reply was sent from Upwork's own app rather than
 * from here, so the only source of truth for those is somebody saying so.
 */
async function applyCorrections<T extends { storyId: string; direction?: string }>(
  messages: T[],
  roomId: string,
): Promise<T[]> {
  const { data: corrections } = await createAdminClient()
    .from('message_directions')
    .select('story_id, direction')
    .eq('room_id', roomId)

  if (!corrections || corrections.length === 0) return messages
  const byStory = new Map(corrections.map((c) => [c.story_id, c.direction] as const))

  return messages.map((message) => {
    const corrected = byStory.get(message.storyId)
    if (!corrected) return message
    return {
      ...message,
      direction: corrected,
      directionSource: 'corrected',
      isOutbound: corrected === 'outbound',
    }
  })
}

/** Ascending time; alternation depends on order and Upwork does not promise one. */
function sortByTime<T extends { sentAt: string | null }>(list: T[]): T[] {
  return [...list].sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''))
}

/** is_outbound predates direction and is still read in places; keep them agreeing. */
function withOutboundFlag<T extends { direction?: string; isOutbound?: boolean }>(list: T[]): T[] {
  return list.map((m) => (m.direction ? { ...m, isOutbound: m.direction === 'outbound' } : m))
}

/**
 * Re-run the alternation pass over rooms the portal already holds.
 *
 * Sync only fetches conversations that changed, so a room that went quiet keeps
 * whatever attribution it had when it was last touched — and every room synced
 * before this pass existed is stuck at a quarter resolved. This walks them.
 *
 * It costs nothing against Upwork: no request, no token, no cache age. Purely a
 * re-read of rows already stored, which is why it is safe to run on every tick.
 * Capped per pass so a sync stays quick rather than doing all 400 rooms at once.
 */
export async function backfillDirections(maxRooms = 15): Promise<{ rooms: number; updated: number }> {
  const supabase = createAdminClient()
  const changedRooms: string[] = []
  const attempted: string[] = []

  // Rotated by the database, not by whatever order PostgREST happens to return.
  // Taking "the first 15 rooms with unknown messages" meant taking the SAME 15
  // every tick: they have anchors, but their remaining unknowns sit past
  // alternation's flip cap, so nothing changed and they never left the front of
  // the queue. 66 other rooms were never looked at. rooms_needing_attribution
  // orders by last attempt, and every room is stamped below whether or not the
  // attempt achieved anything.
  const { data: candidates } = await supabase.rpc('rooms_needing_attribution', {
    p_limit: maxRooms,
  })

  const rooms = candidates ?? []
  let updated = 0

  for (const roomId of rooms) {
    const { data: rows } = await supabase
      .from('up_messages')
      .select('story_id, sent_at, direction, direction_source, is_system')
      .eq('room_id', roomId)
      .order('sent_at', { ascending: true })
      .limit(400)

    // Stamped before the work, and unconditionally: a room that cannot be
    // resolved must still leave the queue, or it blocks every room behind it.
    attempted.push(roomId)

    if (!rows || rows.length === 0) continue

    const before = rows.map((r) => ({
      storyId: r.story_id as string,
      sentAt: r.sent_at as string | null,
      direction: r.direction as 'inbound' | 'outbound' | 'unknown',
      directionSource: r.direction_source as never,
      isSystem: Boolean(r.is_system),
    }))

    // Corrected messages are excluded from the pass entirely: alternation
    // propagates outward from anchors, and letting it rewrite a human's answer
    // would be the portal overruling the only party that actually knows.
    const { data: corrected } = await supabase
      .from('message_directions')
      .select('story_id')
      .eq('room_id', roomId)
    const locked = new Set((corrected ?? []).map((c) => c.story_id as string))

    const after = resolveByAlternation(before).map((m, i) =>
      locked.has(before[i]!.storyId) ? before[i]! : m,
    )
    if (after.every((m, i) => m === before[i])) continue
    changedRooms.push(roomId)

    for (let i = 0; i < after.length; i++) {
      const next = after[i]!
      const prev = before[i]!
      if (next.direction === prev.direction && next.directionSource === prev.directionSource) continue

      await supabase
        .from('up_messages')
        .update({
          direction: next.direction,
          direction_source: next.directionSource,
          is_outbound: next.direction === 'outbound',
        })
        .eq('story_id', next.storyId)
      updated++
    }
  }

  // Record the attempt on every room we looked at, so the next pass moves on.
  // update, not upsert: an upsert would INSERT a row for a room that has no reply
  // state yet, and the defaults on that row (message_count 0, awaiting_since
  // null) read as "answered" — inventing a resolved conversation out of a
  // bookkeeping write. Rooms without a state get one from hydration instead.
  const stamp = new Date().toISOString()
  for (const roomId of attempted) {
    await supabase
      .from('room_reply_state')
      .update({ attribution_pass_at: stamp })
      .eq('room_id', roomId)
  }

  // Re-attributing a message can change who spoke last, so the derived state has
  // to be recomputed for those rooms. Still no Upwork requests.
  for (const roomId of changedRooms) {
    const { data: rows } = await supabase
      .from('up_messages')
      .select('direction, direction_source, sent_at, is_system')
      .eq('room_id', roomId)
      .limit(400)

    if (!rows) continue

    await supabase.from('room_reply_state').upsert(
      replyStateRow(
        roomId,
        rows.map((r) => ({
          direction: r.direction,
          directionSource: r.direction_source as DirectionSource,
          sentAt: r.sent_at,
          isSystem: Boolean(r.is_system),
        })),
      ),
      { onConflict: 'room_id' },
    )
  }

  return { rooms: rooms.length, updated }
}

/** Drop mirrored rows past the self-imposed cache age. Cheap; no API calls. */
export async function expireMirror() {
  await createAdminClient().rpc('expire_upwork_mirror', {
    p_max_age: `${SELF_IMPOSED.cacheMaxAgeHours} hours`,
  })
}

/**
 * A room as a database row — with absent fields OMITTED, never nulled.
 *
 * This matters because Upwork drops fields without warning. On 21 Aug 2026 the
 * new list_rooms payload stopped sending `topic` and `lastVisitedDateTime`
 * altogether. Writing the mapped nulls straight into an upsert overwrote every
 * value we already held: 425 conversations lost their project title, and
 * last_visited_at went to zero across the board, which silently killed the
 * `visit_window` direction rule and pushed all inbound attribution onto the
 * turn-taking guess.
 *
 * PostgREST's upsert only updates the columns present in the payload, so leaving
 * a key out preserves what is already stored. An absent field now means "Upwork
 * did not say", not "Upwork said nothing".
 *
 * room_name, counts and the latest-story fields are always sent: those Upwork
 * does still provide, and they genuinely change.
 */
type RoomRow = Partial<UpRoom> & Pick<UpRoom, 'room_id' | 'org_uid'>

function toRoomRow(room: Room): RoomRow {
  const row: RoomRow = {
    room_id: room.roomId,
    org_uid: room.orgUid,
    room_name: room.roomName,
    num_users: room.numUsers,
    num_unread: room.numUnread,
    latest_story_id: room.latestStoryId,
    latest_story_at: room.latestStoryAt,
    latest_snippet: room.latestSnippet,
    fetched_at: new Date().toISOString(),
  }

  // Only written when Upwork actually sent them.
  if (room.topic !== null && room.topic !== undefined) row.topic = room.topic
  if (room.createdAtUpwork) row.created_at_upwork = room.createdAtUpwork
  if (room.lastVisitedAt) row.last_visited_at = room.lastVisitedAt
  if (room.contractId) row.contract_id = room.contractId
  if (room.contractStatus) row.contract_status = room.contractStatus

  return row
}

function toMessageRow(message: Message) {
  return {
    story_id: message.storyId,
    room_id: message.roomId,
    author_id: message.authorId,
    author_name: message.authorName,
    is_outbound: message.isOutbound,
    direction: message.direction,
    direction_source: message.directionSource,
    action_verb: message.actionVerb,
    is_system: message.isSystem,
    body: message.body,
    attachments: message.attachments,
    sent_at: message.sentAt,
    edited_at: message.editedAt,
    fetched_at: new Date().toISOString(),
  }
}


/**
 * Has the proposal list gone stale for this org?
 *
 * Read from what we already hold rather than tracked separately: the newest
 * fetched_at IS the answer, and a dedicated timestamp somewhere else would be one
 * more thing to keep in step with the rows it describes.
 */
async function proposalsAreStale(orgUid: string): Promise<boolean> {
  const { data } = await createAdminClient()
    .from('up_proposals')
    .select('fetched_at')
    .eq('org_uid', orgUid)
    .order('fetched_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!data?.fetched_at) return true

  const ageMinutes = (Date.now() - Date.parse(data.fetched_at)) / 60_000
  return ageMinutes >= SELF_IMPOSED.proposalRefreshMinutes
}
