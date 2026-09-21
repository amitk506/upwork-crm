'use server'

import { createClient as createRawClient } from '@supabase/supabase-js'

import { requireUser } from '@/lib/auth'
import { logActivity } from '@/lib/activity'
import { clientEnv } from '@/lib/env'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * Changing your own password.
 *
 * The current password is verified first, against a throwaway client so the
 * check cannot disturb the live session. Without that step a hijacked session
 * could lock the real owner out of their own account, which is exactly the
 * situation a password change is supposed to protect against.
 */
export async function changeOwnPassword(input: {
  currentPassword: string
  newPassword: string
}) {
  const user = await requireUser()

  const current = input.currentPassword
  const next = input.newPassword

  if (!current || !next) return { error: 'Fill in both fields' }
  if (next.length < 10) return { error: 'Use at least 10 characters' }
  if (next === current) return { error: 'That is your current password' }

  // Isolated client: no session persistence, so verifying cannot sign anyone
  // in or out anywhere else.
  const probe = createRawClient(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const { error: wrongPassword } = await probe.auth.signInWithPassword({
    email: user.email,
    password: current,
  })

  if (wrongPassword) {
    await logActivity({
      actorId: user.id,
      action: 'account.password_change_refused',
      succeeded: false,
      error: 'current password did not match',
    })
    return { error: 'That is not your current password' }
  }

  const { error } = await createAdminClient().auth.admin.updateUserById(user.id, {
    password: next,
  })

  if (error) return { error: error.message }

  await logActivity({
    actorId: user.id,
    action: 'account.password_changed',
    succeeded: true,
  })

  // Deliberately NOT signing out other sessions: a routine password change on a
  // shared-office machine should not boot the person off their phone. An owner
  // can force that from Team if an account is actually compromised.
  return { ok: true }
}
