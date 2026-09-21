import { AppShell } from '@/components/app-shell'
import { ConnectProfile } from '@/components/connect-profile'
import { ProfileCard } from '@/components/profile-card'
import { Notice } from '@/components/ui'
import { requireCapability } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { createClient } from '@/lib/supabase/server'

/**
 * The agency's Upwork profiles, held centrally by the portal.
 *
 * An owner connects each profile once and then grants team members access to
 * the profiles or individual chats they handle. Members never authenticate to
 * Upwork themselves.
 */
export default async function ProfilesPage() {
  const user = await requireCapability('team:manage')
  // The member's own client, not the service role. v_profiles is staff-only
  // (migration 0020), and it decides that with is_staff(), which reads
  // auth.uid() — the service role has none, so reading this page through the
  // admin client returned zero rows and the page rendered "no profiles
  // connected" on a portal holding four. app_users and profile_grants both carry
  // SELECT policies for authenticated, so nothing here needs to bypass RLS.
  const supabase = await createClient()

  const [{ data: profiles, error: profilesError }, { data: members }, { data: grants }] =
    await Promise.all([
    supabase.from('v_profiles').select('*').order('label'),
    supabase.from('app_users').select('id, full_name, email, role').eq('is_active', true),
    supabase.from('profile_grants').select('profile_id, user_id, can_send'),
  ])

  const list = profiles ?? []
  const grantsByProfile = new Map<string, { user_id: string; can_send: boolean }[]>()
  for (const g of grants ?? []) {
    const existing = grantsByProfile.get(g.profile_id) ?? []
    existing.push({ user_id: g.user_id, can_send: g.can_send })
    grantsByProfile.set(g.profile_id, existing)
  }

  return (
    <AppShell user={user}>
      <h1 className="text-2xl font-semibold tracking-tight">Upwork profiles</h1>
      <p className="mt-1 max-w-2xl text-sm text-soft">
        Every Upwork profile the agency runs, connected once and held by the portal. Grant a member
        a whole profile, or just the conversations they handle — they sign into the portal and
        work, without an Upwork login of their own.
      </p>

      <div className="mt-6">
        <ConnectProfile />
      </div>

      {/* An empty state must never stand in for a failure. That is precisely how
          a stale PostgREST schema cache and, later, the wrong Supabase client
          both presented themselves as "no profiles connected" — a confident
          answer to a question the page could not actually answer. */}
      {profilesError ? (
        <div className="mt-6">
          <Notice tone="stop">
            The profile list could not be loaded, so this page cannot say whether any are
            connected. {profilesError.message}
          </Notice>
        </div>
      ) : list.length === 0 ? (
        <div className="mt-6 rounded-[--radius] border bg-surface p-6 text-sm text-soft">
          No profiles connected yet. Add the first one above — you will need whoever holds that
          Upwork account to complete the consent step.
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {list.map((profile) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              members={members ?? []}
              grants={grantsByProfile.get(profile.id) ?? []}
              canChangeApproval={can(user, 'roles:manage')}
            />
          ))}
        </div>
      )}

      <p className="mt-6 max-w-2xl text-xs text-soft">
        Each profile is authorized by the person who holds that Upwork account — OAuth offers no
        other route, which is also what keeps the credentials out of anyone else&apos;s hands. What
        the portal adds is the ability to grant that access onward, under your control.
      </p>
    </AppShell>
  )
}
