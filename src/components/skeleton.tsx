/**
 * Loading placeholders.
 *
 * Geometry matches the real thing exactly — 34px monogram, three text lines, a
 * meter block on the right — so nothing shifts when data lands. A skeleton whose
 * rows are the wrong height is worse than a spinner: it promises a layout and
 * then moves it.
 *
 * Rows fade toward the fold so the count does not read as a promise about how
 * many conversations are coming.
 */

export function SkeletonBar({ className = '' }: { className?: string }) {
  return <span className={`skeleton block rounded-[5px] ${className}`} />
}

export function SkeletonRow({ dim = 1 }: { dim?: number }) {
  return (
    <div
      style={{ opacity: dim }}
      className="grid grid-cols-[34px_minmax(0,1fr)_46px] gap-3 border-b border-line py-[13px] pl-[17px] pr-3.5"
    >
      <SkeletonBar className="h-[34px] w-[34px] rounded-[9px]" />
      <div className="flex flex-col gap-[7px] pt-0.5">
        <SkeletonBar className="h-3 w-[56%]" />
        <SkeletonBar className="h-2 w-[38%]" />
        <SkeletonBar className="h-2 w-[82%]" />
      </div>
      <div className="flex flex-col items-end gap-[7px] pt-0.5">
        <SkeletonBar className="h-2 w-[38px]" />
        <SkeletonBar className="h-2 w-[44px]" />
      </div>
    </div>
  )
}

/** Widths vary per row so the block does not read as a table. */
const WIDTHS = [56, 44, 62, 50, 58, 48]

export function SkeletonList({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={WIDTHS[i] ?? i} dim={i >= rows - 1 ? 0.5 : 1} />
      ))}
    </div>
  )
}

export function SkeletonFigure() {
  return (
    <div className="bg-surface px-4 py-3">
      <SkeletonBar className="h-2 w-[64px]" />
      <SkeletonBar className="mt-2.5 h-6 w-[38px]" />
      <SkeletonBar className="mt-2.5 h-2 w-[80%]" />
    </div>
  )
}
