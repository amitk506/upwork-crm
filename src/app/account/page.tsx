import { AppShell } from '@/components/app-shell'
import { ChangePassword } from '@/components/change-password'
import { PageHead, Panel } from '@/components/ui'
import { requireUser } from '@/lib/auth'
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/permissions'

export default async function AccountPage() {
  const user = await requireUser()

  return (
    <AppShell user={user}>
      <PageHead title="Your account" meta="Your sign-in details and password." />

      <div className="grid max-w-3xl gap-3 lg:grid-cols-2">
        <Panel title="Details">
          <dl className="space-y-2.5 text-sm">
            <div>
              <dt className="text-xs text-faint">Name</dt>
              <dd>{user.full_name || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Email</dt>
              <dd>{user.email}</dd>
            </div>
            <div>
              <dt className="text-xs text-faint">Role</dt>
              <dd>
                {ROLE_LABELS[user.role]}
                <span className="mt-0.5 block text-xs text-soft">
                  {ROLE_DESCRIPTIONS[user.role]}
                </span>
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-faint">
            Your name and role are set by an owner from the Team page.
          </p>
        </Panel>

        <Panel title="Change password" hint="Takes effect immediately.">
          <ChangePassword />
        </Panel>
      </div>
    </AppShell>
  )
}
