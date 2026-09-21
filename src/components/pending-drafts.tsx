'use client'

import { useState, useTransition } from 'react'

import { approveDraft, withdrawDraft } from '@/app/inbox/draft-actions'
import type { OutboundDraft } from '@/lib/database.types'

/**
 * Replies queued against someone's profile, shown inline in the thread so the
 * conversation reads in order: what the client said, and what is waiting to go
 * back to them.
 */
export function PendingDrafts({
  drafts,
  currentUserId,
  memberNames,
}: {
  drafts: OutboundDraft[]
  currentUserId: string
  memberNames: Record<string, string>
}) {
  const [handled, setHandled] = useState<Record<string, string>>({})
  const [pending, startTransition] = useTransition()

  if (drafts.length === 0) return null

  return (
    <div className="mt-4 space-y-2">
      {drafts.map((draft) => {
        const done = handled[draft.id]
        if (done) {
          return (
            <p key={draft.id} className="text-xs text-ok">
              {done}
            </p>
          )
        }

        const mineToApprove = draft.owner_id === currentUserId
        const mineToWithdraw = draft.author_id === currentUserId

        return (
          <div
            key={draft.id}
            className="ml-auto max-w-[85%] rounded-[--radius] border border-dashed border-line-strong bg-sunk p-3"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-xs font-medium text-ink">Awaiting approval</span>
              <span className="text-[11px] text-soft">
                written by {memberNames[draft.author_id] ?? 'a teammate'} · to send from{' '}
                {memberNames[draft.owner_id] ?? 'their profile'}
              </span>
            </div>

            <p className="mt-1 whitespace-pre-wrap text-sm">{draft.body}</p>

            {draft.note && (
              <p className="mt-1 text-[11px] text-soft">Note: {draft.note}</p>
            )}

            {(mineToApprove || mineToWithdraw) && (
              <div className="mt-2 flex gap-2">
                {mineToApprove && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const r = await approveDraft(draft.id)
                        setHandled((h) => ({
                          ...h,
                          [draft.id]: r?.error ?? 'Sent from your profile.',
                        }))
                      })
                    }
                    className="rounded-[--radius-sm] bg-action px-3 py-1.5 text-xs font-medium text-action-ink disabled:opacity-50"
                  >
                    Approve &amp; send
                  </button>
                )}
                {mineToWithdraw && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      startTransition(async () => {
                        const r = await withdrawDraft(draft.id)
                        setHandled((h) => ({ ...h, [draft.id]: r?.error ?? 'Withdrawn.' }))
                      })
                    }
                    className="rounded-[--radius-sm] border px-3 py-1.5 text-xs text-soft hover:text-stop disabled:opacity-50"
                  >
                    Withdraw
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
