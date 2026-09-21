'use client'

import Link from 'next/link'
import { useState } from 'react'

import { ProfileAvatar } from '@/components/profile-avatar'
import { activeFilterCount, inboxHref, WAIT_BANDS } from '@/lib/inbox-filters'
import type { InboxData } from '@/lib/inbox-data'

/**
 * The filter drawer.
 *
 * Every option carries its live count, computed against the OTHER active
 * conditions — so each number answers "what would I get if I added this one",
 * and you never click into an empty result. That is the whole reason a drawer
 * beats a row of dropdowns here: a manager builds a query like "waiting over six
 * hours, nobody granted access" and needs to see it is worth opening.
 *
 * The primary button states the outcome rather than the mechanism. "Apply" tells
 * you nothing; "Show 3 conversations" tells you whether to bother.
 *
 * State lives entirely in the URL, so a filtered view can be pasted into chat and
 * arrives the same for whoever opens it — subject to their own access, since the
 * scoping happens in the database.
 */
export function FilterDrawer({ data }: { data: InboxData }) {
  const [open, setOpen] = useState(false)
  const { filters, optionCount, profiles, members, rooms } = data
  const count = activeFilterCount(filters)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        title="Filter conversations"
        className={[
          'flex h-[30px] shrink-0 items-center gap-1.5 rounded-[--radius-sm] border px-2 text-[11.5px] font-semibold transition-colors',
          count > 0
            ? 'border-ink bg-ink text-paper'
            : 'border-line text-soft hover:bg-sunk',
        ].join(' ')}
      >
        <FilterIcon />
        {count > 0 && <span className="tabular">{count}</span>}
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Filter conversations"
          className="fixed inset-0 z-50 flex justify-end bg-ink/30"
          onClick={() => setOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="flex h-full w-[340px] max-w-full flex-col border-l border-line-strong bg-surface"
          >
            <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-3">
              <FilterIcon />
              <h2 className="flex-1 text-[14px] font-semibold tracking-[-0.018em]">Filter</h2>
              {count > 0 && (
                <Link
                  href={inboxHref(filters, { profile: null, user: null, wait: null, assignee: null })}
                  onClick={() => setOpen(false)}
                  className="text-[11.5px] text-soft underline underline-offset-2 hover:text-ink"
                >
                  Reset
                </Link>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="text-faint hover:text-ink"
              >
                ✕
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto">
              <Group title="Waiting on us">
                <Option
                  href={inboxHref(filters, { wait: null })}
                  onNavigate={() => setOpen(false)}
                  active={filters.wait === null}
                  label="Any"
                  count={data.scoped.length}
                  radio
                />
                {WAIT_BANDS.map((band) => (
                  <Option
                    key={band.hours}
                    href={inboxHref(filters, { wait: band.hours })}
                    onNavigate={() => setOpen(false)}
                    active={filters.wait === band.hours}
                    label={band.label}
                    count={optionCount.wait[band.hours] ?? 0}
                    radio
                  />
                ))}
              </Group>

              {profiles.length > 1 && (
                <Group title="Profile">
                  {profiles.map((profile) => (
                    <Option
                      key={profile.profile_id}
                      href={inboxHref(filters, {
                        profile:
                          filters.profile === profile.profile_id ? null : profile.profile_id,
                      })}
                      onNavigate={() => setOpen(false)}
                      active={filters.profile === profile.profile_id}
                      label={profile.profile_label}
                      count={profile.room_count}
                      avatar={{ id: profile.profile_id, label: profile.profile_label }}
                    />
                  ))}
                </Group>
              )}

              <Group title="Assigned to">
                {/* Replaces the old "Mine" tab, which was a scope wearing a tab's
                    clothes — and for an owner granted every profile it selected
                    everything, so it duplicated "All". */}
                <Option
                  href={inboxHref(filters, {
                    assignee: filters.assignee === data.viewerId ? null : data.viewerId,
                  })}
                  onNavigate={() => setOpen(false)}
                  active={filters.assignee === data.viewerId}
                  label="Me"
                  count={optionCount.assignee[data.viewerId] ?? 0}
                />
                <Option
                  href={inboxHref(filters, {
                    assignee: filters.assignee === 'none' ? null : 'none',
                  })}
                  onNavigate={() => setOpen(false)}
                  active={filters.assignee === 'none'}
                  label="Nobody granted access"
                  count={optionCount.unassigned}
                />
                {members
                  .filter((member) => member.id !== data.viewerId)
                  .map((member) => (
                  <Option
                    key={member.id}
                    href={inboxHref(filters, {
                      assignee: filters.assignee === member.id ? null : member.id,
                    })}
                    onNavigate={() => setOpen(false)}
                    active={filters.assignee === member.id}
                    label={member.name}
                    count={optionCount.assignee[member.id] ?? 0}
                  />
                ))}
              </Group>

              {data.canRoute && members.length > 0 && (
                <Group title="Has access to">
                  {members.map((member) => (
                    <Option
                      key={member.id}
                      href={inboxHref(filters, {
                        user: filters.user === member.id ? null : member.id,
                      })}
                      onNavigate={() => setOpen(false)}
                      active={filters.user === member.id}
                      label={member.name}
                      count={member.roomCount}
                    />
                  ))}
                </Group>
              )}
            </div>

            <footer className="shrink-0 border-t border-line p-3">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="w-full rounded-[--radius-sm] bg-action px-4 py-2 text-[13.5px] font-semibold text-action-ink"
              >
                Show {rooms.length} conversation{rooms.length === 1 ? '' : 's'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  )
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3">
      <h3 className="mb-2 text-[9.5px] font-semibold uppercase tracking-[0.13em] text-faint">
        {title}
      </h3>
      <div className="space-y-0.5">{children}</div>
    </section>
  )
}

function Option({
  href,
  onNavigate,
  active,
  label,
  count,
  avatar,
  radio = false,
}: {
  href: string
  onNavigate: () => void
  active: boolean
  label: string
  count: number
  avatar?: { id: string; label: string }
  radio?: boolean
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'true' : undefined}
      className="flex items-center gap-2.5 py-1 text-[12.5px] text-soft hover:text-ink"
    >
      <span
        aria-hidden
        className={[
          'flex h-[15px] w-[15px] shrink-0 items-center justify-center border-[1.5px]',
          radio ? 'rounded-full' : 'rounded-[4px]',
          active ? 'border-accent bg-accent text-accent-ink' : 'border-line-strong',
        ].join(' ')}
      >
        {active && (
          <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 fill-none stroke-current" strokeWidth="3.5">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        )}
      </span>
      {avatar && <ProfileAvatar profileId={avatar.id} label={avatar.label} size="xs" />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="tabular shrink-0 text-[11px] text-faint">{count}</span>
    </Link>
  )
}

function FilterIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 shrink-0 fill-none stroke-current"
      strokeWidth="1.8"
      strokeLinecap="round"
    >
      <path d="M3 6h18M6 12h12M10 18h4" />
    </svg>
  )
}
