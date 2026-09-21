'use server'

import { revalidatePath } from 'next/cache'

import { requireCapability } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { logActivity } from '@/lib/activity'
import type { AppRole } from '@/lib/database.types'

import { ALL_ROLES } from '@/lib/permissions'

export async function updateRole(userId: string, role: AppRole) {
  const actor = await requireCapability('roles:manage')

  if (!ALL_ROLES.includes(role)) return { error: 'Unknown role' }
  if (userId === actor.id) return { error: 'You cannot change your own role' }

  // RLS and the guard_role_changes trigger enforce this server-side too —
  // the checks above just produce a friendlier message.
  const supabase = await createClient()
  const { error } = await supabase.from('app_users').update({ role }).eq('id', userId)

  await logActivity({
    actorId: actor.id,
    action: 'team.role_changed',
    targetType: 'user',
    targetId: userId,
    payload: { role },
    succeeded: !error,
    error: error?.message,
  })

  if (error) return { error: error.message }

  revalidatePath('/team')
  return { ok: true }
}
