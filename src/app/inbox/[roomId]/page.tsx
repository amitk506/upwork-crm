import Link from 'next/link'
import { notFound } from 'next/navigation'

import { AppShell } from '@/components/app-shell'
import { AutoPull } from '@/components/auto-pull'
import { AutoRefresh } from '@/components/auto-refresh'
import { Composer } from '@/components/composer'
import { DetailsSheet } from '@/components/details-sheet'
import { DraftComposer } from '@/components/draft-composer'
import { FollowUp } from '@/components/follow-up'
import { JobPost } from '@/components/job-post'
import { ConversationList } from '@/components/conversation-list'
import { MessageScroller } from '@/components/message-scroller'
import { WaitMeter } from '@/components/wait-meter'
import { WaiveReply } from '@/components/waive-reply'
import { inboxHref, loadInbox, parseView, parseWait } from '@/lib/inbox-data'
import { matchJob } from '@/lib/upwork/job-match'
import {
  ThreadStream,
  type StreamMessage,
  type StreamNote,
} from '@/components/thread-stream'
import { PendingDrafts } from '@/components/pending-drafts'
import { ActivityFeed, type ActivityEntry } from '@/components/activity-feed'
import { RoomAccessPanel } from '@/components/room-access-panel'
import { ThreadSidebar } from '@/components/thread-sidebar'
import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { allowedWriteTools } from '@/lib/upwork/limits'
import { can } from '@/lib/permissions'
import { ProfileAvatar } from '@/components/profile-avatar'
import { Panel } from '@/components/ui'

export default async function ThreadPage({
  params,
  searchParams,
}: {
  params: Promise<{ roomId: string }>
  searchParams: Promise<{
    profile?: string
    user?: string
    view?: string
    wait?: string
    assignee?: string
  }>
}) {
  const { roomId } = await params
  const {
    profile: profileParam,
    user: memberParam,
    view,
    wait: waitParam,
    assignee: assigneeParam,
  } = await searchParams
  const user = await requireUser()
  const supabase = await createClient()

  const { data: room } = await supabase
    .from('up_rooms')
    .select('room_id, room_name, topic, num_users')
    .eq('room_id', roomId)
    .maybeSingle()

  // RLS already hides rooms assigned to someone else, so "not found" here also
  // covers "not yours" — deliberately indistinguishable.
  if (!room) notFound()

  const [
    { data: messages },
    { data: notes },
    { data: members },
    { data: assignment },
    { data: participants },
    { data: roomProfiles },
    { data: chatGrants },
    { data: roomActivity },
    { data: proposals },
    { data: followup },
    { data: pendingDrafts },
  ] = await Promise.all([
      supabase
        .from('up_messages')
        .select(
          'story_id, author_name, is_outbound, is_system, body, attachments, sent_at, author_id, direction, direction_source',
        )
        .eq('room_id', roomId)
        .order('sent_at', { ascending: true })
        .limit(200),
      supabase
        .from('internal_notes')
        .select('id, body, created_at, author_id')
        .eq('target_type', 'room')
        .eq('target_id', roomId)
        .order('created_at', { ascending: false }),
      supabase.from('app_users').select('id, full_name, email').eq('is_active', true),
      supabase
        .from('assignments')
        .select('assigned_to')
        .eq('target_type', 'room')
        .eq('target_id', roomId)
        .maybeSingle(),
      // Who can actually act in this room — their own Upwork account has seen it.
      supabase.from('v_room_participants').select('*').eq('room_id', roomId),
      supabase
        .from('v_room_profiles')
        .select('profile_id, profile_label, send_requires_approval')
        .eq('room_id', roomId),
      supabase.from('room_grants').select('user_id, can_send').eq('room_id', roomId),
      supabase
        .from('v_activity')
        .select('*')
        .eq('target_type', 'room')
        .eq('target_id', roomId)
        .order('created_at', { ascending: false })
        .limit(30),
      // Proposals are agency-wide and small, so this is a plain read rather than
      // a per-room lookup — the title match happens in memory.
      supabase
        .from('up_proposals')
        .select('proposal_id, job_id, job_title, status, status_label, rate_amount, rate_currency, created_at_upwork')
        .limit(500),
      supabase
        .from('v_followups')
        .select('*')
        .eq('room_id', roomId)
        .is('done_at', null)
        .maybeSingle(),
      supabase
        .from('outbound_drafts')
        .select('*')
        .eq('room_id', roomId)
        .eq('status', 'pending')
        .order('created_at', { ascending: true }),
    ])

  // One row per MEMBER. The view unions profile and per-chat grants, so someone
  // holding several profiles that all reach this room appears more than once;
  // keep the entry that permits sending.
  type Participant = NonNullable<typeof participants>[number]
  const participantList = Object.values(
    (participants ?? []).reduce<Record<string, Participant>>((acc, p) => {
      const existing = acc[p.user_id]
      if (!existing || (p.can_send && !existing.can_send)) acc[p.user_id] = p
      return acc
    }, {}),
  )

  const perChatUsers = new Set((chatGrants ?? []).map((g) => g.user_id))
  const accessGrants = participantList.map((p) => ({
    userId: p.user_id,
    canSend: p.can_send,
    viaProfile: p.profile_label,
    perChat: perChatUsers.has(p.user_id),
  }))
  // Replies go out from the sender's OWN Upwork account, so three things must
  // hold: the role permits sending, the portal's write allowlist includes
  // send_message, and this person's Upwork account is actually in the thread.
  // Access comes from grants, not from the member having their own Upwork
  // login — under central profiles they never authenticate to Upwork at all.
  const myGrant = participantList.find((p) => p.user_id === user.id)

  // Which identity this member would be speaking through here. Falls back to
  // the profile that owns the conversation so the header still says whose
  // thread this is, even for someone who can only read it.
  const actingProfile = myGrant
    ? { id: myGrant.profile_id, label: myGrant.profile_label }
    : ((roomProfiles ?? [])[0]
        ? { id: roomProfiles![0]!.profile_id, label: roomProfiles![0]!.profile_label }
        : null)

  // Whether this profile's holder wants to read replies before they go out. Read
  // HERE rather than discovered inside sendReply(): the composer used to offer an
  // enabled Send button, take the click and then refuse, which presents a
  // deliberate policy as a failure. Off by default since 0025.
  const requiresApproval = Boolean(
    (roomProfiles ?? []).find((p) => p.profile_id === actingProfile?.id)
      ?.send_requires_approval,
  )
  const hasRoomAccess = Boolean(myGrant?.can_send)
  const canSend =
    can(user, 'inbox:send') && allowedWriteTools().has('send_message') && hasRoomAccess

  const blockedReason = !can(user, 'inbox:send')
    ? 'Your role cannot send replies.'
    : !myGrant
      ? 'You have not been granted access to this conversation. An owner grants it under Profiles.'
      : !myGrant.can_send
        ? 'Your access to this conversation is read-only.'
        : null
  const memberNames = new Map(
    (members ?? []).map((m) => [m.id, m.full_name || m.email] as const),
  )

  // The same column the inbox renders, so stepping into a conversation does not
  // reshuffle the list under the cursor.
  const inbox = await loadInbox(user, {
    profile: profileParam ?? null,
    user: memberParam ?? null,
    view: parseView(view),
    wait: parseWait(waitParam),
    assignee: assigneeParam ?? null,
  })

  const wait = inbox.scoped.find((r) => r.roomId === roomId)?.wait ?? null

  const jobMatch = matchJob(
    room.topic,
    (proposals ?? []).map((p) => ({
      proposalId: p.proposal_id,
      jobId: p.job_id,
      jobTitle: p.job_title,
      status: p.status,
      statusLabel: p.status_label,
      rateAmount: p.rate_amount,
      rateCurrency: p.rate_currency,
      createdAt: p.created_at_upwork,
    })),
  )

  // One panel, two placements. Defined once so the sheet on a phone and the
  // column on a wide screen can never drift apart.
  const contextPanels = (
    <>
            <JobPost match={jobMatch} />

            <FollowUp roomId={roomId} existing={followup ?? null} />

            <ThreadSidebar
              roomId={roomId}
              members={members ?? []}
              assignedTo={assignment?.assigned_to ?? null}
              currentUserId={user.id}
              canAssign={can(user, 'inbox:assign')}
              participantIds={participantList.map((p) => p.user_id)}
            />

            <RoomAccessPanel
              roomId={roomId}
              members={members ?? []}
              profiles={(roomProfiles ?? []).map((p) => ({
                id: p.profile_id,
                label: p.profile_label,
              }))}
              grants={accessGrants}
              canManage={can(user, 'inbox:assign')}
            />

            <Panel title="Activity" hint="Who replied here, and what changed.">
              <div className="max-h-64 overflow-y-auto">
                <ActivityFeed
                  entries={(roomActivity ?? []) as ActivityEntry[]}
                  showRoom={false}
                  empty="Nothing recorded for this conversation yet."
                  people={Object.fromEntries(memberNames)}
                  profiles={Object.fromEntries(
                    (roomProfiles ?? []).map((p) => [p.profile_id, p.profile_label] as const),
                  )}
                />
              </div>
            </Panel>
    </>
  )

  return (
    <AppShell user={user} workspace breachedCount={inbox.breached.length}>
      <AutoRefresh />

      {/* Rail · list · thread · context. min-h-0 at every level is what lets the
          inner scrollers actually shrink instead of pushing the page taller. */}
      <div className="grid h-full min-h-0 lg:grid-cols-[336px_minmax(0,1fr)] xl:grid-cols-[336px_minmax(0,1fr)_320px]">
        <div className="hidden min-h-0 border-r border-line lg:block">
          <ConversationList data={inbox} selectedRoomId={roomId} />
        </div>

        <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface">
          <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3">
            <Link
              href={inboxHref(inbox.filters)}
              aria-label="Back to the inbox"
              className="shrink-0 text-soft transition-colors hover:text-ink lg:hidden"
            >
              <span aria-hidden>←</span>
            </Link>
            {actingProfile && (
              <ProfileAvatar profileId={actingProfile.id} label={actingProfile.label} size="md" />
            )}
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[14.5px] font-semibold tracking-[-0.018em]">
                {room.room_name ?? 'Conversation'}
              </h1>
              <p className="truncate text-[11.5px] text-faint">
                {[room.topic, actingProfile ? `via ${actingProfile.label}` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            {wait && <WaitMeter state={wait} />}
            {wait && <WaiveReply roomId={roomId} wait={wait} />}
            {/* Below 1280px the context column is hidden, so this is the only
                route to follow-ups, assignment and access. */}
            <DetailsSheet>{contextPanels}</DetailsSheet>
          </header>

          {/* The wait banner. Names who opened it and did not answer, because
              "someone should reply" is a weaker prompt than "you read this at
              11:04 and left it". */}
          {wait?.awaiting && wait.level !== 'fresh' && (
            <p
              className={[
                'flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-4 py-1.5 text-[11.5px] font-medium',
                wait.level === 'breached' ? 'bg-stop-tint text-stop' : 'bg-warn-tint text-warn',
              ].join(' ')}
            >
              {room.room_name ?? 'This client'} has been waiting{' '}
              <span className="tabular font-semibold">{wait.label}</span>
              {wait.inferred && <span className="font-normal">· approximate attribution</span>}
            </p>
          )}

          {/* The stream scrolls; the header above and the composer below stay
              put however long the conversation runs. */}
          {/* No overflow here: MessageScroller owns the scrolling viewport, and
              nesting two of them gives you a scrollbar inside a scrollbar and
              breaks its jump-to-latest. */}
          <div className="flex min-h-0 flex-1 flex-col">
            {/* Opening a conversation is the request — nobody should have to ask
                twice for the messages they just clicked on. */}
            <AutoPull roomId={roomId} hasMessages={(messages ?? []).length > 0} />

            <MessageScroller>
              <ThreadStream
                messages={(messages ?? []) as StreamMessage[]}
                notes={(notes ?? []) as StreamNote[]}
                memberNames={memberNames}
                clientName={room.room_name ?? 'Client'}
                actingProfile={actingProfile}
                roomId={roomId}
              />
            </MessageScroller>
          </div>

          <div className="shrink-0 border-t border-line px-4 pb-3 pt-3">
            <PendingDrafts
              drafts={pendingDrafts ?? []}
              currentUserId={user.id}
              memberNames={Object.fromEntries(memberNames)}
            />

            {canSend && !requiresApproval ? (
              <Composer
                roomId={roomId}
                canSend
                blockedReason={null}
                actingProfile={actingProfile}
                senderName={user.full_name || user.email}
              />
            ) : canSend && requiresApproval ? (
              // Granted to send, but this profile's holder reviews first. Same
              // draft flow, different reason — and said before you type, not after.
              <DraftComposer
                roomId={roomId}
                approvers={participantList.map((p) => ({
                  id: p.user_id,
                  name: p.full_name || p.email,
                }))}
                reason={`${actingProfile?.label ?? 'This profile'} reviews replies before they go out, so this goes to their approvals queue.`}
              />
            ) : can(user, 'inbox:send') && !hasRoomAccess ? (
              // They may reply, but not from their own profile in this thread —
              // so offer to write it for someone who can send it.
              <DraftComposer
                roomId={roomId}
                approvers={participantList.map((p) => ({
                  id: p.user_id,
                  name: p.full_name || p.email,
                }))}
                reason="You cannot send in this conversation from a profile you hold."
              />
            ) : (
              <Composer
                roomId={roomId}
                canSend={false}
                blockedReason={blockedReason}
                actingProfile={actingProfile}
                senderName={user.full_name || user.email}
              />
            )}

            <p className="mt-2 text-[11px] text-faint">
              Upwork does not name the sender. Replies sent from this portal are exact; everything
              else is worked out from the conversation and labelled — <em>approximate</em> where it
              rests on turn-taking rather than a signal we can trust.
            </p>
          </div>
        </div>

        {/* Context. First column to go when the viewport narrows — you can work
            without it, and you cannot work without the thread. */}
        <aside className="hidden min-h-0 space-y-3 overflow-y-auto border-l border-line bg-surface p-3 xl:block">
          {contextPanels}
        </aside>
      </div>
    </AppShell>
  )
}
