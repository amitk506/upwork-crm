import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { SELF_IMPOSED, UPWORK_PUBLISHED } from './limits'
import { UpworkPolicyError } from './types'

/**
 * Keeps this portal inside Upwork's limits.
 *
 * Upwork enforces 10 req/s PER IP — not per user and not per app. So the
 * relevant bucket is the process, not the caller: every user's traffic shares
 * one throttle. Deploying to a single fixed-IP host (see docs/02-architecture)
 * is what makes that model correct.
 *
 * Two independent gates:
 *   1. a token bucket at 6 req/s, well under the 10 req/s ceiling
 *   2. a daily budget read from Postgres, capped at 30k of the published 40k,
 *      with background work cut off far earlier at 20k so it can never starve
 *      a person waiting on a screen
 */

type Priority = 'interactive' | 'background'

// ---------------------------------------------------------------------------
// Token bucket (per process === per IP)
// ---------------------------------------------------------------------------
let tokens: number = SELF_IMPOSED.burstCapacity
let lastRefill = Date.now()

function refill() {
  const now = Date.now()
  const elapsedSec = (now - lastRefill) / 1000
  if (elapsedSec <= 0) return
  tokens = Math.min(
    SELF_IMPOSED.burstCapacity,
    tokens + elapsedSec * SELF_IMPOSED.requestsPerSecond,
  )
  lastRefill = now
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits until a request slot is free. Never rejects — it only delays. */
async function takeToken(): Promise<void> {
  for (;;) {
    refill()
    if (tokens >= 1) {
      tokens -= 1
      return
    }
    // Time until the next whole token, plus a little jitter so concurrent
    // callers do not all wake and fire on the same millisecond.
    const waitMs = ((1 - tokens) / SELF_IMPOSED.requestsPerSecond) * 1000
    await sleep(Math.ceil(waitMs) + Math.floor(Math.random() * 25))
  }
}

// ---------------------------------------------------------------------------
// Daily budget
// ---------------------------------------------------------------------------
// Read from Postgres, cached briefly: checking per request would add a round
// trip to every call, but a stale-by-minutes number could overshoot the cap.
let budgetCache: { value: number; at: number } | null = null
const BUDGET_TTL_MS = 10_000

async function requestsToday(): Promise<number> {
  if (budgetCache && Date.now() - budgetCache.at < BUDGET_TTL_MS) {
    return budgetCache.value
  }

  const supabase = createAdminClient()
  const { data, error } = await supabase.rpc('sync_budget_today')

  if (error) {
    // Fail closed-ish: if we cannot read the budget we assume we are near the
    // background cutoff, so background work stops but a person can still work.
    console.error('[upwork] could not read daily budget', error.message)
    return SELF_IMPOSED.backgroundCutoffPerDay
  }

  const value = typeof data === 'number' ? data : 0
  budgetCache = { value, at: Date.now() }
  return value
}

/** Force the next budget check to hit the database. */
export function invalidateBudgetCache() {
  budgetCache = null
}

async function recordSpend(endpoint: string, opts: { error?: boolean; throttled?: boolean } = {}) {
  const supabase = createAdminClient()
  const { error } = await supabase.rpc('bump_sync_budget', {
    p_endpoint: endpoint,
    p_requests: 1,
    p_errors: opts.error ? 1 : 0,
    p_throttled: opts.throttled ? 1 : 0,
  })
  if (error) console.error('[upwork] could not record spend', error.message)

  // Keep the cached figure moving between refreshes rather than under-counting.
  if (budgetCache) budgetCache.value += 1
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Runs `fn` inside both gates. Throws UpworkPolicyError *before* `fn` is called
 * when the daily budget is spent — no request reaches Upwork in that case.
 */
export async function withRateLimit<T>(
  endpoint: string,
  priority: Priority,
  fn: () => Promise<T>,
): Promise<T> {
  const spent = await requestsToday()

  const ceiling =
    priority === 'background' ? SELF_IMPOSED.backgroundCutoffPerDay : SELF_IMPOSED.requestsPerDay

  if (spent >= ceiling) {
    throw new UpworkPolicyError(
      priority === 'background'
        ? `Background sync paused: ${spent} requests today, cutoff is ${ceiling} ` +
          `(Upwork's published cap is ${UPWORK_PUBLISHED.requestsPerDay}).`
        : `Daily request budget reached (${spent}/${ceiling}). Resets at midnight UTC.`,
      'daily_budget_exhausted',
    )
  }

  await takeToken()

  try {
    const result = await fn()
    await recordSpend(endpoint)
    return result
  } catch (err) {
    const throttled = err instanceof Error && err.message.includes('429')
    await recordSpend(endpoint, { error: true, throttled })
    throw err
  }
}

/** Exposed for the ops screen. */
export async function budgetStatus() {
  const spent = await requestsToday()
  return {
    spent,
    selfImposedDailyCap: SELF_IMPOSED.requestsPerDay,
    backgroundCutoff: SELF_IMPOSED.backgroundCutoffPerDay,
    upworkPublishedCap: UPWORK_PUBLISHED.requestsPerDay,
    percentOfSelfImposed: Math.round((spent / SELF_IMPOSED.requestsPerDay) * 100),
    percentOfUpwork: Math.round((spent / UPWORK_PUBLISHED.requestsPerDay) * 100),
    backgroundAllowed: spent < SELF_IMPOSED.backgroundCutoffPerDay,
  }
}
