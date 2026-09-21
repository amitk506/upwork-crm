/**
 * Inbox filter state — the pure half.
 *
 * Split out of inbox-data.ts because the filter drawer is a client component: it
 * needs inboxHref(), WAIT_BANDS and activeFilterCount(), and importing them from
 * the module that also holds loadInbox() dragged the server-only Supabase client
 * into the browser bundle. Nothing here touches the database or the request.
 */

export type InboxView = 'waiting' | 'unread' | 'mine' | 'all'

/**
 * Three tabs, not four.
 *
 * "Mine" was a scope pretending to be a state, and in a 336px column the fourth
 * tab pushed "All" off the edge. It is an assignee filter, which the drawer
 * already does properly — and for an owner granted every profile it selected
 * everything anyway, so it read as a duplicate of "All".
 *
 * `countable` marks the tabs whose number means something is outstanding. A count
 * beside "All" only says how many conversations exist, which is not a number
 * anyone acts on, and four numbers in a row is what made this strip unreadable.
 */
export const INBOX_VIEWS: { key: InboxView; label: string; countable: boolean }[] = [
  { key: 'waiting', label: 'Needs reply', countable: true },
  { key: 'unread', label: 'Unread', countable: true },
  { key: 'all', label: 'All', countable: false },
]

const VIEW_KEYS: InboxView[] = ['waiting', 'unread', 'mine', 'all']

/** 'mine' is still honoured from a URL even though it no longer has a tab. */
export function parseView(raw: string | undefined): InboxView {
  return VIEW_KEYS.includes(raw as InboxView) ? (raw as InboxView) : 'waiting'
}

/**
 * The wait thresholds the drawer offers.
 *
 * The same numbers as the severity ramp in src/lib/wait.ts, deliberately: a
 * manager filtering for "over 6 hours" should get exactly the rows showing an
 * amber stripe, not a set that nearly matches.
 */
export const WAIT_BANDS = [
  { hours: 2, label: 'Over 2 hours' },
  { hours: 6, label: 'Over 6 hours' },
  { hours: 24, label: 'Over 24 hours — breached' },
] as const

export function parseWait(raw: string | undefined): number | null {
  const hours = Number(raw)
  return WAIT_BANDS.some((b) => b.hours === hours) ? hours : null
}

export type InboxFilters = {
  profile: string | null
  user: string | null
  view: InboxView
  /** Minimum hours waited, from WAIT_BANDS. Null means any. */
  wait: number | null
  /** A member id, or 'none' for conversations nobody has been granted. */
  assignee: string | null
}

export function inboxHref(
  filters: InboxFilters,
  next: Partial<{
    view: InboxView
    profile: string | null
    user: string | null
    wait: number | null
    assignee: string | null
  }> = {},
  basePath = '/inbox',
): string {
  const params = new URLSearchParams()
  const view = next.view ?? filters.view
  const profile = 'profile' in next ? next.profile : filters.profile
  const member = 'user' in next ? next.user : filters.user
  const wait = 'wait' in next ? next.wait : filters.wait
  const assignee = 'assignee' in next ? next.assignee : filters.assignee

  if (view !== 'waiting') params.set('view', view)
  if (profile) params.set('profile', profile)
  if (member) params.set('user', member)
  if (wait) params.set('wait', String(wait))
  if (assignee) params.set('assignee', assignee)

  const query = params.toString()
  return query ? `${basePath}?${query}` : basePath
}

export function activeFilterCount(filters: InboxFilters): number {
  return [filters.profile, filters.user, filters.wait, filters.assignee].filter(Boolean).length
}

/** "Vansh Kapoor" → "Vansh K." — a 336px column has room for one surname letter. */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'Someone'
  if (parts.length === 1) return parts[0]!
  return `${parts[0]} ${parts[1]![0]!.toUpperCase()}.`
}
