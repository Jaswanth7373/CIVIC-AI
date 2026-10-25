import { cn } from '@/utils/cn'
import { renderIcon } from '@/utils/icons'

/** Hover raise for clickable cards: lifts 2px onto the "raised" elevation (no lift with reduced motion). */
const INTERACTIVE =
  'cursor-pointer transition-[border-color,box-shadow,translate] duration-200 ease-standard hover:-translate-y-0.5 ' +
  'hover:border-line-strong hover:elev-raised active:translate-y-0 motion-reduce:hover:translate-y-0'

/**
 * Panel container: `bg-surface border border-line rounded-xl`, deliberately flat (elevation "base"): static
 * panels never get a shadow. A card that IS the click target - `interactive`, or automatically when it has
 * `onClick`, `href` or `to` - rises onto the "raised" elevation on hover. Compose with CardHeader / CardBody /
 * CardFooter.
 * @param {{as?: import('react').ElementType, interactive?: boolean, className?: string, children?: import('react').ReactNode}} props
 */
export function Card({ as: Component = 'section', interactive, className, children, ...props }) {
  const isInteractive = interactive ?? Boolean(props.onClick || props.href || props.to)
  return (
    <Component className={cn('min-w-0 rounded-xl border border-line bg-surface', isInteractive && INTERACTIVE, className)} {...props}>
      {children}
    </Component>
  )
}

/**
 * Card heading row: optional icon chip, title, description and right-aligned actions.
 * The heading keeps at least 13rem: when the actions do not fit beside it (filter selects or a chart / table
 * toggle on a phone), they wrap onto their own row under the title instead of squeezing it to a sliver.
 * @param {{title?: import('react').ReactNode, description?: import('react').ReactNode, actions?: import('react').ReactNode,
 *          icon?: import('react').ComponentType, titleAs?: import('react').ElementType, className?: string}} props
 */
export function CardHeader({ title, description, actions, icon, titleAs: Title = 'h2', className, children }) {
  return (
    <div className={cn('flex flex-wrap items-start gap-3 border-b border-line px-4 py-3.5 sm:px-5', className)}>
      {icon ? (
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2">
          {renderIcon(icon, { className: 'size-4' })}
        </span>
      ) : null}
      <div className="min-w-0 flex-[1_1_13rem]">
        {title ? <Title className="font-display text-base font-bold leading-snug text-ink">{title}</Title> : null}
        {description ? <p className="mt-0.5 text-sm text-ink-2">{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

export function CardBody({ className, children, ...props }) {
  return (
    <div className={cn('px-4 py-4 sm:px-5', className)} {...props}>
      {children}
    </div>
  )
}

export function CardFooter({ className, children, ...props }) {
  return (
    <div
      className={cn('flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t border-line bg-surface-2 px-4 py-3 sm:px-5', className)}
      {...props}
    >
      {children}
    </div>
  )
}

export default Card
