'use client'

import { useState, useTransition } from 'react'

import { reviewMiss } from '@/app/reviews/actions'

/**
 * The two decisions a reviewer can make.
 *
 * Dismiss is offered first and styled as the plain option. Most of these will be
 * wrong to begin with — the attribution behind them is inferred — and a queue
 * that makes confirming the easy default would launder guesses into records.
 */
export function ReviewActions({ id }: { id: number }) {
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function decide(status: 'confirmed' | 'dismissed') {
    startTransition(async () => {
      await reviewMiss(id, status, note)
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {open && (
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why? (optional, kept with the record)"
          className="min-w-0 flex-1 rounded-[--radius-sm] border border-line bg-surface px-2.5 py-1 text-[12px] outline-none placeholder:text-faint focus:border-accent"
        />
      )}
      <button
        type="button"
        onClick={() => (open ? decide('dismissed') : setOpen(true))}
        disabled={pending}
        className="rounded-[--radius-sm] border border-line px-2.5 py-1 text-[11.5px] font-semibold text-soft hover:bg-sunk disabled:opacity-50"
      >
        {pending ? '…' : open ? 'Dismiss' : 'Review'}
      </button>
      {open && (
        <button
          type="button"
          onClick={() => decide('confirmed')}
          disabled={pending}
          className="rounded-[--radius-sm] border border-stop/40 bg-stop-tint px-2.5 py-1 text-[11.5px] font-semibold text-stop disabled:opacity-50"
        >
          Confirm miss
        </button>
      )}
    </div>
  )
}
