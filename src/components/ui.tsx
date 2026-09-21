import Link from 'next/link'

/**
 * The small set of primitives every screen is built from.
 *
 * Having these in one place is what keeps a nine-route tool feeling like one
 * product rather than nine pages that happen to share a stylesheet.
 */

type ButtonTone = 'primary' | 'quiet' | 'danger'

const BUTTON: Record<ButtonTone, string> = {
  // No hue: the accent slot is spent on identity, so the primary action is
  // simply inverted ink. It reads as the strongest thing on the page precisely
  // because nothing else is.
  primary: 'bg-action text-action-ink hover:opacity-90',
  quiet: 'border border-line bg-surface text-ink hover:bg-sunk',
  danger: 'border border-line bg-surface text-stop hover:bg-stop/10',
}

const SIZE = {
  sm: 'h-7 px-2.5 text-xs',
  md: 'h-9 px-3.5 text-sm',
}

export function buttonClass(tone: ButtonTone = 'quiet', size: keyof typeof SIZE = 'md') {
  return [
    'inline-flex items-center justify-center gap-1.5 rounded-[--radius-sm] font-medium',
    'transition-[opacity,background-color] duration-150',
    'disabled:cursor-not-allowed disabled:opacity-45',
    BUTTON[tone],
    SIZE[size],
  ].join(' ')
}

export function inputClass(extra = '') {
  return [
    'w-full rounded-[--radius-sm] border border-line bg-surface px-3 py-2 text-sm',
    'placeholder:text-faint outline-none',
    'focus:border-line-strong',
    extra,
  ].join(' ')
}

/** A titled block. The whole app is made of these. */
export function Panel({
  title,
  hint,
  action,
  children,
  className = '',
}: {
  title?: string
  hint?: string
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={`rounded-[--radius] border border-line bg-surface ${className}`}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
            {hint && <p className="mt-0.5 text-xs text-soft">{hint}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

/** Page heading with optional right-hand controls. */
export function PageHead({
  title,
  meta,
  children,
}: {
  title: React.ReactNode
  meta?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
        {meta && <p className="mt-1 text-sm text-soft">{meta}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  )
}

type BadgeTone = 'neutral' | 'ok' | 'warn' | 'stop'

const BADGE: Record<BadgeTone, string> = {
  neutral: 'border-line text-soft',
  ok: 'border-ok/30 text-ok',
  warn: 'border-warn/35 text-warn',
  stop: 'border-stop/30 text-stop',
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode
  tone?: BadgeTone
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] leading-none ${BADGE[tone]}`}
    >
      {children}
    </span>
  )
}

/** Inline notice. Used for the things the operator must not miss. */
export function Notice({
  tone = 'warn',
  children,
}: {
  tone?: 'warn' | 'stop' | 'ok'
  children: React.ReactNode
}) {
  const map = {
    warn: 'border-warn/30 bg-warn/8 text-warn',
    stop: 'border-stop/30 bg-stop/8 text-stop',
    ok: 'border-ok/30 bg-ok/8 text-ok',
  }
  return (
    <p className={`rounded-[--radius-sm] border px-3 py-2 text-sm ${map[tone]}`}>{children}</p>
  )
}

/** An empty state should invite an action, not just report absence. */
export function Empty({
  title,
  children,
  href,
  cta,
}: {
  title: string
  children?: React.ReactNode
  href?: string
  cta?: string
}) {
  return (
    <div className="rounded-[--radius] border border-dashed border-line bg-surface px-6 py-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-soft">{children}</p>}
      {href && cta && (
        <Link href={href} className={`${buttonClass('primary')} mt-4`}>
          {cta}
        </Link>
      )}
    </div>
  )
}
