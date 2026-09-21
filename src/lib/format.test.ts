import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AGENCY_TIME_ZONE, formatDate, formatDateTime, formatTime } from './format.ts'

/**
 * These pin the timezone, not the exact wording. The bug being guarded against
 * is a server rendering timestamps in UTC while the team reads them as IST.
 */

// 14 Aug 2026, 10:47:08 UTC  →  16:17 IST the same day (UTC+05:30)
const SAMPLE = '2026-08-14T10:47:08.000Z'

test('formats in IST, not the machine timezone', () => {
  const out = formatTime(SAMPLE)
  assert.match(out, /4:17|04:17/, `expected 4:17 pm IST, got "${out}"`)
  assert.match(out.toLowerCase(), /pm/)
})

test('a late-evening UTC timestamp lands on the NEXT day in IST', () => {
  // 23:00 UTC on the 14th is 04:30 on the 15th in India — the case that makes
  // a naive UTC render show the wrong date entirely.
  assert.match(formatDate('2026-08-14T23:00:00.000Z'), /15 Aug 2026/)
})

test('date and datetime agree with each other', () => {
  assert.match(formatDate(SAMPLE), /14 Aug 2026/)
  assert.match(formatDateTime(SAMPLE), /14 Aug 2026/)
})

test('null and invalid input fall back instead of rendering "Invalid Date"', () => {
  assert.equal(formatDateTime(null), '—')
  assert.equal(formatDateTime(undefined), '—')
  assert.equal(formatDateTime(''), '—')
  assert.equal(formatDateTime('not a date'), '—')
  assert.equal(formatDate(null), '')
  assert.equal(formatTime(null, 'n/a'), 'n/a')
})

test('the timezone constant is the one the team actually works in', () => {
  assert.equal(AGENCY_TIME_ZONE, 'Asia/Kolkata')
})
