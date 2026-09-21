import type { AppUser } from '@/lib/database.types'
import {
  activeFilterCount,
  inboxHref,
  INBOX_VIEWS,
  parseView,
  parseWait,
  shortName,
  WAIT_BANDS,
  type InboxFilters,
  type InboxView,
} from '@/lib/inbox-filters'
import { can } from '@/lib/permissions'
import { createClient } from '@/lib/supabase/server'
import { waitSortKey, waitState, type WaitState } from '@/lib/wait'

// Re-exported so server callers keep one import site for the whole inbox module.
export {
  activeFilterCount,
  inboxHref,
  INBOX_VIEWS,
  parseView,
  parseWait,
  shortName,
  WAIT_BANDS,
}
export type { InboxFilters, InboxView }

/**
 * Everything the conversation list needs, loaded once.
 *
 * This lives outside the page because the list is a column on two routes now:
 * /inbox shows it beside the triage panel, /inbox/[roomId] beside the thread. A
 * layout cannot supply it — a Next layout does not receive its child's dynamic
 * params, and the list has to know which row is selected — so both pages call
 * this instead and the shape is guaranteed identical.
 *
 * Sorting happens here for the same reason: the wait meter and the severity
 * stripe are derived from the same WaitState object, and computing them twice in
 * two places is how a row ends up with an amber stripe and a red figure.
 */

/**
 * How many conversations the inbox loads in one go.
 *
 * Deliberately larger than the agency's current 402 so nothing is silently
 * dropped. `truncated` goes true if we ever hit it, which is the signal to move
 * sorting and paging into the database rather than quietly under-reporting.
 */
export const ROOM_FETCH_LIMIT = 2000

export type InboxRoom = {
  roomId: string
  name: string
  topic: string | null
  snippet: string | null
  unread: number
  latestStoryAt: string | null
  /** When the portal last refreshed this room from Upwork. */
  fetchedAt: string
  wait: WaitState
  profile: { id: string; label: string } | null
  assignee: { id: string; name: string; isMe: boolean } | null
  /** Somebody has been granted this conversation, whether or not assigned. */
  covered: boolean
  mine: boolean
}

export type InboxData = {
  filters: InboxFilters
  /** In view, sorted longest-wait first. */
  rooms: InboxRoom[]
  /** Every room passing the profile/member filters, whatever the tab. */
  scoped: InboxRoom[]
  tabCount: Record<InboxView, number>
  /** Live counts for each drawer option, so nobody clicks into an empty result. */
  optionCount: {
    wait: Record<number, number>
    assignee: Record<string, number>
    unassigned: number
  }
  profiles: { profile_id: string; profile_label: string; room_count: number; unread_rooms: number }[]
  members: { id: string; name: string; roomCount: number }[]
  activeProfileLabel: string | null
  activeMemberName: string | null
  waiting: InboxRoom[]
  breached: InboxRoom[]
  unowned: InboxRoom[]
  oldestSync: string | null
  /** The signed-in member, so the drawer can offer "assigned to me". */
  viewerId: string
  canRoute: boolean
  /** True if we hit ROOM_FETCH_LIMIT — counts below would then be understated. */
  truncated: boolean
  /** No profile is connected, or none this member may see. */
  empty: boolean
}

export async function loadInbox(user: AppUser, filters: InboxFilters): Promise<InboxData> {
  const supabase = await createClient()

  const [
    { data: rooms },
    { data: waits },
    { data: assignments },
    { data: participants },
    { data: roomProfiles },
    { data: profileCounts },
    { data: members },
  ] = await Promise.all([
    // Every room, not a page of them.
    //
    // This was capped at 200 while the mirror held 402, and the cap was applied
    // AFTER ordering by recency — so a conversation that had gone quiet but was
    // three days overdue simply never loaded. The tab read "Needs reply 13" when
    // 86 clients were waiting, and the badge people are meant to trust was wrong
    // by a factor of six. Sorting by wait cannot happen in the app if the app has
    // only seen half the rooms.
    //
    // A few hundred narrow rows is a cheap query. Past a couple of thousand this
    // needs the ordering pushed into Postgres and real paging; the count check
    // below is what will tell us when we get there.
    supabase
      .from('up_rooms')
      .select('room_id, room_name, topic, num_unread, latest_snippet, latest_story_at, fetched_at')
      .order('latest_story_at', { ascending: false, nullsFirst: false })
      .limit(ROOM_FETCH_LIMIT),
    supabase.from('v_room_wait').select('*'),
    supabase.from('assignments').select('target_id, assigned_to').eq('target_type', 'room'),
    supabase.from('v_room_participants').select('room_id, user_id, full_name, email, can_send'),
    supabase.from('v_room_profiles').select('room_id, profile_id, profile_label'),
    supabase.from('v_profile_room_counts').select('*').order('profile_label'),
    supabase.from('app_users').select('id, full_name, email').eq('is_active', true),
  ])

  const now = new Date()
  const memberName = new Map((members ?? []).map((m) => [m.id, m.full_name || m.email] as const))
  const assignedTo = new Map((assignments ?? []).map((a) => [a.target_id, a.assigned_to]))
  const waitByRoom = new Map((waits ?? []).map((w) => [w.room_id, w] as const))

  // Keyed by member: someone holding several profiles that all reach a room
  // would otherwise be counted once per grant.
  const coverage = new Map<string, Set<string>>()
  for (const p of participants ?? []) {
    const set = coverage.get(p.room_id) ?? new Set<string>()
    set.add(p.user_id)
    coverage.set(p.room_id, set)
  }

  const memberRoomCounts = new Map<string, number>()
  for (const [, set] of coverage) {
    for (const id of set) memberRoomCounts.set(id, (memberRoomCounts.get(id) ?? 0) + 1)
  }

  const firstProfile = new Map<string, { id: string; label: string }>()
  for (const rp of roomProfiles ?? []) {
    if (!firstProfile.has(rp.room_id)) {
      firstProfile.set(rp.room_id, { id: rp.profile_id, label: rp.profile_label })
    }
  }

  const decorated: InboxRoom[] = (rooms ?? []).map((room) => {
    const assigneeId = assignedTo.get(room.room_id) ?? null
    const granted = coverage.get(room.room_id)
    return {
      roomId: room.room_id,
      name: room.room_name ?? 'Conversation',
      topic: room.topic,
      snippet: room.latest_snippet,
      unread: room.num_unread,
      latestStoryAt: room.latest_story_at,
      wait: waitState(waitByRoom.get(room.room_id), now),
      profile: firstProfile.get(room.room_id) ?? null,
      assignee: assigneeId
        ? {
            id: assigneeId,
            name: shortName(memberName.get(assigneeId) ?? 'A teammate'),
            isMe: assigneeId === user.id,
          }
        : null,
      covered: (granted?.size ?? 0) > 0,
      mine: assigneeId === user.id || Boolean(granted?.has(user.id)),
      fetchedAt: room.fetched_at,
    }
  })

  // "Scoped" is everything the drawer's conditions allow. The tabs then slice it
  // further, which is why the two are counted separately — a tab badge that
  // ignored the active filter would send you to an empty list.
  const scoped = decorated
    .filter((d) => !filters.profile || d.profile?.id === filters.profile)
    .filter((d) => !filters.user || Boolean(coverage.get(d.roomId)?.has(filters.user)))
    .filter((d) => filters.wait === null || waitedAtLeast(d, filters.wait))
    .filter((d) => {
      if (!filters.assignee) return true
      if (filters.assignee === 'none') return !d.assignee && !d.covered
      return d.assignee?.id === filters.assignee
    })

  // Counted against everything the OTHER filters allow, so each number answers
  // "what would I get if I added this one".
  const forOptions = decorated
    .filter((d) => !filters.profile || d.profile?.id === filters.profile)
    .filter((d) => !filters.user || Boolean(coverage.get(d.roomId)?.has(filters.user)))

  const optionCount = {
    wait: Object.fromEntries(
      WAIT_BANDS.map((band) => [band.hours, forOptions.filter((d) => waitedAtLeast(d, band.hours)).length]),
    ) as Record<number, number>,
    assignee: {} as Record<string, number>,
    unassigned: forOptions.filter((d) => !d.assignee && !d.covered).length,
  }
  for (const room of forOptions) {
    if (room.assignee) {
      optionCount.assignee[room.assignee.id] = (optionCount.assignee[room.assignee.id] ?? 0) + 1
    }
  }

  const tabCount: Record<InboxView, number> = {
    waiting: scoped.filter((d) => d.wait.awaiting).length,
    unread: scoped.filter((d) => d.unread > 0).length,
    mine: scoped.filter((d) => d.mine).length,
    all: scoped.length,
  }

  const inView = scoped.filter((d) => {
    if (filters.view === 'waiting') return d.wait.awaiting
    if (filters.view === 'unread') return d.unread > 0
    if (filters.view === 'mine') return d.mine
    return true
  })

  // Longest wait first; answered conversations keep recency order beneath them.
  const sorted = [...inView].sort((a, b) => {
    const byWait = waitSortKey(a.wait) - waitSortKey(b.wait)
    if (byWait !== 0) return byWait
    return (b.latestStoryAt ?? '').localeCompare(a.latestStoryAt ?? '')
  })

  const waiting = scoped.filter((d) => d.wait.awaiting)
  const counts = profileCounts ?? []

  return {
    filters,
    rooms: sorted,
    scoped,
    tabCount,
    optionCount,
    profiles: counts,
    members: (members ?? [])
      .map((m) => ({
        id: m.id,
        name: m.full_name || m.email,
        roomCount: memberRoomCounts.get(m.id) ?? 0,
      }))
      .filter((m) => m.roomCount > 0),
    activeProfileLabel: filters.profile
      ? (counts.find((p) => p.profile_id === filters.profile)?.profile_label ?? null)
      : null,
    activeMemberName: filters.user ? (memberName.get(filters.user) ?? null) : null,
    waiting,
    breached: waiting.filter((d) => d.wait.awaiting && d.wait.level === 'breached'),
    unowned: waiting.filter((d) => !d.assignee && !d.covered),
    oldestSync: decorated.reduce<string | null>(
      (acc, d) => (!acc || d.fetchedAt < acc ? d.fetchedAt : acc),
      null,
    ),
    viewerId: user.id,
    canRoute: can(user, 'inbox:assign'),
    truncated: (rooms ?? []).length >= ROOM_FETCH_LIMIT,
    empty: counts.length === 0,
  }
}

/** Filter state lives in the URL so a view can be pasted into chat. */

/** True when this conversation's counted wait has passed `hours`. */
function waitedAtLeast(room: InboxRoom, hours: number): boolean {
  return room.wait.awaiting && room.wait.seconds >= hours * 3600
}

/** How many drawer conditions are on, for the button badge. */
