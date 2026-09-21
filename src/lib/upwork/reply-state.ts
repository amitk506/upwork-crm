import type { Direction, DirectionSource } from './direction'

/**
 * Reducing a room's messages to the one thing the wait meter needs.
 *
 * This exists as its own module because of a constraint, not for tidiness.
 * Upwork's terms forbid caching their responses beyond 24 hours, so
 * up_messages is expired on a schedule — and sync only re-fetches a room whose
 * latest message id changed. A conversation that has gone quiet therefore loses
 * its messages and never gets them back, which is precisely the conversation
 * where somebody has been waiting a long time.
 *
 * What survives is this: a timestamp, an attribution label and two counts. No
 * bodies, no message ids, nothing that constitutes holding an Upwork response.
 * It is a fact the portal derived, stored in the portal's own zone, so the meter
 * can say "waiting 26 hours" without the cache having to remember anything.
 */

export type SpokenMessage = {
  sentAt: string | null
  direction: Direction
  directionSource: DirectionSource
  isSystem?: boolean
}

export type ReplyStateRow = {
  room_id: string
  awaiting_since: string | null
  attribution: string | null
  last_outbound_at: string | null
  message_count: number
  all_unknown: boolean
  observed_at: string
}

export function replyStateRow(
  roomId: string,
  messages: SpokenMessage[],
  observedAt: Date = new Date(),
): ReplyStateRow {
  // System rows — milestone submitted, contract ended — belong to neither side,
  // so they must not count as anybody having replied.
  const spoken = messages
    .filter((m) => !m.isSystem && m.sentAt)
    .sort((a, b) => (a.sentAt ?? '').localeCompare(b.sentAt ?? ''))

  const lastInbound = findLast(spoken, (m) => m.direction === 'inbound')
  const lastOutboundAt = findLast(spoken, (m) => m.direction === 'outbound')?.sentAt ?? null

  // Compared as ISO strings, which sort correctly for the UTC timestamps Upwork
  // returns and avoids a Date round-trip per message.
  const awaiting =
    lastInbound?.sentAt && (!lastOutboundAt || lastOutboundAt < lastInbound.sentAt)
      ? lastInbound
      : null

  return {
    room_id: roomId,
    awaiting_since: awaiting?.sentAt ?? null,
    attribution: awaiting?.directionSource ?? null,
    last_outbound_at: lastOutboundAt,
    message_count: spoken.length,
    all_unknown: spoken.length > 0 && spoken.every((m) => m.direction === 'unknown'),
    observed_at: observedAt.toISOString(),
  }
}

function findLast<T>(list: T[], predicate: (item: T) => boolean): T | null {
  for (let i = list.length - 1; i >= 0; i--) {
    if (predicate(list[i]!)) return list[i]!
  }
  return null
}
