import { isValidElement } from 'react'
import { Inbox } from 'lucide-react'
import { EmptyRoadIllustration, Illustration } from '@/components/illustrations'
import { cn } from '@/utils/cn'
import { renderIcon } from '@/utils/icons'

/**
 * Empty state that invites the next action ("No complaints yet" + "Report an issue").
 *
 * Illustration (cinematic plan 6.2): by default a small road-sign scene in the CivicAI signage language - an
 * empty road with a green guide sign that carries `icon` as its pictogram; `compact` states get just the sign on
 * its post. `illustration` picks another scene by name ('search', 'roadworks', 'detour', 'deadEnd', 'noEntry',
 * 'road'), takes any element, or `false` for the plain round icon chip of before. The scene is decorative; the
 * title and description carry the message.
 *
 * @param {object} props
 * @param {import('react').ComponentType} [props.icon=Inbox] pictogram (on the sign, or in the chip)
 * @param {string|import('react').ReactElement|false} [props.illustration] scene name, element, or false for the chip
 * @param {import('react').ReactNode} props.title
 * @param {import('react').ReactNode} [props.description]
 * @param {import('react').ReactNode} [props.action] usually a <Button>
 * @param {boolean} [props.bordered=true] dashed panel; set false inside cards and tables
 * @param {boolean} [props.compact] less vertical padding, smaller illustration
 * @param {import('react').ElementType} [props.titleAs='h2']
 */
export function EmptyState({
  icon,
  illustration,
  title,
  description,
  action,
  bordered = true,
  compact = false,
  titleAs: Title = 'h2',
  className,
}) {
  const size = compact ? 'sm' : 'md'
  let art
  if (illustration === false || illustration === null || illustration === 'none') {
    art = (
      <span className="mb-4 grid size-12 place-items-center rounded-full bg-sunken text-ink-3">
        {renderIcon(icon ?? Inbox, { className: 'size-6' })}
      </span>
    )
  } else if (isValidElement(illustration)) {
    art = <div className={compact ? 'mb-2' : 'mb-3'}>{illustration}</div>
  } else if (typeof illustration === 'string') {
    art = <Illustration name={illustration} icon={icon} size={size} className={compact ? 'mb-2' : 'mb-3'} />
  } else {
    art = <EmptyRoadIllustration icon={icon ?? Inbox} size={size} className={compact ? 'mb-2' : 'mb-3'} />
  }

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'px-4 py-7' : 'px-6 py-12',
        bordered && 'rounded-xl border border-dashed border-line-strong bg-surface',
        className,
      )}
    >
      {art}
      {title ? <Title className="font-display text-lg font-bold text-ink">{title}</Title> : null}
      {description ? <p className="mt-1.5 max-w-md text-sm text-ink-2">{description}</p> : null}
      {action ? <div className="mt-5 flex flex-wrap items-center justify-center gap-2">{action}</div> : null}
    </div>
  )
}

export default EmptyState
