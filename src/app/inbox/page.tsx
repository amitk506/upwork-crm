import Link from 'next/link'

import { AppShell } from '@/components/app-shell'
import { AutoRefresh } from '@/components/auto-refresh'
import { ConversationList } from '@/components/conversation-list'
import { SyncButton } from '@/components/sync-button'
import { SyncGapNotice } from '@/components/sync-gap-notice'
import { WaitMeter } from '@/components/wait-meter'
import { Empty, PageHead } from '@/components/ui'
import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type { AppUser, FollowupView, SyncGaps } from '@/lib/database.types'
import { formatDate, formatTime } from '@/lib/format'
import { loadInbox, parseView, parseWait, type InboxData } from '@/lib/inbox-data'
import { can, INBOX_SCOPE_COPY, inboxScope } from '@/lib/permissions'
import { waitSortKey } from '@/lib/wait'

/**
 * The workspace with nothing selected.
 *
 * The middle column is not blank waiting for a click — it answers the question
 * you opened the app to ask. "Select a conversation" is a instruction the layout
 * already communicates, and spending the largest region of the screen on it
 * wastes the one moment when you have not yet decided what to work on.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{
    profile?: string
    user?: string
    view?: string
    wait?: string
    assignee?: string
  }>
}) {
  const user = await requireUser()
  const { profile, user: member, view, wait, assignee } = await searchParams

  const data = await loadInbox(user, {
    profile: profile ?? null,
    user: member ?? null,
    view: parseView(view),
    wait: parseWait(wait),
    assignee: assignee ?? null,
  })

  // Staff only by construction: v_sync_gaps filters on is_staff(), so this is
  // null for everyone else and the notice renders nothing.
  const supabase = await createClient()
  const [{ data: gaps }, { data: followups }] = await Promise.all([
    supabase.from('v_sync_gaps').select('*').maybeSingle(),
    // What this person owes a client today. Scoped to them: a shared list of
    // everyone's commitments is a list nobody treats as theirs.
    supabase
      .from('v_followups')
      .select('*')
      .is('done_at', null)
      .eq('for_user', user.id)
      .lte('due_at', new Date().toISOString())
      .order('due_at', { ascending: true })
      .limit(10),
  ])

  if (data.empty) {
    return (
      <AppShell user={user}>
        <PageHead title="Inbox" />
        <Empty
          title={can(user, 'team:manage') ? 'No Upwork profiles connected' : 'No access yet'}
          href={can(user, 'team:manage') ? '/profiles' : undefined}
          cta="Connect a profile"
        >
          {can(user, 'team:manage')
            ? 'The portal holds the agency’s Upwork profiles centrally. Once one is connected, its conversations appear here.'
            : 'You have not been given access to any conversations yet. Ask an owner to assign you the clients you handle — you will never need an Upwork login of your own.'}
        </Empty>
      </AppShell>
    )
  }

  return (
    <AppShell user={user} workspace breachedCount={data.breached.length}>
      <AutoRefresh />
      <div className="grid h-full min-h-0 lg:grid-cols-[336px_minmax(0,1fr)]">
        <div className="hidden min-h-0 border-r border-line lg:block">
          <ConversationList data={data} />
        </div>
        {/* Narrow screens get the list itself, since there is no thread to pair
            it with — the triage panel is the thing that gets dropped. */}
        <div className="min-h-0 lg:hidden">
          <ConversationList data={data} />
        </div>
        <div className="hidden min-h-0 overflow-y-auto lg:block">
          <Triage data={data} user={user} gaps={gaps} followups={followups ?? []} />
        </div>
      </div>
    </AppShell>
  )
}

function Triage({
  data,
  user,
  gaps,
  followups,
}: {
  data: InboxData
  user: AppUser
  gaps: SyncGaps | null
  followups: FollowupView[]
}) {
  const { waiting, breached, unowned, oldestSync } = data
  const worst = [...waiting].sort((a, b) => waitSortKey(a.wait) - waitSortKey(b.wait)).slice(0, 4)
  const firstName = (user.full_name || user.email).split(/\s+/)[0]

  return (
    <div className="flex h-full flex-col gap-4 bg-paper p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-[-0.028em]">
            {waiting.length === 0 ? `Nothing waiting, ${firstName}.` : `Hello, ${firstName}.`}
          </h1>
          <p className="mt-0.5 max-w-[52ch] text-[13px] text-soft">{summary(data)}</p>
        </div>
        <SyncButton />
      </div>

      <SyncGapNotice gaps={gaps} />

      {/* Above the waiting figures on purpose: a follow-up is something you
          promised, which outranks something you merely received. */}
      {followups.length > 0 && (
        <section className="overflow-hidden rounded-[--radius] border border-accent/35 bg-accent-tint">
          <h2 className="border-b border-accent/20 px-4 py-2 text-[11.5px] font-semibold text-accent">
            You said you would message {followups.length === 1 ? 'this client' : `${followups.length} clients`} today
          </h2>
          <ul>
            {followups.map((f) => (
              <li key={f.id} className="border-b border-accent/15 last:border-b-0">
                <Link
                  href={`/inbox/${f.room_id}`}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface/60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold">
                      {f.room_name ?? 'Conversation'}
                    </span>
                    {f.note && <span className="block truncate text-[11px] text-soft">{f.note}</span>}
                  </span>
                  <span className="tabular shrink-0 text-[11px] text-soft">
                    {formatDate(f.due_at)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-px overflow-hidden rounded-[--radius] border border-line bg-line sm:grid-cols-3">
        <Figure
          label="Waiting on us"
          value={waiting.length}
          detail={
            unowned.length > 0
              ? `${unowned.length} with nobody granted access`
              : 'All of them have someone'
          }
        />
        <Figure
          label="Breached 24 hours"
          value={breached.length}
          detail={breached.length === 0 ? 'Nothing overdue' : breached.map((b) => b.name).join(', ')}
          alarm={breached.length > 0}
        />
        <Figure
          label="Longest wait"
          value={worst[0]?.wait.awaiting ? worst[0].wait.label : '—'}
          detail={worst[0]?.name ?? 'Nobody waiting'}
        />
      </div>

      {worst.length > 0 && (
        <section className="overflow-hidden rounded-[--radius] border border-line bg-surface">
          <h2 className="border-b border-line px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.13em] text-faint">
            Clear these first
          </h2>
          <ul>
            {worst.map((room) => (
              <li key={room.roomId} className="border-b border-line last:border-b-0">
                <Link
                  href={`/inbox/${room.roomId}`}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-sunk"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-semibold">{room.name}</span>
                    <span className="block truncate text-[11px] text-faint">
                      {room.profile ? `${room.profile.label} · ` : ''}
                      {room.assignee ? room.assignee.name : 'Nobody assigned'}
                      {room.topic ? ` · ${room.topic}` : ''}
                    </span>
                  </span>
                  <WaitMeter state={room.wait} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-auto max-w-[64ch] text-[11px] text-faint">
        {INBOX_SCOPE_COPY[inboxScope(user)]} A conversation needs a reply when the client spoke
        last, whether or not anyone opened it. The clock pauses between 10 PM and 8 AM IST.
        {oldestSync && (
          <>
            {' Synced '}
            <span className="tabular">{formatTime(oldestSync)}</span>.
          </>
        )}
      </p>
    </div>
  )
}

function summary({ waiting, breached, unowned }: InboxData): string {
  if (waiting.length === 0) {
    return 'Every conversation you can see has a reply after the client’s last message.'
  }

  const parts = [
    `${waiting.length} ${waiting.length === 1 ? 'client is' : 'clients are'} waiting on a reply`,
  ]
  if (breached.length > 0) {
    parts.push(`${breached.length} for more than a day`)
  }
  if (unowned.length > 0) {
    parts.push(`${unowned.length} with nobody granted access`)
  }
  return `${parts.join(', ')}.`
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
