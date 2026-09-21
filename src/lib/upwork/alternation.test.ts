import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveByAlternation, type Attributable } from './alternation.ts'
import type { Direction, DirectionSource } from './direction.ts'

const T0 = Date.parse('2026-08-17T06:00:00Z')

/** Compact fixture: minutes from T0, plus a known direction if there is one. */
function msg(
  id: string,
  minutes: number,
  direction: Direction = 'unknown',
  source: DirectionSource = null,
  isSystem = false,
): Attributable {
  return {
    storyId: id,
    sentAt: new Date(T0 + minutes * 60_000).toISOString(),
    direction,
    directionSource: source,
    isSystem,
  }
}

const shape = (list: Attributable[]) => list.map((m) => `${m.direction}:${m.directionSource ?? '-'}`)

test('a room with nothing known is left alone', () => {
  const input = [msg('a', 0), msg('b', 30), msg('c', 90)]
  assert.deepEqual(shape(resolveByAlternation(input)), ['unknown:-', 'unknown:-', 'unknown:-'])
})

test('messages seconds after a known one adopt its side', () => {
  const out = resolveByAlternation([
    msg('a', 0, 'outbound', 'portal_send'),
    msg('b', 1),
    msg('c', 3),
  ])
  assert.deepEqual(shape(out), ['outbound:portal_send', 'outbound:burst', 'outbound:burst'])
})

test('burst propagation reaches backwards too', () => {
  const out = resolveByAlternation([msg('a', 0), msg('b', 2), msg('c', 4, 'inbound', 'visit_window')])
  assert.deepEqual(shape(out), ['inbound:burst', 'inbound:burst', 'inbound:visit_window'])
})

test('a real pause flips the turn', () => {
  const out = resolveByAlternation([msg('a', 0, 'outbound', 'mention'), msg('b', 120)])
  assert.deepEqual(shape(out), ['outbound:mention', 'inbound:alternation'])
})

test('two pauses flip back', () => {
  const out = resolveByAlternation([
    msg('a', 0, 'outbound', 'mention'),
    msg('b', 120),
    msg('c', 300),
  ])
  assert.deepEqual(shape(out), ['outbound:mention', 'inbound:alternation', 'outbound:alternation'])
})

test('a gap under the turn threshold keeps the same side', () => {
  // 10 minutes: past the burst window, short of a turn change.
  const out = resolveByAlternation([msg('a', 0, 'inbound', 'visit_window'), msg('b', 10)])
  assert.deepEqual(shape(out), ['inbound:visit_window', 'inbound:alternation'])
})

test('guessing stops after the flip cap', () => {
  const out = resolveByAlternation([
    msg('a', 0, 'outbound', 'mention'),
    msg('b', 60),
    msg('c', 120),
    msg('d', 180),
    msg('e', 240),
    msg('f', 300),
  ])
  // Four flips is past MAX_FLIPS, so the tail is left unknown rather than guessed.
  assert.deepEqual(shape(out).slice(4), ['unknown:-', 'unknown:-'])
})

test('system rows belong to neither side and never take a turn', () => {
  const out = resolveByAlternation([
    msg('a', 0, 'outbound', 'portal_send'),
    // "Milestone submitted" lands between two lines someone typed.
    msg('sys', 1, 'unknown', null, true),
    msg('b', 2),
  ])
  // The system row is passed through untouched, and crucially it does not sit
  // between 'a' and 'b' in the turn order — so 'b' still bursts off 'a' instead
  // of being treated as the reply to a milestone notification.
  assert.deepEqual(shape(out), ['outbound:portal_send', 'unknown:-', 'outbound:burst'])
})

test('an inference never becomes the anchor for the next inference', () => {
  // Anchors are snapshotted, so 'd' is measured from the real anchor at index 0
  // (three pauses → one flip parity), not from the guess at 'c'.
  const out = resolveByAlternation([
    msg('a', 0, 'inbound', 'visit_window'),
    msg('b', 60),
    msg('c', 120),
    msg('d', 180),
  ])
  assert.deepEqual(shape(out), [
    'inbound:visit_window',
    'outbound:alternation',
    'inbound:alternation',
    'outbound:alternation',
  ])
})

test('the nearest anchor wins, whichever side it is on', () => {
  const out = resolveByAlternation([
    msg('a', 0, 'outbound', 'mention'),
    msg('b', 400),
    msg('c', 401, 'inbound', 'visit_window'),
  ])
  // 'b' is one minute before a known inbound, so it bursts with it.
  assert.deepEqual(shape(out), ['outbound:mention', 'inbound:burst', 'inbound:visit_window'])
})

test('messages with no timestamp are skipped, not mangled', () => {
  const out = resolveByAlternation([
    { storyId: 'a', sentAt: null, direction: 'unknown', directionSource: null },
    msg('b', 0, 'outbound', 'portal_send'),
  ])
  assert.deepEqual(shape(out), ['unknown:-', 'outbound:portal_send'])
})

test('already-resolved rooms are returned unchanged, by reference', () => {
  const input = [msg('a', 0, 'outbound', 'portal_send'), msg('b', 1, 'outbound', 'burst')]
  assert.equal(resolveByAlternation(input), input)
})

test('a full realistic thread resolves the last message, which is what the meter needs', () => {
  const out = resolveByAlternation([
    msg('c1', 0, 'outbound', 'mention'), // we opened with "Hi Sarah,"
    msg('c2', 2), // …and added a line
    msg('c3', 180), // she replies
    msg('c4', 181), // twice, a minute later
    msg('c5', 600), // we answer
    msg('c6', 900), // she comes back — nobody has replied since
  ])
  assert.deepEqual(shape(out), [
    'outbound:mention',
    'outbound:burst',
    'inbound:alternation',
    // c4 sits a minute after c3, but c3 was still unknown when the burst pass
    // ran, so c4 is reached by alternation instead. That is the right label: a
    // burst off a guessed anchor is still a guess, and confidence must not be
    // laundered upward by proximity.
    'inbound:alternation',
    'outbound:alternation',
    'inbound:alternation',
  ])
  assert.equal(out.at(-1)!.direction, 'inbound')
})

test('a human correction anchors the messages around it', () => {
  // The point of seeding corrections before the pass: fixing one message should
  // repair its burst and the turns either side, not just itself. Otherwise
  // someone has to correct six messages by hand where Upwork told us nothing.
  const out = resolveByAlternation([
    msg('a', 0, 'outbound', 'corrected'), // a person said "this was us"
    msg('b', 1), // same burst
    msg('c', 200), // a turn later
  ])
  assert.deepEqual(shape(out), ['outbound:corrected', 'outbound:burst', 'inbound:alternation'])
})

test('a correction is never overwritten by the pass it seeded', () => {
  const out = resolveByAlternation([
    msg('a', 0, 'inbound', 'visit_window'),
    msg('b', 200, 'outbound', 'corrected'),
    msg('c', 400),
  ])
  assert.equal(out[1]!.direction, 'outbound')
  assert.equal(out[1]!.directionSource, 'corrected')
})
