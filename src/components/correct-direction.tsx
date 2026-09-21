'use client'

import { useTransition } from 'react'

import { correctDirection } from '@/app/inbox/actions'

/**
 * "That was us" / "That was them".
 *
 * Appears only on messages whose side was worked out rather than known, because
 * offering to correct a fact the portal recorded itself would invite someone to
 * make it wrong.
 *
 * Deliberately quiet — it sits in the meta line and only darkens on hover. This
 * is a rare repair, not a control anybody needs to see while reading.
 */
export function CorrectDirection({
  storyId,
  roomId,
  currentlyOutbound,
}: {
  storyId: string
  roomId: string
  currentlyOutbound: boolean
}) {
  const [pending, startTransition] = useTransition()

  function fix() {
    startTransition(async () => {
      await correctDirection(storyId, roomId, currentlyOutbound ? 'inbound' : 'outbound')
    })
  }

  return (
    <button
      type="button"
      onClick={fix}
      disabled={pending}
      title={
        currentlyOutbound
          ? 'Mark this as the client’s message instead.'
          : 'Mark this as sent by the agency — for replies sent from Upwork rather than the portal.'
      }
      className="text-faint underline decoration-dotted underline-offset-2 hover:text-ink disabled:opacity-50"
    >
      {pending ? '…' : currentlyOutbound ? 'not us' : 'this was us'}
    </button>
  )
}
