'use client'

import { useState, useTransition } from 'react'

import { grantRoom, revokeRoomGrant } from '@/app/profiles/actions'

type Member = { id: string; full_name: string | null; email: string }
type ProfileOption = { id: string; label: string }
type Grant = { userId: string; canSend: boolean; viaProfile: string; perChat: boolean }

/**
 * Giving one person access to one conversation.
 *
 * A member can hold access two ways: a grant on a whole profile, or this — a
 * grant on this conversation alone. The distinction is shown, because revoking
 * here only removes the per-chat grant; someone who also holds the profile
 * keeps their access, and it would be misleading to imply otherwise.
 */
export function RoomAccessPanel({
  roomId,
  members,
  profiles,
  grants,
  canManage,
}: {
  roomId: string
  members: Member[]
  profiles: ProfileOption[]
  grants: Grant[]
  canManage: boolean
}) {
  const [userId, setUserId] = useState('')
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? '')
  const [canSend, setCanSend] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const byUser = new Map(grants.map((g) => [g.userId, g]))
  const available = members.filter((m) => !byUser.has(m.id))

  function run(fn: () => Promise<{ error?: string; ok?: boolean }>) {
    setError(null)
    startTransition(async () => {
      const result = await fn()
      if (result?.error) setError(result.error)
      else setUserId('')
    })
  }

  return (
    <section className="rounded-[--radius] border bg-surface p-4">
      <h2 className="text-sm font-semibold">Who can see this chat</h2>

      <ul className="mt-2 space-y-1.5">
        {grants.length === 0 && (
          <li className="text-xs text-soft">Nobody has access to this conversation yet.</li>
        )}

        {grants.map((g) => {
          const member = members.find((m) => m.id === g.userId)
          return (
            <li key={g.userId} className="flex items-center gap-2 text-xs">
              <span className="truncate">{member?.full_name || member?.email || g.userId}</span>
              <span className="shrink-0 text-[10px] text-soft">
                {g.canSend ? 'can reply' : 'read only'} · {g.perChat ? 'this chat' : g.viaProfile}
              </span>
              {canManage && g.perChat && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => revokeRoomGrant(roomId, g.userId))}
                  className="ml-auto shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-soft hover:text-stop disabled:opacity-50"
                >
                  Remove
                </button>
              )}
            </li>
          )
        })}
      </ul>

      {canManage && profiles.length > 0 && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!userId || !profileId) return
            run(() => grantRoom(roomId, userId, profileId, canSend))
          }}
          className="mt-3 space-y-1.5 border-t pt-3"
        >
          <label className="block text-xs text-soft" htmlFor="grant-user">
            Give someone access to just this chat
          </label>
          <select
            id="grant-user"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="w-full rounded-[--radius-sm] border bg-sunk px-2 py-1.5 text-sm outline-none focus:border-line-strong"
          >
            <option value="">Choose a member…</option>
            {available.map((m) => (
              <option key={m.id} value={m.id}>
                {m.full_name || m.email}
              </option>
            ))}
          </select>

          {profiles.length > 1 && (
            <select
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              className="w-full rounded-[--radius-sm] border bg-sunk px-2 py-1.5 text-sm outline-none focus:border-line-strong"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  through {p.label}
                </option>
              ))}
            </select>
          )}

          <label className="flex items-center gap-1.5 text-xs text-soft">
            <input type="checkbox" checked={canSend} onChange={(e) => setCanSend(e.target.checked)} />
            can reply, not just read
          </label>

          <button
            type="submit"
            disabled={pending || !userId}
            className="w-full rounded-[--radius-sm] bg-action px-3 py-1.5 text-sm font-medium text-action-ink disabled:opacity-50"
          >
            {pending ? 'Saving…' : 'Give access'}
          </button>

          {error && <p className="text-xs text-stop">{error}</p>}
        </form>
      )}
    </section>
  )
}
