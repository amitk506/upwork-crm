import Link from 'next/link'

import { AppShell } from '@/components/app-shell'
import { InviteMember } from '@/components/invite-member'
import { MemberActions } from '@/components/member-actions'
import { ProfileAvatar } from '@/components/profile-avatar'
import { RoleSelect } from '@/components/role-select'
import { Badge, Empty, Notice, PageHead, buttonClass } from '@/components/ui'
import { requireCapability } from '@/lib/auth'
import { can, ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/permissions'
import { createClient } from '@/lib/supabase/server'
import type { AppRole } from '@/lib/database.types'

type Member = {
  id: string
  email: string
  full_name: string | null
  role: AppRole
  is_active: boolean
}

/**
 * The roster.
 *
 * The old "Upwork connected?" column is gone: under central profiles a member
 * never authenticates to Upwork, so whether they personally hold a token is
 * neither true nor useful. What matters is which of the agency's profiles they
 * have been granted, which is what this shows instead.
 */
export default async function TeamPage() {
  const user = await requireCapability('team:manage')
  const supabase = await createClient()

  const [{ data, error }, { data: grants }, { data: profiles }] = await Promise.all([
    supabase
      .from('app_users')
      .select('id, email, full_name, role, is_active')
      .order('is_active', { ascending: false })
      .order('email', { ascending: true }),
    supabase.from('profile_grants').select('user_id, profile_id, can_send'),
    supabase.from('v_profiles').select('id, label'),
  ])

  const members = (data ?? []) as Member[]
  const profileLabel = new Map((profiles ?? []).map((p) => [p.id, p.label]))

  const accessByUser = new Map<string, { id: string; label: string; canSend: boolean }[]>()
  for (const g of grants ?? []) {
    const list = accessByUser.get(g.user_id) ?? []
    list.push({
      id: g.profile_id,
      label: profileLabel.get(g.profile_id) ?? 'profile',
      canSend: g.can_send,
    })
    accessByUser.set(g.user_id, list)
  }

  const withoutAccess = members.filter(
    (m) => m.is_active && (accessByUser.get(m.id) ?? []).length === 0,
  )

  return (
    <AppShell user={user}>
      <PageHead
        title="Team"
        meta="Members sign into the portal and work through the profiles you grant them. Nobody connects an Upwork account of their own."
      >
        <InviteMember canCreateOwner={can(user, 'roles:manage')} />
      </PageHead>

      {error && <Notice tone="stop">Could not load the roster: {error.message}</Notice>}

      {withoutAccess.length > 0 && (
        <div className="mb-4">
          <Notice>
            <span className="tabular">{withoutAccess.length}</span> member
            {withoutAccess.length === 1 ? ' has' : 's have'} no profile access yet, so their inbox
            is empty. Grant them a profile — or an individual chat — under{' '}
            <Link href="/profiles" className="underline underline-offset-2">
              Profiles
            </Link>
            .
          </Notice>
        </div>
      )}

      {members.length === 0 ? (
        <Empty title="No members yet">The first person to sign in becomes the owner.</Empty>
      ) : (
        <div className="overflow-hidden rounded-[--radius] border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-sunk text-left">
              <tr className="text-[11px] uppercase tracking-[0.1em] text-faint">
                <th className="px-4 py-2.5 font-medium">Member</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Profile access</th>
                <th className="px-4 py-2.5 font-medium">Manage</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => {
                const access = accessByUser.get(m.id) ?? []
                return (
                  <tr
                    key={m.id}
                    className={`border-b border-line last:border-b-0 ${m.is_active ? '' : 'opacity-55'}`}
                  >
                    <td className="px-4 py-3 align-top">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{m.full_name || '—'}</span>
                        {!m.is_active && <Badge tone="stop">deactivated</Badge>}
                      </div>
                      <div className="mt-0.5 text-xs text-soft">{m.email}</div>
                    </td>

                    <td className="px-4 py-3 align-top">
                      {can(user, 'roles:manage') && m.id !== user.id ? (
                        <RoleSelect userId={m.id} role={m.role} />
                      ) : (
                        <span className="text-soft" title={ROLE_DESCRIPTIONS[m.role]}>
                          {ROLE_LABELS[m.role]}
                        </span>
                      )}
                    </td>

                    <td className="px-4 py-3 align-top">
                      {access.length === 0 ? (
                        <Link
                          href="/profiles"
                          className="text-xs text-warn underline underline-offset-2"
                        >
                          None yet — grant one
                        </Link>
                      ) : (
                        <ul className="flex flex-wrap gap-1.5">
                          {access.map((a) => (
                            <li key={a.id} className="flex items-center gap-1.5">
                              <ProfileAvatar profileId={a.id} label={a.label} size="xs" />
                              <span className="text-xs">
                                {a.label}
                                {!a.canSend && <span className="text-faint"> · read</span>}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>

                    <td className="px-4 py-3 align-top">
                      <MemberActions
                        userId={m.id}
                        fullName={m.full_name}
                        email={m.email}
                        isActive={m.is_active}
                        canDelete={can(user, 'roles:manage')}
                        isSelf={m.id === user.id}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-xs text-faint">
        Deactivating a member ends their sessions and strips every grant. Reactivating does not
        restore access — grant it again deliberately.{' '}
        <Link href="/profiles" className={buttonClass('quiet', 'sm') + ' ml-1 align-middle'}>
          Manage profiles
        </Link>
      </p>
    </AppShell>
  )
}
