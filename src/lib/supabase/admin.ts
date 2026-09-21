import 'server-only'

import { createClient } from '@supabase/supabase-js'

import { clientEnv, serverEnv } from '@/lib/env'
import type { Database } from '@/lib/database.types'

/**
 * Service-role client. BYPASSES RLS — use only where that is the point:
 *   - the sync worker writing the Upwork mirror
 *   - reading/writing upwork_connections (the token vault, which grants no
 *     policies to authenticated users at all)
 *   - writing activity_log entries
 *
 * Never import this from a client component, and never hand its results
 * straight to the browser without filtering by the caller's own permissions.
 */
/**
 * Turns a Supabase error into something a human can act on.
 *
 * A PostgREST 404 from a stale schema cache arrives with NO `message`, which
 * previously surfaced as "Could not store the profile: undefined" — true, and
 * useless. Anything reported to a user should name the likely cause.
 */
export function describeDbError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'unknown database error'

  const e = error as { message?: string; code?: string; details?: string; hint?: string }
  if (e.message) return e.message

  if (e.code === 'PGRST205' || e.code === '404') {
    return 'the API layer does not know this table yet — reload the PostgREST schema cache'
  }

  const parts = [e.code, e.details, e.hint].filter(Boolean)
  return parts.length > 0
    ? parts.join(' · ')
    : 'the API layer rejected the request without a message (usually a stale PostgREST schema cache after a migration)'
}

export function createAdminClient() {
  return createClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    serverEnv().SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: { autoRefreshToken: false, persistSession: false },
    },
  )
}
