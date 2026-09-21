'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'

import { searchPortal, type SearchHit, type SearchResults } from '@/app/search-actions'

/**
 * ⌘K — one input over conversations, notes, people and commands.
 *
 * At a few hundred conversations across eight profiles, navigating by scrolling
 * stops working, and adding a search field to each screen teaches four different
 * behaviours. Commands live in the same input as results so there is one thing to
 * learn.
 *
 * A note hit shows the matched sentence rather than the conversation's title,
 * because when you search a note you are looking for the sentence.
 */

type Command = { id: string; title: string; detail: string; href: string; keys?: string }

const COMMANDS: Command[] = [
  { id: 'c-waiting', title: 'Conversations waiting on a reply', detail: 'Sorted by longest wait', href: '/inbox' },
  { id: 'c-unread', title: 'Unread conversations', detail: 'Nobody has opened these', href: '/inbox?view=unread' },
  { id: 'c-mine', title: 'My conversations', detail: 'Assigned or granted to you', href: '/inbox?view=mine' },
  { id: 'c-all', title: 'All conversations', detail: 'Everything you can see', href: '/inbox?view=all' },
  { id: 'c-board', title: 'Board', detail: 'Longest waits, coverage, replies today', href: '/board' },
  { id: 'c-activity', title: 'Activity', detail: 'Who did what', href: '/activity' },
  { id: 'c-account', title: 'My account', detail: 'Change your password', href: '/account' },
]

export function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [cursor, setCursor] = useState(0)
  const [pending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)

  // ⌘K anywhere. Ignored while typing in a field so it cannot hijack a reply.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const typing =
        event.target instanceof HTMLElement &&
        ['INPUT', 'TEXTAREA'].includes(event.target.tagName)

      // State setters are stable, so this handler needs no dependencies and the
      // listener is attached once.
      function reset() {
        setQuery('')
        setResults(null)
        setCursor(0)
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((was) => {
          if (was) reset()
          return !was
        })
        return
      }

      if (event.key === 'Escape' && !typing) {
        setOpen(false)
        reset()
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Focus is an external system, so it belongs in an effect. Resetting state is
  // not — that happens in close(), where the intent actually is.
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  function close() {
    setOpen(false)
    setQuery('')
    setResults(null)
    setCursor(0)
  }

  // Debounced so a fast typist issues one query, not eight.
  useEffect(() => {
    if (!open) return
    const term = query.trim()
    if (term.length < 2) return

    const timer = setTimeout(() => {
      startTransition(async () => {
        const next = await searchPortal(term)
        setResults(next)
        setCursor(0)
      })
    }, 160)

    return () => clearTimeout(timer)
  }, [query, open])

  // Results carry the query they answered, so staleness is derived rather than
  // cleared: mid-typing you never see hits for the phrase you just changed.
  const term = query.trim()
  const fresh = results && results.query === term ? results : null

  const commandHits = matchCommands(query)
  const groups: { label: string; hits: (SearchHit | Command)[] }[] = [
    { label: 'Conversations', hits: fresh?.rooms ?? [] },
    { label: 'Notes', hits: fresh?.notes ?? [] },
    { label: 'People', hits: fresh?.members ?? [] },
    { label: 'Go to', hits: commandHits },
  ].filter((g) => g.hits.length > 0)

  const flat = groups.flatMap((g) => g.hits)
  const active = flat[Math.min(cursor, flat.length - 1)]

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor((c) => Math.min(c + 1, flat.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
    } else if (event.key === 'Enter' && active) {
      event.preventDefault()
      close()
      router.push(active.href)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  const trigger = (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="flex w-full items-center gap-2 rounded-[--radius-sm] border border-line bg-sunk px-2.5 py-1.5 text-left text-[12.5px] text-faint transition-colors hover:border-line-strong"
    >
      <SearchIcon />
      <span className="flex-1">Search</span>
      <kbd className="code rounded border border-line-strong bg-surface px-1 text-[10px]">⌘K</kbd>
    </button>
  )

  // No mounted flag needed: `open` starts false and can only be set by a click or
  // a keypress, so the portal is never reached during server rendering. The
  // document check is belt and braces for a stray render.
  if (!open || typeof document === 'undefined') return trigger

  // Rendered into document.body rather than in place.
  //
  // The trigger lives inside the 216px rail, and an overlay declared there is at
  // the mercy of every ancestor: a transform, filter or `contain` anywhere up the
  // tree turns `position: fixed` into "fixed relative to that ancestor", which
  // sizes a full-screen dialog to a narrow column. A portal to the body makes the
  // dialog independent of wherever the button happens to sit.
  //
  // The backdrop is a plain scrim, not backdrop-blur. A blurred layer containing a
  // child with its own shadow and stacking context composites unreliably — it can
  // paint the blur and drop the panel, which is a screen that looks broken rather
  // than one that looks soft.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search the portal"
      className="fixed inset-0 z-[100] flex items-start justify-center bg-ink/45 px-4 pt-[10vh]"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[600px] overflow-hidden rounded-[--radius-lg] border border-line-strong bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search conversations, notes and people"
            aria-label="Search"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          <span className="tabular shrink-0 text-[11px] text-faint">
            {pending ? 'Searching…' : fresh ? `${flat.length} result${flat.length === 1 ? '' : 's'}` : ''}
          </span>
        </div>

        <div className="max-h-[52vh] overflow-y-auto py-1">
          {flat.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12.5px] text-faint">
              {term.length < 2
                ? 'Type at least two characters.'
                : pending
                  ? 'Searching…'
                  : `Nothing matches “${term}”.`}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <p className="px-4 pb-1 pt-2 text-[9.5px] font-semibold uppercase tracking-[0.13em] text-faint">
                  {group.label}
                </p>
                {group.hits.map((hit) => {
                  const index = flat.indexOf(hit)
                  return (
                    <button
                      key={`${group.label}-${hit.id}`}
                      type="button"
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => {
                        close()
                        router.push(hit.href)
                      }}
                      className={`flex w-full items-center gap-3 px-4 py-1.5 text-left ${
                        index === cursor ? 'bg-accent-tint' : ''
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold">{hit.title}</span>
                        {'detail' in hit && hit.detail && (
                          <span className="block truncate text-[11.5px] text-faint">
                            {hit.detail}
                          </span>
                        )}
                      </span>
                      {'keys' in hit && hit.keys && (
                        <kbd className="code shrink-0 text-[10px] text-faint">{hit.keys}</kbd>
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex flex-wrap gap-3.5 border-t border-line bg-sunk px-4 py-2 text-[10.5px] text-faint">
          <span>
            <kbd className="code">↑↓</kbd> move
          </span>
          <span>
            <kbd className="code">↵</kbd> open
          </span>
          <span>
            <kbd className="code">esc</kbd> close
          </span>
          <span className="ml-auto">Searches the portal only — never Upwork</span>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Substring match on title and detail, so "wait" finds the waiting view. */
function matchCommands(query: string): Command[] {
  const term = query.trim().toLowerCase()
  if (term.length === 0) return COMMANDS
  return COMMANDS.filter(
    (c) => c.title.toLowerCase().includes(term) || c.detail.toLowerCase().includes(term),
  )
}

function SearchIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-4 w-4 shrink-0 fill-none stroke-current"
      strokeWidth="1.7"
      strokeLinecap="round"
    >
      <circle cx="11" cy="11" r="6" />
      <path d="M16 16l4 4" />
    </svg>
  )
}
