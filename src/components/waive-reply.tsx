'use client'

import { useTransition } from 'react'

import { setReplyWaived } from '@/app/inbox/actions'
import type { WaitState } from '@/lib/wait'

/**
 * "No reply needed" / "Needs a reply".
 *
 * Sits next to the wait meter in the conversation header, because that is the
 * number it turns off — a control that changes something should be beside the
 * thing it changes.
 *
 * The undo path is always visible when a waiver is active. Marking a
 * conversation as not needing an answer is a judgement call somebody else may
 * disagree with, so it must never look permanent.
 */
export function WaiveReply({ roomId, wait }: { roomId: string; wait: WaitState }) {
  const [pending, startTransition] = useTransition()

  const waived = !wait.awaiting && wait.waived === true
  // Nothing is outstanding and nothing was waived: no decision to make.
  if (!wait.awaiting && !waived) return null

  function toggle() {
    startTransition(async () => {
      await setReplyWaived(roomId, !waived)
    })
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      title={
        waived
          ? 'Put this conversation back in the waiting list.'
          : 'Hide the timer for this message. It returns on its own when the client writes again.'
      }
      className={[
        'shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
        'disabled:opacity-50',
        waived
          ? 'border-line text-soft hover:bg-sunk'
          : 'border-line text-faint hover:border-line-strong hover:text-ink',
      ].join(' ')}
    >
      {pending ? '…' : waived ? 'Needs a reply' : 'No reply needed'}
    </button>
  )
}
