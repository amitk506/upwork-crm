/**
 * Hand-maintained until the Supabase project exists, at which point replace with:
 *   npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts
 *
 * Only the tables Phase 1 actually touches are typed out. The mirror tables
 * (up_*) land in Phase 3 with the sync worker.
 */

export type AppRole = 'owner' | 'manager' | 'team_lead' | 'bidder'
export type AssignmentTarget = 'room' | 'job'
export type DraftStatus = 'draft' | 'in_review' | 'submitted' | 'discarded'

export type AppUser = {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  role: AppRole
  is_active: boolean
  upwork_user_id: string | null
  created_at: string
  updated_at: string
}

export type UpworkConnection = {
  user_id: string
  upwork_user_id: string
  upwork_user_name: string | null
  org_uid: string
  org_name: string | null
  org_role: string | null
  access_token_ct: string
  access_token_iv: string
  access_token_tag: string
  refresh_token_ct: string
  refresh_token_iv: string
  refresh_token_tag: string
  key_version: number
  scopes: string[]
  refreshed_at: string | null
  last_used_at: string | null
  revoked_at: string | null
  connect_error: string | null
  access_token_expires_at: string | null
  refresh_after: string | null
  consecutive_failures: number
  circuit_open_until: string | null
  created_at: string
  updated_at: string
}

export type UpworkHealth = {
  requests_today: number
  connections_active: number
  connections_circuit_open: number
  connections_needing_refresh: number
  throttled_today: number
  errors_today: number
}

export type ConnectionStatus = {
  user_id: string
  email: string
  full_name: string | null
  role: AppRole
  is_active: boolean
  is_connected: boolean
  upwork_user_name: string | null
  org_name: string | null
  refreshed_at: string | null
  last_used_at: string | null
  connect_error: string | null
}

export type ActivityLog = {
  id: number
  actor_id: string | null
  action: string
  target_type: string | null
  target_id: string | null
  payload: Record<string, unknown>
  succeeded: boolean | null
  error: string | null
  created_at: string
}

// supabase-js requires the Relationships key on every table entry; without it
// the generated Insert/Update argument types collapse to `never`.
export type UpRoom = {
  room_id: string
  org_uid: string
  room_name: string | null
  topic: string | null
  room_type: string | null
  num_users: number | null
  num_unread: number
  is_favorite: boolean
  latest_story_id: string | null
  latest_story_at: string | null
  latest_snippet: string | null
  created_at_upwork: string | null
  last_visited_at: string | null
  contract_id: string | null
  contract_status: string | null
  fetched_at: string
}

export type UpMessage = {
  story_id: string
  room_id: string
  author_id: string | null
  author_name: string | null
  is_outbound: boolean
  direction: 'outbound' | 'inbound' | 'unknown'
  direction_source: string | null
  action_verb: string | null
  is_system: boolean
  body: string | null
  attachments: unknown[]
  sent_at: string | null
  edited_at: string | null
  fetched_at: string
}

export type Assignment = {
  id: string
  target_type: AssignmentTarget
  target_id: string
  assigned_to: string
  assigned_by: string | null
  note: string | null
  created_at: string
}

export type InternalNote = {
  id: string
  target_type: AssignmentTarget
  target_id: string
  author_id: string
  body: string
  created_at: string
  updated_at: string
}

export type UpworkProfileView = {
  id: string
  label: string
  upwork_user_name: string | null
  org_name: string | null
  org_role: string | null
  send_requires_approval: boolean
  is_active: boolean
  connect_error: string | null
  last_used_at: string | null
  refreshed_at: string | null
  room_count: number
  member_count: number
}

export type ProfileGrant = {
  profile_id: string
  user_id: string
  can_send: boolean
  granted_by: string | null
  created_at: string
}

export type RoomGrant = {
  room_id: string
  user_id: string
  profile_id: string
  can_send: boolean
  granted_by: string | null
  created_at: string
}

export type RoomProfile = {
  room_id: string
  profile_id: string
  first_seen_at: string
  last_seen_at: string
}

/**
 * Portal-derived reply state (0019). Outlives up_messages deliberately: it holds
 * a timestamp and an attribution label the portal worked out, not a copy of an
 * Upwork response, so keeping it does not extend their 24h caching window.
 */
export type RoomReplyState = {
  room_id: string
  awaiting_since: string | null
  attribution: string | null
  last_outbound_at: string | null
  message_count: number
  all_unknown: boolean
  observed_at: string
  /** Stamped every attribution attempt, so the backfill queue rotates. */
  attribution_pass_at: string | null
  /** The awaiting_since a "no reply needed" was granted for; see 0023. */
  waived_for: string | null
  waived_by: string | null
  waived_at: string | null
}

/** A dated intention to message a client again (0026). */
export type RoomFollowup = {
  id: number
  room_id: string
  due_at: string
  for_user: string
  note: string | null
  created_by: string | null
  created_at: string
  done_at: string | null
  done_by: string | null
}

/** v_followups — a follow-up with its conversation named. */
export type FollowupView = {
  id: number
  room_id: string
  room_name: string | null
  topic: string | null
  due_at: string
  for_user: string
  for_name: string | null
  note: string | null
  created_by: string | null
  created_at: string
  done_at: string | null
  is_due: boolean | null
}

/** A conversation that ended a working day unanswered (0030). */
export type ReplyMissStatus = 'pending' | 'confirmed' | 'dismissed'

export type ReplyMiss = {
  id: number
  miss_date: string
  room_id: string
  room_name: string | null
  employee_id: string
  employee_name: string
  awaiting_since: string
  waited_seconds: number
  attribution: string | null
  attribution_certain: boolean
  status: ReplyMissStatus
  reviewed_by: string | null
  reviewed_at: string | null
  review_note: string | null
  exported_at: string | null
  created_at: string
}

export type OutboundDraftStatus = 'pending' | 'approved' | 'declined' | 'withdrawn'

export type OutboundDraft = {
  id: string
  room_id: string
  author_id: string
  owner_id: string
  body: string
  status: OutboundDraftStatus
  note: string | null
  decline_reason: string | null
  decided_by: string | null
  decided_at: string | null
  sent_at: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export type RoomParticipant = {
  room_id: string
  user_id: string
  full_name: string | null
  email: string
  role: AppRole
  can_send: boolean
  profile_id: string
  profile_label: string
  last_seen_at: string
}

export type RoomProfileView = {
  room_id: string
  profile_id: string
  profile_label: string
  org_role: string | null
  last_seen_at: string
  /** Read before offering a Send button, so the gate is announced not discovered. */
  send_requires_approval: boolean
}

/**
 * Per-room reply state from v_room_wait (0017). Severity is not stored: the
 * ramp discounts overnight IST hours, which is computed in src/lib/wait.ts.
 */
/** Where the sync has stopped working (0022). Staff only. */
export type SyncGaps = {
  profiles_broken: number
  rooms_unreachable: number
  broken_labels: string[]
}

export type RoomWaitView = {
  room_id: string
  last_inbound_at: string | null
  last_outbound_at: string | null
  message_count: number
  awaiting_reply: boolean | null
  waiting_since: string | null
  /** direction_source of the unanswered message; 'alternation' means it is a guess. */
  waiting_source: string | null
  direction_unknown: boolean | null
  /** When the portal last confirmed this against live Upwork data. */
  observed_at: string
  /** True only while the waiver still applies to the current unanswered message. */
  waived: boolean | null
  waived_by: string | null
  waived_at: string | null
}

export type ProfileRoomCount = {
  profile_id: string
  profile_label: string
  room_count: number
  unread_rooms: number
}

export type ActivityView = {
  id: number
  actor_id: string | null
  actor_name: string | null
  actor_role: AppRole | null
  action: string
  target_type: string | null
  target_id: string | null
  room_name: string | null
  room_topic: string | null
  payload: Record<string, unknown> | null
  succeeded: boolean | null
  error: string | null
  created_at: string
}

export type SentMessage = {
  id: string
  room_id: string
  author_id: string
  body_sha: string
  sent_at: string
  story_id: string | null
}

type Table<Row, Insert = Partial<Row>, Update = Partial<Row>> = {
  Row: Row
  Insert: Insert
  Update: Update
  Relationships: []
}

export type Database = {
  public: {
    Tables: {
      app_users: Table<AppUser>
      upwork_connections: Table<
        UpworkConnection,
        // insert requires the identity + both sealed token triples
        Partial<UpworkConnection> &
          Pick<
            UpworkConnection,
            | 'user_id'
            | 'upwork_user_id'
            | 'org_uid'
            | 'access_token_ct'
            | 'access_token_iv'
            | 'access_token_tag'
            | 'refresh_token_ct'
            | 'refresh_token_iv'
            | 'refresh_token_tag'
          >
      >
      activity_log: Table<ActivityLog, Omit<Partial<ActivityLog>, 'id' | 'created_at'>>
      up_rooms: Table<UpRoom, Partial<UpRoom> & Pick<UpRoom, 'room_id' | 'org_uid'>>
      up_messages: Table<UpMessage, Partial<UpMessage> & Pick<UpMessage, 'story_id' | 'room_id'>>
      assignments: Table<
        Assignment,
        Partial<Assignment> & Pick<Assignment, 'target_type' | 'target_id' | 'assigned_to'>
      >
      upwork_profiles: Table<Record<string, unknown>, Record<string, unknown>>
      profile_grants: Table<
        ProfileGrant,
        Partial<ProfileGrant> & Pick<ProfileGrant, 'profile_id' | 'user_id'>
      >
      room_grants: Table<
        RoomGrant,
        Partial<RoomGrant> & Pick<RoomGrant, 'room_id' | 'user_id' | 'profile_id'>
      >
      room_profiles: Table<
        RoomProfile,
        Partial<RoomProfile> & Pick<RoomProfile, 'room_id' | 'profile_id'>
      >
      message_directions: Table<
        {
          story_id: string
          room_id: string
          direction: 'inbound' | 'outbound' | 'unknown'
          set_by: string | null
          set_at: string
        },
        {
          story_id: string
          room_id: string
          direction: 'inbound' | 'outbound' | 'unknown'
          set_by?: string | null
        }
      >
      up_proposals: Table<
        {
          proposal_id: string
          org_uid: string
          job_id: string | null
          job_title: string | null
          status: string | null
          status_label: string | null
          rate_amount: number | null
          rate_currency: string | null
          created_at_upwork: string | null
          fetched_at: string
        },
        {
          proposal_id: string
          org_uid: string
          job_id?: string | null
          job_title?: string | null
          status?: string | null
          status_label?: string | null
          rate_amount?: number | null
          rate_currency?: string | null
          created_at_upwork?: string | null
          fetched_at?: string
        }
      >
      reply_misses: Table<
        ReplyMiss,
        Partial<ReplyMiss> &
          Pick<ReplyMiss, 'miss_date' | 'room_id' | 'employee_id' | 'employee_name' | 'awaiting_since' | 'waited_seconds'>
      >
      room_followups: Table<
        RoomFollowup,
        Partial<RoomFollowup> & Pick<RoomFollowup, 'room_id' | 'due_at' | 'for_user'>
      >
      room_reply_state: Table<
        RoomReplyState,
        Partial<RoomReplyState> & Pick<RoomReplyState, 'room_id'>
      >
      outbound_drafts: Table<
        OutboundDraft,
        Partial<OutboundDraft> &
          Pick<OutboundDraft, 'room_id' | 'author_id' | 'owner_id' | 'body'>
      >
      sent_messages: Table<
        SentMessage,
        Partial<SentMessage> & Pick<SentMessage, 'room_id' | 'author_id' | 'body_sha'>
      >
      internal_notes: Table<
        InternalNote,
        Partial<InternalNote> &
          Pick<InternalNote, 'target_type' | 'target_id' | 'author_id' | 'body'>
      >
    }
    Views: {
      v_upwork_health: { Row: UpworkHealth; Relationships: [] }
      v_room_participants: { Row: RoomParticipant; Relationships: [] }
      v_profiles: { Row: UpworkProfileView; Relationships: [] }
      v_room_profiles: { Row: RoomProfileView; Relationships: [] }
      v_profile_room_counts: { Row: ProfileRoomCount; Relationships: [] }
      v_room_wait: { Row: RoomWaitView; Relationships: [] }
      v_followups: { Row: FollowupView; Relationships: [] }
      v_sync_gaps: { Row: SyncGaps; Relationships: [] }
      v_activity: { Row: ActivityView; Relationships: [] }
    }
    Functions: {
      bump_sync_budget: {
        Args: {
          p_endpoint: string
          p_requests?: number
          p_errors?: number
          p_throttled?: number
        }
        Returns: number
      }
      waive_room_reply: {
        Args: { p_room_id: string; p_waive: boolean }
        Returns: boolean
      }
      rooms_needing_reply_state: {
        Args: { p_profile_id: string; p_limit?: number }
        Returns: { room_id: string; room_name: string | null; last_visited_at: string | null }[]
      }
      rooms_needing_attribution: {
        Args: { p_limit?: number }
        Returns: string[]
      }
      revoke_member_access: {
        Args: { p_user_id: string }
        Returns: undefined
      }
      pending_approvals_for: {
        Args: { p_user_id?: string }
        Returns: number
      }
      visible_profile_ids: {
        Args: { p_user_id?: string }
        Returns: string[]
      }
      can_see_activity_of: {
        Args: { p_actor: string | null }
        Returns: boolean
      }
      profiles_for_room: {
        Args: { p_room_id: string; p_user_id?: string }
        Returns: { profile_id: string; can_send: boolean }[]
      }
      sync_budget_today: {
        Args: Record<string, never>
        Returns: number
      }
      expire_upwork_mirror: {
        Args: { p_max_age?: string }
        Returns: { table_name: string; deleted: number }[]
      }
    }
    Enums: {
      app_role: AppRole
      assignment_target: AssignmentTarget
      draft_status: DraftStatus
      outbound_draft_status: OutboundDraftStatus
    }
  }
}
