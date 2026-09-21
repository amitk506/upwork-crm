import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Append to the audit trail.
 *
 * Uses the service-role client on purpose: activity_log grants no INSERT policy
 * to authenticated users, so the trail cannot be forged or rewritten from the
 * browser. Every Upwork-facing write should land here, successful or not.
 *
 * Never throws — an audit failure must not take down the action it describes.
 */
export async function logActivity(entry: {
  actorId: string | null
  action: string
  targetType?: string
  targetId?: string
  payload?: Record<string, unknown>
  succeeded?: boolean
  error?: string
}) {
  try {
    const supabase = createAdminClient()
    await supabase.from('activity_log').insert({
      actor_id: entry.actorId,
      action: entry.action,
      target_type: entry.targetType ?? null,
      target_id: entry.targetId ?? null,
      payload: entry.payload ?? {},
      succeeded: entry.succeeded ?? true,
      error: entry.error ?? null,
    })
  } catch (err) {
    console.error('[activity] failed to record entry', entry.action, err)
  }
}
