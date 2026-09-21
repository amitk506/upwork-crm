/**
 * Dates and times, always in the agency's timezone.
 *
 * Two problems this solves:
 *
 *   1. Server components ran with the container's timezone (UTC), so every
 *      server-rendered timestamp was 5½ hours behind for an India-based team.
 *   2. `toLocaleString()` with no arguments resolves differently on the server
 *      and in the browser, so the same timestamp could render two ways — which
 *      also risks a React hydration mismatch.
 *
 * Pinning both the locale and the timezone makes the output identical wherever
 * it is produced, and correct for the people reading it.
 */

export const AGENCY_TIME_ZONE = 'Asia/Kolkata'
const LOCALE = 'en-IN'

type DateInput = string | number | Date | null | undefined

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/** Intl formatters are expensive to construct; build each one once. */
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: AGENCY_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
})

const dateFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: AGENCY_TIME_ZONE,
  day: '2-digit',
  month: 'short',
  year: 'numeric',
})

const timeFmt = new Intl.DateTimeFormat(LOCALE, {
  timeZone: AGENCY_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
})

const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: AGENCY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** "14 Aug 2026, 03:41 pm" */
export function formatDateTime(value: DateInput, fallback = '—'): string {
  const date = toDate(value)
  return date ? dateTimeFmt.format(date) : fallback
}

/** "14 Aug 2026" */
export function formatDate(value: DateInput, fallback = ''): string {
  const date = toDate(value)
  return date ? dateFmt.format(date) : fallback
}

/** "03:41 pm" */
export function formatTime(value: DateInput, fallback = ''): string {
  const date = toDate(value)
  return date ? timeFmt.format(date) : fallback
}

/**
 * Short form for a message list: the time for today, the date for anything
 * older. "Today" means today in IST, not in UTC — which is why the day key is
 * computed through the same timezone rather than from the raw timestamp.
 */
export function formatListStamp(value: DateInput, fallback = ''): string {
  const date = toDate(value)
  if (!date) return fallback
  return dayKeyFmt.format(date) === dayKeyFmt.format(new Date())
    ? timeFmt.format(date)
    : dateFmt.format(date)
}
