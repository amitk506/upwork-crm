import 'server-only'

import { redirect } from 'next/navigation'

import { createClient } from '@/lib/supabase/server'
import { can, type Capability } from '@/lib/permissions'
import type { AppUser } from '@/lib/database.types'

/** The signed-in portal user, or null. Never throws. */
export async function getCurrentUser(): Promise<AppUser | null> {
  const supabase = await createClient()

  // getUser() revalidates against the auth server. Do not trust getSession()
  // for authorization — its payload comes from a cookie the client controls.
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data } = await supabase.from('app_users').select('*').eq('id', user.id).single()
  return (data as AppUser | null) ?? null
}

/** Require a signed-in, active user. Redirects to /login otherwise. */
export async function requireUser(): Promise<AppUser> {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!user.is_active) redirect('/login?error=deactivated')
  return user
}

/**
 * Require a specific capability. Redirects to the dashboard if the user lacks
 * it. Capability-based rather than rank-based, so that a role can be given more
 * of one thing without inheriting everything below it — see lib/permissions.ts.
 */
export async function requireCapability(capability: Capability): Promise<AppUser> {
  const user = await requireUser()
  if (!can(user, capability)) redirect('/?error=forbidden')
  return user
}

export { can } from '@/lib/permissions'
