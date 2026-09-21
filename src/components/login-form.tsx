'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { createClient } from '@/lib/supabase/client'

/**
 * Password sign-in.
 *
 * Self-hosted GoTrue runs with signup disabled: accounts are created by an
 * owner from /team, not self-served. That removes the SMTP dependency entirely
 * — nothing here needs to send an email — and for an internal tool it is the
 * right model anyway.
 */
export function LoginForm({ next }: { next?: string }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)

    const supabase = createClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })

    if (signInError) {
      setPending(false)
      // Deliberately not distinguishing "no such user" from "wrong password".
      setError(
        signInError.message.toLowerCase().includes('invalid')
          ? 'That email and password combination was not recognised.'
          : signInError.message,
      )
      return
    }

    // Full reload so the proxy re-reads the fresh session cookie.
    router.push(next && next.startsWith('/') ? next : '/')
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="mt-6 space-y-3">
      <div>
        <label className="block text-sm font-medium" htmlFor="email">
          Work email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@your-agency.com"
          className="mt-1 w-full rounded-[--radius-sm] border bg-sunk px-3 py-2 text-sm outline-none focus:border-line-strong"
        />
      </div>

      <div>
        <label className="block text-sm font-medium" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-[--radius-sm] border bg-sunk px-3 py-2 text-sm outline-none focus:border-line-strong"
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-[--radius-sm] bg-action px-3.5 py-2 text-sm font-medium text-action-ink transition-opacity disabled:opacity-50"
      >
        {pending ? 'Signing in…' : 'Sign in'}
      </button>

      {error && <p className="text-sm text-stop">{error}</p>}

      <p className="pt-1 text-xs text-soft">
        No account? An owner adds you from the Team page — accounts are not self-served.
      </p>
    </form>
  )
}
