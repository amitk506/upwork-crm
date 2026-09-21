import Link from 'next/link'

import { AppShell } from '@/components/app-shell'
import { AutoRefresh } from '@/components/auto-refresh'
import { ProfileAvatar } from '@/components/profile-avatar'
import { SyncButton } from '@/components/sync-button'
import { SyncGapNotice } from '@/components/sync-gap-notice'
import { PerformancePanel } from '@/components/performance-panel'
import { WaitMeter } from '@/components/wait-meter'
import { PageHead } from '@/components/ui'
import { requireCapability } from '@/lib/auth'
import {
  averageWaitSeconds,
  formatWait,
  istTodayStartISO,
  sinceDaysAgoISO,
  waitSortKey,
  type WaitLevel,
} from '@/lib/wait'
import { loadInbox, shortName, type InboxRoom } from '@/lib/inbox-data'
import { createClient } from '@/lib/supabase/server'

/**
 * The board.
 *
 * Not a metrics wall. Four figures a manager can act on, then the only two lists
 * that lead anywhere: who has been waiting longest, and which profiles nobody is
 * watching. Every number here is derived from data the portal actually holds —
 * see averageWaitSeconds() for the one figure this deliberately does NOT show.
 *
 * Scope follows seniority without this page arranging it: replies are read
 * through v_activity, which migration 0020 filters by can_see_activity_of(), so
 * an owner sees everyone and a manager sees their own plus the people below them.
 */
/** How far back the performance panel looks. */
const PERFORMANCE_WINDOW_DAYS = 30

export default async function BoardPage() {
  const user = await requireCapability('inbox:assign')
  const supabase = await createClient()

  const [data, { data: replies }, { data: gaps }, { data: history }] = await Promise.all([
    loadInbox(user, { profile: null, user: null, view: 'all', wait: null, assignee: null }),
    supabase
      .from('v_activity')
      .select('actor_id, actor_name, action, succeeded, created_at')
      .in('action', ['inbox.replied', 'inbox.reply_failed'])
      .gte('created_at', istTodayStartISO())
      .limit(1000),
    supabase.from('v_sync_gaps').select('*').maybeSingle(),
    // A longer window for the performance panel. Same view, so the same seniority
    // scoping applies — a manager sees their team, not the whole agency.
    supabase
      .from('v_activity')
      .select('actor_id, actor_name, payload, created_at')
      .eq('action', 'inbox.replied')
      .gte('created_at', sinceDaysAgoISO(PERFORMANCE_WINDOW_DAYS))
      .order('created_at', { ascending: true })
      .limit(5000),
  ])

  const { waiting, breached, unowned } = data
  const longest = [...waiting].sort((a, b) => waitSortKey(a.wait) - waitSortKey(b.wait))
  const average = averageWaitSeconds(waiting.map((r) => r.wait))

  // Replies today, by person.
  const byActor = new Map<string, { name: string; sent: number; failed: number }>()
  for (const entry of replies ?? []) {
    const id = entry.actor_id ?? 'system'
    const row = byActor.get(id) ?? {
      name: entry.actor_name ?? 'System',
      sent: 0,
      failed: 0,
    }
    if (entry.action === 'inbox.reply_failed' || entry.succeeded === false) row.failed++
    else row.sent++
    byActor.set(id, row)
  }
  const senders = [...byActor.values()].sort((a, b) => b.sent - a.sent)
  const busiest = Math.max(1, ...senders.map((s) => s.sent))

  // Coverage: a profile with conversations waiting and nobody granted is the
  // failure mode of a shared-inbox model, so it is the only red card here.
  const coverage = data.profiles
    .map((profile) => {
      const rooms = data.scoped.filter((r) => r.profile?.id === profile.profile_id)
      const roomsWaiting = rooms.filter((r) => r.wait.awaiting)
      return {
        id: profile.profile_id,
        label: profile.profile_label,
        waiting: roomsWaiting.length,
        uncovered: roomsWaiting.filter((r) => !r.assignee && !r.covered).length,
        watchers: new Set(rooms.map((r) => r.assignee?.id).filter(Boolean)).size,
      }
    })
    .sort((a, b) => b.uncovered - a.uncovered || b.waiting - a.waiting)

  // Timing only exists on replies sent after the measurement was added, so the
  // panel dates itself from the first one rather than implying full coverage.
  const timedReplies = (history ?? []).map((row) => {
    const payload = (row.payload ?? {}) as { waitedSeconds?: number; waitLevel?: string }
    return {
      actorId: row.actor_id,
      actorName: row.actor_name,
      waitedSeconds: typeof payload.waitedSeconds === 'number' ? payload.waitedSeconds : null,
      level: (payload.waitLevel as WaitLevel | undefined) ?? null,
      createdAt: row.created_at,
    }
  })
  const measuringSince = timedReplies.find((r) => r.waitedSeconds !== null)?.createdAt ?? null

  return (
    <AppShell user={user} breachedCount={breached.length}>
      <AutoRefresh />

      <PageHead
        title="Board"
        meta={
          <>
            {data.scoped.length === 0
              ? 'No conversations held yet.'
              : `${waiting.length} of ${data.scoped.length} conversations are waiting on the agency.`}{' '}
            Counts cover today in IST.
          </>
        }
      >
        <SyncButton />
      </PageHead>

      {gaps && (
        <div className="mb-4">
          <SyncGapNotice gaps={gaps} />
        </div>
      )}

      <div className="grid gap-px overflow-hidden rounded-[--radius] border border-line bg-line sm:grid-cols-2 xl:grid-cols-4">
        <Figure
          label="Waiting on us"
          value={waiting.length}
          detail={waiting.length === 0 ? 'Nothing outstanding' : 'Sorted below, worst first'}
        />
        <Figure
          label="Breached 24 hours"
          value={breached.length}
          detail={breached.length === 0 ? 'Nothing overdue' : 'Escalate to the profile owner'}
          alarm={breached.length > 0}
        />
        <Figure
          label="Nobody granted access"
          value={unowned.length}
          detail={unowned.length === 0 ? 'Every waiting chat has someone' : 'Grant these first'}
          alarm={unowned.length > 0}
        />
        <Figure
          label="Average wait outstanding"
          value={average === null ? '—' : formatWait(average)}
          detail={
            average === null
              ? 'Nobody waiting'
              : `Longest ${longest[0]?.wait.awaiting ? longest[0].wait.label : '—'}`
          }
        />
      </div>

      <div className="mt-4">
        <PerformancePanel
          waiting={waiting}
          replies={timedReplies}
          measuringSince={measuringSince}
          windowDays={PERFORMANCE_WINDOW_DAYS}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className="overflow-hidden rounded-[--radius] border border-line bg-surface">
          <header className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5">
            <h2 className="text-[13px] font-semibold tracking-[-0.015em]">Longest waits</h2>
            <p className="text-[11px] text-faint">Worst first · overnight not counted</p>
          </header>

          {longest.length === 0 ? (
            <p className="px-4 py-8 text-center text-[12.5px] text-faint">
              Every conversation has a reply after the client&apos;s last message.
            </p>
          ) : (
            <ul>
              {longest.slice(0, 12).map((room) => (
                <li key={room.roomId} className="border-b border-line last:border-b-0">
                  <Link
                    href={`/inbox/${room.roomId}`}
                    className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-sunk"
                  >
                    {room.profile && (
                      <ProfileAvatar
                        profileId={room.profile.id}
                        label={room.profile.label}
                        size="sm"
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-semibold">
                        {room.name}
                      </span>
                      <span className="block truncate text-[11px] text-faint">
                        {ownerLine(room)}
                      </span>
                    </span>
                    <WaitMeter state={room.wait} />
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {longest.length > 12 && (
            <p className="border-t border-line px-4 py-2 text-[11px] text-faint">
              Showing the 12 longest of <span className="tabular">{longest.length}</span>.{' '}
              <Link href="/inbox" className="underline underline-offset-2">
                Open the inbox
              </Link>{' '}
              for the rest.
            </p>
          )}
        </section>

        <div className="space-y-4">
          <section className="overflow-hidden rounded-[--radius] border border-line bg-surface">
            <header className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-[-0.015em]">Replies today</h2>
              <p className="text-[11px] text-faint">Since midnight IST</p>
            </header>

            {senders.length === 0 ? (
              <p className="px-4 py-6 text-center text-[12.5px] text-faint">
                Nothing sent from the portal yet today.
              </p>
            ) : (
              <ul className="space-y-2.5 px-4 py-3">
                {senders.map((person) => (
                  <li
                    key={person.name}
                    className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_2.25rem] items-center gap-2.5 text-[12px]"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{shortName(person.name)}</span>
                      {person.failed > 0 && (
                        <span className="tabular block text-[10.5px] text-stop">
                          {person.failed} failed
                        </span>
                      )}
                    </span>
                    <span className="h-[7px] overflow-hidden rounded-full bg-sunk-2">
                      <span
                        className="block h-full rounded-full bg-accent"
                        style={{ width: `${Math.round((person.sent / busiest) * 100)}%` }}
                      />
                    </span>
                    <span className="tabular text-right font-semibold">{person.sent}</span>
                  </li>
                ))}
              </ul>
            )}

            <p className="border-t border-line px-4 py-2 text-[11px] text-faint">
              Volume only. The portal keeps no reply history — Upwork&apos;s terms cap how long
              their message data may be held — so there is no time-to-reply average to show here.
            </p>
          </section>

          <section className="overflow-hidden rounded-[--radius] border border-line bg-surface">
            <header className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-2.5">
              <h2 className="text-[13px] font-semibold tracking-[-0.015em]">Coverage by profile</h2>
              <p className="text-[11px] text-faint">Who is watching what</p>
            </header>

            {coverage.length === 0 ? (
              <p className="px-4 py-6 text-center text-[12.5px] text-faint">
                No profiles connected yet.
              </p>
            ) : (
              <ul className="grid gap-2 p-3 sm:grid-cols-2">
                {coverage.map((profile) => (
                  <li
                    key={profile.id}
                    className={[
                      'flex flex-col gap-1.5 rounded-[--radius-sm] border px-2.5 py-2',
                      profile.uncovered > 0 ? 'border-stop/40 bg-stop-tint' : 'border-line',
                    ].join(' ')}
                  >
                    <span className="flex items-center gap-1.5 text-[11.5px] font-semibold">
                      <ProfileAvatar profileId={profile.id} label={profile.label} size="xs" />
                      <span className="truncate">{profile.label}</span>
                    </span>
                    <span
                      className={`text-[10.5px] ${profile.uncovered > 0 ? 'text-stop' : 'text-faint'}`}
                    >
                      {profile.uncovered > 0
                        ? `${profile.uncovered} waiting with nobody granted`
                        : profile.watchers > 0
                          ? `${profile.watchers} ${profile.watchers === 1 ? 'person' : 'people'} assigned`
                          : 'Nothing waiting'}
                    </span>
                    {profile.waiting > 0 && (
                      <span className="tabular text-[10.5px] text-soft">
                        {profile.waiting} waiting
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  )
}

function ownerLine(room: InboxRoom): string {
  const parts = [room.profile?.label]
  if (room.assignee) parts.push(room.assignee.name)
  else if (room.covered) parts.push('granted, not assigned')
  else parts.push('nobody granted access')
  if (room.wait.awaiting && room.wait.inferred) parts.push('approximate')
  return parts.filter(Boolean).join(' · ')
}

function Figure({
  label,
  value,
  detail,
  alarm = false,
}: {
  label: string
  value: string | number
  detail: string
  alarm?: boolean
}) {
  return (
    <div className="bg-surface px-4 py-3">
      <p className="text-[11.5px] text-faint">{label}</p>
      <p
        className={`tabular mt-1 text-[27px] font-semibold leading-none tracking-[-0.035em] ${
          alarm ? 'text-stop' : ''
        }`}
      >
        {value}
      </p>
      <p className="mt-1.5 truncate text-[11px] text-faint" title={detail}>
        {detail}
      </p>
    </div>
  )
}
