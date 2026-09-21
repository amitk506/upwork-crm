import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  countedWaitSeconds,
  formatWait,
  waitLevel,
  waitSortKey,
  waitState,
  WAIT_THRESHOLDS,
  averageWaitSeconds,
  DORMANT_AFTER_DAYS,
  istTodayStartISO,
  istDayStart,
} from './wait.ts'

/** IST is +05:30, so 08:00 IST is 02:30Z and 22:00 IST is 16:30Z. */
const ist = (iso: string) => new Date(`${iso}+05:30`)

test('daytime waits are counted straight through', () => {
  assert.equal(countedWaitSeconds(ist('2026-08-17T10:00:00'), ist('2026-08-17T13:30:00')), 3.5 * 3600)
})

test('overnight is not counted', () => {
  // 21:00 → 09:00 IST spans the whole 22:00–08:00 window: 12h elapsed, 2h counted.
  assert.equal(countedWaitSeconds(ist('2026-08-16T21:00:00'), ist('2026-08-17T09:00:00')), 2 * 3600)
})

test('a message arriving mid-night starts counting at 8 AM', () => {
  // 4:30 AM IST — a 6 PM Chicago message. By 9 AM only one hour is owed.
  assert.equal(countedWaitSeconds(ist('2026-08-17T04:30:00'), ist('2026-08-17T09:00:00')), 3600)
})

test('a full night inside the window counts nothing', () => {
  assert.equal(countedWaitSeconds(ist('2026-08-16T23:00:00'), ist('2026-08-17T02:00:00')), 0)
})

test('multiple nights each get discounted', () => {
  // 3 days elapsed = 72h, minus three 10h nights = 42h.
  assert.equal(
    countedWaitSeconds(ist('2026-08-14T12:00:00'), ist('2026-08-17T12:00:00')),
    42 * 3600,
  )
})

test('the clock never runs backwards', () => {
  assert.equal(countedWaitSeconds(ist('2026-08-17T12:00:00'), ist('2026-08-17T09:00:00')), 0)
  assert.equal(countedWaitSeconds('not a date', ist('2026-08-17T09:00:00')), 0)
})

test('a night that is skipped entirely does not over-subtract', () => {
  // 08:00 → 22:00 same day touches neither window.
  assert.equal(countedWaitSeconds(ist('2026-08-17T08:00:00'), ist('2026-08-17T22:00:00')), 14 * 3600)
})

test('levels sit exactly on their thresholds', () => {
  assert.equal(waitLevel(0), 'fresh')
  assert.equal(waitLevel(WAIT_THRESHOLDS.watch - 1), 'fresh')
  assert.equal(waitLevel(WAIT_THRESHOLDS.watch), 'watch')
  assert.equal(waitLevel(WAIT_THRESHOLDS.late), 'late')
  assert.equal(waitLevel(WAIT_THRESHOLDS.breached), 'breached')
  assert.equal(waitLevel(WAIT_THRESHOLDS.breached * 4), 'breached')
})

test('a breach needs more than 24 wall-clock hours because nights are free', () => {
  // 24h elapsed across one night is only 14h counted — deliberately not a breach.
  const seconds = countedWaitSeconds(ist('2026-08-16T12:00:00'), ist('2026-08-17T12:00:00'))
  assert.equal(waitLevel(seconds), 'late')
})

test('wait formats to at most two units', () => {
  assert.equal(formatWait(41 * 60), '41m')
  assert.equal(formatWait(0), '0m')
  assert.equal(formatWait(3600), '1h')
  assert.equal(formatWait(7 * 3600 + 41 * 60), '7h 41m')
  assert.equal(formatWait(9 * 3600 + 5 * 60), '9h 05m')
  assert.equal(formatWait(52 * 3600), '2d 4h')
  assert.equal(formatWait(48 * 3600), '2d')
})

test('an answered room reports no wait', () => {
  const state = waitState({
    awaiting_reply: false,
    waiting_since: null,
    last_outbound_at: '2026-08-17T06:00:00Z',
    direction_unknown: false,
  })
  assert.equal(state.awaiting, false)
  assert.equal(state.awaiting === false && state.repliedAt, '2026-08-17T06:00:00Z')
})

test('a room with no decidable direction says so rather than guessing', () => {
  const state = waitState({
    awaiting_reply: false,
    waiting_since: null,
    last_outbound_at: null,
    direction_unknown: true,
  })
  assert.equal(state.awaiting, false)
  assert.equal(state.awaiting === false && state.unknown, true)
})

test('a missing row is answered, not urgent', () => {
  assert.equal(waitState(null).awaiting, false)
  assert.equal(waitState(undefined).awaiting, false)
})

test('awaiting rooms carry a level and a label together', () => {
  const state = waitState(
    {
      awaiting_reply: true,
      waiting_since: ist('2026-08-17T08:00:00').toISOString(),
      last_outbound_at: null,
      direction_unknown: false,
    },
    ist('2026-08-17T15:41:00'),
  )
  assert.equal(state.awaiting, true)
  assert.equal(state.awaiting === true && state.level, 'late')
  assert.equal(state.awaiting === true && state.label, '7h 41m')
})

test('longest wait sorts first and answered rooms sink', () => {
  const long = waitState(
    { awaiting_reply: true, waiting_since: ist('2026-08-17T09:00:00').toISOString(), last_outbound_at: null, direction_unknown: false },
    ist('2026-08-17T17:00:00'),
  )
  const short = waitState(
    { awaiting_reply: true, waiting_since: ist('2026-08-17T16:00:00').toISOString(), last_outbound_at: null, direction_unknown: false },
    ist('2026-08-17T17:00:00'),
  )
  const done = waitState({ awaiting_reply: false, waiting_since: null, last_outbound_at: null, direction_unknown: false })

  const order = [done, short, long].sort((a, b) => waitSortKey(a) - waitSortKey(b))
  assert.deepEqual(order, [long, short, done])
})

test('a wait resting on the turn-taking guess is flagged as inferred', () => {
  const row = {
    awaiting_reply: true,
    waiting_since: ist('2026-08-17T08:00:00').toISOString(),
    last_outbound_at: null,
    direction_unknown: false,
  }
  const guessed = waitState({ ...row, waiting_source: 'alternation' }, ist('2026-08-17T15:41:00'))
  const known = waitState({ ...row, waiting_source: 'visit_window' }, ist('2026-08-17T15:41:00'))

  assert.equal(guessed.awaiting === true && guessed.inferred, true)
  assert.equal(known.awaiting === true && known.inferred, false)
  // Same figure either way — confidence changes how it is drawn, not the maths.
  assert.equal(guessed.awaiting === true && guessed.label, '7h 41m')
})

test('a missing waiting_source is treated as known, not guessed', () => {
  const state = waitState(
    {
      awaiting_reply: true,
      waiting_since: ist('2026-08-17T08:00:00').toISOString(),
      last_outbound_at: null,
      direction_unknown: false,
    },
    ist('2026-08-17T12:00:00'),
  )
  assert.equal(state.awaiting === true && state.inferred, false)
})

test('the IST day starts at 18:30 UTC the previous evening', () => {
  // A board that rolled over at UTC midnight would reset at 5:30 AM local, while
  // the team is asleep, and double-count the evening before.
  const start = istDayStart(ist('2026-08-17T14:00:00').getTime())
  assert.equal(new Date(start).toISOString(), '2026-08-16T18:30:00.000Z')

  // A moment just after IST midnight belongs to the new day.
  const justAfter = istDayStart(ist('2026-08-17T00:05:00').getTime())
  assert.equal(new Date(justAfter).toISOString(), '2026-08-16T18:30:00.000Z')

  // And just before it, to the old one.
  const justBefore = istDayStart(ist('2026-08-16T23:55:00').getTime())
  assert.equal(new Date(justBefore).toISOString(), '2026-08-15T18:30:00.000Z')
})

test('average wait ignores answered conversations', () => {
  const at = (iso: string) => ({
    awaiting_reply: true,
    waiting_since: ist(iso).toISOString(),
    last_outbound_at: null,
    direction_unknown: false,
  })
  const now = ist('2026-08-17T16:00:00')

  const states = [
    waitState(at('2026-08-17T14:00:00'), now), // 2h
    waitState(at('2026-08-17T12:00:00'), now), // 4h
    waitState({ awaiting_reply: false, waiting_since: null, last_outbound_at: null, direction_unknown: false }),
  ]

  assert.equal(averageWaitSeconds(states), 3 * 3600)
})

test('average wait is null when nobody is waiting', () => {
  assert.equal(averageWaitSeconds([]), null)
  assert.equal(
    averageWaitSeconds([
      waitState({ awaiting_reply: false, waiting_since: null, last_outbound_at: null, direction_unknown: false }),
    ]),
    null,
  )
})

test('istTodayStartISO agrees with the day arithmetic the ramp uses', () => {
  assert.equal(istTodayStartISO(ist('2026-08-17T14:00:00')), '2026-08-16T18:30:00.000Z')
  assert.equal(istTodayStartISO(ist('2026-08-17T00:01:00')), '2026-08-16T18:30:00.000Z')
})

test('a waived conversation stops counting but says why', () => {
  const state = waitState(
    {
      awaiting_reply: true,
      waiting_since: ist('2026-08-16T09:00:00').toISOString(),
      last_outbound_at: null,
      direction_unknown: false,
      waived: true,
      waived_at: ist('2026-08-16T10:00:00').toISOString(),
    },
    ist('2026-08-17T16:00:00'),
  )

  assert.equal(state.awaiting, false)
  assert.equal(state.awaiting === false && state.waived, true)
  // Not reported as unknown — we know exactly who spoke last, we just are not
  // answering. Confusing the two would make it look like a sync gap.
  assert.equal(state.awaiting === false && state.unknown, false)
})

test('a waiver that no longer matches the newest message does not suppress', () => {
  // The view resolves the pinning; when it reports waived=false the timer runs
  // normally even though waived_at is still set on the row.
  const state = waitState(
    {
      awaiting_reply: true,
      waiting_since: ist('2026-08-17T09:00:00').toISOString(),
      last_outbound_at: null,
      direction_unknown: false,
      waived: false,
      waived_at: ist('2026-08-16T10:00:00').toISOString(),
    },
    ist('2026-08-17T16:00:00'),
  )

  assert.equal(state.awaiting, true)
  assert.equal(state.awaiting === true && state.level, 'late')
})

test('waived conversations sink below the ones still waiting', () => {
  const waiting = waitState(
    { awaiting_reply: true, waiting_since: ist('2026-08-17T15:00:00').toISOString(), last_outbound_at: null, direction_unknown: false },
    ist('2026-08-17T16:00:00'),
  )
  const waived = waitState(
    { awaiting_reply: true, waiting_since: ist('2026-08-16T09:00:00').toISOString(), last_outbound_at: null, direction_unknown: false, waived: true },
    ist('2026-08-17T16:00:00'),
  )

  assert.ok(waitSortKey(waiting) < waitSortKey(waived))
})

test('a waived room is not counted in the average wait', () => {
  const rows = [
    waitState(
      { awaiting_reply: true, waiting_since: ist('2026-08-17T14:00:00').toISOString(), last_outbound_at: null, direction_unknown: false },
      ist('2026-08-17T16:00:00'),
    ),
    waitState(
      { awaiting_reply: true, waiting_since: ist('2026-08-15T09:00:00').toISOString(), last_outbound_at: null, direction_unknown: false, waived: true },
      ist('2026-08-17T16:00:00'),
    ),
  ]
  assert.equal(averageWaitSeconds(rows), 2 * 3600)
})

test('a conversation nobody answered a year ago is dormant, not urgent', () => {
  const state = waitState(
    {
      awaiting_reply: true,
      waiting_since: ist('2024-12-20T16:16:00').toISOString(),
      last_outbound_at: null,
      direction_unknown: false,
    },
    ist('2026-08-18T12:00:00'),
  )
  assert.equal(state.awaiting, false)
  assert.equal(state.awaiting === false && state.dormant, true)
})

test('the dormancy cutoff is the documented one', () => {
  assert.equal(DORMANT_AFTER_DAYS, 30)
})

test('the dormancy line is drawn on the calendar, not on counted hours', () => {
  const at = (iso: string) =>
    waitState(
      { awaiting_reply: true, waiting_since: ist(iso).toISOString(), last_outbound_at: null, direction_unknown: false },
      ist('2026-08-18T12:00:00'),
    )

  // 29 days back: still waiting, and firmly breached.
  const live = at('2026-07-20T12:00:00')
  assert.equal(live.awaiting, true)
  assert.equal(live.awaiting === true && live.level, 'breached')

  // 31 days back: dormant.
  assert.equal(at('2026-07-18T11:00:00').awaiting, false)
})

test('dormant rooms drop out of the counts a board reports', () => {
  const rows = [
    waitState(
      { awaiting_reply: true, waiting_since: ist('2026-08-18T09:00:00').toISOString(), last_outbound_at: null, direction_unknown: false },
      ist('2026-08-18T12:00:00'),
    ),
    waitState(
      { awaiting_reply: true, waiting_since: ist('2023-01-01T09:00:00').toISOString(), last_outbound_at: null, direction_unknown: false },
      ist('2026-08-18T12:00:00'),
    ),
  ]
  assert.equal(rows.filter((r) => r.awaiting).length, 1)
  assert.equal(averageWaitSeconds(rows), 3 * 3600)
})
