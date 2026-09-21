'use client'

import { useState, useTransition } from 'react'

import {
  deactivateMember,
  deleteMember,
  reactivateMember,
  resetMemberPassword,
  updateMember,
} from '@/app/team/invite-actions'

/**
 * Editing and removing a team member.
 *
 * Destructive actions confirm inline rather than through a browser dialog, so
 * the consequence is stated in the same place as the button.
 */
export function MemberActions({
  userId,
  fullName,
  email,
  isActive,
  canDelete,
  isSelf,
}: {
  userId: string
  fullName: string | null
  email: string
  isActive: boolean
  canDelete: boolean
  isSelf: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(fullName ?? '')
  const [confirming, setConfirming] = useState<'deactivate' | 'delete' | null>(null)
  const [password, setPassword] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [pending, startTransition] = useTransition()

  function run(fn: () => Promise<{ error?: string; ok?: boolean; notice?: string } | void>) {
    setMessage(null)
    setFailed(false)
    startTransition(async () => {
      const result = await fn()
      if (result && 'error' in result && result.error) {
        setFailed(true)
        setMessage(result.error)
        return
      }
      if (result && 'notice' in result && result.notice) setMessage(result.notice)
      setConfirming(null)
      setEditing(false)
    })
  }

  if (password) {
    return (
      <div className="rounded-[--radius-sm] bg-ok/10 p-3 text-xs">
        <p className="font-medium text-ok">New password for {email}</p>
        <code className="code mt-1 block break-all rounded bg-sunk px-2 py-1">
          {password}
        </code>
        <p className="mt-1 text-soft">
          Shown once. Their other sessions were signed out.
        </p>
        <button
          type="button"
          onClick={() => setPassword(null)}
          className="mt-2 text-ink underline underline-offset-2"
        >
          Done
        </button>
      </div>
    )
  }

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          run(() => updateMember(userId, name))
        }}
        className="flex flex-wrap items-center gap-1.5"
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border bg-sunk px-2 py-1 text-xs outline-none focus:border-line-strong"
          autoFocus
        />
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-action px-2 py-1 text-xs font-medium text-action-ink disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false)
            setName(fullName ?? '')
          }}
          className="rounded border px-2 py-1 text-xs"
        >
          Cancel
        </button>
        {message && failed && <span className="text-xs text-stop">{message}</span>}
      </form>
    )
  }

  if (confirming) {
    const isDelete = confirming === 'delete'
    return (
      <div className="rounded-[--radius-sm] bg-stop/10 p-2 text-xs">
        <p className="text-stop">
          {isDelete
            ? `Permanently delete ${email}? Their account, grants and drafts go with it. This cannot be undone.`
            : `Deactivate ${email}? They lose all profile and chat access and are signed out. You can reactivate them, but access must be granted again.`}
        </p>
        <div className="mt-2 flex gap-1.5">
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => (isDelete ? deleteMember(userId) : deactivateMember(userId)))}
            className="rounded bg-stop px-2 py-1 font-medium text-white disabled:opacity-50"
          >
            {pending ? '…' : isDelete ? 'Delete permanently' : 'Deactivate'}
          </button>
          <button
            type="button"
            onClick={() => setConfirming(null)}
            className="rounded border px-2 py-1"
          >
            Cancel
          </button>
        </div>
        {message && failed && <p className="mt-1 text-stop">{message}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="rounded border px-2 py-1 hover:bg-sunk"
      >
        Rename
      </button>

      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await resetMemberPassword(userId)
            if (result?.error) {
              setFailed(true)
              setMessage(result.error)
              return
            }
            if (result?.tempPassword) setPassword(result.tempPassword)
          })
        }
        className="rounded border px-2 py-1 hover:bg-sunk disabled:opacity-50"
      >
        Reset password
      </button>

      {isActive ? (
        !isSelf && (
          <button
            type="button"
            onClick={() => setConfirming('deactivate')}
            className="rounded border px-2 py-1 text-soft hover:text-stop"
          >
            Deactivate
          </button>
        )
      ) : (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => reactivateMember(userId))}
          className="rounded border px-2 py-1 text-ok disabled:opacity-50"
        >
          Reactivate
        </button>
      )}

      {canDelete && !isSelf && (
        <button
          type="button"
          onClick={() => setConfirming('delete')}
          className="rounded border px-2 py-1 text-soft hover:text-stop"
        >
          Delete
        </button>
      )}

      {message && (
        <span className={failed ? 'text-stop' : 'text-soft'}>{message}</span>
      )}
    </div>
  )
}
