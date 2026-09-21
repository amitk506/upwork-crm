import { AppShell } from '@/components/app-shell'
import { requireCapability } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { budgetStatus } from '@/lib/upwork/rate-limiter'
import { safetyPosture } from '@/lib/upwork/mcp-client'
import { SELF_IMPOSED, UPWORK_PUBLISHED } from '@/lib/upwork/limits'
import { formatDateTime } from '@/lib/format'

/**
 * The screen that answers "are we anywhere near an Upwork limit?" without
 * anyone having to read code or guess.
 */
export default async function OpsPage() {
  const user = await requireCapability('ops:read')

  const posture = safetyPosture()
  const budget = await budgetStatus().catch(() => null)

  // v_upwork_health is staff-only (0020) and decides that with is_staff(), which
  // reads auth.uid(). The service role has none, so the admin client saw nothing.
  // activity_log carries the seniority policy from 0016, which is what should be
  // deciding here anyway.
  const supabase = await createClient()
  const { data: health } = await supabase.from('v_upwork_health').select('*').maybeSingle()
  const { data: recent } = await supabase
    .from('activity_log')
    .select('action, succeeded, error, created_at')
    .order('created_at', { ascending: false })
    .limit(15)

  return (
    <AppShell user={user}>
      <h1 className="text-2xl font-semibold tracking-tight">Operations</h1>
      <p className="mt-1 text-sm text-soft">
        Upwork limits, current spend, and what this portal is permitted to do.
      </p>

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Requests today"
          value={budget ? String(budget.spent) : '—'}
          detail={
            budget
              ? `${budget.percentOfUpwork}% of Upwork's ${UPWORK_PUBLISHED.requestsPerDay.toLocaleString()}/day`
              : 'unavailable'
          }
          tone={
            budget && budget.spent >= SELF_IMPOSED.backgroundCutoffPerDay ? 'warn' : 'normal'
          }
        />
        <Stat
          label="Writes to Upwork"
          value={posture.writesEnabled ? 'ENABLED' : 'Disabled'}
          detail={
            posture.writesEnabled
              ? 'Mutating tools are callable — confirm the UI gates them'
              : 'Read-only. Mutating tools refuse before any request is sent'
          }
          tone={posture.writesEnabled ? 'warn' : 'good'}
        />
        <Stat
          label="Circuits open"
          value={String(health?.connections_circuit_open ?? 0)}
          detail={`${health?.connections_active ?? 0} connections active`}
          tone={(health?.connections_circuit_open ?? 0) > 0 ? 'warn' : 'good'}
        />
      </section>

      <section className="mt-6 rounded-[--radius] border bg-surface p-5">
        <h2 className="text-sm font-semibold">Limits we hold ourselves to</h2>
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-soft">
            <tr>
              <th className="py-1.5 font-medium">Limit</th>
              <th className="py-1.5 font-medium">Upwork published</th>
              <th className="py-1.5 font-medium">This portal</th>
            </tr>
          </thead>
          <tbody className="text-soft">
            <tr className="border-t">
              <td className="py-2 text-ink">Requests / second (per IP)</td>
              <td className="tabular">{UPWORK_PUBLISHED.requestsPerSecond}</td>
              <td className="tabular text-ok">{SELF_IMPOSED.requestsPerSecond}</td>
            </tr>
            <tr className="border-t">
              <td className="py-2 text-ink">Requests / day</td>
              <td className="tabular">{UPWORK_PUBLISHED.requestsPerDay.toLocaleString()}</td>
              <td className="tabular text-ok">{SELF_IMPOSED.requestsPerDay.toLocaleString()}</td>
            </tr>
            <tr className="border-t">
              <td className="py-2 text-ink">Background sync cutoff</td>
              <td>—</td>
              <td className="tabular text-ok">
                {SELF_IMPOSED.backgroundCutoffPerDay.toLocaleString()}
              </td>
            </tr>
            <tr className="border-t">
              <td className="py-2 text-ink">Cache max age</td>
              <td><span className="tabular">{UPWORK_PUBLISHED.cacheMaxAgeHours}h</span> (ToS ceiling)</td>
              <td className="tabular text-ok">{SELF_IMPOSED.cacheMaxAgeHours}h</td>
            </tr>
          </tbody>
        </table>
        <p className="mt-3 text-xs text-soft">
          The gap is deliberate margin, not spare capacity. Throttled today:{' '}
          <span className="tabular">{health?.throttled_today ?? 0}</span> · errors today:{' '}
          <span className="tabular">{health?.errors_today ?? 0}</span>
        </p>
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-2">
        <div className="rounded-[--radius] border bg-surface p-5">
          <h2 className="text-sm font-semibold text-ok">Allowed tools (read-only)</h2>
          <ul className="mt-2 space-y-1 text-xs text-soft">
            {posture.allowedTools.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
        <div className="rounded-[--radius] border bg-surface p-5">
          <h2 className="text-sm font-semibold text-warn">
            Blocked write tools {posture.writesEnabled ? '(flag is ON)' : ''}
          </h2>
          <ul className="mt-2 space-y-1 text-xs text-soft">
            {posture.blockedWriteTools.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-soft">
            Anything not listed on either side cannot be called at all — the request is refused
            before it is built.
          </p>
        </div>
      </section>

      <section className="mt-6 rounded-[--radius] border bg-surface p-5">
        <h2 className="text-sm font-semibold">Recent activity</h2>
        <ul className="mt-3 space-y-1.5 text-xs">
          {(recent ?? []).map((entry, i) => (
            <li key={i} className="flex items-baseline gap-3">
              <span className={entry.succeeded ? 'text-ok' : 'text-stop'}>
                {entry.succeeded ? '✓' : '✕'}
              </span>
              <span className="text-ink">{entry.action}</span>
              <span className="tabular ml-auto shrink-0 text-faint">
                {formatDateTime(entry.created_at)}
              </span>
            </li>
          ))}
          {(recent ?? []).length === 0 && <li className="text-soft">Nothing recorded yet.</li>}
        </ul>
      </section>
    </AppShell>
  )
}

function Stat({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: string
  detail: string
  tone: 'good' | 'warn' | 'normal'
}) {
  const color = tone === 'good' ? 'text-ok' : tone === 'warn' ? 'text-warn' : 'text-ink'
  return (
    <div className="rounded-[--radius] border bg-surface p-4">
      <p className="text-xs uppercase tracking-wide text-soft">{label}</p>
      <p className={`tabular mt-1 text-2xl font-semibold leading-none ${color}`}>{value}</p>
      <p className="mt-0.5 text-xs text-soft">{detail}</p>
    </div>
  )
}
