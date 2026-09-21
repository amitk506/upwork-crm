'use client'

import { useState, useTransition } from 'react'

import { clearFollowUp, setFollowUp } from '@/app/inbox/actions'
import { formatDate } from '@/lib/format'

/**
 * "Come back to this on…"
 *
 * Sits in the conversation panel because that is where you realise you owe
 * someone an update — usually just after replying, when the wait meter has gone
 * quiet and the conversation is about to disappear from the list.
 *
 * Quick presets rather than a calendar first: in practice the answer is almost
 * always tomorrow, a few days, or next week, and making the common case one tap
 * is the difference between people using this and not.
 */

function isoDaysFromNow(days: number): string {
  const at = new Date()
  at.setDate(at.getDate() + days)
  return at.toISOString().slice(0, 10)
}

const PRESETS = [
  { label: 'Tomorrow', days: 1 },
  { label: 'In 3 days', days: 3 },
  { label: 'Next week', days: 7 },
]

export function FollowUp({
  roomId,
  existing,
}: {
  roomId: string
  existing: { due_at: string; for_name: string | null; note: string | null; is_due: boolean | null } | null
}) {
  const [open, setOpen] = useState(false)
  const [date, setDate] = useState(isoDaysFromNow(1))
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function save(on: string) {
    setError(null)
    startTransition(async () => {
      const result = await setFollowUp(roomId, on, note)
      if (result?.error) {
        setError(result.error)
        return
      }
      setOpen(false)
      setNote('')
    })
  }

  function clear() {
    startTransition(async () => {
      await clearFollowUp(roomId)
    })
  }

  if (existing) {
    return (
      <section className="rounded-[--radius] border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold">Follow-up</h2>
        <p
          className={`mt-1.5 text-[13px] font-semibold ${existing.is_due ? 'text-warn' : ''}`}
        >
          {existing.is_due ? 'Due now' : formatDate(existing.due_at)}
          {existing.for_name && (
            <span className="font-normal text-soft"> · {existing.for_name}</span>
          )}
        </p>
        {existing.note && <p className="mt-1 text-xs text-soft">{existing.note}</p>}

        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            onClick={clear}
            disabled={pending}
            className="rounded-[--radius-sm] border border-line px-2.5 py-1 text-[11.5px] font-semibold text-soft hover:bg-sunk disabled:opacity-50"
          >
            {pending ? '…' : 'Mark done'}
          </button>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-[--radius-sm] px-2.5 py-1 text-[11.5px] font-semibold text-faint hover:text-ink"
          >
            Change date
          </button>
        </div>

        {open && <Picker {...{ date, setDate, note, setNote, save, pending, error }} />}
        <p className="mt-2 text-[11px] text-faint">
          Clears itself when a reply goes out from here.
        </p>
      </section>
    )
  }

  return (
    <section className="rounded-[--radius] border border-line bg-surface p-4">
      <h2 className="text-sm font-semibold">Follow-up</h2>
      <p className="mt-0.5 text-xs text-soft">
        Owe this client an update later? Put a date on it and it appears on the
        assignee&apos;s dashboard that morning.
      </p>

      {!open ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.days}
              type="button"
              disabled={pending}
              onClick={() => save(isoDaysFromNow(preset.days))}
              className="rounded-[--radius-sm] border border-line px-2.5 py-1 text-[11.5px] font-semibold text-soft hover:bg-sunk disabled:opacity-50"
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-[--radius-sm] px-2.5 py-1 text-[11.5px] font-semibold text-faint hover:text-ink"
          >
            Pick a date
          </button>
        </div>
      ) : (
        <Picker {...{ date, setDate, note, setNote, save, pending, error }} />
      )}

      {error && !open && <p className="mt-2 text-xs text-stop">{error}</p>}
    </section>
  )
}

function Picker({
  date,
  setDate,
  note,
  setNote,
  save,
  pending,
  error,
}: {
  date: string
  setDate: (v: string) => void
  note: string
  setNote: (v: string) => void
  save: (on: string) => void
  pending: boolean
  error: string | null
}) {
  return (
    <div className="mt-2 space-y-2">
      <input
        type="date"
        value={date}
        min={new Date().toISOString().slice(0, 10)}
        onChange={(e) => setDate(e.target.value)}
        className="w-full rounded-[--radius-sm] border border-line bg-surface px-2.5 py-1.5 text-[12.5px] outline-none focus:border-accent"
      />
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What for? e.g. chase the invoice"
        className="w-full rounded-[--radius-sm] border border-line bg-surface px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-faint focus:border-accent"
      />
      <button
        type="button"
        onClick={() => save(date)}
        disabled={pending}
        className="w-full rounded-[--radius-sm] bg-action px-3 py-1.5 text-[12.5px] font-semibold text-action-ink disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Set follow-up'}
      </button>
      {error && <p className="text-xs text-stop">{error}</p>}
    </div>
  )
}
