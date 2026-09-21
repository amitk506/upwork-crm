/**
 * Single source of truth for Upwork's published limits, and the deliberately
 * lower ceilings this portal holds itself to.
 *
 * Published (support.upwork.com, "What are the API requests limits?",
 * updated 2026-06-22):
 *   - 10 requests/second, enforced PER IP — not per user, not per app
 *   - 40,000 requests/day
 *   - caching responses beyond 24 hours breaches the ToS
 *
 * We run under all three on purpose. The gap is not wasted capacity, it is the
 * margin that keeps a burst, a retry storm or a bug from ever reaching a limit
 * that Upwork could read as abuse.
 */

/** Upwork's published hard limits. Never change these to "get more headroom". */
export const UPWORK_PUBLISHED = {
  requestsPerSecond: 10,
  requestsPerDay: 40_000,
  cacheMaxAgeHours: 24,
} as const

/** What this portal actually allows itself. */
export const SELF_IMPOSED = {
  /** 60% of the per-IP ceiling. Bursts land well inside the limit. */
  requestsPerSecond: 6,

  /** Refill granularity for the token bucket. */
  burstCapacity: 6,

  /**
   * 75% of the daily cap. Beyond this the limiter refuses everything that is
   * not explicitly marked interactive, so a runaway background job cannot
   * consume the budget a person needs.
   */
  requestsPerDay: 30_000,

  /**
   * Past this, ONLY interactive (user-initiated) requests are served.
   * Background sync stops entirely.
   */
  backgroundCutoffPerDay: 20_000,

  /**
   * Rooms per background tick whose messages may be fetched purely to fill a
   * gap, on top of the rooms that actually changed.
   *
   * Sized against the cutoff, not picked by feel. Eight profiles polling once a
   * minute already spend 8 × 1440 = 11,520 requests/day of the 20,000 background
   * budget, leaving 8,480 — about 5.8 per tick. Four keeps a margin for the
   * message fetches real activity triggers, and the catch-up is finite anyway:
   * once every conversation has been observed once, this spends nothing.
   *
   * Asserted in limits.test.ts so a future increase has to argue with a test.
   */
  hydrateRoomsPerTick: 4,

  /**
   * Room-list pages a BACKGROUND tick may read per profile.
   *
   * One, and it cannot be more at a 60-second interval: a second page would take
   * eight profiles from 11,520 to 23,040 requests a day, past the 20,000 cutoff
   * before any message fetches. One page is enough for the job background sync
   * actually has — the list is newest-first and carries each conversation's
   * latest message id, so page one detects all new activity.
   */
  roomPagesBackground: 1,

  /**
   * Room-list pages an INTERACTIVE refresh may read per profile.
   *
   * Deeper, because a person is waiting and the interactive budget is 30,000
   * rather than the unattended 20,000. This is the only route by which a
   * conversation sitting past position 100 — invisible to every background tick —
   * gets into the mirror at all. Worst case per click: 8 profiles × 5 pages = 40
   * requests, under seven seconds at the 6/second limiter.
   */
  roomPagesInteractive: 5,

  /**
   * How stale the proposal list may get before it is refetched.
   *
   * Proposals change when somebody bids, which is a handful of times a day, not
   * every minute — and the whole budget argument turns on not spending a request
   * per profile per tick on data that has not moved. Hourly costs 24 calls per
   * profile per day against the 20,000 background cutoff, which rounds to
   * nothing, and the list is only used to name the job behind a conversation.
   */
  proposalRefreshMinutes: 60,

  /** Mirror rows are refetched well before the ToS ceiling. */
  cacheMaxAgeHours: 12,

  /** Consecutive 429/5xx responses before a user's circuit opens. */
  circuitBreakerThreshold: 3,

  /** How long a tripped circuit stays open. */
  circuitBreakerCooldownMs: 5 * 60_000,

  /** Ceiling on retries for one logical call. */
  maxRetries: 3,
} as const

/**
 * Tools this portal is permitted to call, and whether each mutates anything on
 * Upwork.
 *
 * This is an ALLOWLIST, not a blocklist: a tool absent from this map cannot be
 * called at all, and the call is refused before any network request happens.
 * That is what stops a bug — or a future careless edit — from ever reaching
 * `send_message` unattended.
 */
export const TOOL_POLICY = {
  // --- reads -------------------------------------------------------------
  list_accounts: { write: false },
  get_profile: { write: false },
  get_agency: { write: false },
  get_messages: { write: false },
  list_contracts: { write: false },
  list_milestones: { write: false },
  list_offers: { write: false },
  // Names the job posting behind a conversation; nothing here submits one.
  list_freelancer_proposals: { write: false },
  get_freelancer_dashboard: { write: false },
  get_agency_dashboard: { write: false },
  get_freelancer_financials: { write: false },

  // --- writes: defined, but blocked until a later phase turns them on ----
  // Every one of these requires UPWORK_ALLOW_WRITES=true *and* an explicit
  // human confirmation step in the UI. None are reachable in Phase 2.
  send_message: { write: true },

  // The attachment upload chain. Each is a write: start_attachment_upload opens
  // an upload session, store_uploaded_files puts bytes into Upwork storage, and
  // confirm_attachment_upload retains them. get_upload_status is a read but
  // belongs to the same session, so it is listed here to keep the flow together.
  start_attachment_upload: { write: true },
  store_uploaded_files: { write: true },
  get_upload_status: { write: false },
  confirm_attachment_upload: { write: true },
} as const

export type ToolName = keyof typeof TOOL_POLICY

/**
 * Upwork namespaces every tool on the wire: `list_accounts` is exposed as
 * `upwork__list_accounts`. Calling the bare name returns
 * `400 invalid tool name … invalid resource name`.
 *
 * The policy map above uses bare names because they read better and are what
 * the documentation calls them; the prefix is applied at the call site so the
 * two can never drift.
 */
export const TOOL_NAMESPACE = 'upwork__'

export function qualifiedToolName(name: ToolName): string {
  return `${TOOL_NAMESPACE}${name}`
}

export function isKnownTool(name: string): name is ToolName {
  return Object.hasOwn(TOOL_POLICY, name)
}

export function isWriteTool(name: ToolName): boolean {
  return TOOL_POLICY[name].write
}

/**
 * Which write tools are enabled, from UPWORK_ALLOWED_WRITES.
 *
 * A per-tool allowlist rather than one global boolean, so replying to a client
 * can be switched on without also arming proposal submission. Upwork's
 * automation policy calls out proposal and invite spam specifically; those two
 * capabilities deserve separate decisions.
 *
 *   UPWORK_ALLOWED_WRITES=send_message
 *   UPWORK_ALLOWED_WRITES=send_message,start_attachment_upload,store_uploaded_files,confirm_attachment_upload
 *
 * Unset means no writes at all. An unrecognised name is ignored rather than
 * silently widening the gate.
 */
export function allowedWriteTools(): Set<ToolName> {
  const raw = process.env.UPWORK_ALLOWED_WRITES ?? ''
  const enabled = new Set<ToolName>()

  for (const entry of raw.split(',')) {
    const name = entry.trim()
    if (name && isKnownTool(name) && isWriteTool(name)) enabled.add(name)
  }
  return enabled
}

export function isWriteAllowed(name: ToolName): boolean {
  return !isWriteTool(name) || allowedWriteTools().has(name)
}
