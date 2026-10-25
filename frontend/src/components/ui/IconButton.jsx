import { Link } from 'react-router-dom'
import { cn } from '@/utils/cn'
import { renderIcon } from '@/utils/icons'
import { BUTTON_VARIANTS } from './buttonStyles'
import { Spinner } from './Spinner'

const SIZES = {
  sm: 'size-8 rounded-md pointer-coarse:size-11',
  md: 'size-10 rounded-lg pointer-coarse:size-11',
  lg: 'size-12 rounded-lg',
}
const ICON_SIZES = { sm: 'size-4', md: 'size-5', lg: 'size-6' }

/**
 * Icon-only button. `label` is required: it becomes the accessible name (aria-label) and the native
 * tooltip (title). `badge` shows a count bubble (number) or a dot (true), e.g. unread notifications.
 *
 * @param {object} props
 * @param {import('react').ComponentType} props.icon lucide component
 * @param {string} props.label accessible name, e.g. "Open navigation"
 * @param {'primary'|'secondary'|'outline'|'ghost'|'danger'|'warning'} [props.variant='ghost']
 * @param {'sm'|'md'|'lg'} [props.size='md']
 * @param {number|boolean} [props.badge]
 * @param {string} [props.to] render as a router link
 */
export function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'md',
  badge,
  loading = false,
  disabled = false,
  to,
  type = 'button',
  className,
  ref,
  ...props
}) {
  const classes = cn(
    'pressable relative inline-grid shrink-0 place-items-center [--press-scale:0.9] disabled:pointer-events-none disabled:opacity-55',
    BUTTON_VARIANTS[variant] ?? BUTTON_VARIANTS.ghost,
    SIZES[size] ?? SIZES.md,
    className,
  )
  const showBadge = badge === true || (typeof badge === 'number' && badge > 0)
  const content = (
    <>
      {loading ? <Spinner size="sm" decorative /> : renderIcon(icon, { className: ICON_SIZES[size] ?? ICON_SIZES.md })}
      {showBadge ? (
        <span
          // Re-keyed by its value, so the bubble pops in again whenever the count changes.
          key={String(badge)}
          aria-hidden
          className={cn(
            'absolute right-1 top-1 animate-pop-in rounded-full bg-signal-500 font-sans text-[10px] font-bold leading-none text-white ring-2 ring-surface',
            badge === true ? 'size-2.5' : 'grid min-w-4 place-items-center px-1 py-0.5 tabular',
          )}
        >
          {badge === true ? null : badge > 99 ? '99+' : badge}
        </span>
      ) : null}
    </>
  )

  if (to && !disabled) {
    return (
      <Link ref={ref} to={to} aria-label={label} title={label} className={classes} {...props}>
        {content}
      </Link>
    )
  }
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={classes}
      {...props}
    >
      {content}
    </button>
  )
}

export default IconButton
