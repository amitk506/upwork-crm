'use client'

import { useState, useTransition } from 'react'

import { syncRooms } from '@/app/inbox/actions'

export function SyncButton() {
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)
  const [isError, setIsError] = useState(false)

  function refresh() {
    setMessage(null)
    startTransition(async () => {
      const result = await syncRooms()
      if (result?.error) {
        setIsError(true)
        setMessage(result.error)
        return
      }
      setIsError(false)
      setMessage(
        result?.changedRooms
          ? `${result.changedRooms} conversation${result.changedRooms === 1 ? '' : 's'} updated`
          : 'Up to date',
      )
    })
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={refresh}
        disabled={pending}
        className="rounded-[--radius-sm] border px-3.5 py-2 text-sm font-medium transition-colors hover:bg-sunk disabled:opacity-50"
      >
        {pending ? 'Refreshing…' : 'Refresh'}
      </button>
      {message && (
        <p className={`mt-1.5 text-xs ${isError ? 'text-stop' : 'text-soft'}`}>{message}</p>
      )}
    </div>
  )
}
