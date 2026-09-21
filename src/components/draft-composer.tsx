'use client'

import { useState, useTransition } from 'react'

import { createDraft } from '@/app/inbox/draft-actions'
import { MESSAGE_MAX_LENGTH } from '@/lib/upwork/types'

type Approver = { id: string; name: string }

/**
 * Composing a reply for someone else's profile to send.
 *
 * Shown when the signed-in member cannot post to this conversation from their
 * own Upwork account. They write it; the profile owner approves; the client
 * sees the owner's name.
 */
export function DraftComposer({
  roomId,
  approvers,
  reason,
}: {
  roomId: string
  approvers: Approver[]
  reason: string
}) {
  const [body, setBody] = useState('')
  const [note, setNote] = useState('')
  const [ownerId, setOwnerId] = useState(approvers[0]?.id ?? '')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const [pending, startTransition] = useTransition()

  const length = body.trim().length
  const overLimit = length > MESSAGE_MAX_LENGTH

  if (approvers.length === 0) {
    return (
      <div className="rounded-[--radius] border bg-surface p-4 text-sm">
        <p className="font-medium text-stop">Nobody can reply here yet</p>
        <p className="mt-1 text-soft">
          {reason} No connected teammate is a participant in this conversation either, so there is
          no profile it could be sent from. Add someone to the thread on Upwork, then have them
          press Refresh here.
        </p>
      </div>
    )
  }

  if (sent) {
    return (
      <div className="rounded-[--radius] border bg-surface p-4 text-sm">
        <p className="font-medium text-ok">Sent for approval</p>
        <p className="mt-1 text-soft">
          {approvers.find((a) => a.id === ownerId)?.name} will see it in their approvals queue. Once
          they approve, it goes to the client from their profile, under their name.
        </p>
        <button
          type="button"
          onClick={() => {
            setSent(false)
            setBody('')
            setNote('')
          }}
          className="mt-3 text-sm text-ink underline underline-offset-2"
        >
          Write another
        </button>
      </div>
    )
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (overLimit || length === 0 || !ownerId) return
    setError(null)

    startTransition(async () => {
      const result = await createDraft({ roomId, ownerId, body, note })
      if (result?.error) {
        setError(result.error)
        return
      }
      setSent(true)
    })
  }

  return (
    <form onSubmit={submit} className="rounded-[--radius] border bg-surface p-4">
      <p className="text-sm font-medium">Write a reply for a teammate to send</p>
      <p className="mt-1 text-xs text-soft">
        {reason} Write it here and it goes out from their profile once they approve — the client
        only ever sees their name.
      </p>

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={5}
        placeholder="Write the reply exactly as the client should read it…"
        className="mt-3 w-full resize-y rounded-[--radius-sm] bg-sunk px-3 py-2 text-sm outline-none"
      />

      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note for the approver (optional, never sent to the client)"
        className="mt-2 w-full rounded-[--radius-sm] bg-sunk px-3 py-2 text-xs outline-none"
      />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-xs text-soft" htmlFor="approver">
          Send from
        </label>
        <select
          id="approver"
          value={ownerId}
          onChange={(e) => setOwnerId(e.target.value)}
          className="rounded-[--radius-sm] border bg-sunk px-2 py-1.5 text-sm outline-none focus:border-line-strong"
        >
          {approvers.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>

        <span className={`tabular ml-auto text-xs ${overLimit ? 'text-stop' : 'text-faint'}`}>
          {length.toLocaleString()} / {MESSAGE_MAX_LENGTH.toLocaleString()}
        </span>

        <button
          type="submit"
          disabled={pending || length === 0 || overLimit}
          className="rounded-[--radius-sm] bg-action px-3.5 py-2 text-sm font-medium text-action-ink disabled:opacity-50"
        >
          {pending ? 'Sending…' : 'Send for approval'}
        </button>
      </div>

      {error && <p className="mt-2 text-sm text-stop">{error}</p>}
    </form>
  )
}
