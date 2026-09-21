import type { AppRole, AppUser } from '@/lib/database.types'

/**
 * Capability-based permissions.
 *
 * This replaced a linear rank ladder (bidder < manager < owner) because the
 * team_lead role does not fit one. A team lead sees a NARROWER slice of the
 * inbox than a bidder (strictly what is assigned to them, with no visibility of
 * unclaimed conversations) while also being denied jobs, milestones, the roster
 * and ops. It is not "one rung down" from anything — it is a different shape.
 * A single ordering cannot express that, and forcing it into one produces
 * exactly the kind of accidental privilege that is hard to notice.
 *
 * The database enforces the same split independently — see inbox_scope() and
 * can_use_delivery_data() in migrations 0007 and 0008. Hiding a nav link is
 * presentation, not access control.
 */

export type Capability =
  /** See every conversation in the agency. */
  | 'inbox:read_all'
  /** See conversations nobody has claimed yet, as well as your own. */
  | 'inbox:read_unassigned'
  /** Reply to clients from the portal. */
  | 'inbox:send'
  /** Route a conversation to a teammate. */
  | 'inbox:assign'
  /** Roster: add members, deactivate them. */
  | 'team:manage'
  /** Change someone's role. Owner only. */
  | 'roles:manage'
  /** Limits, spend, safety posture, audit trail. */
  | 'ops:read'

const ROLE_CAPABILITIES: Record<AppRole, readonly Capability[]> = {
  owner: [
    'inbox:read_all',
    'inbox:read_unassigned',
    'inbox:send',
    'inbox:assign',
    'team:manage',
    'roles:manage',
    'ops:read',
  ],

  // Everything an owner can do except changing roles.
  manager: [
    'inbox:read_all',
    'inbox:read_unassigned',
    'inbox:send',
    'inbox:assign',
    'team:manage',
    'ops:read',
  ],

  // Strictly their own conversations, and nothing else in the product. Note
  // they hold NEITHER read capability: an unassigned conversation is invisible
  // to them until someone with a wider scope routes it.
  team_lead: ['inbox:send'],

  // Their own conversations plus anything unclaimed, so nothing sits unseen.
  bidder: ['inbox:read_unassigned', 'inbox:send'],
}

export function can(user: Pick<AppUser, 'role'>, capability: Capability): boolean {
  return ROLE_CAPABILITIES[user.role]?.includes(capability) ?? false
}

export function capabilitiesFor(role: AppRole): readonly Capability[] {
  return ROLE_CAPABILITIES[role] ?? []
}

export type InboxScope = 'all' | 'assigned_or_unassigned' | 'assigned' | 'none'

/**
 * How much of the inbox a role may see. Mirrors public.inbox_scope() in SQL —
 * the database is the real boundary; this is for rendering honest copy.
 */
export function inboxScope(user: Pick<AppUser, 'role'>): InboxScope {
  if (can(user, 'inbox:read_all')) return 'all'
  if (can(user, 'inbox:read_unassigned')) return 'assigned_or_unassigned'
  if (ROLE_CAPABILITIES[user.role]) return 'assigned'
  return 'none'
}

export const INBOX_SCOPE_COPY: Record<InboxScope, string> = {
  all: 'You can see every conversation in the agency.',
  assigned_or_unassigned:
    'You can see conversations assigned to you, plus any that nobody has claimed yet.',
  assigned:
    'You can see conversations assigned to you. New or unassigned conversations stay hidden until someone routes one to you.',
  none: 'You cannot see any conversations.',
}

export const ROLE_LABELS: Record<AppRole, string> = {
  owner: 'Owner',
  manager: 'Manager',
  team_lead: 'Team lead',
  bidder: 'Bidder',
}

export const ROLE_DESCRIPTIONS: Record<AppRole, string> = {
  owner: 'Full access, and the only role that can change roles.',
  manager: 'All conversations and the roster. Cannot change roles.',
  team_lead: 'Only conversations assigned to them, and can reply. Nothing else.',
  bidder: 'Their conversations plus any that nobody has claimed yet.',
}

/** Every role, in the order they should be offered in a picker. */
export const ALL_ROLES: readonly AppRole[] = ['owner', 'manager', 'team_lead', 'bidder']
