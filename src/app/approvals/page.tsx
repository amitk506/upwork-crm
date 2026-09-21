import Link from 'next/link'

import { AppShell } from '@/components/app-shell'
import { ApprovalCard } from '@/components/approval-card'
import { requireUser } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'

/**
 * The queue of replies waiting to go out from this person's Upwork profile.
 *
 * Only the addressed member sees their own queue — not managers, not owners.
 * The person whose name goes on the message is the one who decides to send it.
 */
export default async function ApprovalsPage() {
  const user = await requireUser()
  const supabase = createAdminClient()

  const { data: drafts } = await supabase
    .from('outbound_drafts')
    .select('*')
    .eq('owner_id', user.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })

  const list = drafts ?? []

  const [{ data: authors }, { data: rooms }] = await Promise.all([
    supabase.from('app_users').select('id, full_name, email'),
    supabase.from('up_rooms').select('room_id, room_name, topic'),
  ])

  const authorName = new Map(
    (authors ?? []).map((a) => [a.id, a.full_name || a.email] as const),
  )
  const roomInfo = new Map(
    (rooms ?? []).map((r) => [r.room_id, { name: r.room_name, topic: r.topic }] as const),
  )

  return (
    <AppShell user={user}>
      <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
      <p className="mt-1 max-w-2xl text-sm text-soft">
        Replies your teammates wrote for your Upwork profile. Approving sends the message from your
        account, under your name — so the client sees the person they contracted with.
      </p>

      {list.length === 0 ? (
        <div className="mt-6 rounded-[--radius] border bg-surface p-6 text-sm text-soft">
          Nothing waiting on you.
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {list.map((draft) => {
            const room = roomInfo.get(draft.room_id)
            return (
              <ApprovalCard
                key={draft.id}
                draftId={draft.id}
                body={draft.body}
                note={draft.note}
                error={draft.error}
                createdAt={draft.created_at}
                authorName={authorName.get(draft.author_id) ?? 'A teammate'}
                roomName={room?.name ?? 'Conversation'}
                roomTopic={room?.topic ?? null}
                roomHref={`/inbox/${draft.room_id}`}
              />
            )
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-soft">
        You are the only person who can approve these — a manager cannot send from your profile on
        your behalf. Read them before approving:{' '}
        <Link href="/inbox" className="underline underline-offset-2">
          open the conversation
        </Link>{' '}
        for full context.
      </p>
    </AppShell>
  )
}
