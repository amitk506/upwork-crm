'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * The scrolling message pane.
 *
 * Threads run to hundreds of messages, which turned the page into an endless
 * scroll with the composer stranded at the bottom. This gives the conversation
 * its own viewport so the composer and the thread header stay put.
 *
 * Opens at the newest message, the way every chat client does. Jumping happens
 * before paint so there is no visible lurch from top to bottom.
 */
export function MessageScroller({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [showJump, setShowJump] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  function onScroll() {
    const el = ref.current
    if (!el) return
    // "Near the bottom" rather than exactly at it — a couple of pixels of
    // rounding should not make the button flicker.
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setShowJump(!atBottom)
  }

  function jumpToLatest() {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' })
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={ref}
        onScroll={onScroll}
        className="h-full space-y-1 overflow-y-auto bg-paper px-4 py-3"
      >
        {children}
      </div>

      {showJump && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border bg-surface px-3 py-1.5 text-xs shadow-lg transition-colors hover:bg-sunk"
        >
          Jump to latest ↓
        </button>
      )}
    </div>
  )
}
