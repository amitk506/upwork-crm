'use client'

import { useState, useTransition } from 'react'

import { changeOwnPassword } from '@/app/account/actions'
import { buttonClass, inputClass } from '@/components/ui'

export function ChangePassword() {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const [pending, startTransition] = useTransition()

  const mismatch = confirm.length > 0 && next !== confirm

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (mismatch) return
    setError(null)

    startTransition(async () => {
      const result = await changeOwnPassword({ currentPassword: current, newPassword: next })
      if (result?.error) {
        setError(result.error)
        return
      }
      setDone(true)
      setCurrent('')
      setNext('')
      setConfirm('')
    })
  }

  if (done) {
    return (
      <div className="text-sm">
        <p className="font-medium text-ok">Password changed</p>
        <p className="mt-1 text-soft">
          Use the new one next time you sign in. Your other sessions stay signed in.
        </p>
        <button
          type="button"
          onClick={() => setDone(false)}
          className={`${buttonClass('quiet', 'sm')} mt-3`}
        >
          Change it again
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="block text-xs text-soft" htmlFor="current">
          Current password
        </label>
        <input
          id="current"
          type="password"
          required
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          className={inputClass('mt-1')}
        />
      </div>

      <div>
        <label className="block text-xs text-soft" htmlFor="next">
          New password
        </label>
        <input
          id="next"
          type="password"
          required
          minLength={10}
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          className={inputClass('mt-1')}
        />
        <p className="mt-1 text-[11px] text-faint">At least 10 characters.</p>
      </div>

      <div>
        <label className="block text-xs text-soft" htmlFor="confirm">
          Confirm new password
        </label>
        <input
          id="confirm"
          type="password"
          required
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className={inputClass('mt-1')}
        />
        {mismatch && <p className="mt-1 text-[11px] text-stop">These do not match.</p>}
      </div>

      <button
        type="submit"
        disabled={pending || mismatch || !current || next.length < 10}
        className={buttonClass('primary')}
      >
        {pending ? 'Changing…' : 'Change password'}
      </button>

      {error && <p className="text-sm text-stop">{error}</p>}
    </form>
  )
}
