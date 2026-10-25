/**
 * PanelUnavailable - the quiet stand-in for a panel whose request failed while the page already shows ONE
 * error with one "Retry all" for all of its requests (AdminDashboard, AIAnalytics): no second alert, no
 * second retry button, just a calm note in the panel's place. Chart cards get the same look through
 * ChartErrorModeContext ('quiet').
 *
 * Props: minHeight (px, default 160), className.
 */
import { CloudOff } from 'lucide-react'
import { cn } from '@/utils/cn'

export function PanelUnavailable({ minHeight = 160, className }) {
  return (
    <p
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line px-4 text-center text-sm text-ink-3',
        className,
      )}
      style={{ minHeight }}
    >
      <CloudOff aria-hidden className="size-5" />
      Not available right now
    </p>
  )
}

export default PanelUnavailable
