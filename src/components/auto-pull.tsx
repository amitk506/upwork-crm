'use client'

import { useEffect, useRef, useState, useTransition } from 'react'

import { syncThread } from '@/app/inbox/actions'

/**
 * Fetch a conversation's messages the moment someone opens it empty.
 *
 * Upwork's terms cap how long their message text may be cached, so up_messages
 * is expired on a schedule and the background sync only refetches rooms whose
 * latest message changed. The result was that opening a quiet conversation — or
 * going back and opening it again — showed an empty thread with a "Pull latest"
 * button, every time. Correct behaviour, unusable interface: the person has
 * already told us which conversation they want by opening it.
 *
 * So the pull happens on open instead of on request. One request, only for a
 * conversation someone is actually looking at, and only when we hold nothing —
 * a thread that already has its messages costs nothing.
 *
 * Guarded against repeating: React re-runs effects on refresh, and the inbox
 * refreshes itself every 20 seconds. Without the ref this would fire on every
 * tick for any conversation Upwork genuinely has no messages for.
 */
export function AutoPull({ roomId, hasMessages }: { roomId: string; hasMessages: boolean }) {
  const [pending, startTransition] = useTransition()
  const [failed, setFailed] = useState(false)
  const attempted = useRef<string | null>(null)

  useEffect(() => {
    if (hasMessages) return
    // Once per conversation per mount, whatever the refresh cycle does.
    if (attempted.current === roomId) return
    attempted.current = roomId

    startTransition(async () => {
      const result = await syncThread(roomId)
      if (result?.error) setFailed(true)
    })
  }, [roomId, hasMessages])

  if (hasMessages) return null

  return (
    <p className="rounded-[--radius] border border-line bg-surface px-4 py-6 text-center text-[12.5px] text-soft">
      {pending ? (
        <>Fetching this conversation from Upwork…</>
      ) : failed ? (
        <>
          Could not fetch this conversation. Use <span className="font-medium">Pull latest</span> in
          the details panel to try again.
        </>
      ) : (
        <>No messages in this conversation yet.</>
      )}
    </p>
  )
}
