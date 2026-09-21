'use client'

import { useRef, useState } from 'react'

/**
 * Choosing files to send: a button, a paste, or a drop.
 *
 * Paste matters most in practice — the common case is a screenshot on the
 * clipboard, and a clipboard image has no filename, so one is invented from the
 * timestamp rather than sending "image.png" every time.
 *
 * Files are read to base64 here because that is what Upwork's upload tool takes.
 * They are held in memory until send: the upload session is short-lived and tied
 * to the room, so opening one while someone is still typing would usually expire
 * before they finished.
 */

export type StagedFile = {
  id: string
  name: string
  type: string
  size: number
  base64: string
  previewUrl: string | null
}

/** Upwork's inline upload path caps at 7 MB per file. */
export const MAX_FILE_BYTES = 7 * 1024 * 1024
export const MAX_FILES = 5

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function toStaged(file: File, index: number): Promise<StagedFile> {
  const buffer = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  // Chunked: a single spread of a multi-megabyte array blows the call stack.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }

  const isImage = file.type.startsWith('image/')
  return {
    id: `${Date.now()}-${index}-${file.name}`,
    // A pasted screenshot arrives as "image.png" or nothing at all.
    name: file.name && file.name !== 'image.png' ? file.name : pastedName(file.type),
    type: file.type || 'application/octet-stream',
    size: file.size,
    base64: btoa(binary),
    previewUrl: isImage ? URL.createObjectURL(file) : null,
  }
}

function pastedName(type: string): string {
  const ext = type.split('/')[1]?.split('+')[0] ?? 'png'
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `screenshot-${stamp}.${ext}`
}

export function useAttachments() {
  const [files, setFiles] = useState<StagedFile[]>([])
  const [error, setError] = useState<string | null>(null)

  async function add(incoming: FileList | File[] | null) {
    if (!incoming) return
    const list = Array.from(incoming)
    if (list.length === 0) return

    setError(null)
    const accepted: StagedFile[] = []

    for (const [index, file] of list.entries()) {
      if (file.size > MAX_FILE_BYTES) {
        setError(`${file.name || 'That file'} is ${formatSize(file.size)}. The limit is 7 MB.`)
        continue
      }
      accepted.push(await toStaged(file, index))
    }

    setFiles((current) => {
      const next = [...current, ...accepted]
      if (next.length > MAX_FILES) {
        setError(`Up to ${MAX_FILES} files per message.`)
        return next.slice(0, MAX_FILES)
      }
      return next
    })
  }

  function remove(id: string) {
    setFiles((current) => {
      const gone = current.find((f) => f.id === id)
      // Release the object URL, or a long session leaks every preview.
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl)
      return current.filter((f) => f.id !== id)
    })
  }

  function clear() {
    setFiles((current) => {
      for (const f of current) if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
      return []
    })
    setError(null)
  }

  return { files, add, remove, clear, error, setError }
}

export function AttachButton({ onPick }: { onPick: (files: FileList | null) => void }) {
  const input = useRef<HTMLInputElement>(null)

  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          onPick(e.target.files)
          // Reset, or picking the same file twice in a row does nothing.
          e.target.value = ''
        }}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        title="Attach a file"
        aria-label="Attach a file"
        className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[--radius-sm] border border-line text-soft hover:bg-sunk"
      >
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          className="h-4 w-4 fill-none stroke-current"
          strokeWidth="1.7"
          strokeLinecap="round"
        >
          <path d="M15 7l-6.5 6.5a2.5 2.5 0 003.5 3.5L19 10a4.5 4.5 0 00-6.4-6.4L6 10.2" />
        </svg>
      </button>
    </>
  )
}

export function StagedFiles({
  files,
  onRemove,
  disabled,
}: {
  files: StagedFile[]
  onRemove: (id: string) => void
  disabled?: boolean
}) {
  if (files.length === 0) return null

  return (
    <ul className="mb-2 flex flex-wrap gap-2">
      {files.map((file) => (
        <li
          key={file.id}
          className="flex items-center gap-2 rounded-[--radius-sm] border border-line bg-surface py-1 pl-1 pr-2"
        >
          {file.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={file.previewUrl}
              alt=""
              className="h-8 w-8 rounded-[4px] object-cover"
            />
          ) : (
            <span className="grid h-8 w-8 place-items-center rounded-[4px] bg-sunk-2 text-faint">
              <svg
                aria-hidden
                viewBox="0 0 24 24"
                className="h-4 w-4 fill-none stroke-current"
                strokeWidth="1.6"
              >
                <path d="M6 3h8l4 4v14H6z" />
                <path d="M14 3v4h4" />
              </svg>
            </span>
          )}
          <span className="min-w-0">
            <span className="block max-w-[13rem] truncate text-[11.5px] font-medium">
              {file.name}
            </span>
            <span className="tabular block text-[10.5px] text-faint">{formatSize(file.size)}</span>
          </span>
          <button
            type="button"
            onClick={() => onRemove(file.id)}
            disabled={disabled}
            aria-label={`Remove ${file.name}`}
            className="ml-1 text-[13px] leading-none text-faint hover:text-stop disabled:opacity-40"
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  )
}
