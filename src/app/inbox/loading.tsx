import { SkeletonBar, SkeletonFigure, SkeletonList } from '@/components/skeleton'

/**
 * The inbox while it loads.
 *
 * Both columns are drawn at their real widths, so the workspace does not jump
 * from one layout to another when the data arrives.
 */
export default function InboxLoading() {
  return (
    <div className="grid h-screen min-h-0 md:grid-cols-[216px_minmax(0,1fr)]">
      {/* The rail is rendered by AppShell, which belongs to the page — so this
          has to stand in for it, or the entire workspace shifts sideways the
          moment the page resolves. */}
      <div className="hidden flex-col gap-2 border-r border-line bg-surface px-5 py-4 md:flex">
        <SkeletonBar className="h-3 w-[92px]" />
        <SkeletonBar className="h-2 w-[70px]" />
        <SkeletonBar className="mt-4 h-7 w-full rounded-[--radius-sm]" />
        {['w-[54%]', 'w-[62%]', 'w-[48%]', 'w-[58%]'].map((width) => (
          <SkeletonBar key={width} className={`mt-1.5 h-2.5 ${width}`} />
        ))}
      </div>

      <div className="grid h-full min-h-0 lg:grid-cols-[336px_minmax(0,1fr)]">
      <div className="min-h-0 border-r border-line bg-surface">
        <div className="flex gap-4 border-b border-line px-3.5 py-3">
          <SkeletonBar className="h-3 w-[68px]" />
          <SkeletonBar className="h-3 w-[52px]" />
          <SkeletonBar className="h-3 w-[40px]" />
        </div>
        <SkeletonList rows={7} />
      </div>

      <div className="hidden flex-col gap-4 bg-paper p-6 lg:flex">
        <div className="flex flex-col gap-2">
          <SkeletonBar className="h-5 w-[210px]" />
          <SkeletonBar className="h-2.5 w-[70%] max-w-[420px]" />
        </div>

        <div className="grid gap-px overflow-hidden rounded-[--radius] border border-line bg-line sm:grid-cols-3">
          <SkeletonFigure />
          <SkeletonFigure />
          <SkeletonFigure />
        </div>

        <div className="overflow-hidden rounded-[--radius] border border-line bg-surface">
          <div className="border-b border-line px-4 py-2.5">
            <SkeletonBar className="h-2 w-[96px]" />
          </div>
          {['w-[58%]', 'w-[48%]', 'w-[54%]'] .map((width) => (
            <div
              key={width}
              className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
            >
              <SkeletonBar className={`h-2.5 ${width}`} />
              <SkeletonBar className="ml-auto h-2.5 w-[44px]" />
            </div>
          ))}
        </div>

        <p className="mt-auto flex items-center gap-2 text-[11px] text-faint">
          <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-accent" />
          Loading your conversations…
        </p>
      </div>
      </div>
    </div>
  )
}
