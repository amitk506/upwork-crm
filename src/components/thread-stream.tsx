import { CorrectDirection } from '@/components/correct-direction'
import { ProfileAvatar } from '@/components/profile-avatar'
import { formatDateTime } from '@/lib/format'
import { identityStyle } from '@/lib/identity'
import { directionConfidence, type DirectionSource } from '@/lib/upwork/direction'
import { isUpworkPlaceholder } from '@/lib/upwork/text'
import {
  formatBytes,
  kindLabel,
  parseAttachments,
  type Attachment,
} from '@/lib/upwork/attachments'

/**
 * The conversation itself, with the team's own notes threaded through it.
 *
 * Notes used to live in a sidebar panel, which meant reading a conversation and
 * reading what your colleagues said about it were two different activities in two
 * different places — and the note that says "don't mention the hours, Aditi
 * already fixed them" is worthless if you only find it after replying.
 *
 * They are interleaved by time, but rendered so they cannot possibly be mistaken
 * for a message: centred rather than sided, dashed rather than solid, narrower
 * than a bubble, and captioned with the consequence.
 *
 * Two attribution rules the design turns on:
 *
 *   · An outbound message is stamped "Vansh Kapoor, as Gayatri Mittal". The
 *     client sees one voice; the agency sees who actually typed it. That pairing
 *     is the whole reason a shared-profile inbox is honest rather than a way of
 *     hiding who did the work.
 *
 *   · Upwork returns no sender, so a side we worked out is labelled as worked
 *     out. `certain` is true only for messages the portal recorded sending.
 */

export type StreamMessage = {
  story_id: string
  body: string | null
  attachments?: unknown
  sent_at: string | null
  is_system: boolean | null
  author_id: string | null
  direction: 'inbound' | 'outbound' | 'unknown'
  direction_source: string | null
}

export type StreamNote = {
  id: string
  body: string
  created_at: string
  author_id: string | null
}

const SOURCE_EXPLANATION: Record<string, string> = {
  mention: 'Worked out: this message addresses the client by name, and nobody addresses themselves.',
  visit_window: 'Worked out: this arrived after the profile last opened the conversation.',
  burst: 'Worked out: sent seconds after a message whose side is known — the same person still typing.',
  alternation:
    'Approximate: Upwork does not report who sent a message, so this side comes from the conversation’s turn-taking. It can be wrong when one party sends twice with no reply between.',
}

export function ThreadStream({
  messages,
  notes,
  memberNames,
  clientName,
  actingProfile,
  roomId,
}: {
  messages: StreamMessage[]
  notes: StreamNote[]
  memberNames: Map<string, string>
  clientName: string
  actingProfile: { id: string; label: string } | null
  roomId: string
}) {
  // Day rules are worked out here rather than while rendering: deciding them
  // inside the map would mean mutating a running value during render.
  const ordered = [
    ...messages.map((m) => ({ kind: 'message' as const, at: m.sent_at ?? '', data: m })),
    ...notes.map((n) => ({ kind: 'note' as const, at: n.created_at, data: n })),
  ].sort((a, b) => a.at.localeCompare(b.at))

  const items = ordered.map((item, i) => ({
    ...item,
    startsNewDay: Boolean(item.at) && item.at.slice(0, 10) !== (ordered[i - 1]?.at ?? '').slice(0, 10),
  }))

  if (items.length === 0) {
    // AutoPull owns the empty state now: it fetches on open and reports on its
    // own progress. A second message here would contradict it.
    return null
  }

  return (
    <>
      {items.map((item) => {
        return (
          <div key={`${item.kind}-${item.kind === 'note' ? item.data.id : item.data.story_id}`}>
            {item.startsNewDay && <DayRule at={item.at} />}
            {item.kind === 'note' ? (
              <NoteCard
                note={item.data}
                authorName={memberNames.get(item.data.author_id ?? '') ?? 'A teammate'}
              />
            ) : (
              <MessageRow
                message={item.data}
                memberNames={memberNames}
                clientName={clientName}
                actingProfile={actingProfile}
                roomId={roomId}
              />
            )}
          </div>
        )
      })}
    </>
  )
}

function DayRule({ at }: { at: string }) {
  return (
    <div className="my-3 flex items-center gap-3 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-faint">
      <span className="h-px flex-1 bg-line" />
      <span className="tabular">{formatDateTime(at).split(',')[0]}</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}

function MessageRow({
  message,
  memberNames,
  clientName,
  actingProfile,
  roomId,
}: {
  message: StreamMessage
  memberNames: Map<string, string>
  clientName: string
  actingProfile: { id: string; label: string } | null
  roomId: string
}) {
  // System events are not someone talking — a milestone submission, a contract
  // ending. They get no bubble and no side.
  if (message.is_system) {
    return (
      <p className="mx-auto my-2 max-w-md rounded-full border border-line bg-sunk px-3.5 py-1 text-center text-[11px] text-faint">
        {message.body}
        {message.sent_at && <span className="tabular"> · {formatDateTime(message.sent_at)}</span>}
      </p>
    )
  }

  const files = parseAttachments(message.attachments)
  const text = isUpworkPlaceholder(message.body) ? null : message.body
  const mine = message.direction === 'outbound'
  const source = message.direction_source as DirectionSource
  const confidence = directionConfidence(source)
  const certain = mine && confidence === 'certain'
  const typedBy = certain ? memberNames.get(message.author_id ?? '') : null

  return (
    <div
      style={mine ? identityStyle(actingProfile?.id) : undefined}
      className={[
        'my-1.5 flex max-w-[86%] flex-col gap-1',
        mine ? 'ml-auto items-end' : 'items-start',
      ].join(' ')}
    >
      <div
        className={[
          'rounded-[12px] border px-3.5 py-2.5 text-[13.5px] leading-relaxed',
          mine
            ? 'rounded-br-[4px] border-accent/25 bg-accent-tint'
            : 'rounded-bl-[4px] border-line bg-surface',
        ].join(' ')}
      >
        {/* Upwork sends a stand-in body when a message is only files. Rendering
            it says nothing and points the reader off to upwork.com, so the
            attachment speaks for itself instead. */}
        {text && <p className="whitespace-pre-wrap">{text}</p>}
        {files.length > 0 && <Attachments files={files} spaced={Boolean(text)} />}
        {!text && files.length === 0 && (
          <p className="text-faint">
            {isUpworkPlaceholder(message.body)
              ? 'Upwork did not return this message’s content.'
              : 'No text in this message.'}
          </p>
        )}
      </div>

      <p className="flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-faint">
        {mine ? (
          <>
            {/* The stamp. Who typed it, and whose name the client saw. */}
            {typedBy && <span className="font-semibold text-soft">{typedBy}</span>}
            {typedBy && actingProfile && <span>, as</span>}
            {actingProfile && (
              <>
                <ProfileAvatar
                  profileId={actingProfile.id}
                  label={actingProfile.label}
                  size="xs"
                />
                <span className="font-semibold text-soft">{actingProfile.label}</span>
              </>
            )}
            {!typedBy && <span className="font-semibold text-soft">Your side</span>}
          </>
        ) : message.direction === 'inbound' ? (
          <span className="font-semibold text-soft">{clientName}</span>
        ) : (
          <span title="Upwork returned no sender and nothing in the thread settled it.">
            Sender unclear
          </span>
        )}

        {/* Only where the side was guessed. A message the portal recorded
            sending is not up for debate. */}
        {confidence !== 'certain' && (
          <CorrectDirection storyId={message.story_id} roomId={roomId} currentlyOutbound={mine} />
        )}

        {message.direction !== 'unknown' && confidence !== 'certain' && (
          <span
            className={confidence === 'inferred' ? 'text-warn' : ''}
            title={SOURCE_EXPLANATION[source ?? ''] ?? 'Worked out from the conversation.'}
          >
            · {confidence === 'inferred' ? 'approximate' : 'worked out'}
          </span>
        )}

        <span className="tabular">· {formatDateTime(message.sent_at, '')}</span>
      </p>
    </div>
  )
}

function NoteCard({ note, authorName }: { note: StreamNote; authorName: string }) {
  return (
    <div className="mx-auto my-2.5 max-w-[72%] rounded-[10px] border border-dashed border-line-strong bg-sunk px-3.5 py-2.5">
      <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-faint">
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="h-3 w-3 fill-none stroke-current"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 4h14v11l-4 5H5z" />
          <path d="M9 9h6M9 13h4" />
        </svg>
        Internal note · not sent to the client
      </p>
      <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-soft">
        {highlightMentions(note.body)}
      </p>
      <p className="mt-1.5 text-[11px] text-faint">
        <span className="font-semibold text-soft">{authorName}</span>
        <span className="tabular"> · {formatDateTime(note.created_at)}</span>
      </p>
    </div>
  )
}

/** "@Vansh can you check" — the point of a note is usually aimed at someone. */
function highlightMentions(body: string) {
  return body.split(/(@[\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?)/gu).map((part, i) =>
    part.startsWith('@') ? (
      <span key={i} className="font-semibold text-accent">
        {part}
      </span>
    ) : (
      part
    ),
  )
}


/**
 * Files on a message.
 *
 * Listed, not previewed. Upwork serves attachments from a browser-session
 * endpoint — fetching one with the portal's OAuth token returns 403, exactly as
 * it does with no credentials at all — so the bytes are genuinely out of reach
 * and an <img> would render a broken image on every message. A named, sized,
 * typed row that opens the real thing is worth more than a placeholder.
 *
 * The link goes to Upwork and needs an Upwork login, which most of the team does
 * not have. That is said on the row rather than discovered by clicking.
 */
function Attachments({ files, spaced }: { files: Attachment[]; spaced: boolean }) {
  return (
    <ul className={spaced ? 'mt-2 space-y-1.5' : 'space-y-1.5'}>
      {files.map((file) => {
        const meta = [kindLabel(file), formatBytes(file.size)].filter(Boolean).join(' · ')

        const inner = (
          <>
            <span
              aria-hidden
              className={[
                'mt-px shrink-0',
                file.isImage ? 'text-accent' : 'text-faint',
              ].join(' ')}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4 fill-none stroke-current"
                strokeWidth="1.6"
                strokeLinejoin="round"
              >
                {file.isImage ? (
                  <>
                    <rect x="3.5" y="5" width="17" height="14" rx="2" />
                    <path d="M3.5 16l4.5-4 4 3.5 3.5-3 5 4.5" />
                  </>
                ) : (
                  <>
                    <path d="M6 3h8l4 4v14H6z" />
                    <path d="M14 3v4h4" />
                  </>
                )}
              </svg>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{file.name}</span>
              <span className="block text-[11px] text-faint">
                {meta}
                {!file.safe && (
                  <span className="text-stop">
                    {' · '}
                    {file.scanStatus ? `scan: ${file.scanStatus.toLowerCase()}` : 'not virus-scanned'}
                  </span>
                )}
              </span>
            </span>
          </>
        )

        // No link when the URL failed validation or Upwork has not cleared the
        // file — the row still appears, so nobody wonders where the file went.
        if (!file.url || !file.safe) {
          return (
            <li
              key={file.id}
              className="flex items-start gap-2 rounded-[--radius-sm] border border-dashed border-line-strong px-2.5 py-1.5 text-[12.5px]"
              title={
                file.safe
                  ? 'This attachment had no usable Upwork link.'
                  : 'Upwork has not marked this file clean, so the portal will not link to it.'
              }
            >
              {inner}
            </li>
          )
        }

        return (
          <li key={file.id}>
            <a
              href={file.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Opens on Upwork — needs an Upwork login"
              className="flex items-start gap-2 rounded-[--radius-sm] border border-line bg-surface px-2.5 py-1.5 text-[12.5px] transition-colors hover:border-line-strong"
            >
              {inner}
              <span className="mt-px shrink-0 text-[10.5px] text-faint">Upwork ↗</span>
            </a>
          </li>
        )
      })}
    </ul>
  )
}
