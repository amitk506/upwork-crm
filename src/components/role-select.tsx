'use client'

import { useState, useTransition } from 'react'

import { updateRole } from '@/app/team/actions'
import type { AppRole } from '@/lib/database.types'

import { ALL_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/permissions'

export function RoleSelect({ userId, role }: { userId: string; role: AppRole }) {
  const [current, setCurrent] = useState<AppRole>(role)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function onChange(next: AppRole) {
    const previous = current
    setCurrent(next)
    setError(null)

    startTransition(async () => {
      const result = await updateRole(userId, next)
      if (result?.error) {
        setCurrent(previous)
        setError(result.error)
      }
    })
  }

  return (
    <div>
      <select
        value={current}
        disabled={pending}
        onChange={(e) => onChange(e.target.value as AppRole)}
        className="rounded-[--radius-sm] border bg-sunk px-2 py-1 text-sm outline-none focus:border-line-strong disabled:opacity-50"
      >
        {ALL_ROLES.map((r) => (
          <option key={r} value={r} title={ROLE_DESCRIPTIONS[r]}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </select>
      {error && <p className="mt-1 text-xs text-stop">{error}</p>}
    </div>
  )
}
