import assert from 'node:assert/strict'
import { test } from 'node:test'

import { istDateOf, istHourOf, isWorkingDay } from './holidays.ts'

const holidays = new Set(['2026-08-15', '2026-10-02', '2026-11-08'])

test('weekends are not working days', () => {
  assert.equal(isWorkingDay('2026-08-22', holidays), false) // Saturday
  assert.equal(isWorkingDay('2026-08-23', holidays), false) // Sunday
  assert.equal(isWorkingDay('2026-08-24', holidays), true) // Monday
})

test('holidays from HR are not working days', () => {
  assert.equal(isWorkingDay('2026-10-02', holidays), false) // Gandhi Jayanti
  assert.equal(isWorkingDay('2026-10-01', holidays), true)
})

test('a holiday that falls on a weekend is still simply not a working day', () => {
  // 15 Aug 2026 is a Saturday and Independence Day. Both rules agree; the point
  // is that neither double-counts or contradicts.
  assert.equal(isWorkingDay('2026-08-15', holidays), false)
})

test('the IST day is not the UTC day in the evening', () => {
  // 18:30 UTC is 00:00 IST the next day — the exact boundary the nightly job
  // runs on, and the one an off-by-one would silently ruin.
  assert.equal(istDateOf(new Date('2026-08-18T18:29:00Z')), '2026-08-18')
  assert.equal(istDateOf(new Date('2026-08-18T18:30:00Z')), '2026-08-19')
})

test('IST hours are read off the same offset', () => {
  assert.equal(istHourOf(new Date('2026-08-18T17:29:00Z')), 22) // 22:59 IST
  assert.equal(istHourOf(new Date('2026-08-18T17:30:00Z')), 23) // 23:00 IST
  assert.equal(istHourOf(new Date('2026-08-18T18:30:00Z')), 0)
})
