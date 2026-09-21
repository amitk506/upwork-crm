'use server'

import { createHash } from 'node:crypto'

import { revalidatePath } from 'next/cache'

import { requireCapability, requireUser } from '@/lib/auth'
import { logActivity } from '@/lib/activity'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import {
  allActiveProfiles,
  loadProfile,
  resolveActingProfile,
} from '@/lib/upwork/profiles'
import { syncAllProfiles } from '@/lib/upwork/sync'
import { mcpTransport } from '@/lib/upwork/transport-mcp'
import { MESSAGE_MAX_LENGTH, UpworkPolicyError, type PendingUpload } from '@/lib/upwork/types'
import { inferDirection } from '@/lib/upwork/direction'
import { countedWaitSeconds, waitLevel } from '@/lib/wait'
import type { Message } from '@/lib/upwork/types'

/**
 * Everything here is triggered by a person clicking something. There is no
 * background polling yet — that lands with the sync worker, and when it does it
 * must use priority:'background' so it stops at the 20k/day cutoff instead of
 * eating the budget interactive work needs.
 */

function friendly(err: unknown): string {
  if (err instanceof UpworkPolicyError) return err.message
  return err instanceof Error ? err.message : 'Something went wrong talking to Upwork'
}

/**
 * Refresh the room list, then fetch messages only for rooms whose latest story
 * changed. The room list already carries latestStory, so ONE call detects new
 * activity everywhere — this is the single most important budget decision in
 * the whole system.
 */
export async function syncRooms() {
  await requireUser()

  const profiles = await allActiveProfiles()
  if (profiles.length === 0) {
    return { error: 'No Upwork profiles are connected yet. An owner adds them under Profiles.' }
  }

  try {
    // Interactive priority: a person is waiting, so this gets the higher of the
    // two daily ceilings. The unattended loop in /api/sync uses background.
    const result = await syncAllProfiles('interactive')

    revalidatePath('/inbox')

    if (result.failures.length === profiles.length) {
      return { error: result.failures.join(' · ') }
    }

    return {
      ok: true,
      profiles: result.profiles,
      rooms: result.rooms,
      changedRooms: result.changedRooms,
      messages: result.messages,
      warning: [...result.failures, ...result.skipped].join(' · ') || undefined,
    }
  } catch (err) {
    return { error: friendly(err) }
  }
}

/** Pull one thread on demand — opening a conversation should show it fresh. */
export async function syncThread(roomId: string) {
  const user = await requireUser()

  try {
    const acting = await resolveActingProfile(user.id, roomId)
    if (!acting) return { error: 'You do not have access to this conversation.' }

    const profile = await loadProfile(acting.profileId)
    const fetched = await mcpTransport.listMessages(profile, roomId, { limit: 100 })

    const { data: roomRow } = await createAdminClient()
      .from('up_rooms')
      .select('room_name, last_visited_at')
      .eq('room_id', roomId)
      .maybeSingle()

    const messages = await resolveDirections(fetched, {
      roomName: roomRow?.room_name ?? null,
      lastVisitedAt: roomRow?.last_visited_at ?? null,
    })

    if (messages.length > 0) {
      await createAdminClient()
        .from('up_messages')
        .upsert(messages.map(toMessageRow), { onConflict: 'story_id' })
    }

    revalidatePath(`/inbox/${roomId}`)
    return { ok: true, messages: messages.length }
  } catch (err) {
    return { error: friendly(err) }
  }
}

/**
 * Send a reply. Human-initiated by construction: this only runs because someone
 * typed a body and pressed send.
 */
export async function sendReply(
  roomId: string,
  body: string,
  files: PendingUpload[] = [],
) {
  const user = await requireCapability('inbox:send')

  const trimmed = body.trim()
  if (!trimmed && files.length === 0) return { error: 'Nothing to send' }
  if (trimmed.length > MESSAGE_MAX_LENGTH) {
    return {
      error: `That is ${trimmed.length.toLocaleString()} characters; Upwork's limit is ${MESSAGE_MAX_LENGTH.toLocaleString()}. Please shorten it — the portal will not truncate a message to a client.`,
    }
  }

  try {
    const acting = await resolveActingProfile(user.id, roomId)
    if (!acting) {
      return {
        error:
          'You have not been given access to this conversation. An owner grants access under ' +
          'Profiles, either for a whole profile or for individual chats.',
      }
    }
    if (!acting.canSend) {
      return { error: 'Your access to this conversation is read-only.' }
    }

    const profile = await loadProfile(acting.profileId)

    // With approval required, the profile holder is the one who actually sends.
    if (profile.sendRequiresApproval) {
      return {
        error:
          `Replies through ${profile.label} need its account holder to approve. ` +
          `Write it as a draft and it will appear in their approvals queue.`,
        needsApproval: true,
        profileLabel: profile.label,
      }
    }

    // How long the client had been waiting, captured at the moment we answer.
    //
    // This is the only chance to record it: room_reply_state.awaiting_since is
    // cleared by the next sync once the reply lands, and up_messages expires on
    // Upwork's 24h caching rule — so reply speed cannot be reconstructed later
    // from anything the portal is allowed to keep. The activity log is
    // portal-owned and permanent, so the measurement goes there, once, now.
    //
    // Counted the same way the inbox ramp counts, overnight excluded, so a
    // person is never marked slow for hours nobody was expected to work.
    const waited = await measureWait(roomId)

    // Uploaded at send time, not when the file was picked: Upwork's upload
    // session is short-lived and tied to the room, so opening one while somebody
    // is still typing would often have expired by the time they pressed send.
    const uploaded =
      files.length > 0 ? await mcpTransport.uploadAttachments(profile, roomId, files) : []

    await mcpTransport.sendMessage(profile, roomId, trimmed, uploaded)

    // Sending IS the follow-up. Closing it here rather than making someone tick
    // it off keeps the dashboard honest — a reminder that survives the message it
    // was asking for is the kind people learn to ignore.
    await createAdminClient()
      .from('room_followups')
      .update({ done_at: new Date().toISOString(), done_by: user.id })
      .eq('room_id', roomId)
      .is('done_at', null)

    // Upwork returns no author on messages, so the only reliable record that
    // this reply is ours is the one we write here, at the moment we send it.
    const supabase = createAdminClient()
    await supabase
      .from('sent_messages')
      .upsert(
        { room_id: roomId, author_id: user.id, body_sha: bodySha(trimmed) },
        { onConflict: 'room_id,body_sha' },
      )

    // Tagged with the room so the conversation's own activity tab can answer
    // "who replied to this client?" — the failure path already logged, but the
    // success path did not, which is the half people actually want to see.
    await logActivity({
      actorId: user.id,
      action: 'inbox.replied',
      targetType: 'room',
      targetId: roomId,
      payload: {
        profile: profile.label,
        characters: trimmed.length,
        ...waited,
      },
      succeeded: true,
    })

    // Pull the thread back so the sent message appears with Upwork's own id and
    // timestamp rather than an optimistic local guess.
    await syncThread(roomId)
    await attributeOwnMessages(roomId)

    revalidatePath(`/inbox/${roomId}`)
    return { ok: true }
  } catch (err) {
    await logActivity({
      actorId: user.id,
      action: 'inbox.reply_failed',
      targetType: 'room',
      targetId: roomId,
      succeeded: false,
      error: err instanceof Error ? err.message : String(err),
    })
    return { error: friendly(err) }
  }
}

/** Assign a conversation to a teammate. Portal-only; Upwork never sees this. */
export async function assignRoom(roomId: string, assignedTo: string | null) {
  const user = await requireCapability('inbox:assign')
  const supabase = createAdminClient()

  if (assignedTo) {
    await supabase
      .from('assignments')
      .upsert(
        { target_type: 'room', target_id: roomId, assigned_to: assignedTo, assigned_by: user.id },
        { onConflict: 'target_type,target_id' },
      )
  } else {
    await supabase.from('assignments').delete().eq('target_type', 'room').eq('target_id', roomId)
  }

  await logActivity({
    actorId: user.id,
    action: assignedTo ? 'inbox.assigned' : 'inbox.unassigned',
    targetType: 'room',
    targetId: roomId,
    payload: { assignedTo },
  })

  revalidatePath('/inbox')
  revalidatePath(`/inbox/${roomId}`)
  return { ok: true }
}

/** A private note on a thread. Never leaves the portal. */
export async function addNote(roomId: string, body: string) {
  const user = await requireUser()
  const trimmed = body.trim()
  if (!trimmed) return { error: 'Nothing to save' }

  // The member's own client, not the admin one. internal_notes already carries
  // an RLS policy that says a note may only be written by its author, against a
  // room they can see — going through the service role would have bypassed the
  // rule instead of enforcing it, letting anyone signed in write a note against
  // any room id they could guess.
  const supabase = await createClient()

  const { error } = await supabase.from('internal_notes').insert({
    target_type: 'room',
    target_id: roomId,
    author_id: user.id,
    body: trimmed,
  })

  if (error) {
    // A policy refusal is the common case here and reads as gibberish otherwise.
    return {
      error:
        error.code === '42501'
          ? 'You do not have access to this conversation, so the note was not saved.'
          : error.message,
    }
  }

  revalidatePath(`/inbox/${roomId}`)
  return { ok: true }
}

/**
 * Decide which side each message came from, using the room context Upwork does
 * give us. See lib/upwork/direction.ts — every result records how it was
 * decided so the UI never presents an inference as a fact.
 */
async function resolveDirections(
  messages: Message[],
  room: { roomName: string | null; lastVisitedAt: string | null },
): Promise<Message[]> {
  if (messages.length === 0) return messages

  const supabase = createAdminClient()
  const { data: sent } = await supabase
    .from('sent_messages')
    .select('body_sha')
    .eq('room_id', messages[0]!.roomId)

  const sentHashes = new Set((sent ?? []).map((s) => s.body_sha as string))

  return messages.map((message) => {
    if (message.isSystem) return message

    const { direction, source } = inferDirection({
      body: message.body,
      sentAt: message.sentAt,
      sentFromPortal: Boolean(message.body) && sentHashes.has(bodySha(message.body!)),
      roomName: room.roomName,
      lastVisitedAt: room.lastVisitedAt,
    })

    return {
      ...message,
      direction,
      directionSource: source,
      isOutbound: direction === 'outbound',
    }
  })
}

/** Stable digest of a message body, used to match our sends back to Upwork's copy. */
function bodySha(body: string): string {
  return createHash('sha256').update(body.trim()).digest('hex')
}

/**
 * Mark the messages we sent ourselves.
 *
 * Upwork exposes no authorship, so a body digest is the join key: if a message
 * in this room matches something we recorded sending, it is ours. Only ever
 * ADDS attribution — a message we cannot match stays honestly unattributed
 * rather than being guessed at.
 */
async function attributeOwnMessages(roomId: string) {
  const supabase = createAdminClient()

  const [{ data: sent }, { data: messages }] = await Promise.all([
    supabase.from('sent_messages').select('body_sha, author_id').eq('room_id', roomId),
    supabase
      .from('up_messages')
      .select('story_id, body')
      .eq('room_id', roomId)
      .eq('is_outbound', false),
  ])

  if (!sent?.length || !messages?.length) return

  const byDigest = new Map(sent.map((s) => [s.body_sha as string, s.author_id as string]))

  for (const message of messages) {
    if (!message.body) continue
    const author = byDigest.get(bodySha(message.body))
    if (!author) continue

    await supabase
      .from('up_messages')
      .update({ is_outbound: true, author_id: author })
      .eq('story_id', message.story_id)

    await supabase
      .from('sent_messages')
      .update({ story_id: message.story_id })
      .eq('room_id', roomId)
      .eq('body_sha', bodySha(message.body))
  }
}

// ---------------------------------------------------------------------------

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
 * Mark a conversation as not needing a reply, or undo that.
 *
 * "Thanks, that's perfect" is the client speaking last, so the meter counts it,
 * and a board full of waits nobody intends to answer is how the ramp stops being
 * believed. This is the way out.
 *
 * The waiver is pinned in the database to the message it was granted for, so it
 * expires by itself the moment the client writes again — see migration 0023. That
 * matters more than it sounds: a dismissal that outlived its reason would hide
 * the next urgent message indefinitely, which is the one outcome this feature
 * exists to prevent.
 *
 * Access is checked inside waive_room_reply() rather than here, because it is
 * SECURITY DEFINER and must not trust its caller.
 */
export async function setReplyWaived(roomId: string, waived: boolean) {
  const user = await requireUser()
  const supabase = await createClient()

  const { error } = await supabase.rpc('waive_room_reply', {
    p_room_id: roomId,
    p_waive: waived,
  })

  if (error) {
    return {
      error:
        error.code === '42501'
          ? 'You do not have access to this conversation.'
          : error.message,
    }
  }

  await logActivity({
    actorId: user.id,
    action: waived ? 'inbox.reply_waived' : 'inbox.reply_unwaived',
    targetType: 'room',
    targetId: roomId,
  })

  revalidatePath(`/inbox/${roomId}`)
  revalidatePath('/inbox')
  return { ok: true }
}


/**
 * The wait this reply is about to end, in the ramp's own units.
 *
 * Returns nothing rather than zero when the room has no outstanding wait — a
 * reply to a conversation nobody was waiting on is not a fast response, and
 * recording it as 0 seconds would flatter whoever sent it and corrupt the median.
 */
async function measureWait(
  roomId: string,
): Promise<{ waitedSeconds?: number; waitLevel?: string }> {
  try {
    const { data } = await createAdminClient()
      .from('room_reply_state')
      .select('awaiting_since')
      .eq('room_id', roomId)
      .maybeSingle()

    if (!data?.awaiting_since) return {}

    const seconds = countedWaitSeconds(data.awaiting_since)
    return { waitedSeconds: seconds, waitLevel: waitLevel(seconds) }
  } catch {
    // Never block a reply on a measurement.
    return {}
  }
}

/**
 * Promise to come back to a client on a date.
 *
 * The wait meter cannot cover this: once we reply, the conversation is answered
 * and correctly leaves the waiting list, so "we said we'd update them Tuesday"
 * has nowhere to live. This is that promise, with a date on it.
 *
 * Defaults to the conversation's assignee, because the person who owns the chat
 * is normally the one who owes the message — but it is stored explicitly rather
 * than derived, so reassigning a chat later cannot silently move somebody's
 * commitments onto a colleague's dashboard.
 */
export async function setFollowUp(roomId: string, dueOn: string, note: string) {
  const user = await requireUser()
  const supabase = await createClient()

  const due = parseFollowUpDate(dueOn)
  if (!due) return { error: 'Pick a date for the follow-up.' }
  if (due.getTime() < Date.now() - 60_000) {
    return { error: 'That date has already passed. Pick today or later.' }
  }

  const { data: assignment } = await supabase
    .from('assignments')
    .select('assigned_to')
    .eq('target_type', 'room')
    .eq('target_id', roomId)
    .maybeSingle()

  // Only one open follow-up per conversation — replacing is the expected way to
  // change a date, so close any existing one first rather than failing on the
  // unique index.
  await supabase
    .from('room_followups')
    .update({ done_at: new Date().toISOString(), done_by: user.id })
    .eq('room_id', roomId)
    .is('done_at', null)

  const { error } = await supabase.from('room_followups').insert({
    room_id: roomId,
    due_at: due.toISOString(),
    for_user: assignment?.assigned_to ?? user.id,
    note: note.trim() || null,
    created_by: user.id,
  })

  if (error) {
    return {
      error:
        error.code === '42501'
          ? 'You do not have access to this conversation.'
          : error.message,
    }
  }

  await logActivity({
    actorId: user.id,
    action: 'inbox.followup_set',
    targetType: 'room',
    targetId: roomId,
    payload: { dueAt: due.toISOString(), forUser: assignment?.assigned_to ?? user.id },
  })

  revalidatePath(`/inbox/${roomId}`)
  revalidatePath('/inbox')
  return { ok: true }
}

/** Mark it handled, or drop it. Same action either way — the promise is discharged. */
export async function clearFollowUp(roomId: string) {
  const user = await requireUser()
  const supabase = await createClient()

  const { error } = await supabase
    .from('room_followups')
    .update({ done_at: new Date().toISOString(), done_by: user.id })
    .eq('room_id', roomId)
    .is('done_at', null)

  if (error) return { error: error.message }

  await logActivity({
    actorId: user.id,
    action: 'inbox.followup_cleared',
    targetType: 'room',
    targetId: roomId,
  })

  revalidatePath(`/inbox/${roomId}`)
  revalidatePath('/inbox')
  return { ok: true }
}

/**
 * A bare date from a date input, pinned to 10:00 IST.
 *
 * Not midnight: a reminder that comes due at 00:00 has already been sitting on
 * the dashboard marked overdue by the time anyone starts work, which trains
 * people to ignore the colour.
 */
function parseFollowUpDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const at = new Date(`${value}T10:00:00+05:30`)
  return Number.isNaN(at.getTime()) ? null : at
}

/**
 * Tell the portal who actually sent a message.
 *
 * Upwork returns no author, so direction is worked out — and there is one case
 * the portal can never get right on its own: a reply the team sent from Upwork's
 * own app. It arrives after the profile's last visit, so the visit_window rule
 * files it as the client's, and it appears in the thread under their name.
 *
 * The person reading the conversation knows immediately. This is how they say so.
 * The correction outranks every inferred source and is re-applied on each sync,
 * because direction is recomputed from scratch whenever a room is refetched.
 */
export async function correctDirection(
  storyId: string,
  roomId: string,
  direction: 'inbound' | 'outbound',
) {
  const user = await requireUser()
  const supabase = await createClient()

  const { error } = await supabase.from('message_directions').upsert(
    { story_id: storyId, room_id: roomId, direction, set_by: user.id },
    { onConflict: 'story_id' },
  )

  if (error) {
    return {
      error:
        error.code === '42501'
          ? 'You do not have access to this conversation.'
          : error.message,
    }
  }

  // Apply it to the mirror now, rather than leaving the thread wrong until the
  // next sync touches this room — which for a quiet conversation could be hours.
  await createAdminClient()
    .from('up_messages')
    .update({
      direction,
      direction_source: 'corrected',
      is_outbound: direction === 'outbound',
    })
    .eq('story_id', storyId)

  await logActivity({
    actorId: user.id,
    action: 'inbox.direction_corrected',
    targetType: 'room',
    targetId: roomId,
    payload: { storyId, direction },
  })

  revalidatePath(`/inbox/${roomId}`)
  revalidatePath('/inbox')
  return { ok: true }
}
