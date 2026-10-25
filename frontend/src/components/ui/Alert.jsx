import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react'
import { cn } from '@/utils/cn'
import { renderIcon } from '@/utils/icons'

const TONES = {
  info: {
    icon: Info,
    box: 'border-guide-200 bg-guide-50 dark:border-guide-400/30 dark:bg-guide-500/10',
    icon_: 'text-guide-600 dark:text-guide-300',
  },
  success: {
    icon: CircleCheck,
    box: 'border-sign-200 bg-sign-50 dark:border-sign-500/30 dark:bg-sign-500/10',
    icon_: 'text-sign-600 dark:text-sign-300',
  },
  warning: {
    icon: TriangleAlert,
    box: 'border-marking-200 bg-marking-50 dark:border-marking-500/30 dark:bg-marking-500/10',
    icon_: 'text-marking-700 dark:text-marking-300',
  },
  danger: {
    icon: CircleAlert,
    box: 'border-signal-200 bg-signal-50 dark:border-signal-500/30 dark:bg-signal-500/10',
    icon_: 'text-signal-600 dark:text-signal-300',
  },
  neutral: {
    icon: Info,
    box: 'border-line bg-surface-2',
    icon_: 'text-ink-3',
  },
}

const TONE_ALIASES = { error: 'danger', red: 'danger', green: 'success', yellow: 'warning', blue: 'info' }

/**
 * Inline message banner (form errors, "flagged for manual review", demo notices).
 * Danger alerts use role="alert" (announced immediately), others role="status".
 *
 * @param {object} props
 * @param {'info'|'success'|'warning'|'danger'|'neutral'} [props.tone='info']
 * @param {import('react').ReactNode} [props.title]
 * @param {import('react').ComponentType} [props.icon] overrides the tone icon
 * @param {import('react').ReactNode} [props.action] e.g. a small Button
 * @param {() => void} [props.onDismiss] shows a close button
 */
export function Alert({ tone = 'info', title, icon, action, onDismiss, className, children }) {
  const key = TONES[tone] ? tone : (TONE_ALIASES[tone] ?? 'info')
  const style = TONES[key]
  return (
    <div
      role={key === 'danger' ? 'alert' : 'status'}
      className={cn('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm', style.box, className)}
    >
      {renderIcon(icon ?? style.icon, { className: cn('mt-0.5 size-[18px] shrink-0', style.icon_) })}
      <div className="min-w-0 flex-1">
        {title ? <p className="font-semibold text-ink">{title}</p> : null}
        {children ? <div className={cn('text-ink-2', title && 'mt-0.5')}>{children}</div> : null}
        {action ? <div className="mt-2.5 flex flex-wrap gap-2">{action}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mr-1.5 -mt-1 grid size-8 shrink-0 place-items-center rounded-md text-ink-3 transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/10 pointer-coarse:size-11"
        >
          <X aria-hidden className="size-4" />
        </button>
      ) : null}
    </div>
  )
}

export default Alert
