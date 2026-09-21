import Link from 'next/link'

import { clientEnv } from '@/lib/env'

import type { AppUser } from '@/lib/database.types'
import { can, ROLE_LABELS, type Capability } from '@/lib/permissions'
import { CommandPalette } from '@/components/command-palette'
import { MobileTabs, type MobileTab } from '@/components/mobile-tabs'
import { buttonClass } from '@/components/ui'

/**
 * A left rail rather than a top bar.
 *
 * Eight destinations do not fit across the top without becoming a scan of
 * near-identical words, and the top edge is worth more as context for the
 * screen you are on. Grouping by Work vs Manage also matches how the roles
 * split: most of the team only ever needs the first group.
 *
 * Filtering by capability is presentation only — every page re-checks with
 * requireCapability(), and the database enforces the same split via RLS.
 */
type NavItem = { href: string; label: string; capability?: Capability }

const WORK: NavItem[] = [
  // The home dashboard had no way in except the wordmark, which nobody reads as
  // a link. It is the first screen people land on and had no entry in its own
  // navigation.
  { href: '/', label: 'Dashboard' },
  { href: '/inbox', label: 'Inbox' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/activity', label: 'Activity' },
]

const MANAGE: NavItem[] = [
  { href: '/board', label: 'Board', capability: 'inbox:assign' },
  { href: '/reviews', label: 'Reviews', capability: 'inbox:assign' },
  { href: '/profiles', label: 'Profiles', capability: 'team:manage' },
  { href: '/team', label: 'Team', capability: 'team:manage' },
  { href: '/ops', label: 'Ops', capability: 'ops:read' },
]

function NavGroup({ label, items, user }: { label: string; items: NavItem[]; user: AppUser }) {
  const visible = items.filter((i) => !i.capability || can(user, i.capability))
  if (visible.length === 0) return null

  return (
    <div className="mb-5">
      <p className="mb-1.5 px-3 text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
        {label}
      </p>
      <ul className="space-y-px">
        {visible.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="flex items-center gap-2 rounded-[--radius-sm] px-3 py-1.5 text-sm text-soft transition-colors hover:bg-sunk hover:text-ink"
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AppShell({
  user,
  children,
  /**
   * Workspace mode: the inbox is a set of full-height columns, not a document,
   * so it gets the whole viewport with no max-width and no page padding. Every
   * other route stays a centred column, which is right for reading.
   */
  workspace = false,
  /**
   * Breached conversations, for the mobile badge. Passed in rather than queried
   * here so the shell stays free of data loading — only the inbox and the board
   * already know it, and neither should pay for a second query.
   */
  breachedCount,
}: {
  user: AppUser
  children: React.ReactNode
  workspace?: boolean
  breachedCount?: number
}) {
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-[216px] shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="px-5 py-4">
          <Link href="/" className="block">
            <span className="text-sm font-semibold tracking-tight">Upwork Agency Portal</span>
            <span className="mt-0.5 block text-[11px] text-faint">{clientEnv.NEXT_PUBLIC_AGENCY_NAME}</span>
          </Link>
        </div>

        <div className="px-3 pb-2">
          <CommandPalette />
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-2">
          <NavGroup label="Work" items={WORK} user={user} />
          <NavGroup label="Manage" items={MANAGE} user={user} />
        </nav>

        <div className="border-t border-line p-3">
          <Link href="/account" className="block rounded-[--radius-sm] hover:opacity-80">
            <p className="truncate text-sm font-medium">{user.full_name || user.email}</p>
            <p className="mt-0.5 text-[11px] text-faint">
              {ROLE_LABELS[user.role]} · account
            </p>
          </Link>
          <form action="/auth/signout" method="post" className="mt-2">
            <button type="submit" className={`${buttonClass('quiet', 'sm')} w-full`}>
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {workspace ? (
          <main
            style={{ height: 'calc(100dvh - 3.25rem - env(safe-area-inset-bottom))' }}
            className="min-h-0 overflow-hidden md:!h-screen"
          >
            {children}
          </main>
        ) : (
          <main
            style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))' }}
            className="mx-auto max-w-6xl px-5 pt-6 md:px-8 md:!pb-8 md:py-8"
          >
            {children}
          </main>
        )}
      </div>

      <MobileTabs tabs={mobileTabs(user)} breached={breachedCount ?? 0} />
    </div>
  )
}


/**
 * The four destinations worth a thumb. Deliberately not every nav item: a tab bar
 * with eight entries is a scrolling strip again, and the rest are reachable from
 * the pages themselves or from search.
 */
function mobileTabs(user: AppUser): MobileTab[] {
  const tabs: MobileTab[] = [
    { href: '/', label: 'Home', icon: 'home' },
    { href: '/inbox', label: 'Inbox', icon: 'inbox' },
  ]
  if (can(user, 'inbox:assign')) tabs.push({ href: '/board', label: 'Board', icon: 'board' })
  tabs.push({ href: '/activity', label: 'Activity', icon: 'activity' })
  // Account is reachable from the dashboard; a fifth tab makes each one too
  // narrow to hit reliably.
  return tabs
}
