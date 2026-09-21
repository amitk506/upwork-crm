/**
 * Reading Upwork's list responses, whichever shape they are in today.
 *
 * Pure and dependency-free so it can be tested against real captured payloads —
 * which is the whole point. On 21 Aug 2026 list_rooms changed from a
 * GraphQL-style connection to a flat array:
 *
 *   was  { data: { roomList: { edges: [{ node }], pageInfo } } }
 *   now  { data: { rooms: [ … ] }, hasMore, next_cursor }
 *
 * The reader found no `edges`, returned an empty list, and raised nothing. Sync
 * reported "0 changed" every minute and the inbox froze for nine hours while
 * every health check passed. Defensive parsing turned a loud failure into a
 * silent one.
 */

export type Unknown = Record<string, unknown>

export function asRecord(value: unknown): Unknown {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Unknown) : {}
}

export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export type ListResult = {
  nodes: Unknown[]
  endCursor: string | null
  hasNextPage: boolean
}

/**
 * `key` names the connection in the old shape, `flatKey` the array in the new.
 * Both are tried, so a rollback on Upwork's side does not break us again.
 */
export function listOf(payload: unknown, key: string, flatKey?: string): ListResult {
  const root = asRecord(payload)
  const data = asRecord(root.data)
  const name = flatKey ?? key

  const flat = arr(data[name] ?? root[name])
    .map(asRecord)
    .filter((item) => Object.keys(item).length > 0)

  if (flat.length > 0) {
    return { nodes: flat, endCursor: str(root.next_cursor), hasNextPage: root.hasMore === true }
  }

  const container = asRecord(data[key] ?? root[key])
  const nodes = arr(container.edges)
    .map((edge) => asRecord(asRecord(edge).node))
    .filter((node) => Object.keys(node).length > 0)
  const pageInfo = asRecord(container.pageInfo)

  return {
    nodes,
    endCursor: str(pageInfo.endCursor) ?? str(root.next_cursor),
    hasNextPage: pageInfo.hasNextPage === true || root.hasMore === true,
  }
}

/**
 * Upwork now sends times as epoch milliseconds in a string where it used to send
 * ISO 8601. A digits-only string is treated as millis; anything else passes
 * through unchanged for Postgres to parse.
 */
export function toIso(value: unknown): string | null {
  const raw = str(value)
  if (!raw) return null
  if (/^\d{10,}$/.test(raw)) {
    const at = new Date(Number(raw))
    return Number.isNaN(at.getTime()) ? null : at.toISOString()
  }
  return raw
}

/**
 * Upwork reports money three different ways in the same feature: a plain number,
 * a `{ rawValue, currency }` object, and a formatted string. find_jobs search
 * returns the client's lifetime spend as "$5,574.97" while find_jobs get returns
 * "5574.97" for the same client, so a reader that only handles numbers records
 * null for one of them and a scorer then treats a $5.5k client as unproven.
 *
 * Returns null rather than 0 for anything unparseable: an unknown spend and a
 * zero spend are different facts, and only one of them should count against a
 * client.
 */
export function parseMoney(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null

  const raw = str(value)
  if (!raw) return null

  // Strip currency symbols, thousands separators and whitespace; keep the sign
  // and a single decimal point.
  const cleaned = raw.replace(/[^0-9.-]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null

  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/**
 * Upwork wraps anything a client typed in <untrusted_participant_content> tags.
 *
 * The tags are an instruction to the reader, not part of the posting, so they
 * come off before the text is stored or shown. What they mark stays true after
 * they are gone: a job description is a stranger's writing that this portal
 * displays and scores. It is never followed as direction, by a person or by
 * anything downstream of one.
 */
export function unwrapUntrusted(value: unknown): string | null {
  const raw = str(value)
  if (!raw) return null

  const text = raw
    .replace(/<\/?untrusted_participant_content>/gi, '')
    .trim()

  return text.length > 0 ? text : null
}
