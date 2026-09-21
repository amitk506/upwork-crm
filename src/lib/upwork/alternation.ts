import type { Direction, DirectionSource } from './direction'

/**
 * Filling in the messages Upwork left unattributed.
 *
 * Upwork's MCP returns no author, so direction.ts infers it per message from
 * three signals. On real data those resolve about a quarter of messages: a
 * conversation the team has already read produces no `visit_window` hits at all,
 * because nothing in it is newer than the last visit. That leaves the inbox
 * unable to say whether anyone is waiting — which is the one thing it exists to
 * say.
 *
 * This pass works on a whole room at once and propagates outward from the
 * messages whose side we do know. Two rules, in order of how much they can be
 * trusted:
 *
 *   burst       — a message sent seconds after one we can attribute is the same
 *                 person still typing. People send follow-up lines; they do not
 *                 hand the keyboard over mid-thought. Strong.
 *
 *   alternation — past a real pause, assume the turn changed. This is the guess,
 *                 and it is wrong precisely when a client sends two messages an
 *                 hour apart with no reply in between. So it is capped at a few
 *                 flips from a known anchor, tagged as 'alternation', and the UI
 *                 renders anything resting on it as approximate.
 *
 * Nothing here calls Upwork. It reads rows the portal already holds, so it costs
 * no requests against the rate limit and no cache age against their terms.
 */

/** Consecutive lines from one person. Deliberately tight. */
export const BURST_MS = 6 * 60 * 1000
/** A pause long enough that the other side probably spoke next. */
export const TURN_GAP_MS = 20 * 60 * 1000
/** Error compounds with every flip, so stop guessing before it is worthless. */
export const MAX_FLIPS = 3

export type Attributable = {
  storyId: string
  sentAt: string | null
  direction: Direction
  directionSource: DirectionSource
  isSystem?: boolean
}

function flip(direction: Direction): Direction {
  if (direction === 'inbound') return 'outbound'
  if (direction === 'outbound') return 'inbound'
  return 'unknown'
}

function flipTimes(direction: Direction, times: number): Direction {
  return times % 2 === 0 ? direction : flip(direction)
}

function ms(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/**
 * Returns a new list with unknown directions filled in where they can be.
 *
 * The input must be a single room's messages in ascending time order. System
 * rows (milestone submitted, contract ended) are passed through untouched and
 * excluded from the turn-taking, because they belong to neither side and would
 * otherwise be counted as somebody's turn.
 */
export function resolveByAlternation<T extends Attributable>(messages: T[]): T[] {
  const conversational = messages.filter((m) => !m.isSystem)
  if (conversational.length === 0) return messages
  if (!conversational.some((m) => m.direction !== 'unknown')) return messages

  const working = conversational.map((m) => ({
    direction: m.direction,
    source: m.directionSource,
    at: ms(m.sentAt),
  }))

  // ---- burst propagation, to a fixed point -------------------------------
  // Repeated because a run of three messages a minute apart should all adopt
  // from the one anchor at its end, not just the message adjacent to it.
  for (let pass = 0; pass < working.length; pass++) {
    let changed = false

    for (let i = 0; i < working.length; i++) {
      const cell = working[i]!
      if (cell.direction !== 'unknown' || cell.at === null) continue

      const prev = working[i - 1]
      const next = working[i + 1]
      const prevGap =
        prev && prev.direction !== 'unknown' && prev.at !== null ? cell.at - prev.at : null
      const nextGap =
        next && next.direction !== 'unknown' && next.at !== null ? next.at - cell.at : null

      const usePrev =
        prevGap !== null && prevGap <= BURST_MS && (nextGap === null || prevGap <= nextGap)
      const useNext = nextGap !== null && nextGap <= BURST_MS && !usePrev

      if (usePrev) {
        cell.direction = prev!.direction
        cell.source = 'burst'
        changed = true
      } else if (useNext) {
        cell.direction = next!.direction
        cell.source = 'burst'
        changed = true
      }
    }

    if (!changed) break
  }

  // ---- alternation from the nearest anchor -------------------------------
  // Snapshot the anchors first: propagating off a value this same pass produced
  // would let one guess seed the next and drift without bound.
  // 'corrected' is a person telling us; it anchors like a portal send does.
  const anchors = working.map((c) => (c.source === 'alternation' ? null : c.direction))

  for (let i = 0; i < working.length; i++) {
    const cell = working[i]!
    if (cell.direction !== 'unknown') continue
    // No timestamp means it cannot be placed in the turn order at all. Adopting
    // a neighbour's side here would be a coin flip wearing a source label.
    if (cell.at === null) continue

    const resolved = fromNearestAnchor(working, anchors, i)
    if (resolved) {
      cell.direction = resolved
      cell.source = 'alternation'
    }
  }

  // ---- stitch back -------------------------------------------------------
  const updates = new Map<string, { direction: Direction; source: DirectionSource }>()
  conversational.forEach((m, i) => {
    const cell = working[i]!
    if (cell.direction !== m.direction || cell.source !== m.directionSource) {
      updates.set(m.storyId, { direction: cell.direction, source: cell.source })
    }
  })

  if (updates.size === 0) return messages

  return messages.map((m) => {
    const update = updates.get(m.storyId)
    return update ? { ...m, direction: update.direction, directionSource: update.source } : m
  })
}

/** Walk left then right for a known message, flipping once per real pause. */
function fromNearestAnchor(
  working: { direction: Direction; at: number | null }[],
  anchors: (Direction | null)[],
  index: number,
): Direction | null {
  const here = working[index]!.at

  for (const step of [-1, 1] as const) {
    let flips = 0
    let previousAt = here

    for (let i = index + step; i >= 0 && i < working.length; i += step) {
      const cell = working[i]!
      if (cell.at !== null && previousAt !== null && Math.abs(cell.at - previousAt) > TURN_GAP_MS) {
        flips++
      }
      if (cell.at !== null) previousAt = cell.at

      const anchor = anchors[i]
      if (anchor && anchor !== 'unknown') {
        return flips <= MAX_FLIPS ? flipTimes(anchor, flips) : null
      }
    }
  }

  return null
}
