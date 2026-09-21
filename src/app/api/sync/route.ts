import { NextResponse, type NextRequest } from 'next/server'

import { serverEnv } from '@/lib/env'
import { safeEqual } from '@/lib/crypto'
import { logActivity } from '@/lib/activity'
import { expireMirror, syncAllProfiles } from '@/lib/upwork/sync'
import { runEndOfDayCheck } from '@/lib/reply-misses'
import { istHourOf } from '@/lib/holidays'
import { budgetStatus } from '@/lib/upwork/rate-limiter'

/**
 * The unattended sync tick.
 *
 * Called on a timer by the `sync` container, not by a browser, so it
 * authenticates with a shared secret rather than a session. Runs at background
 * priority: it stops at a lower daily ceiling than interactive work, so the
 * loop can never eat the budget someone waiting on a page needs.
 */

// A tick that overruns must not stack on top of the next one. Upwork's rate
// limit is per IP, so two overlapping passes would double the burst for no gain.
let running = false
let lastRunAt = 0

export async function POST(request: NextRequest) {
  const secret = serverEnv().SYNC_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'SYNC_SECRET is not configured' }, { status: 503 })
  }

  const provided = request.headers.get('x-sync-key') ?? ''
  if (!safeEqual(provided, secret)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  if (running) {
    return NextResponse.json({ skipped: 'a sync is already in progress' }, { status: 202 })
  }

  // Cheap guard against a misconfigured timer hammering this.
  const since = Date.now() - lastRunAt
  if (since < 20_000) {
    return NextResponse.json({ skipped: `last run ${Math.round(since / 1000)}s ago` }, { status: 202 })
  }

  running = true
  const startedAt = Date.now()

  try {
    const result = await syncAllProfiles('background')

    // Enforce the cache ceiling on the same tick; it costs no API calls.
    await expireMirror().catch(() => undefined)

    // The end-of-day check, once per night. Fired from the sync tick rather than
    // a second cron so there is one timer to reason about — it costs no Upwork
    // requests and does nothing for all but a few minutes of the day.
    //
    // The window is the first quarter-hour after IST midnight: wide enough that a
    // missed tick or a slow pass does not skip a night, and the unique constraint
    // on (miss_date, room_id) makes running twice harmless.
    const istHour = istHourOf(new Date())
    const istMinute = new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCMinutes()
    if (istHour === 0 && istMinute < 15) {
      const misses = await runEndOfDayCheck().catch((err) => ({
        date: 'unknown',
        examined: 0,
        recorded: 0,
        reason: err instanceof Error ? err.message : String(err),
      }))

      if (misses.recorded > 0 || misses.reason) {
        await logActivity({
          actorId: null,
          action: 'review.end_of_day',
          payload: { ...misses },
          succeeded: !misses.reason,
          error: misses.reason,
        })
      }
    }


    lastRunAt = Date.now()
    const budget = await budgetStatus().catch(() => null)

    // Only record ticks that did something or went wrong — a quiet minute
    // every minute would bury the audit trail in noise.
    if (result.messages > 0 || result.failures.length > 0 || result.skipped.length > 0) {
      await logActivity({
        actorId: null,
        action: 'sync.tick',
        payload: { ...result, durationMs: Date.now() - startedAt },
        succeeded: result.failures.length === 0,
        error: result.failures.join(' · ') || undefined,
      })
    }

    return NextResponse.json({
      ...result,
      durationMs: Date.now() - startedAt,
      budget: budget
        ? { spent: budget.spent, backgroundAllowed: budget.backgroundAllowed }
        : null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logActivity({ actorId: null, action: 'sync.tick_failed', succeeded: false, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  } finally {
    running = false
  }
}

/** Lets the cron container check the endpoint is alive without syncing. */
export async function GET() {
  const budget = await budgetStatus().catch(() => null)
  return NextResponse.json({ ok: true, running, lastRunAt: lastRunAt || null, budget })
}
