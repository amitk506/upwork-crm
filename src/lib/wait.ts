/**
 * The wait meter.
 *
 * Every other inbox sorts by recency and flags unread. Neither is the question
 * an agency asks. The question is who is waiting on us, and for how long — so
 * this module turns "the client spoke last, at time T" into a severity the
 * whole interface reads from.
 *
 * The one non-obvious rule: the clock pauses overnight. A client in Chicago
 * writing at 2 AM their time lands at 12:30 PM IST — fine — but one writing at
 * 6 PM Chicago lands at 4:30 AM IST, and if the meter ran through the night
 * every such message would be "Late" before anyone had a chance to see it. A
 * ramp that cries wolf gets ignored, and an ignored ramp is worse than none.
 *
 * IST has no DST and a fixed +05:30 offset, which is the only reason this can
 * be plain arithmetic rather than a timezone library.
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** The agency is not expected to answer between these IST hours. */
export const QUIET_FROM_HOUR = 22
export const QUIET_UNTIL_HOUR = 8

export type WaitLevel = 'fresh' | 'watch' | 'late' | 'breached'

/**
 * Past this, a conversation is dormant rather than waiting.
 *
 * Without it the meter counted threads whose last client message was in 2022 —
 * the departure board opened on "613d 10h", which is true and useless. A client
 * who wrote thirteen months ago and never heard back is not someone to answer
 * today; they are a conversation that ended. Counting them inflates the one
 * number the whole product asks people to trust, and a board full of them is a
 * board nobody reads.
 *
 * Thirty days is deliberately generous for an agency inbox: anything genuinely
 * live gets touched inside a month. Dormant rooms are not hidden — they still
 * appear under All, and they still say the client spoke last — they simply stop
 * counting as work outstanding.
 */
export const DORMANT_AFTER_DAYS = 30

/** Thresholds in *counted* seconds, so overnight never pushes a row over. */
export const WAIT_THRESHOLDS = {
  watch: 2 * 3600,
  late: 6 * 3600,
  breached: 24 * 3600,
} as const

export const WAIT_LEVEL_LABEL: Record<WaitLevel, string> = {
  fresh: 'Fresh',
  watch: 'Watch',
  late: 'Late',
  breached: 'Breached',
}

/**
 * UTC milliseconds of the IST midnight that opens the day containing `ms`.
 *
 * Exported because "today" has to mean the same thing everywhere in this
 * product — the wait ramp's quiet hours and the board's reply counts both hinge
 * on it, and a board that rolls over at UTC midnight would reset at 5:30 AM
 * while the team is asleep and then double-count the previous evening.
 */
export function istDayStart(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS
}

/** Alias kept for the local quiet-hours arithmetic below. */
const istMidnight = istDayStart

/**
 * The current IST day's opening instant, as an ISO string for a query filter.
 *
 * Reading the clock lives here rather than in a page body: a server component
 * that calls Date.now() directly trips React's purity rule, and the rule is
 * right that "now" is not a render-stable value. Keeping it in this module puts
 * it alongside the rest of the day arithmetic it has to agree with.
 */
export function istTodayStartISO(now: Date = new Date()): string {
  return new Date(istDayStart(now.getTime())).toISOString()
}

function overlap(aFrom: number, aTo: number, bFrom: number, bTo: number): number {
  return Math.max(0, Math.min(aTo, bTo) - Math.max(aFrom, bFrom))
}

/**
 * Seconds the agency has actually been sitting on this, with overnight removed.
 *
 * Walks the quiet windows (each IST day's 22:00 → next 08:00, ten hours) that
 * could touch the interval. Windows never overlap each other, so subtracting
 * each one's intersection cannot double-count.
 */
export function countedWaitSeconds(since: Date | string, now: Date = new Date()): number {
  const from = typeof since === 'string' ? Date.parse(since) : since.getTime()
  const to = now.getTime()
  if (!Number.isFinite(from) || to <= from) return 0

  let quiet = 0
  // Start a day early: `from` may fall inside the previous night's window.
  for (let day = istMidnight(from) - DAY_MS; day <= istMidnight(to); day += DAY_MS) {
    quiet += overlap(from, to, day + QUIET_FROM_HOUR * HOUR_MS, day + DAY_MS + QUIET_UNTIL_HOUR * HOUR_MS)
  }

  return Math.max(0, Math.round((to - from - quiet) / 1000))
}

export function waitLevel(countedSeconds: number): WaitLevel {
  if (countedSeconds >= WAIT_THRESHOLDS.breached) return 'breached'
  if (countedSeconds >= WAIT_THRESHOLDS.late) return 'late'
  if (countedSeconds >= WAIT_THRESHOLDS.watch) return 'watch'
  return 'fresh'
}

/**
 * Compact and always two units at most: "41m", "7h 41m", "2d 4h".
 *
 * Minutes are dropped past a day because at that scale nobody cares, and a
 * three-part string stops being scannable in a 336px column.
 */
export function formatWait(countedSeconds: number): string {
  const total = Math.max(0, Math.floor(countedSeconds / 60))
  if (total < 60) return `${total}m`

  const hours = Math.floor(total / 60)
  if (hours < 24) {
    const minutes = total % 60
    return minutes === 0 ? `${hours}h` : `${hours}h ${String(minutes).padStart(2, '0')}m`
  }

  const days = Math.floor(hours / 24)
  const rest = hours % 24
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`
}

export type WaitState =
  | {
      awaiting: false
      unknown: boolean
      repliedAt: string | null
      /** The client spoke last, but so long ago that it is not live work. */
      dormant?: boolean
      dormantSince?: string | null
      /**
       * Someone decided this one needs no answer. Distinct from "answered": the
       * client did speak last, we just are not going to reply — so the interface
       * says so rather than showing nothing, which would look like a sync gap.
       */
      waived?: boolean
      waivedAt?: string | null
    }
  | {
      awaiting: true
      unknown: false
      since: string
      seconds: number
      level: WaitLevel
      label: string
      /**
       * True when the only reason we believe the client spoke last is the
       * turn-taking guess in alternation.ts. The meter shows these differently:
       * a ramp that invents waiting clients gets ignored, and an ignored ramp is
       * worse than no ramp.
       */
       inferred: boolean
    }

/**
 * Everything a row needs to render its meter, from the two facts v_room_wait
 * supplies. Kept as one call so a row can never show a stripe whose colour
 * disagrees with its figure.
 */
export function waitState(
  row: {
    awaiting_reply: boolean | null
    waiting_since: string | null
    last_outbound_at: string | null
    waiting_source?: string | null
    direction_unknown: boolean | null
    waived?: boolean | null
    waived_at?: string | null
  } | null | undefined,
  now: Date = new Date(),
): WaitState {
  if (!row || !row.awaiting_reply || !row.waiting_since) {
    return {
      awaiting: false,
      unknown: Boolean(row?.direction_unknown),
      repliedAt: row?.last_outbound_at ?? null,
    }
  }

  // A waiver only holds for the message it was granted for; the view has already
  // checked that it still matches. So this needs no expiry of its own — a newer
  // client message revives the timer by moving what the waiver was pinned to.
  if (row.waived) {
    return {
      awaiting: false,
      unknown: false,
      repliedAt: row.last_outbound_at ?? null,
      waived: true,
      waivedAt: row.waived_at ?? null,
    }
  }

  // Elapsed wall-clock, not counted time: dormancy is about the calendar, and a
  // year of discounted nights would still be a year.
  const elapsedDays = (now.getTime() - Date.parse(row.waiting_since)) / 86_400_000
  if (elapsedDays > DORMANT_AFTER_DAYS) {
    return {
      awaiting: false,
      unknown: false,
      repliedAt: row.last_outbound_at ?? null,
      dormant: true,
      dormantSince: row.waiting_since,
    }
  }

  const seconds = countedWaitSeconds(row.waiting_since, now)
  const level = waitLevel(seconds)
  return {
    awaiting: true,
    unknown: false,
    since: row.waiting_since,
    seconds,
    level,
    label: formatWait(seconds),
    inferred: row.waiting_source === 'alternation',
  }
}

/** Sort key: longest wait first, then anything answered, oldest activity last. */
export function waitSortKey(state: WaitState): number {
  return state.awaiting ? -state.seconds : Number.MAX_SAFE_INTEGER
}


/**
 * Mean of the waits currently outstanding.
 *
 * Deliberately NOT "median time to first reply", which is the figure a manager
 * dashboard usually leads with: the portal keeps no reply history, because
 * Upwork's terms cap how long their message data may be held and only the
 * derived reply state survives. Inventing that number from what is left would be
 * guesswork presented as a measurement. This is the real thing we know — how long
 * the people waiting right now have been waiting.
 */
export function averageWaitSeconds(states: WaitState[]): number | null {
  const waits = states.filter((s) => s.awaiting).map((s) => (s.awaiting ? s.seconds : 0))
  if (waits.length === 0) return null
  return Math.round(waits.reduce((total, s) => total + s, 0) / waits.length)
}

/**
 * An ISO timestamp N days back, for windowed queries.
 *
 * Lives here rather than in a page for the same reason as istTodayStartISO():
 * reading the clock inside a server component trips React's purity rule, and the
 * rule is right that "now" is not render-stable.
 */
export function sinceDaysAgoISO(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString()
}
