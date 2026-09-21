'use client'

import { useState, useTransition } from 'react'

import { assignRoom, syncThread } from '@/app/inbox/actions'

type Member = { id: string; full_name: string | null; email: string }

/**
 * Routing controls for one conversation.
 *
 * Notes deliberately do NOT live here any more. They are written in the
 * composer, which has the four-signal note mode, and read inline in the thread
 * where the context they refer to actually is. A second, plainer note box in
 * this panel undercut both: it was the easy one to reach, and it looked nothing
 * like the mode that guarantees a note cannot leave the building.
 */
export function ThreadSidebar({
  roomId,
  members,
  assignedTo,
  currentUserId,
  canAssign,
  participantIds,
}: {
  roomId: string
  members: Member[]
  assignedTo: string | null
  currentUserId: string
  canAssign: boolean
  /** Members whose own Upwork account can act in this room. */
  participantIds: string[]
}) {
  const [assignee, setAssignee] = useState(assignedTo ?? '')
  const [status, setStatus] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function refresh() {
    setStatus(null)
    startTransition(async () => {
      const result = await syncThread(roomId)
      setStatus(result?.error ?? `Pulled ${result?.messages ?? 0} messages`)
    })
  }

  function changeAssignee(next: string) {
    setAssignee(next)
    startTransition(async () => {
      await assignRoom(roomId, next || null)
    })
  }

  return (
    <aside className="space-y-4">
      <section className="rounded-[--radius] border bg-surface p-4">
        <h2 className="text-sm font-semibold">Thread</h2>
        <button
          type="button"
          onClick={refresh}
          disabled={pending}
          className="mt-2 w-full rounded-[--radius-sm] border px-3 py-1.5 text-sm transition-colors hover:bg-sunk disabled:opacity-50"
        >
          {pending ? 'Working…' : 'Pull latest'}
        </button>
        {status && <p className="mt-1.5 text-xs text-soft">{status}</p>}
      </section>

      <section className="rounded-[--radius] border bg-surface p-4">
        <h2 className="text-sm font-semibold">Assigned to</h2>
        <select
          value={assignee}
          onChange={(e) => changeAssignee(e.target.value)}
          disabled={pending || !canAssign}
          className="mt-2 w-full rounded-[--radius-sm] border bg-sunk px-2 py-1.5 text-sm outline-none focus:border-line-strong disabled:opacity-50"
        >
          <option value="">Unassigned</option>
          {members.map((m) => {
            const canReply = participantIds.includes(m.id)
            return (
              <option key={m.id} value={m.id}>
                {m.full_name || m.email}
                {m.id === currentUserId ? ' (you)' : ''}
                {canReply ? '' : ' — cannot reply here'}
              </option>
            )
          })}
        </select>

        {assignee && !participantIds.includes(assignee) && (
          <p className="mt-1.5 rounded bg-warn/10 px-2 py-1 text-xs text-warn">
            That member&apos;s Upwork account is not in this conversation, so they can read it but
            cannot reply from their own profile.
          </p>
        )}
        <p className="mt-1.5 text-xs text-soft">
          {canAssign
            ? 'Portal-only. The client never sees this, and unassigned threads stay visible to everyone.'
            : 'Read-only for your role — a manager or owner routes conversations.'}
        </p>
      </section>

    </aside>
  )
}
