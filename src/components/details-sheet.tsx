'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * The conversation's context panel, on screens too narrow to show it beside the
 * thread.
 *
 * Below 1280px the panel was simply hidden — which on a phone meant follow-ups,
 * assignment, who-can-reply and granting access did not exist at all. Hiding a
 * column on a narrow screen is right; removing the only route to what it holds
 * is not.
 *
 * The same server-rendered content is passed in as children, so the sheet and the
 * desktop column can never drift apart — there is one panel, shown two ways.
 *
 * Portalled to document.body, and not blurred: both lessons from the command
 * palette, where a fixed overlay declared inside the rail was at the mercy of
 * every ancestor's transform, and a backdrop-filter dropped the panel entirely.
 */
export function DetailsSheet({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)

  // A sheet over the conversation must not let the conversation scroll behind
  // it, and Escape should close it like any other dialog.
  useEffect(() => {
    if (!open) return

    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)

    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Conversation details"
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-[--radius-sm] border border-line px-2.5 text-[11.5px] font-semibold text-soft hover:bg-sunk xl:hidden"
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5 fill-none stroke-current"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 11v5M12 8h.01" />
        </svg>
        Details
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Conversation details"
            className="fixed inset-0 z-[90] flex justify-end bg-ink/45"
            onClick={() => setOpen(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
              className="flex h-full w-full max-w-[420px] flex-col border-l border-line-strong bg-paper"
            >
              <header className="flex shrink-0 items-center gap-2 border-b border-line bg-surface px-4 py-3">
                <h2 className="flex-1 text-[14px] font-semibold tracking-[-0.018em]">Details</h2>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="rounded-[--radius-sm] px-2 py-1 text-faint hover:bg-sunk hover:text-ink"
                >
                  ✕
                </button>
              </header>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">{children}</div>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
