import { notFound } from 'next/navigation'

import { AutoRefresh } from '@/components/auto-refresh'
import { safeEqual } from '@/lib/crypto'
import { serverEnv } from '@/lib/env'
import { formatTime } from '@/lib/format'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchWhatsAppWaiting } from '@/lib/whatsapp-feed'
import { formatWait, waitState, waitSortKey, type WaitState } from '@/lib/wait'

/**
 * The departure board.
 *
 * Meant for a screen on the office wall and for a phone at a glance: who is
 * waiting on us, and how long. No login, because a wall display cannot sign in,
 * and because the point is that nobody has to.
 *
 * Two decisions worth stating plainly.
 *
 * THE URL IS THE CREDENTIAL. Anyone holding it sees your client names and how
 * long each has waited. That is the trade the request asked for, so the secret is
 * a long path segment rather than a guessable /status, it is compared in constant
 * time, and the page exists at all only when the token is configured. Anyone who
 * gets the link has it until the token is rotated.
 *
 * IT READS THROUGH THE SERVICE ROLE, DELIBERATELY. The obvious shortcut — open a
 * view to anonymous PostgREST — would expose the same data to the entire
 * internet with no token at all, which is exactly the failure this codebase has
 * already had once. Reading server-side keeps every table and view closed.
 */

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Waiting on us',
  robots: { index: false, follow: false, nocache: true },
}

type Line = {
  roomId: string
  client: string
  project: string | null
  profile: string | null
  owner: string | null
  wait: WaitState
  /** Which inbox this came from, so one board can carry both. */
  source: 'upwork' | 'whatsapp'
}

export default async function StatusBoard({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const expected = serverEnv().STATUS_BOARD_TOKEN

  // No token configured means no board. A 404 rather than a message, so a wrong
  // or stale link says nothing about whether the page exists.
  if (!expected || !safeEqual(token, expected)) notFound()

  const supabase = createAdminClient()
  const now = new Date()

  // Fetched alongside Upwork rather than after it, so the slower of the two sets
  // the page's latency instead of the sum.
  const whatsappPromise = fetchWhatsAppWaiting()

  const [{ data: states }, { data: rooms }, { data: roomProfiles }, { data: assignments }, { data: members }] =
    await Promise.all([
      supabase
        .from('room_reply_state')
        .select('room_id, awaiting_since, last_outbound_at, attribution, all_unknown, waived_for')
        .not('awaiting_since', 'is', null),
      supabase.from('up_rooms').select('room_id, room_name, topic'),
      supabase.from('v_room_profiles').select('room_id, profile_label'),
      supabase.from('assignments').select('target_id, assigned_to').eq('target_type', 'room'),
      supabase.from('app_users').select('id, full_name, email'),
    ])

  const roomById = new Map((rooms ?? []).map((r) => [r.room_id, r] as const))
  const profileByRoom = new Map((roomProfiles ?? []).map((p) => [p.room_id, p.profile_label] as const))
  const assigneeByRoom = new Map((assignments ?? []).map((a) => [a.target_id, a.assigned_to] as const))
  const memberName = new Map((members ?? []).map((m) => [m.id, m.full_name || m.email] as const))

  const lines: Line[] = (states ?? [])
    .map((state) => {
      const wait = waitState(
        {
          awaiting_reply: true,
          waiting_since: state.awaiting_since,
          last_outbound_at: state.last_outbound_at,
          waiting_source: state.attribution,
          direction_unknown: state.all_unknown,
          // A waiver still pinned to this exact message hides the row, the same
          // rule the inbox uses — the view cannot help us here, so it is applied
          // by hand rather than showing a wait somebody already dismissed.
          waived: state.waived_for !== null && state.waived_for === state.awaiting_since,
        },
        now,
      )
      const room = roomById.get(state.room_id)
      const assignee = assigneeByRoom.get(state.room_id)
      return {
        roomId: state.room_id,
        client: room?.room_name ?? 'Conversation',
        project: room?.topic ?? null,
        profile: profileByRoom.get(state.room_id) ?? null,
        owner: assignee ? (memberName.get(assignee) ?? null) : null,
        wait,
        source: 'upwork' as const,
      }
    })
    .filter((line) => line.wait.awaiting)

  // WhatsApp rows are timed by the SAME wait logic rather than trusting a number
  // computed elsewhere, so both channels share one definition of "late".
  const whatsapp = await whatsappPromise
  const whatsappLines: Line[] = whatsapp.rows
    .map((row) => ({
      roomId: 'wa:' + row.id,
      client: row.client,
      project: row.project,
      profile: row.profile,
      owner: row.owner,
      wait: waitState(
        {
          awaiting_reply: true,
          waiting_since: row.waitingSince,
          last_outbound_at: null,
          waiting_source: 'whatsapp',
          direction_unknown: false,
        },
        now,
      ),
      source: 'whatsapp' as const,
    }))
    .filter((line) => line.wait.awaiting)

  const allLines = [...lines, ...whatsappLines].sort(
    (a, b) => waitSortKey(a.wait) - waitSortKey(b.wait),
  )

  const breached = allLines.filter((l) => l.wait.awaiting && l.wait.level === 'breached').length
  const waCount = whatsappLines.length
  const upCount = lines.length

  return (
    <div className="min-h-screen bg-paper px-6 py-6 md:px-10 md:py-8">
      <AutoRefresh />

      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div>
          <h1 className="text-[28px] font-semibold leading-none tracking-[-0.035em] md:text-[34px]">
            Waiting on us
          </h1>
          <p className="mt-2 text-sm text-soft">
            Clients who spoke last and have not had a reply. Longest wait first.
          </p>
        </div>
        <div className="flex items-end gap-7">
          <Figure label="Waiting" value={allLines.length} />
          <Figure label="Over 24 hours" value={breached} alarm={breached > 0} />
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-[0.12em] text-faint">Updated</p>
            <p className="tabular mt-1 text-lg font-semibold">{formatTime(now.toISOString())}</p>
          </div>
        </div>
      </header>

      {allLines.length === 0 ? (
        <p className="py-24 text-center text-xl font-medium text-soft">
          Nobody is waiting. Everything has been answered.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-[color:var(--line)]">
          {allLines.map((line) => (
            <li
              key={line.roomId}
              className={`stripe grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 py-3 pl-4 md:grid-cols-[minmax(0,1fr)_11rem_7rem] ${
                line.wait.awaiting ? `sev-${line.wait.level}` : ''
              }`}
            >
              <div className="min-w-0">
                <p className="truncate text-[17px] font-semibold tracking-[-0.02em] md:text-[19px]">
                  <span
                    className="mr-2 rounded-full px-2 py-[2px] align-middle text-[10px] font-bold uppercase tracking-[0.08em]"
                    style={
                      line.source === 'whatsapp'
                        ? { background: 'rgba(14,124,102,0.14)', color: '#0E7C66' }
                        : { background: 'rgba(20,143,119,0.10)', color: 'var(--soft)' }
                    }
                  >
                    {line.source === 'whatsapp' ? 'WhatsApp' : 'Upwork'}
                  </span>
                  {line.client}
                </p>
                <p className="truncate text-[12.5px] text-faint">
                  {[line.profile, line.project].filter(Boolean).join(' · ') || 'No project set'}
                </p>
              </div>

              <p className="hidden truncate text-[13px] text-soft md:block">
                {line.owner ?? <span className="text-stop">Nobody assigned</span>}
              </p>

              <p
                className={`tabular text-right text-[20px] font-semibold tracking-[-0.03em] md:text-[24px] ${
                  line.wait.awaiting && line.wait.level === 'breached'
                    ? 'text-stop'
                    : line.wait.awaiting && line.wait.level === 'late'
                      ? 'text-warn'
                      : line.wait.awaiting && line.wait.level === 'watch'
                        ? 'text-watch'
                        : 'text-soft'
                }`}
              >
                {line.wait.awaiting ? formatWait(line.wait.seconds) : '—'}
              </p>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-6 text-[11px] text-faint">
        {whatsapp.configured
          ? whatsapp.reachable
            ? `${upCount} from Upwork, ${waCount} from WhatsApp. `
            : 'WhatsApp could not be reached, so only Upwork is shown. '
          : ''}
        Overnight hours between 10 PM and 8 AM IST are not counted. Refreshes on its own — leave it
        open. Anyone with this link can see this page, so treat the address as confidential.
      </p>
    </div>
  )
}

function Figure({ label, value, alarm = false }: { label: string; value: number; alarm?: boolean }) {
  return (
    <div className="text-right">
      <p className="text-[11px] uppercase tracking-[0.12em] text-faint">{label}</p>
      <p
        className={`tabular mt-1 text-[30px] font-semibold leading-none tracking-[-0.035em] ${
          alarm ? 'text-stop' : ''
        }`}
      >
        {value}
      </p>
    </div>
  )
}
