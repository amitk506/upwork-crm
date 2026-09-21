import Link from 'next/link'

import { ConversationRow } from '@/components/conversation-row'
import { FilterDrawer } from '@/components/filter-drawer'
import { activeFilterCount, inboxHref, INBOX_VIEWS, WAIT_BANDS } from '@/lib/inbox-filters'
import type { InboxData } from '@/lib/inbox-data'

/**
 * The conversation column — the one part of the workspace that never collapses.
 *
 * Same component on both routes, so moving from the triage panel into a thread
 * does not reshuffle the list under the cursor. The selected row is passed in
 * rather than read from the URL because only the page knows its own params.
 */
export function ConversationList({
  data,
  selectedRoomId,
}: {
  data: InboxData
  selectedRoomId?: string
}) {
  const { filters, rooms, tabCount, canRoute } = data
  const chips = activeChips(data)

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* One row, not two.
          The tabs and a separate strip of profile chips were two filter systems
          stacked in a 336px column, both scrolling sideways and both truncating.
          Profiles moved into the drawer, which already lists them with live
          counts — one tap further away, and the column is legible again. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-line pl-2 pr-2">
        <div className="flex min-w-0 flex-1 items-center gap-0.5">
          {INBOX_VIEWS.map((v) => {
            const active = v.key === filters.view
            const count = tabCount[v.key]
            return (
              <Link
                key={v.key}
                href={inboxHref(filters, { view: v.key })}
                aria-current={active ? 'page' : undefined}
                className={[
                  'flex items-baseline gap-1 whitespace-nowrap rounded-[--radius-sm] px-2 py-1.5 text-[12.5px]',
                  active ? 'bg-sunk font-semibold text-ink' : 'font-medium text-faint hover:text-soft',
                ].join(' ')}
              >
                {v.label}
                {/* Only where the number means work outstanding, and only when
                    there is any — a row of zeroes is noise. */}
                {v.countable && count > 0 && (
                  <span
                    className={`tabular text-[11px] font-semibold ${
                      v.key === 'waiting' ? 'text-stop' : 'text-faint'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </Link>
            )
          })}
        </div>

        <FilterDrawer data={data} />
      </div>

      {/* What the drawer is currently doing, kept visible and removable once it
          closes. A filter you cannot see is a filter you forget you set, and then
          the inbox looks like it has lost conversations. */}
      {chips.length > 0 && (
        <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-sunk px-3 py-2">
          {chips.map((chip) => (
            <Link
              key={chip.label}
              href={chip.clearHref}
              title={`Remove: ${chip.label}`}
              className="flex shrink-0 items-center gap-1.5 rounded-full border border-line-strong bg-surface py-0.5 pl-2.5 pr-1.5 text-[11.5px] font-medium"
            >
              {chip.label}
              <span aria-hidden className="text-[12px] font-bold leading-none text-faint">
                ×
              </span>
            </Link>
          ))}
          <span className="tabular ml-auto shrink-0 pl-2 text-[11px] text-faint">
            {rooms.length} of {data.scoped.length}
          </span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {rooms.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12.5px] text-faint">
            {emptyLine(data)}
          </p>
        ) : (
          <ul>
            {data.truncated && (
              <li className="border-b border-line bg-warn-tint px-4 py-2 text-[11.5px] text-warn">
                Showing the first {rooms.length.toLocaleString()} conversations. Counts above cover
                only these, so some waits may not be listed.
              </li>
            )}
            {rooms.map((room) => (
              <li key={room.roomId} className="border-b border-line last:border-b-0">
                <ConversationRow
                  roomId={room.roomId}
                  name={room.name}
                  topic={room.topic}
                  snippet={room.snippet}
                  unread={room.unread}
                  profile={room.profile}
                  wait={room.wait}
                  assignee={room.assignee}
                  showCoverage={canRoute}
                  selected={room.roomId === selectedRoomId}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function emptyLine(data: InboxData): string {
  if (activeFilterCount(data.filters) > 0) return 'Nothing matches these filters.'
  if (data.filters.view === 'waiting') return 'Nobody is waiting on a reply.'
  if (data.filters.view === 'unread') return 'Everything has been opened.'
  if (data.filters.view === 'mine') return 'Nothing is assigned to you yet.'
  return 'No conversations held yet.'
}



/** One removable chip per active drawer condition. */
function activeChips(data: InboxData): { label: string; clearHref: string }[] {
  const { filters, profiles, members } = data
  if (activeFilterCount(filters) === 0) return []

  const chips: { label: string; clearHref: string }[] = []

  if (filters.wait !== null) {
    chips.push({
      label: WAIT_BANDS.find((b) => b.hours === filters.wait)?.label ?? `Over ${filters.wait}h`,
      clearHref: inboxHref(filters, { wait: null }),
    })
  }

  if (filters.profile) {
    chips.push({
      label: profiles.find((p) => p.profile_id === filters.profile)?.profile_label ?? 'Profile',
      clearHref: inboxHref(filters, { profile: null }),
    })
  }

  if (filters.assignee) {
    chips.push({
      label:
        filters.assignee === 'none'
          ? 'Nobody granted access'
          : `Assigned to ${members.find((m) => m.id === filters.assignee)?.name ?? 'someone'}`,
      clearHref: inboxHref(filters, { assignee: null }),
    })
  }

  if (filters.user) {
    chips.push({
      label: `Access: ${members.find((m) => m.id === filters.user)?.name ?? 'someone'}`,
      clearHref: inboxHref(filters, { user: null }),
    })
  }

  return chips
}
