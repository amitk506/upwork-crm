import Link from 'next/link'

import { AppShell } from '@/components/app-shell'
import { AutoRefresh } from '@/components/auto-refresh'
import { ProfileAvatar } from '@/components/profile-avatar'
import { Empty, PageHead, Panel, buttonClass } from '@/components/ui'
import { requireUser } from '@/lib/auth'
import { formatTime } from '@/lib/format'
import { identityStyle } from '@/lib/identity'
import { can } from '@/lib/permissions'
import { createClient } from '@/lib/supabase/server'

/**
 * The operator's home: what needs attention right now, not a status report.
 *
 * Deliberately short. Anyone who opens this is on their way to the inbox — the
 * job of this screen is to tell them where to go first, and get out of the way.
 */
export default async function HomePage() {
  const user = await requireUser()
  const supabase = await createClient()

  const [{ data: rooms }, { data: approvals }, { data: profiles }, { data: recent }] =
    await Promise.all([
      supabase.from('up_rooms').select('room_id, num_unread, fetched_at'),
      supabase
        .from('outbound_drafts')
        .select('id')
        .eq('owner_id', user.id)
        .eq('status', 'pending'),
      supabase.from('v_profile_room_counts').select('*').order('profile_label'),
      supabase
        .from('v_activity')
        .select('id, actor_name, action, room_name, created_at')
        .eq('action', 'inbox.replied')
        .order('created_at', { ascending: false })
        .limit(5),
    ])

  const roomList = rooms ?? []
  const unread = roomList.reduce((sum, r) => sum + (r.num_unread ?? 0), 0)
  const unreadRooms = roomList.filter((r) => (r.num_unread ?? 0) > 0).length
  const waiting = (approvals ?? []).length
  const lastSync = roomList.reduce<string | null>(
    (acc, r) => (!acc || r.fetched_at > acc ? r.fetched_at : acc),
    null,
  )

  const firstName = user.full_name?.split(' ')[0]

  return (
    <AppShell user={user}>
      <AutoRefresh seconds={30} />

      <PageHead
        title={`Good to see you${firstName ? `, ${firstName}` : ''}`}
        meta={
          lastSync ? (
            <>
              Conversations synced <span className="tabular">{formatTime(lastSync)}</span> — the
              portal keeps itself up to date.
            </>
          ) : (
            'Nothing synced yet.'
          )
        }
      />

      {(profiles ?? []).length === 0 ? (
        <Empty
          title="No Upwork profiles connected"
          href={can(user, 'team:manage') ? '/profiles' : undefined}
          cta="Connect a profile"
        >
          The portal holds the agency&apos;s Upwork identities centrally. Once one is connected,
          its conversations appear in the inbox.
        </Empty>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Link
              href="/inbox"
              className="group rounded-[--radius] border border-line bg-surface p-4 transition-colors hover:bg-sunk"
            >
              <p className="text-xs uppercase tracking-[0.12em] text-faint">Unread</p>
              <p className="tabular mt-1 text-3xl font-semibold leading-none">{unread}</p>
              <p className="mt-1.5 text-sm text-soft">
                across <span className="tabular">{unreadRooms}</span> conversation
                {unreadRooms === 1 ? '' : 's'}
              </p>
            </Link>

            <Link
              href="/approvals"
              className="group rounded-[--radius] border border-line bg-surface p-4 transition-colors hover:bg-sunk"
            >
              <p className="text-xs uppercase tracking-[0.12em] text-faint">Waiting on you</p>
              <p
                className={`tabular mt-1 text-3xl font-semibold leading-none ${waiting > 0 ? 'text-warn' : ''}`}
              >
                {waiting}
              </p>
              <p className="mt-1.5 text-sm text-soft">
                {waiting === 0
                  ? 'No replies need your approval'
                  : `repl${waiting === 1 ? 'y' : 'ies'} to send from your profile`}
              </p>
            </Link>
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <Panel title="Identities" hint="Every Upwork profile the portal holds.">
              <ul className="space-y-2">
                {(profiles ?? []).map((p) => (
                  <li key={p.profile_id}>
                    <Link
                      href={`/inbox?profile=${p.profile_id}`}
                      style={identityStyle(p.profile_id)}
                      className="flex items-center gap-2.5 text-sm transition-colors hover:text-ink"
                    >
                      <ProfileAvatar profileId={p.profile_id} label={p.profile_label} size="sm" />
                      <span className="truncate">{p.profile_label}</span>
                      <span className="tabular ml-auto text-xs text-faint">{p.room_count}</span>
                      {p.unread_rooms > 0 && (
                        <span className="tabular rounded-full bg-[color:var(--identity)] px-1.5 text-[10px] font-medium text-white">
                          {p.unread_rooms}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel
              title="Latest replies"
              hint="Who answered a client most recently."
              action={
                <Link href="/activity" className={buttonClass('quiet', 'sm')}>
                  All activity
                </Link>
              }
            >
              {(recent ?? []).length === 0 ? (
                <p className="text-sm text-soft">No replies sent from the portal yet.</p>
              ) : (
                <ul className="space-y-2">
                  {(recent ?? []).map((r) => (
                    <li key={r.id} className="flex items-baseline gap-2 text-sm">
                      <span className="font-medium">{r.actor_name}</span>
                      <span className="text-soft">→</span>
                      <span className="truncate text-soft">{r.room_name ?? 'a conversation'}</span>
                      <span className="tabular ml-auto shrink-0 text-[11px] text-faint">
                        {formatTime(r.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        </>
      )}
    </AppShell>
  )
}
