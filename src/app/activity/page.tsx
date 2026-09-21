import Link from 'next/link'

import { ActivityFeed, type ActivityEntry } from '@/components/activity-feed'
import { AppShell } from '@/components/app-shell'
import { AutoRefresh } from '@/components/auto-refresh'
import { requireUser } from '@/lib/auth'
import { can } from '@/lib/permissions'
import { createClient } from '@/lib/supabase/server'

/**
 * Everything happening across the portal.
 *
 * Read through the user's own client, so RLS decides what each person sees:
 * staff get the whole trail, everyone else gets their own actions plus anything
 * in a conversation they have access to.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ user?: string; kind?: string }>
}) {
  const viewer = await requireUser()
  const { user: userFilter, kind } = await searchParams
  const supabase = await createClient()

  let query = supabase
    .from('v_activity')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200)

  if (userFilter) query = query.eq('actor_id', userFilter)
  // "Replies" is the question people actually ask; the rest is admin noise.
  if (kind === 'replies') query = query.in('action', ['inbox.replied', 'inbox.reply_failed'])
  if (kind === 'access') query = query.like('action', '%grant%')
  if (kind === 'team') query = query.like('action', 'team.%')

  const [{ data: entries }, { data: members }, { data: profileLabels }] = await Promise.all([
    query,
    supabase.from('app_users').select('id, full_name, email').eq('is_active', true),
    // Labels for the profile ids that grant entries carry in their payload.
    supabase.from('v_profiles').select('id, label'),
  ])

  const activeName = userFilter
    ? (() => {
        const m = (members ?? []).find((x) => x.id === userFilter)
        return m ? m.full_name || m.email : null
      })()
    : null

  const kinds = [
    { key: null, label: 'Everything' },
    { key: 'replies', label: 'Replies' },
    { key: 'access', label: 'Access changes' },
    { key: 'team', label: 'Team' },
  ]

  const href = (nextKind: string | null, nextUser: string | null) => {
    const params = new URLSearchParams()
    if (nextKind) params.set('kind', nextKind)
    if (nextUser) params.set('user', nextUser)
    const qs = params.toString()
    return qs ? `/activity?${qs}` : '/activity'
  }

  return (
    <AppShell user={viewer}>
      <AutoRefresh seconds={30} />

      <h1 className="text-2xl font-semibold tracking-tight">
        Activity{activeName ? ` · ${activeName}` : ''}
      </h1>
      <p className="mt-1 text-sm text-soft">
        Who did what, and when. Replies are recorded whether they went out directly or through an
        approval.
      </p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {kinds.map((k) => (
          <Link
            key={k.label}
            href={href(k.key, userFilter ?? null)}
            className={`rounded-[--radius-sm] border px-3 py-1.5 text-sm transition-colors ${
              (kind ?? null) === k.key ? 'border-line-strong bg-sunk' : 'text-soft hover:bg-sunk'
            }`}
          >
            {k.label}
          </Link>
        ))}
      </div>

      {can(viewer, 'team:manage') && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-soft">By:</span>
          <Link
            href={href(kind ?? null, null)}
            className={`rounded-[--radius-sm] border px-2.5 py-1 text-xs transition-colors ${
              !userFilter ? 'border-line-strong bg-sunk' : 'text-soft hover:bg-sunk'
            }`}
          >
            Everyone
          </Link>
          {(members ?? []).map((m) => (
            <Link
              key={m.id}
              href={href(kind ?? null, m.id)}
              className={`rounded-[--radius-sm] border px-2.5 py-1 text-xs transition-colors ${
                userFilter === m.id ? 'border-line-strong bg-sunk' : 'text-soft hover:bg-sunk'
              }`}
            >
              {m.full_name || m.email}
            </Link>
          ))}
        </div>
      )}

      <div className="mt-4 rounded-[--radius] border bg-surface p-4">
        <ActivityFeed
          entries={(entries ?? []) as ActivityEntry[]}
          empty="No activity matches this filter yet."
          people={Object.fromEntries(
            (members ?? []).map((m) => [m.id, m.full_name || m.email] as const),
          )}
          profiles={Object.fromEntries((profileLabels ?? []).map((p) => [p.id, p.label] as const))}
        />
      </div>

      <p className="mt-4 text-xs text-soft">
        The trail is append-only — no policy allows updating or deleting an entry, so it cannot be
        rewritten from the app.
      </p>
    </AppShell>
  )
}
