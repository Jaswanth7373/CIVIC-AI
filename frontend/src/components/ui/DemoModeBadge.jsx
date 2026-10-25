import { FlaskConical } from 'lucide-react'
import { useConfig } from '@/hooks/useConfig'
import { cn } from '@/utils/cn'
import { DEMO_MODE_DESCRIPTION } from '@/utils/constants'
import { Tooltip } from './Tooltip'

/** Gives the reserved strip one line of text height. */
const NO_BREAK_SPACE = String.fromCharCode(0xa0)

/**
 * "Demo AI Mode" label. Renders only when /system/config/ reports that the AI engine runs in demo mode (never
 * while the mode is still unknown), so the label is always truthful.
 *
 * - `variant="badge"` (default): a small yellow badge; it is a button with a tooltip that explains what demo
 *   mode means, so keyboard and touch users can reach the explanation too (44px tall on touch screens).
 * - `variant="strip"`: a slim full-width line with the label and a one-line explanation, for phones, where
 *   the top bar has no room for the badge text (DashboardLayout shows it under the bar below `sm`).
 *   `reserve` keeps the strip's line, empty and invisible, while the first config request is still out: the
 *   strip sits above the page, so arriving after the page had painted it pushed the whole page down (a
 *   layout shift of ~0.03 on phones). If the answer is "not demo" (or the request fails) the line goes away.
 *
 * @param {{variant?: 'badge'|'strip', compact?: boolean, reserve?: boolean, className?: string}} props
 *   `compact` hides the badge text below the sm breakpoint (icon only)
 */
export function DemoModeBadge({ variant = 'badge', compact = false, reserve = false, className }) {
  const { isDemo, loaded, loading } = useConfig()

  if (variant === 'strip') {
    const strip = cn(
      'flex items-start gap-1.5 border-b border-marking-200 bg-marking-50 px-3 py-1.5 text-xs text-marking-800',
      'dark:border-marking-500/30 dark:bg-marking-500/15 dark:text-marking-300',
    )
    if (!loaded || !isDemo) {
      // Same box as the strip (one line of text-xs), without the label: nothing to read, nothing to match.
      return reserve && loading && !loaded ? (
        <p aria-hidden className={cn(strip, 'invisible', className)}>
          {NO_BREAK_SPACE}
        </p>
      ) : null
    }
    return (
      <p className={cn(strip, className)}>
        <FlaskConical aria-hidden className="mt-px size-3.5 shrink-0" />
        <span>
          <span className="font-semibold">Demo AI Mode</span>: AI results come from demo models.
        </span>
      </p>
    )
  }

  if (!loaded || !isDemo) return null

  return (
    <Tooltip content={DEMO_MODE_DESCRIPTION} side="bottom">
      <button
        type="button"
        className={cn(
          'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-marking-50 px-2 py-1 text-xs font-semibold text-marking-800 ring-1 ring-inset ring-marking-200',
          'dark:bg-marking-500/15 dark:text-marking-300 dark:ring-marking-500/30 pointer-coarse:min-h-11 pointer-coarse:min-w-11',
          className,
        )}
      >
        <FlaskConical aria-hidden className="size-3.5" />
        <span className={cn(compact && 'sr-only sm:not-sr-only')}>Demo AI Mode</span>
      </button>
    </Tooltip>
  )
}

export default DemoModeBadge
