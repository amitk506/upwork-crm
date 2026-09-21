'use client'

import { useState, useTransition } from 'react'

import { addNote, sendReply } from '@/app/inbox/actions'
import {
  AttachButton,
  StagedFiles,
  useAttachments,
} from '@/components/attachment-picker'
import { ProfileAvatar } from '@/components/profile-avatar'
import { MESSAGE_MAX_LENGTH } from '@/lib/upwork/types'

/**
 * Writing into a conversation — either to the client, or to the team.
 *
 * The highest-stakes state in the whole product is note mode, because the one
 * failure that can cost a client relationship outright is an internal note going
 * out as a reply. So the mode change is carried by four independent signals,
 * none of which relies on colour alone:
 *
 *   1. the surface drops to sunk grey
 *   2. the input border becomes dashed
 *   3. a strip states the consequence in plain words
 *   4. the button loses its accent fill and its label changes to "Save note"
 *
 * Signal 4 matters most. Because send is DE-EMPHASISED in note mode, muscle
 * memory works in your favour: the reflex to hit the solid accent button is the
 * reflex to send a real reply, and that button is simply not on screen while you
 * are writing a note.
 *
 * Note mode stays available to people who cannot reply. A note never touches
 * Upwork, so read-only access to a conversation is no reason to bar someone from
 * telling their team what they found.
 */

const NOTE_MAX_LENGTH = 4_000

export function Composer({
  roomId,
  canSend,
  blockedReason,
  actingProfile,
  senderName,
}: {
  roomId: string
  canSend: boolean
  blockedReason?: string | null
  /** The identity the client will see on a reply. */
  actingProfile?: { id: string; label: string } | null
  /** The current member, recorded internally against whatever they send. */
  senderName?: string
}) {
  const [mode, setMode] = useState<'reply' | 'note'>(canSend ? 'reply' : 'note')
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [dragging, setDragging] = useState(false)
  const attachments = useAttachments()

  const isNote = mode === 'note'
  const limit = isNote ? NOTE_MAX_LENGTH : MESSAGE_MAX_LENGTH
  const length = body.trim().length
  const overLimit = length > limit
  // A screenshot with no caption is a perfectly good message.
  const hasSomething = length > 0 || (!isNote && attachments.files.length > 0)

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (overLimit || !hasSomething) return
    setError(null)
    setSaved(null)

    startTransition(async () => {
      const result = isNote
        ? await addNote(roomId, body)
        : await sendReply(
            roomId,
            body,
            attachments.files.map((f) => ({
              name: f.name,
              type: f.type,
              size: f.size,
              base64: f.base64,
            })),
          )

      if (result?.error) {
        setError(result.error)
        return
      }
      setBody('')
      const sentCount = attachments.files.length
      attachments.clear()
      setSaved(
        isNote
          ? 'Note saved. Only the team can see it.'
          : sentCount > 0
            ? `Reply sent with ${sentCount} file${sentCount === 1 ? '' : 's'}.`
            : 'Reply sent.',
      )
    })
  }

  return (
    <form
      onSubmit={submit}
      onPaste={(e) => {
        // Only claim the paste when it actually carries files, or pasting text
        // into the box would stop working.
        if (isNote || e.clipboardData.files.length === 0) return
        e.preventDefault()
        void attachments.add(e.clipboardData.files)
      }}
      onDragOver={(e) => {
        if (isNote) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (isNote) return
        e.preventDefault()
        setDragging(false)
        void attachments.add(e.dataTransfer.files)
      }}
      className={[
        'rounded-[--radius] border p-3',
        isNote ? 'bg-sunk' : 'bg-surface',
        dragging ? 'border-accent bg-accent-tint' : '',
      ].join(' ')}
    >
      {/* Signal 3, and the attribution line it replaces in reply mode. Both are
          permanent: whichever mode you are in, the consequence is on screen. */}
      {isNote ? (
        <p className="mb-2.5 flex items-center gap-2 rounded-[--radius-sm] border border-dashed border-line-strong bg-sunk-2 px-3 py-1.5 text-[11.5px] font-semibold text-soft">
          <NoteIcon />
          Internal note — stays in the portal. The client will not see this.
        </p>
      ) : (
        actingProfile && (
          <p className="mb-2.5 flex items-center gap-2 text-[11.5px] text-soft">
            <ProfileAvatar profileId={actingProfile.id} label={actingProfile.label} size="xs" />
            Sending as <span className="font-semibold text-ink">{actingProfile.label}</span>
            {senderName && (
              <span className="text-faint">
                · they see {actingProfile.label.split(/\s+/)[0]}, your name is recorded internally
              </span>
            )}
          </p>
        )
      )}

      {!isNote && (
        <StagedFiles
          files={attachments.files}
          onRemove={attachments.remove}
          disabled={pending}
        />
      )}

      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={4}
        aria-label={isNote ? 'Internal note' : 'Reply to the client'}
        placeholder={
          isNote
            ? 'What should the team know? Use @name to point it at someone.'
            : 'Write a reply… paste or drop a file to attach it'
        }
        className={[
          'w-full resize-y rounded-[--radius-sm] border px-3 py-2 text-sm outline-none',
          'placeholder:text-faint',
          // Signals 1 and 2.
          isNote
            ? 'border-dashed border-line-strong bg-surface'
            : 'border-line-strong bg-surface focus:border-accent',
        ].join(' ')}
      />

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <div className="flex overflow-hidden rounded-[--radius-sm] border border-line">
          <button
            type="button"
            onClick={() => canSend && setMode('reply')}
            disabled={!canSend}
            title={canSend ? undefined : (blockedReason ?? 'You cannot reply here')}
            aria-pressed={!isNote}
            className={`px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
              !isNote ? 'bg-ink text-paper' : 'text-faint hover:text-soft disabled:opacity-40'
            }`}
          >
            Reply
          </button>
          <button
            type="button"
            onClick={() => setMode('note')}
            aria-pressed={isNote}
            className={`px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
              isNote ? 'bg-ink text-paper' : 'text-faint hover:text-soft'
            }`}
          >
            Internal note
          </button>
        </div>

        {!isNote && canSend && (
          <AttachButton onPick={(picked) => void attachments.add(picked)} />
        )}

        <span className={`tabular text-xs ${overLimit ? 'text-stop' : 'text-faint'}`}>
          {length.toLocaleString()} / {limit.toLocaleString()}
          {overLimit && (isNote ? ' — too long to save' : ' — too long to send')}
        </span>

        <span className="ml-auto flex items-center gap-2">
          {/* Signal 4: no accent fill in note mode, and the verb changes. */}
          <button
            type="submit"
            // Never offer a working Send in reply mode without the right to send.
            // The old composer rendered it enabled and let the server refuse.
            disabled={pending || !hasSomething || overLimit || (!isNote && !canSend)}
            className={[
              'inline-flex h-8 items-center gap-1.5 rounded-[--radius-sm] px-3.5 text-sm font-semibold',
              'disabled:cursor-not-allowed disabled:opacity-45',
              isNote
                ? 'border border-line-strong bg-surface text-ink hover:bg-sunk-2'
                : 'bg-action text-action-ink hover:opacity-90',
            ].join(' ')}
          >
            {isNote ? <NoteIcon /> : null}
            {pending ? (isNote ? 'Saving…' : 'Sending…') : isNote ? 'Save note' : 'Send reply'}
          </button>
        </span>
      </div>

      {!canSend && !isNote && (
        <p className="mt-2 text-sm text-warn">{blockedReason ?? 'You cannot reply here.'}</p>
      )}

      {!canSend && isNote && blockedReason && (
        <p className="mt-2 text-[11.5px] text-faint">
          {blockedReason} You can still leave notes — they never reach Upwork.
        </p>
      )}

      {attachments.error && <p className="mt-2 text-sm text-warn">{attachments.error}</p>}
      {error && <p className="mt-2 text-sm text-stop">{error}</p>}
      {saved && !error && <p className="mt-2 text-[11.5px] text-ok">{saved}</p>}
    </form>
  )
}

function NoteIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="h-3.5 w-3.5 shrink-0 fill-none stroke-current"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 4h14v11l-4 5H5z" />
      <path d="M9 9h6M9 13h4" />
    </svg>
  )
}
