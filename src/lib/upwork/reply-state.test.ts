import assert from 'node:assert/strict'
import { test } from 'node:test'

import { replyStateRow, type SpokenMessage } from './reply-state.ts'
import type { Direction, DirectionSource } from './direction.ts'

const OBSERVED = new Date('2026-08-17T12:00:00Z')

function m(
  minutes: number,
  direction: Direction,
  source: DirectionSource = null,
  isSystem = false,
): SpokenMessage {
  return {
    sentAt: new Date(Date.parse('2026-08-17T06:00:00Z') + minutes * 60_000).toISOString(),
    direction,
    directionSource: source,
    isSystem,
  }
}

test('the client spoke last, so they are waiting', () => {
  const row = replyStateRow('r1', [m(0, 'outbound', 'portal_send'), m(60, 'inbound', 'burst')], OBSERVED)
  assert.equal(row.awaiting_since, m(60, 'inbound').sentAt)
  assert.equal(row.attribution, 'burst')
  assert.equal(row.last_outbound_at, m(0, 'outbound').sentAt)
})

test('we spoke last, so nobody is waiting', () => {
  const row = replyStateRow('r1', [m(0, 'inbound', 'burst'), m(60, 'outbound', 'portal_send')], OBSERVED)
  assert.equal(row.awaiting_since, null)
  assert.equal(row.attribution, null)
})

test('the wait starts at the last of a burst, not the first', () => {
  // A client sending three lines is waiting from the point they stopped.
  const row = replyStateRow(
    'r1',
    [m(0, 'inbound', 'visit_window'), m(2, 'inbound', 'burst'), m(4, 'inbound', 'burst')],
    OBSERVED,
  )
  assert.equal(row.awaiting_since, m(4, 'inbound').sentAt)
})

test('order in the input does not matter', () => {
  const forwards = replyStateRow('r1', [m(0, 'outbound'), m(60, 'inbound', 'burst')], OBSERVED)
  const backwards = replyStateRow('r1', [m(60, 'inbound', 'burst'), m(0, 'outbound')], OBSERVED)
  assert.deepEqual(forwards, backwards)
})

test('a system row is never treated as somebody replying', () => {
  // "Milestone submitted" arriving after the client's question must not make the
  // conversation look answered — that is the bug that hides a waiting client.
  const row = replyStateRow(
    'r1',
    [m(0, 'inbound', 'visit_window'), m(30, 'outbound', 'portal_send', true)],
    OBSERVED,
  )
  assert.equal(row.awaiting_since, m(0, 'inbound').sentAt)
  assert.equal(row.message_count, 1)
})

test('unknown messages neither create nor clear a wait', () => {
  const row = replyStateRow('r1', [m(0, 'unknown'), m(60, 'unknown')], OBSERVED)
  assert.equal(row.awaiting_since, null)
  assert.equal(row.all_unknown, true)
  assert.equal(row.message_count, 2)
})

test('all_unknown is false as soon as one message is attributed', () => {
  const row = replyStateRow('r1', [m(0, 'unknown'), m(60, 'inbound', 'burst')], OBSERVED)
  assert.equal(row.all_unknown, false)
})

test('an empty room is answered, not unknown', () => {
  const row = replyStateRow('r1', [], OBSERVED)
  assert.equal(row.awaiting_since, null)
  assert.equal(row.all_unknown, false)
  assert.equal(row.message_count, 0)
})

test('messages with no timestamp are ignored', () => {
  const row = replyStateRow(
    'r1',
    [{ sentAt: null, direction: 'inbound', directionSource: 'burst' }, m(0, 'outbound')],
    OBSERVED,
  )
  assert.equal(row.message_count, 1)
  assert.equal(row.awaiting_since, null)
})

test('the attribution of the waiting message is what gets stored', () => {
  // The UI reads this to decide whether to draw the meter as approximate, so it
  // must be the source of the unanswered message specifically — not the room's
  // best or worst signal.
  const row = replyStateRow(
    'r1',
    [m(0, 'inbound', 'visit_window'), m(30, 'outbound', 'mention'), m(60, 'inbound', 'alternation')],
    OBSERVED,
  )
  assert.equal(row.attribution, 'alternation')
})

test('observed_at records when the portal last confirmed this', () => {
  const row = replyStateRow('r1', [m(0, 'inbound', 'burst')], OBSERVED)
  assert.equal(row.observed_at, '2026-08-17T12:00:00.000Z')
})
