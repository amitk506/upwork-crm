'use client'

import Link from 'next/link'

type Member = { id: string; name: string; roomCount: number }

/**
 * "What can this person actually see?"
 *
 * Reads the same grant data the inbox itself uses, so an owner can check
 * someone's coverage without impersonating them — which is not possible here,
 * and should not be.
 */
export function MemberFilter({
  members,
  active,
  profileParam,
}: {
  members: Member[]
  active: string | null
  profileParam: string | null
}) {
  if (members.length === 0) return null

  const href = (userId: string | null) => {
    const params = new URLSearchParams()
    if (profileParam) params.set('profile', profileParam)
    if (userId) params.set('user', userId)
    const qs = params.toString()
    return qs ? `/inbox?${qs}` : '/inbox'
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-[0.12em] text-faint">Access</span>

      <Link
        href={href(null)}
        className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
          active === null ? 'border-line-strong bg-sunk text-ink' : 'border-line text-soft hover:bg-sunk'
        }`}
      >
        Everyone
      </Link>

      {members.map((m) => (
        <Link
          key={m.id}
          href={href(m.id)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
            active === m.id ? 'border-line-strong bg-sunk text-ink' : 'border-line text-soft hover:bg-sunk'
          }`}
        >
          {m.name}
          <span className="tabular text-faint">{m.roomCount}</span>
        </Link>
      ))}
    </div>
  )
}
