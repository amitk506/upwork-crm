'use client'

import { useState, useTransition } from 'react'

import { inviteMember } from '@/app/team/invite-actions'
import type { AppRole } from '@/lib/database.types'
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/permissions'

export function InviteMember({ canCreateOwner }: { canCreateOwner: boolean }) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState<AppRole>('bidder')
  const [error, setError] = useState<string | null>(null)
  const [created, setCreated] = useState<{ email: string; tempPassword: string } | null>(null)
  const [pending, startTransition] = useTransition()

  const roles: AppRole[] = canCreateOwner
    ? ['bidder', 'team_lead', 'manager', 'owner']
    : ['bidder', 'team_lead', 'manager']

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    startTransition(async () => {
      const result = await inviteMember({ email, fullName, role })
      if (result?.error) {
        setError(result.error)
        return
      }
      if (result?.ok && result.tempPassword) {
        setCreated({ email: result.email!, tempPassword: result.tempPassword })
        setEmail('')
        setFullName('')
        setRole('bidder')
      }
    })
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-[--radius-sm] bg-action px-3.5 py-2 text-sm font-medium text-action-ink"
      >
        Add member
      </button>
    )
  }

  return (
    <div className="rounded-[--radius] border bg-surface p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Add a member</h2>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            setCreated(null)
          }}
          className="text-sm text-soft hover:text-ink"
        >
          Close
        </button>
      </div>

      {created ? (
        <div className="mt-4 rounded-[--radius-sm] bg-ok/10 p-4">
          <p className="text-sm text-ok">Account created for {created.email}.</p>
          <p className="mt-2 text-xs text-soft">
            Send them this. The password is shown once and never stored in readable form. They do
            not need an Upwork login of their own — the portal holds the agency&apos;s profiles.
          </p>

          <pre className="code mt-2 whitespace-pre-wrap rounded bg-sunk px-3 py-2 text-xs">
{`Portal: ${typeof window === 'undefined' ? '' : window.location.origin}
Email:    ${created.email}
Password: ${created.tempPassword}

Sign in and you're ready — the conversations you have been
given access to are already there. Change your password
from the Team page after your first sign-in.`}
          </pre>

          <button
            type="button"
            onClick={() =>
              navigator.clipboard?.writeText(
                `Portal: ${window.location.origin}\nEmail: ${created.email}\n` +
                  `Password: ${created.tempPassword}\n\n` +
                  `Sign in and you're ready — the conversations you have been given ` +
                  `access to are already there.`,
              )
            }
            className="mt-2 rounded-[--radius-sm] border px-3 py-1.5 text-xs hover:bg-sunk"
          >
            Copy handoff message
          </button>

          <button
            type="button"
            onClick={() => setCreated(null)}
            className="ml-2 mt-2 text-sm text-ink underline underline-offset-2"
          >
            Add another
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="mt-4 grid gap-3 sm:grid-cols-3">
          <input
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="Full name"
            className="rounded-[--radius-sm] border bg-sunk px-3 py-2 text-sm outline-none focus:border-line-strong"
          />
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="email@your-agency.com"
            className="rounded-[--radius-sm] border bg-sunk px-3 py-2 text-sm outline-none focus:border-line-strong"
          />
          <div className="flex gap-2">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as AppRole)}
              className="flex-1 rounded-[--radius-sm] border bg-sunk px-2 py-2 text-sm outline-none focus:border-line-strong"
            >
              {roles.map((r) => (
                <option key={r} value={r} title={ROLE_DESCRIPTIONS[r]}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={pending}
              className="rounded-[--radius-sm] bg-action px-3.5 py-2 text-sm font-medium text-action-ink disabled:opacity-50"
            >
              {pending ? '…' : 'Create'}
            </button>
          </div>

          <p className="text-xs text-soft sm:col-span-3">{ROLE_DESCRIPTIONS[role]}</p>

          {error && <p className="text-sm text-stop sm:col-span-3">{error}</p>}
        </form>
      )}
    </div>
  )
}
