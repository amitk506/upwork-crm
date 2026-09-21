'use client'

import { useState, useTransition } from 'react'

import { ProfileAvatar } from '@/components/profile-avatar'
import {
  grantProfile,
  removeProfile,
  revokeProfileGrant,
  setProfileApproval,
} from '@/app/profiles/actions'

type Member = { id: string; full_name: string | null; email: string; role: string }
type Grant = { user_id: string; can_send: boolean }

type Profile = {
  id: string
  label: string
  upwork_user_name: string | null
  org_name: string | null
  org_role: string | null
  send_requires_approval: boolean
  is_active: boolean
  connect_error: string | null
  room_count: number
  member_count: number
}

export function ProfileCard({
  profile,
  members,
  grants,
  canChangeApproval,
}: {
  profile: Profile
  members: Member[]
  grants: Grant[]
  canChangeApproval: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const granted = new Map(grants.map((g) => [g.user_id, g.can_send]))

  function run(fn: () => Promise<{ error?: string; ok?: boolean } | void>) {
    setError(null)
    startTransition(async () => {
      const result = await fn()
      if (result && 'error' in result && result.error) setError(result.error)
    })
  }

  return (
    <article className="rounded-[--radius] border bg-surface p-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <ProfileAvatar profileId={profile.id} label={profile.label} size="md" />
        <h2 className="text-sm font-semibold">{profile.label}</h2>
        {profile.upwork_user_name && (
          <span className="text-xs text-soft">{profile.upwork_user_name}</span>
        )}
        {profile.org_role && (
          <span className="rounded bg-sunk px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-soft">
            {profile.org_role === 'FL_AGENCY' ? 'Agency' : 'Freelancer'}
          </span>
        )}
        <span className="ml-auto text-xs text-faint">
          <span className="tabular">{profile.room_count}</span> conversations ·{' '}
          <span className="tabular">{profile.member_count}</span> with access
        </span>
      </div>

      {profile.connect_error && (
        <p className="mt-2 rounded bg-stop/10 px-2 py-1 text-xs text-stop">
          {profile.connect_error}
        </p>
      )}

      {/* Approval setting -------------------------------------------------- */}
      <div className="mt-4 rounded-[--radius-sm] bg-sunk p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium">
              {profile.send_requires_approval
                ? 'Replies need the account holder to approve'
                : 'Granted members send directly under this profile'}
            </p>
            <p className="mt-0.5 text-xs text-soft">
              {profile.send_requires_approval
                ? 'The holder clicks approve, so they are genuinely the sender. Keeps this inside Upwork’s rules.'
                : 'Messages go out under this profile on someone else’s say-so — what Upwork’s account-sharing rule prohibits.'}
            </p>
          </div>
          {canChangeApproval && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(() => setProfileApproval(profile.id, !profile.send_requires_approval))
              }
              className={`shrink-0 rounded-[--radius-sm] border px-3 py-1.5 text-xs disabled:opacity-50 ${
                profile.send_requires_approval ? 'hover:text-warn' : 'text-warn hover:text-ok'
              }`}
            >
              {profile.send_requires_approval ? 'Allow direct send' : 'Require approval'}
            </button>
          )}
        </div>
      </div>

      {/* Grants ------------------------------------------------------------ */}
      <div className="mt-4">
        <p className="text-xs font-medium">Who can use this profile</p>
        <ul className="mt-2 space-y-1">
          {members.map((m) => {
            const has = granted.has(m.id)
            const canSend = granted.get(m.id) ?? false
            return (
              <li key={m.id} className="flex items-center gap-2 text-sm">
                <span className={has ? '' : 'text-soft'}>{m.full_name || m.email}</span>
                <span className="text-[11px] text-soft">{m.role}</span>

                <span className="ml-auto flex gap-1">
                  {has ? (
                    <>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => grantProfile(profile.id, m.id, !canSend))}
                        className="rounded border px-2 py-0.5 text-xs disabled:opacity-50"
                      >
                        {canSend ? 'Can reply' : 'Read only'}
                      </button>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => revokeProfileGrant(profile.id, m.id))}
                        className="rounded border px-2 py-0.5 text-xs text-soft hover:text-stop disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => grantProfile(profile.id, m.id, true))}
                      className="rounded border px-2 py-0.5 text-xs text-ink disabled:opacity-50"
                    >
                      Grant
                    </button>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      </div>

      {error && <p className="mt-3 text-sm text-stop">{error}</p>}

      <button
        type="button"
        disabled={pending}
        onClick={() => run(() => removeProfile(profile.id))}
        className="mt-4 text-xs text-soft hover:text-stop disabled:opacity-50"
      >
        Disconnect this profile
      </button>
    </article>
  )
}
