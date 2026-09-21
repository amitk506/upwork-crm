import { formatDate } from '@/lib/format'
import { formatWait, type WaitLevel } from '@/lib/wait'
import type { InboxRoom } from '@/lib/inbox-data'
import { shortName } from '@/lib/inbox-filters'

/**
 * How each person is doing on the one thing this portal measures.
 *
 * Split into two halves on purpose, because they have different evidence behind
 * them and conflating them would be dishonest:
 *
 *   RIGHT NOW  — how many clients are waiting on each person, and for how long.
 *                Derived from live state, so it is complete and needs no history.
 *
 *   OVER TIME  — how quickly they answer. This can only be measured at the moment
 *                a reply is sent, because Upwork's 24h caching rule means the
 *                inbound message it answers is gone soon after. So it accumulates
 *                forward from the day the measurement was added, and the panel
 *                says so rather than showing a confident average over four
 *                samples.
 *
 * No chart library: a proportional bar and a stacked strip carry this better than
 * a canvas would at this size, and the page stays self-contained.
 */

export type ReplyRecord = {
  actorId: string | null
  actorName: string | null
  waitedSeconds: number | null
  level: WaitLevel | null
  createdAt: string
}

const LEVEL_ORDER: WaitLevel[] = ['fresh', 'watch', 'late', 'breached']
const LEVEL_STYLE: Record<WaitLevel, { bg: string; label: string }> = {
  fresh: { bg: 'bg-ok', label: 'under 2h' },
  watch: { bg: 'bg-watch', label: '2–6h' },
  late: { bg: 'bg-warn', label: '6–24h' },
  breached: { bg: 'bg-stop', label: 'over 24h' },
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2)
}

export function PerformancePanel({
  waiting,
  replies,
  measuringSince,
  windowDays,
}: {
  /** Conversations still awaiting a reply, for the live half. */
  waiting: InboxRoom[]
  /** inbox.replied entries in the window, for the historical half. */
  replies: ReplyRecord[]
  /** When reply timing started being recorded. Null if nothing yet. */
  measuringSince: string | null
  windowDays: number
}) {
  // ---- right now -----------------------------------------------------------
  const load = new Map<string, { name: string; waiting: number; breached: number; longest: number }>()
  for (const room of waiting) {
    if (!room.wait.awaiting) continue
    const key = room.assignee?.id ?? 'unassigned'
    const name = room.assignee?.name ?? 'Nobody assigned'
    const row = load.get(key) ?? { name, waiting: 0, breached: 0, longest: 0 }
    row.waiting++
    if (room.wait.level === 'breached') row.breached++
    row.longest = Math.max(row.longest, room.wait.seconds)
    load.set(key, row)
  }
  const loadRows = [...load.entries()]
    .map(([id, row]) => ({ id, ...row }))
    .sort((a, b) => b.longest - a.longest)
  const heaviest = Math.max(1, ...loadRows.map((r) => r.waiting))

  // ---- over time -----------------------------------------------------------
  const byPerson = new Map<string, { name: string; sent: number; timed: number[]; levels: WaitLevel[] }>()
  for (const reply of replies) {
    const key = reply.actorId ?? 'system'
    const row = byPerson.get(key) ?? {
      name: reply.actorName ?? 'System',
      sent: 0,
      timed: [],
      levels: [],
    }
    row.sent++
    if (reply.waitedSeconds !== null) row.timed.push(reply.waitedSeconds)
    if (reply.level) row.levels.push(reply.level)
    byPerson.set(key, row)
  }
  const people = [...byPerson.values()]
    .map((p) => ({ ...p, median: median(p.timed) }))
    .sort((a, b) => (a.median ?? Infinity) - (b.median ?? Infinity) || b.sent - a.sent)

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <section className="overflow-hidden rounded-[--radius] border border-line bg-surface">
        <header className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-[-0.015em]">Who is being waited on</h2>
          <p className="text-[11px] text-faint">Right now</p>
        </header>

        {loadRows.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12.5px] text-faint">
            Nobody has a client waiting.
          </p>
        ) : (
          <ul className="space-y-3 px-4 py-3">
            {loadRows.map((row) => (
              <li key={row.id} className="grid grid-cols-[7.5rem_minmax(0,1fr)_auto] items-center gap-2.5">
                <span className="min-w-0">
                  <span
                    className={`block truncate text-[12px] font-medium ${
                      row.id === 'unassigned' ? 'text-stop' : ''
                    }`}
                  >
                    {row.name}
                  </span>
                  <span className="tabular block text-[10.5px] text-faint">
                    longest {formatWait(row.longest)}
                  </span>
                </span>

                <span className="h-[7px] overflow-hidden rounded-full bg-sunk-2">
                  <span
                    className={`block h-full rounded-full ${row.breached > 0 ? 'bg-stop' : 'bg-accent'}`}
                    style={{ width: `${Math.round((row.waiting / heaviest) * 100)}%` }}
                  />
                </span>

                <span className="tabular text-right text-[12px] font-semibold">
                  {row.waiting}
                  {row.breached > 0 && (
                    <span className="ml-1 text-[10.5px] font-semibold text-stop">
                      {row.breached} over 24h
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        <p className="border-t border-line px-4 py-2 text-[11px] text-faint">
          Live state, so this is complete. A high number is not automatically a problem — it may
          just be a big book of clients.
        </p>
      </section>

      <section className="overflow-hidden rounded-[--radius] border border-line bg-surface">
        <header className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-[-0.015em]">How fast people answer</h2>
          <p className="text-[11px] text-faint">Last {windowDays} days</p>
        </header>

        {people.length === 0 ? (
          <p className="px-4 py-8 text-center text-[12.5px] text-faint">
            No replies sent from the portal in this window.
          </p>
        ) : (
          <ul className="space-y-3 px-4 py-3">
            {people.map((person) => (
              <li key={person.name}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[12px] font-medium">{shortName(person.name)}</span>
                  <span className="tabular shrink-0 text-[12px] font-semibold">
                    {person.median === null ? (
                      <span className="text-[11px] font-normal text-faint">not measured yet</span>
                    ) : (
                      formatWait(person.median)
                    )}
                  </span>
                </div>

                {/* Where their replies landed on the ramp — the shape matters more
                    than the median when the sample is small. */}
                <div className="mt-1 flex h-[7px] gap-px overflow-hidden rounded-full bg-sunk-2">
                  {LEVEL_ORDER.map((level) => {
                    const n = person.levels.filter((l) => l === level).length
                    if (n === 0) return null
                    return (
                      <span
                        key={level}
                        title={`${n} answered ${LEVEL_STYLE[level].label}`}
                        className={LEVEL_STYLE[level].bg}
                        style={{ width: `${(n / person.levels.length) * 100}%` }}
                      />
                    )
                  })}
                </div>

                <p className="tabular mt-1 text-[10.5px] text-faint">
                  {person.sent} {person.sent === 1 ? 'reply' : 'replies'}
                  {person.timed.length > 0 && ` · ${person.timed.length} timed`}
                  {person.timed.length > 0 &&
                    person.timed.length < 5 &&
                    ' · too few to read much into'}
                </p>
              </li>
            ))}
          </ul>
        )}

        <p className="border-t border-line px-4 py-2 text-[11px] text-faint">
          {measuringSince
            ? `Reply speed is recorded when a reply is sent, so this covers messages sent since ${formatDate(measuringSince)}.`
            : 'Reply speed is recorded at the moment a reply is sent. Nothing has been measured yet — the figures fill in as the team replies from the portal.'}{' '}
          Overnight hours are excluded, so nobody is marked slow for time nobody was working.
        </p>
      </section>
    </div>
  )
}

export const LEVEL_LEGEND = LEVEL_STYLE
