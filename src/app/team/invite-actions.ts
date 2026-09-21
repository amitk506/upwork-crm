'use server'

import { randomBytes } from 'node:crypto'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { requireCapability } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { logActivity } from '@/lib/activity'
import type { AppRole } from '@/lib/database.types'

const inviteSchema = z.object({
  email: z.email('That does not look like an email address'),
  fullName: z.string().trim().min(1, 'Name is required').max(120),
  role: z.enum(['owner', 'manager', 'team_lead', 'bidder']),
})

/**
 * Creates a portal account. Self-hosted GoTrue runs with signup disabled, so
 * this admin path is the only way in — which is what we want for an internal
 * tool: no open registration surface on a public hostname.
 *
 * Returns a one-time password to hand over. No SMTP is involved anywhere.
 */
export async function inviteMember(input: { email: string; fullName: string; role: AppRole }) {
  const actor = await requireCapability('team:manage')

  const parsed = inviteSchema.safeParse(input)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }
  const { email, fullName, role } = parsed.data

  // Only an owner may mint another owner.
  if (role === 'owner' && actor.role !== 'owner') {
    return { error: 'Only an owner can create another owner' }
  }

  // 18 random bytes → 24 base64url chars. Handed over once, changed on first use.
  const tempPassword = randomBytes(18).toString('base64url')

  const supabase = createAdminClient()

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true, // no SMTP available, so confirm on creation
    user_metadata: { full_name: fullName },
  })

  if (error || !data.user) {
    return { error: error?.message ?? 'Could not create the account' }
  }

  // The on_auth_user_created trigger has already inserted the app_users row as
  // a bidder (or owner, if this is the very first account). Apply the intended
  // role, and the name in case the trigger ran before metadata was readable.
  const { error: roleError } = await supabase
    .from('app_users')
    .update({ role, full_name: fullName })
    .eq('id', data.user.id)

  await logActivity({
    actorId: actor.id,
    action: 'team.member_invited',
    targetType: 'user',
    targetId: data.user.id,
    payload: { email, role },
    succeeded: !roleError,
    error: roleError?.message,
  })

  if (roleError) return { error: roleError.message }

  revalidatePath('/team')
  return { ok: true, tempPassword, email }
}

/**
 * Deactivates a member: blocks sign-in, ends their sessions, and strips every
 * grant and assignment. Reversible — the account and its history remain.
 */
export async function deactivateMember(userId: string) {
  const actor = await requireCapability('team:manage')
  if (userId === actor.id) return { error: 'You cannot deactivate yourself' }

  const supabase = createAdminClient()

  const guard = await guardLastOwner(userId)
  if (guard) return guard

  const { error } = await supabase.from('app_users').update({ is_active: false }).eq('id', userId)
  if (error) return { error: error.message }

  // Revoking is a single transaction in the database — half-removed access
  // would be worse than none.
  await supabase.rpc('revoke_member_access', { p_user_id: userId })
  await supabase.auth.admin.signOut(userId, 'global').catch(() => undefined)

  await logActivity({
    actorId: actor.id,
    action: 'team.member_deactivated',
    targetType: 'user',
    targetId: userId,
    succeeded: true,
  })

  revalidatePath('/team')
  revalidatePath('/profiles')
  return { ok: true }
}

export async function reactivateMember(userId: string) {
  const actor = await requireCapability('team:manage')

  const { error } = await createAdminClient()
    .from('app_users')
    .update({ is_active: true })
    .eq('id', userId)

  if (error) return { error: error.message }

  await logActivity({
    actorId: actor.id,
    action: 'team.member_reactivated',
    targetType: 'user',
    targetId: userId,
  })

  revalidatePath('/team')
  return {
    ok: true,
    notice: 'Reactivated. Their previous profile and chat access was removed — grant it again.',
  }
}

/** Rename a member. Email is their sign-in identity and is deliberately fixed. */
export async function updateMember(userId: string, fullName: string) {
  const actor = await requireCapability('team:manage')

  const name = fullName.trim()
  if (!name) return { error: 'Name cannot be empty' }
  if (name.length > 120) return { error: 'That name is too long' }

  const supabase = createAdminClient()

  const { error } = await supabase.from('app_users').update({ full_name: name }).eq('id', userId)
  if (error) return { error: error.message }

  // Keep the auth record in step so it survives a re-provision.
  await supabase.auth.admin
    .updateUserById(userId, { user_metadata: { full_name: name } })
    .catch(() => undefined)

  await logActivity({
    actorId: actor.id,
    action: 'team.member_renamed',
    targetType: 'user',
    targetId: userId,
    payload: { fullName: name },
  })

  revalidatePath('/team')
  return { ok: true }
}

/** Issue a new one-time password. Nothing is emailed — hand it over directly. */
export async function resetMemberPassword(userId: string) {
  const actor = await requireCapability('team:manage')

  const tempPassword = randomBytes(18).toString('base64url')
  const supabase = createAdminClient()

  const { error } = await supabase.auth.admin.updateUserById(userId, { password: tempPassword })
  if (error) return { error: error.message }

  // Existing sessions must not outlive a password they no longer know.
  await supabase.auth.admin.signOut(userId, 'global').catch(() => undefined)

  await logActivity({
    actorId: actor.id,
    action: 'team.password_reset',
    targetType: 'user',
    targetId: userId,
  })

  return { ok: true, tempPassword }
}

/**
 * Permanently delete a member. Owner-only, and irreversible: the auth record,
 * the portal row, and everything cascading from it go.
 */
export async function deleteMember(userId: string) {
  const actor = await requireCapability('roles:manage')
  if (userId === actor.id) return { error: 'You cannot delete your own account' }

  const guard = await guardLastOwner(userId)
  if (guard) return guard

  const supabase = createAdminClient()

  await supabase.rpc('revoke_member_access', { p_user_id: userId })

  // Deleting the auth user cascades to app_users, which cascades onward.
  const { error } = await supabase.auth.admin.deleteUser(userId)
  if (error) return { error: error.message }

  await logActivity({
    actorId: actor.id,
    action: 'team.member_deleted',
    targetType: 'user',
    targetId: userId,
  })

  revalidatePath('/team')
  revalidatePath('/profiles')
  return { ok: true }
}

/** An agency with no active owner cannot be administered by anyone. */
async function guardLastOwner(userId: string): Promise<{ error: string } | null> {
  const supabase = createAdminClient()

  const { data: target } = await supabase
    .from('app_users')
    .select('role')
    .eq('id', userId)
    .maybeSingle()

  if (target?.role !== 'owner') return null

  const { count } = await supabase
    .from('app_users')
    .select('id', { count: 'exact', head: true })
    .eq('role', 'owner')
    .eq('is_active', true)

  return (count ?? 0) <= 1
    ? { error: 'That is the last active owner — promote someone else first' }
    : null
}
