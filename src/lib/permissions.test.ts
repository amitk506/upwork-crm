import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ALL_ROLES,
  can,
  capabilitiesFor,
  inboxScope,
  ROLE_LABELS,
  type Capability,
} from './permissions.ts'
import type { AppRole } from './database.types.ts'

const as = (role: AppRole) => ({ role })

test('team lead sees ONLY conversations assigned to them', () => {
  assert.equal(inboxScope(as('team_lead')), 'assigned')
  assert.equal(can(as('team_lead'), 'inbox:read_all'), false)
  // No visibility of unclaimed conversations — this is the deliberate boundary.
  assert.equal(can(as('team_lead'), 'inbox:read_unassigned'), false)
  assert.equal(can(as('team_lead'), 'inbox:send'), true)
})

test('inbox scope differs per role', () => {
  assert.equal(inboxScope(as('owner')), 'all')
  assert.equal(inboxScope(as('manager')), 'all')
  assert.equal(inboxScope(as('bidder')), 'assigned_or_unassigned')
  assert.equal(inboxScope(as('team_lead')), 'assigned')
})

test('team lead has NO administrative or delivery access', () => {
  // The whole point of the role: inbox only.
  for (const denied of [
    'inbox:assign',
    'team:manage',
    'roles:manage',
    'ops:read',
  ] as Capability[]) {
    assert.equal(can(as('team_lead'), denied), false, `team_lead must not have ${denied}`)
  }
})

test('team lead is not simply a rung below a bidder', () => {
  // Narrower on the inbox than a bidder (no unclaimed conversations) AND denied
  // the job pipeline. Neither role contains the other, which is precisely why a
  // linear rank ladder could not express this.
  assert.equal(can(as('bidder'), 'inbox:read_unassigned'), true)
  assert.equal(can(as('team_lead'), 'inbox:read_unassigned'), false)
})

test('only the owner can change roles', () => {
  assert.equal(can(as('owner'), 'roles:manage'), true)
  for (const role of ['manager', 'team_lead', 'bidder'] as AppRole[]) {
    assert.equal(can(as(role), 'roles:manage'), false, `${role} must not manage roles`)
  }
})

test('a manager has everything except role management', () => {
  const ownerCaps = capabilitiesFor('owner')
  const managerCaps = capabilitiesFor('manager')

  for (const cap of ownerCaps) {
    if (cap === 'roles:manage') continue
    assert.ok(managerCaps.includes(cap), `manager should have ${cap}`)
  }
  assert.equal(managerCaps.includes('roles:manage'), false)
})

test('every role is labelled and offerable', () => {
  for (const role of ALL_ROLES) {
    assert.ok(ROLE_LABELS[role], `${role} needs a label`)
  }
  assert.equal(ALL_ROLES.length, 4)
  assert.ok(ALL_ROLES.includes('team_lead'))
})

test('an unknown role grants nothing', () => {
  // Defensive: a role added in the database but not here must fail closed.
  assert.equal(can({ role: 'ghost' as AppRole }, 'inbox:send'), false)
  assert.equal(can({ role: 'ghost' as AppRole }, 'roles:manage'), false)
})
