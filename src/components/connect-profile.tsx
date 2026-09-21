'use client'

import { useState, useTransition } from 'react'

import { beginProfileConnect, completeProfileConnect } from '@/app/profiles/actions'

/**
 * Adding one of the agency's Upwork profiles to the portal.
 *
 * The consent step must be completed by whoever holds that Upwork account —
 * they can do it at your desk or on their own screen; the authorization lands
 * in the portal either way.
 */
export function ConnectProfile() {
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [context, setContext] = useState<'agency' | 'freelancer'>('freelancer')
  const [started, setStarted] = useState(false)
  const [pasted, setPasted] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function start() {
    setError(null)
    startTransition(async () => {
      const result = await beginProfileConnect(label, context)
      if (result?.error) return setError(result.error)
      if (result?.authorizeUrl) {
        setStarted(true)
        window.open(result.authorizeUrl, '_blank', 'noopener')
      }
    })
  }

  function finish(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    startTransition(async () => {
      const result = await completeProfileConnect(pasted)
      if (result?.error) return setError(result.error)
      setDone(result?.label ?? label)
      setStarted(false)
      setPasted('')
      setLabel('')
    })
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-[--radius-sm] bg-action px-3.5 py-2 text-sm font-medium text-action-ink"
      >
        Connect an Upwork profile
      </button>
    )
  }

  return (
    <div className="rounded-[--radius] border bg-surface p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Connect an Upwork profile</h2>
        <button
          type="button"
          onClick={() => {
            setOpen(false)
            setDone(null)
            setStarted(false)
          }}
          className="text-sm text-soft hover:text-ink"
        >
          Close
        </button>
      </div>

      {done && (
        <p className="mt-3 rounded-[--radius-sm] bg-ok/10 px-3 py-2 text-sm text-ok">
          {done} is connected. Grant it to whoever handles that work below.
        </p>
      )}

      <div className="mt-4 space-y-3">
        <div>
          <label className="block text-xs text-soft" htmlFor="label">
            What should the team call this profile?
          </label>
          <input
            id="label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Gayatri Mittal"
            className="mt-1 w-full max-w-sm rounded-[--radius-sm] border bg-sunk px-3 py-2 text-sm outline-none focus:border-line-strong"
          />
        </div>

        <div>
          <span className="block text-xs text-soft">Which Upwork identity is this?</span>
          <div className="mt-1 flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={context === 'freelancer'}
                onChange={() => setContext('freelancer')}
              />
              Their own freelancer profile
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="radio"
                checked={context === 'agency'}
                onChange={() => setContext('agency')}
              />
              The agency
            </label>
          </div>
          <p className="mt-1 text-xs text-soft">
            Everyone in the agency shares one agency identity, so connect people as their{' '}
            <strong className="text-ink">own freelancer profile</strong> — that is what gives you
            a separate profile per person. Connect the agency once, on its own.
          </p>
        </div>

        {!started ? (
          <div>
            <p className="text-xs text-soft">
              Opens Upwork in a new tab. <strong className="text-ink">The person who holds
              this Upwork account signs in and approves</strong> — that consent is what authorizes
              the portal, and it is the only way in.
            </p>

            {/* This warning belongs HERE, not on the paste step. Upwork sends the
                browser to a loopback address on your own machine, and if something
                is already serving that port it answers instead — a dev server that
                redirects to its own login page takes the authorization code out of
                the address bar before anyone can copy it. By the paste step it is
                already lost, so the warning has to come before consent. */}
            <p className="mt-2 rounded-[--radius-sm] border border-warn/30 bg-warn-tint px-3 py-2 text-xs text-warn">
              <strong>Free up port 3000 first.</strong> Upwork will send you to{' '}
              <span className="code">localhost:3000</span> — your own machine. If a dev server is
              running there it will answer instead and can redirect, discarding the code. Stop it
              before you approve.
            </p>

            <button
              type="button"
              onClick={start}
              disabled={pending || !label.trim()}
              className="mt-2 rounded-[--radius-sm] bg-action px-3.5 py-2 text-sm font-medium text-action-ink disabled:opacity-50"
            >
              {pending ? 'Opening…' : 'Open Upwork consent'}
            </button>
          </div>
        ) : (
          <form onSubmit={finish}>
            <div className="space-y-1.5 text-xs text-soft">
              <p>
                After approving, the browser goes to{' '}
                <span className="code text-ink">localhost:3000</span>. With nothing running there
                it fails to load — that is expected, and the address bar still holds what we need.
                Paste the whole address here.
              </p>
              <p className="text-faint">
                Landed on something else, like a dev server&apos;s login page? The code was
                discarded. Stop whatever is on port 3000 and start again. Just the{' '}
                <span className="code">code</span> value works too, if that is all you could grab.
              </p>
            </div>
            <textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              rows={3}
              placeholder="http://localhost:3000/api/upwork/callback?code=…"
              className="code mt-2 w-full rounded-[--radius-sm] border bg-sunk px-3 py-2 text-xs outline-none focus:border-line-strong"
            />
            <button
              type="submit"
              disabled={pending || !pasted.trim()}
              className="mt-2 rounded-[--radius-sm] bg-action px-3.5 py-2 text-sm font-medium text-action-ink disabled:opacity-50"
            >
              {pending ? 'Connecting…' : `Finish connecting ${label || 'profile'}`}
            </button>
          </form>
        )}

        {error && <p className="text-sm text-stop">{error}</p>}
      </div>
    </div>
  )
}
