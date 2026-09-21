'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * The bottom tab bar, under 768px.
 *
 * A scrolling strip of eight destinations across the top was a horizontal list
 * of near-identical words, and it ate the space the conversation needed. Four
 * fixed tabs at the bottom put the common destinations under a thumb and leave
 * the top edge to the thing you are actually reading.
 *
 * The badge counts breaches only, so the red number means the same thing here as
 * it does everywhere else in the product.
 */

export type MobileTab = {
  href: string
  label: string
  icon: 'home' | 'inbox' | 'board' | 'activity' | 'account'
}

export function MobileTabs({ tabs, breached }: { tabs: MobileTab[]; breached: number }) {
  const pathname = usePathname()

  return (
    <nav
      aria-label="Sections"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-surface md:hidden"
    >
      {tabs.map((tab) => {
        // '/' would otherwise prefix-match every route and light up permanently.
        const active =
          tab.href === '/'
            ? pathname === '/'
            : pathname === tab.href || pathname.startsWith(`${tab.href}/`)
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`relative flex flex-1 flex-col items-center gap-1 py-2 pb-2.5 text-[9.5px] font-semibold ${
              active ? 'text-accent' : 'text-faint'
            }`}
          >
            <Icon name={tab.icon} />
            {tab.label}
            {tab.icon === 'inbox' && breached > 0 && (
              <span className="tabular absolute right-[calc(50%-18px)] top-1 grid h-[15px] min-w-[15px] place-items-center rounded-full bg-stop px-1 text-[9px] font-bold text-white">
                {breached}
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}

const PATHS: Record<MobileTab['icon'], React.ReactNode> = {
  home: (
    <>
      <path d="M4 11.5 12 5l8 6.5" />
      <path d="M6 10.5V19h12v-8.5" />
    </>
  ),
  inbox: (
    <>
      <path d="M5 5h14l2 7v7H3v-7z" />
      <path d="M3 12h4l2 3h6l2-3h4" />
    </>
  ),
  board: <path d="M4 20V10M10 20V5M16 20v-7M22 20H2" />,
  activity: <path d="M3 12h4l3 7 4-14 3 7h4" />,
  account: (
    <>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5 20a7 7 0 0114 0" />
    </>
  ),
}

function Icon({ name }: { name: MobileTab['icon'] }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-[18px] w-[18px] fill-none stroke-current"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  )
}
