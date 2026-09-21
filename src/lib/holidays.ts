/**
 * The company's non-working days.
 *
 * Read from an HR system rather than kept here, when one is configured: someone
 * already maintains that list for leave and attendance, and a second copy would
 * drift — a portal that thinks a public holiday is a working day would log
 * misses against people who were at home, which is exactly the kind of
 * unfairness this feature has to avoid.
 *
 * HOLIDAYS_URL is optional. Unset, the end-of-day check is skipped entirely
 * rather than run without the list: no detection is much better than detections
 * nobody trusts. When set, it is fetched with ?year=YYYY and expected to return
 * a JSON array of { date: 'yyyy-mm-dd', name, type }.
 */

export type Holiday = { date: string; name: string; type: string }

export class HolidaysUnavailable extends Error {
  constructor(cause: string) {
    super(`Could not read the holiday list from HR: ${cause}`)
    this.name = 'HolidaysUnavailable'
  }
}

/** ISO dates (yyyy-mm-dd) of every holiday in the given IST year. */
export async function fetchHolidays(year: number, url: string | undefined): Promise<Set<string>> {
  // The URL is passed in rather than read from env here, so this module stays
  // free of server imports and its date arithmetic can be unit-tested.
  if (!url) throw new HolidaysUnavailable('HOLIDAYS_URL is not configured')

  let payload: unknown
  try {
    const response = await fetch(`${url}?year=${year}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    payload = await response.json()
  } catch (err) {
    throw new HolidaysUnavailable(err instanceof Error ? err.message : String(err))
  }

  if (!Array.isArray(payload)) throw new HolidaysUnavailable('unexpected response shape')

  return new Set(
    payload
      .map((row) => (row as Holiday)?.date)
      .filter((d): d is string => typeof d === 'string')
      // The API returns full timestamps; only the calendar day matters.
      .map((d) => d.slice(0, 10)),
  )
}

/**
 * Was this an IST working day?
 *
 * Saturday and Sunday are treated as the weekend. If the agency ever works
 * Saturdays this is the one line to change — and it should change here rather
 * than by adding every Saturday to the HR holiday list.
 */
export function isWorkingDay(istDate: string, holidays: Set<string>): boolean {
  if (holidays.has(istDate)) return false
  // Parsed as UTC midnight, which is safe: we only want the day of week of a
  // date that is already expressed in IST.
  const day = new Date(`${istDate}T00:00:00Z`).getUTCDay()
  return day !== 0 && day !== 6
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

/** The IST calendar day a moment falls on, as yyyy-mm-dd. */
export function istDateOf(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10)
}

/** The IST wall-clock hour of a moment, 0–23. */
export function istHourOf(at: Date): number {
  return new Date(at.getTime() + IST_OFFSET_MS).getUTCHours()
}
