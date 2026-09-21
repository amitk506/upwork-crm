'use client'

import Link from 'next/link'

import { ProfileAvatar } from '@/components/profile-avatar'
import { identityStyle } from '@/lib/identity'

type ProfileCount = {
  profile_id: string
  profile_label: string
  room_count: number
  unread_rooms: number
}

/**
 * Filtering by Upwork identity.
 *
 * Each chip carries its profile's colour as a dot, and the active chip is
 * outlined in it — the same colour that runs down the spine of every
 * conversation belonging to that profile, so the connection is learnable at a
 * glance. Links rather than state, so a filtered view is a real URL.
 */
export function ProfileFilter({
  profiles,
  active,
  totalRooms,
  userParam,
}: {
  profiles: ProfileCount[]
  active: string | null
  totalRooms: number
  userParam?: string | null
}) {
  if (profiles.length === 0) return null

  const href = (profileId: string | null) => {
    const params = new URLSearchParams()
    if (profileId) params.set('profile', profileId)
    if (userParam) params.set('user', userParam)
    const qs = params.toString()
    return qs ? `/inbox?${qs}` : '/inbox'
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      <Link
        href={href(null)}
        aria-current={active === null ? 'page' : undefined}
        className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition-colors ${
          active === null
            ? 'border-line-strong bg-sunk text-ink'
            : 'border-line text-soft hover:bg-sunk'
        }`}
      >
        All
        <span className="tabular text-xs text-faint">{totalRooms}</span>
      </Link>

      {profiles.map((p) => {
        const on = active === p.profile_id
        return (
          <Link
            key={p.profile_id}
            href={href(p.profile_id)}
            style={identityStyle(p.profile_id)}
            aria-current={on ? 'page' : undefined}
            className={`inline-flex items-center gap-2 rounded-full border py-1 pl-1 pr-3 text-sm transition-colors ${
              on
                ? 'border-[color:var(--identity)] bg-[color:var(--identity)]/8 text-ink'
                : 'border-line text-soft hover:bg-sunk'
            }`}
          >
            <ProfileAvatar profileId={p.profile_id} label={p.profile_label} size="xs" />
            {p.profile_label}
            <span className="tabular text-xs text-faint">{p.room_count}</span>
            {p.unread_rooms > 0 && (
              <span className="tabular rounded-full bg-[color:var(--identity)] px-1.5 text-[10px] font-medium text-white">
                {p.unread_rooms}
              </span>
            )}
          </Link>
        )
      })}
    </div>
  )
}
