import assert from 'node:assert/strict'
import { test } from 'node:test'

import { listOf, parseMoney, toIso, unwrapUntrusted } from './payload.ts'

/** Captured from the live API on 21 Aug 2026, the day the shape changed. */
const NEW_ROOMS = {
  data: {
    rooms: [
      {
        contractId: '42496564',
        contractStatus: 'ACTIVE',
        id: 'room_22aad0217ae47c538a2154bdd9f0c5a0',
        lastActivity: '1787301658006',
        latestStory: { created: '1787301658006', id: 'story_a096771e', message: 'Hexo: hello' },
        numUnread: 0,
        numUsers: 2,
        roomName: 'Hexo Electrical Testing',
        roomType: 'INTERVIEW',
      },
    ],
  },
  hasMore: true,
  next_cursor: '1785175543389',
  status: 'ok',
}

/** The connection shape it served until then, and still uses for messages. */
const OLD_ROOMS = {
  data: {
    roomList: {
      edges: [{ node: { id: 'room_old', roomName: 'Older Client', numUnread: 3 } }],
      pageInfo: { endCursor: 'cursor_old', hasNextPage: false },
    },
  },
}

test('the new flat shape is read, with its own paging fields', () => {
  const { nodes, endCursor, hasNextPage } = listOf(NEW_ROOMS, 'roomList', 'rooms')
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0]!.id, 'room_22aad0217ae47c538a2154bdd9f0c5a0')
  assert.equal(endCursor, '1785175543389')
  assert.equal(hasNextPage, true)
})

test('the old connection shape still works', () => {
  const { nodes, endCursor, hasNextPage } = listOf(OLD_ROOMS, 'roomList', 'rooms')
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0]!.roomName, 'Older Client')
  assert.equal(endCursor, 'cursor_old')
  assert.equal(hasNextPage, false)
})

test('an empty response yields nothing rather than throwing', () => {
  // It must still be *possible* to get zero — the caller decides whether zero is
  // alarming. What must not happen is a shape change silently looking like zero,
  // which is why both readers are tried above.
  for (const payload of [null, {}, { data: {} }, { data: { rooms: [] } }, 'nonsense']) {
    const r = listOf(payload, 'roomList', 'rooms')
    assert.deepEqual(r.nodes, [])
    assert.equal(r.hasNextPage, false)
  }
})

test('a shape neither reader understands returns empty, not a crash', () => {
  const r = listOf({ data: { conversations: [{ id: 'x' }] } }, 'roomList', 'rooms')
  assert.deepEqual(r.nodes, [])
})

test('epoch-millis strings become ISO, ISO passes through', () => {
  assert.equal(toIso('1787301658006'), '2026-08-21T08:40:58.006Z')
  assert.equal(toIso('2026-08-19T07:04:37.211Z'), '2026-08-19T07:04:37.211Z')
  assert.equal(toIso('2025-11-07T15:21:59+0000'), '2025-11-07T15:21:59+0000')
})

test('rubbish timestamps become null rather than Invalid Date', () => {
  assert.equal(toIso(null), null)
  assert.equal(toIso(''), null)
  assert.equal(toIso(undefined), null)
  assert.equal(toIso(1787301658006), null) // a number, not the string Upwork sends
  assert.equal(toIso('99999999999999999999'), null)
})

// ---------------------------------------------------------------------------
// Money. Both spellings below are real: the first is what find_jobs search
// returned for client 3001321 on 2 Sep 2026, the second what find_jobs get
// returned for the same client in the same minute.
// ---------------------------------------------------------------------------

test('a formatted money string parses to the same number as a bare one', () => {
  assert.equal(parseMoney('$5,574.97'), 5574.97)
  assert.equal(parseMoney('5574.97'), 5574.97)
  assert.equal(parseMoney(5574.97), 5574.97)
})

test('zero spend is zero, unknown spend is null — they are different facts', () => {
  assert.equal(parseMoney('$0.00'), 0)
  assert.equal(parseMoney(null), null)
  assert.equal(parseMoney(undefined), null)
  assert.equal(parseMoney(''), null)
  assert.equal(parseMoney('n/a'), null)
})

test('money that is not a number does not become one', () => {
  assert.equal(parseMoney('$'), null)
  assert.equal(parseMoney('.'), null)
  assert.equal(parseMoney(Number.NaN), null)
})

test('the untrusted wrapper comes off, the text it wrapped does not', () => {
  const wrapped =
    '<untrusted_participant_content>\nI run a digital marketing agency.\n</untrusted_participant_content>'
  assert.equal(unwrapUntrusted(wrapped), 'I run a digital marketing agency.')
})

test('text with no wrapper is returned unchanged, and empty stays null', () => {
  assert.equal(unwrapUntrusted('plain description'), 'plain description')
  assert.equal(unwrapUntrusted('<untrusted_participant_content></untrusted_participant_content>'), null)
  assert.equal(unwrapUntrusted(null), null)
})
