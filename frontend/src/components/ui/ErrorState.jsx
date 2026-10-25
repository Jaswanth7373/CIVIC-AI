import { isValidElement } from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import { Illustration, RoadworksIllustration } from '@/components/illustrations'
import { cn } from '@/utils/cn'
import { getErrorMessage } from '@/utils/errors'
import { Button } from './Button'

/**
 * Failure state with a retry action. Pass `error` (any thrown value) to derive the message automatically,
 * or `message` to set it explicitly.
 *
 * Illustration (cinematic plan 6.2): by default road works - a striped barrier, a cone and a yellow warning
 * sign (`compact`: the warning sign on its post). `illustration` picks another scene by name ('detour',
 * 'deadEnd', 'noEntry', ...), takes any element, or `false` for the plain round warning chip of before.
 *
 * @param {object} props
 * @param {string} [props.title='Something went wrong']
 * @param {import('react').ReactNode} [props.message]
 * @param {unknown} [props.error]
 * @param {() => void} [props.onRetry] shows a "Try again" button
 * @param {string} [props.retryLabel='Try again']
 * @param {import('react').ReactNode} [props.action] extra action next to the retry button
 * @param {boolean} [props.bordered=true]
 * @param {boolean} [props.compact]
 * @param {string|import('react').ReactElement|false} [props.illustration] scene name, element, or false for the chip
 */
export function ErrorState({
  title = 'Something went wrong',
  message,
  error,
  onRetry,
  retryLabel = 'Try again',
  action,
  bordered = true,
  compact = false,
  illustration,
  className,
}) {
  const text = message ?? (error ? getErrorMessage(error) : 'The information could not be loaded.')
  const size = compact ? 'sm' : 'md'
  let art
  if (illustration === false || illustration === null || illustration === 'none') {
    art = (
      <span className="mb-4 grid size-12 place-items-center rounded-full bg-signal-50 text-signal-600 dark:bg-signal-500/15 dark:text-signal-300">
        <TriangleAlert aria-hidden className="size-6" />
      </span>
    )
  } else if (isValidElement(illustration)) {
    art = <div className={compact ? 'mb-2' : 'mb-3'}>{illustration}</div>
  } else if (typeof illustration === 'string') {
    art = <Illustration name={illustration} size={size} className={compact ? 'mb-2' : 'mb-3'} />
  } else {
    art = <RoadworksIllustration size={size} className={compact ? 'mb-2' : 'mb-3'} />
  }

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'px-4 py-7' : 'px-6 py-10',
        bordered && 'rounded-xl border border-signal-200 bg-surface dark:border-signal-500/30',
        className,
      )}
    >
      {art}
      <h2 className="font-display text-lg font-bold text-ink">{title}</h2>
      <p className="mt-1.5 max-w-md text-sm text-ink-2">{text}</p>
      {onRetry || action ? (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          {onRetry ? (
            <Button variant="outline" leftIcon={RefreshCw} onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
    </div>
  )
}

export default ErrorState
