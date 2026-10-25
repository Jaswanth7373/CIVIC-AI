import { useEffect, useState } from 'react'
import { cn } from '@/utils/cn'
import { LogoMark } from './Logo'
import { Skeleton } from './Skeleton'

/** How long a page's code may take before its placeholder shows more than the lane-line bar. */
const PAGE_SKELETON_DELAY = 300

/** A short stretch of road seen from the driver's seat, its yellow centre marks flowing toward the viewer. */
function LoaderRoad({ className }) {
  return <span aria-hidden className={cn('loader-road', className)} />
}

/**
 * Loading state for a page or the whole app, with a text label for everyone (role="status").
 *
 * - default ("road"): the road loader - asphalt receding into a fade with the yellow centre marks flowing toward
 *   the viewer (still for users who prefer reduced motion) - above the label. `fullScreen` adds the CivicAI sign
 *   panel above the road, like a gantry sign over the carriageway (session check, first load).
 * - `variant="page"`: used in the dashboard while a page's code loads for the first time. For its first 300 ms
 *   only a lane-line bar runs along the top of the page area, so a quick load goes straight to the page (or to
 *   the page's own skeleton) without a second, differently shaped placeholder first. After that a neutral outline
 *   appears - a heading and one large panel, no stat tiles, since the page may be a list, a detail or a form.
 *   The label is read to screen readers only.
 *
 * Page-area loaders (every variant except `fullScreen`) carry `data-page-loader`. A layout uses it to keep
 * whatever follows the page area - the public site footer - out of the layout while the page is loading, so
 * the footer is never on screen only to jump away when the page arrives (cold-load layout shift).
 *
 * @param {{label?: string, fullScreen?: boolean, variant?: 'road'|'page', className?: string}} props
 *   other props (e.g. `id`, `data-*`) are passed to the root element
 */
/** The page variant: a lane-line bar first, the neutral outline only when the load takes longer. */
function PageOutline({ label, className, ...props }) {
  const [late, setLate] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setLate(true), PAGE_SKELETON_DELAY)
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <div role="status" aria-live="polite" data-page-loader="" {...props} className={cn('w-full', className)}>
      <span className="sr-only">{label}…</span>
      {late ? (
        <div aria-hidden className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <Skeleton className="h-8 w-56 max-w-[70%] rounded-lg" />
            <Skeleton className="h-4 w-[28rem] max-w-full" />
          </div>
          <Skeleton className="h-96 rounded-xl" />
        </div>
      ) : (
        <div aria-hidden className="h-1 overflow-hidden rounded-full bg-sunken">
          <div className="lane-line-x animate-lane h-full w-full motion-reduce:animate-none" />
        </div>
      )}
    </div>
  )
}

export function PageLoader({ label = 'Loading', fullScreen = false, variant = 'road', className, ...props }) {
  if (variant === 'page' && !fullScreen) return <PageOutline label={label} className={className} {...props} />

  return (
    <div
      role="status"
      aria-live="polite"
      data-page-loader={fullScreen ? undefined : ''}
      {...props}
      className={cn('grid place-items-center px-4', fullScreen ? 'min-h-dvh bg-bg' : 'min-h-[50vh]', className)}
    >
      <div className="flex flex-col items-center">
        {fullScreen ? <LogoMark size={44} className="mb-3" /> : null}
        <LoaderRoad />
        <p className="mt-3 text-sm font-medium text-ink-2">{label}…</p>
      </div>
    </div>
  )
}

export default PageLoader
