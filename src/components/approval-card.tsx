'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'

import { approveDraft, declineDraft } from '@/app/inbox/draft-actions'
import { formatDateTime } from '@/lib/format'

export function ApprovalCard({
  draftId,
  body,
  note,
  error,
  createdAt,
  authorName,
  roomName,
  roomTopic,
  roomHref,
}: {
  draftId: string
  body: string
  note: string | null
  error: string | null
  createdAt: string
  authorName: string
  roomName: string
  roomTopic: string | null
  roomHref: string
}) {
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [pending, startTransition] = useTransition()

  function approve() {
    setResult(null)
    startTransition(async () => {
      const response = await approveDraft(draftId)
      if (response?.error) {
        setFailed(true)
        setResult(response.error)
        return
      }
      setFailed(false)
      setResult('Sent to the client from your profile.')
    })
  }

  function decline() {
    startTransition(async () => {
      const response = await declineDraft(draftId, reason)
      if (response?.error) {
        setFailed(true)
        setResult(response.error)
        return
      }
      setFailed(false)
      setResult('Declined.')
    })
  }

  if (result && !failed) {
    return (
      <div className="rounded-[--radius] border bg-surface p-4 text-sm text-ok">{result}</div>
    )
  }

  return (
    <article className="rounded-[--radius] border bg-surface p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Link href={roomHref} className="text-sm font-medium underline-offset-2 hover:underline">
          {roomName}
        </Link>
        {roomTopic && <span className="text-xs text-soft">· {roomTopic}</span>}
        <span className="ml-auto text-xs text-soft">
          {authorName} · <span className="tabular">{formatDateTime(createdAt)}</span>
        </span>
      </div>

      <p className="mt-3 whitespace-pre-wrap rounded-[--radius-sm] bg-sunk p-3 text-sm">{body}</p>

      {note && (
        <p className="mt-2 text-xs text-soft">
          <span className="font-medium">Note from {authorName}:</span> {note}
        </p>
      )}

      {error && (
        <p className="mt-2 rounded bg-stop/10 px-2 py-1 text-xs text-stop">
          Last attempt failed: {error}
        </p>
      )}

      {declining ? (
        <div className="mt-3">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why? (optional, shown to the author)"
            className="w-full rounded-[--radius-sm] bg-sunk px-3 py-2 text-sm outline-none"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={decline}
              disabled={pending}
              className="rounded-[--radius-sm] bg-stop px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? '…' : 'Confirm decline'}
            </button>
            <button
              type="button"
              onClick={() => setDeclining(false)}
              className="rounded-[--radius-sm] border px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={approve}
            disabled={pending}
            className="rounded-[--radius-sm] bg-action px-3.5 py-2 text-sm font-medium text-action-ink disabled:opacity-50"
          >
            {pending ? 'Sending…' : 'Approve & send'}
          </button>
          <button
            type="button"
            onClick={() => setDeclining(true)}
            disabled={pending}
            className="rounded-[--radius-sm] border px-3 py-2 text-sm text-soft hover:text-stop"
          >
            Decline
          </button>
        </div>
      )}

      {result && failed && <p className="mt-2 text-sm text-stop">{result}</p>}
    </article>
  )
}
