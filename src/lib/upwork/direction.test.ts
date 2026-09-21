import assert from 'node:assert/strict'
import { test } from 'node:test'

import { addressesCounterpart, counterpartNames, inferDirection } from './direction.ts'

/** Every string below is taken from a real thread in the live inbox. */

test('extracts the counterpart name from a room title', () => {
  assert.deepEqual(counterpartNames('Max Castiel'), ['Max Castiel', 'Max'])
  // Room titles often carry a company after a comma.
  assert.deepEqual(counterpartNames('Wesley Waxer, UMT'), ['Wesley Waxer', 'Wesley'])
  assert.deepEqual(counterpartNames(null), [])
})

test('mention markup marks a message as ours', () => {
  const names = counterpartNames('William Kreitzmann')
  assert.equal(
    addressesCounterpart(
      'Hi <@424177617406902272:425230075412246528|William Kreitzmann>, have you had the chance?',
      names,
    ),
    true,
  )
  // After the transport renders the markup
  assert.equal(addressesCounterpart('@William Kreitzmann any update?', names), true)
})

test('a greeting by first name marks a message as ours', () => {
  assert.equal(addressesCounterpart('Hi William,\n\nThank you for the update', counterpartNames('William Kreitzmann')), true)
  assert.equal(addressesCounterpart('Hey Max, quick question', counterpartNames('Max Castiel')), true)
})

test('a name mid-sentence proves nothing and must not match', () => {
  // The client could easily write this about themselves in the third person, or
  // about a colleague. Only an opening address is evidence.
  assert.equal(
    addressesCounterpart('I spoke to William yesterday about the brief', counterpartNames('William Kreitzmann')),
    false,
  )
})

test('a message we recorded sending is certain, not inferred', () => {
  const result = inferDirection({
    body: 'anything at all',
    sentAt: '2026-08-13T10:00:00Z',
    sentFromPortal: true,
    roomName: 'Max Castiel',
    lastVisitedAt: '2026-08-13T12:00:00Z',
  })
  assert.deepEqual(result, { direction: 'outbound', source: 'portal_send' })
})

test('a message arriving after our last visit is inbound', () => {
  const result = inferDirection({
    body: "I'm reviewing it today.. things are positive :D",
    sentAt: '2026-08-13T18:54:00Z',
    sentFromPortal: false,
    roomName: 'William Kreitzmann',
    lastVisitedAt: '2026-08-13T09:00:00Z',
  })
  assert.deepEqual(result, { direction: 'inbound', source: 'visit_window' })
})

test('addressing the client wins over the visit window', () => {
  // Sent after our last visit, but it greets them — so it is ours, not theirs.
  const result = inferDirection({
    body: 'Hi William,\n\nThank you for the update; I appreciate it.',
    sentAt: '2026-08-13T23:24:00Z',
    sentFromPortal: false,
    roomName: 'William Kreitzmann',
    lastVisitedAt: '2026-08-13T09:00:00Z',
  })
  assert.equal(result.direction, 'outbound')
  assert.equal(result.source, 'mention')
})

test('with no signal at all it stays unknown rather than guessing', () => {
  const result = inferDirection({
    body: 'sure',
    sentAt: '2026-08-13T08:00:00Z',
    sentFromPortal: false,
    roomName: 'Max Castiel',
    lastVisitedAt: '2026-08-13T09:00:00Z',
  })
  assert.deepEqual(result, { direction: 'unknown', source: null })
})
