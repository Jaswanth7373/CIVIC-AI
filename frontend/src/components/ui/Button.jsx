import { Link } from 'react-router-dom'
import { cn } from '@/utils/cn'
import { renderIcon } from '@/utils/icons'
import { BUTTON_BASE, BUTTON_ICON_SIZES, BUTTON_SIZES, BUTTON_VARIANTS } from './buttonStyles'
import { Spinner } from './Spinner'

/**
 * Button / link button.
 *
 * @param {object} props
 * @param {'primary'|'secondary'|'outline'|'ghost'|'danger'|'warning'|'link'} [props.variant='primary']
 * @param {'sm'|'md'|'lg'|'icon'} [props.size='md'] touch screens always get >= 44px targets
 * @param {boolean} [props.loading] shows a spinner, disables the button and sets aria-busy
 * @param {import('react').ComponentType} [props.leftIcon] lucide component shown before the label
 * @param {import('react').ComponentType} [props.rightIcon] lucide component shown after the label
 * @param {string} [props.to] renders a react-router <Link> instead of a <button>
 * @param {string} [props.href] renders a plain <a> (external links, downloads)
 * @param {boolean} [props.fullWidth]
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  leftIcon,
  rightIcon,
  to,
  href,
  fullWidth = false,
  disabled = false,
  type = 'button',
  className,
  children,
  ref,
  ...props
}) {
  const classes = cn(
    BUTTON_BASE,
    BUTTON_SIZES[size] ?? BUTTON_SIZES.md,
    BUTTON_VARIANTS[variant] ?? BUTTON_VARIANTS.primary,
    fullWidth && 'w-full',
    className,
  )
  const iconClass = BUTTON_ICON_SIZES[size] ?? BUTTON_ICON_SIZES.md
  const content = (
    <>
      {loading ? <Spinner size={size === 'sm' ? 'sm' : 'md'} decorative /> : renderIcon(leftIcon, { className: iconClass })}
      {children}
      {!loading && renderIcon(rightIcon, { className: iconClass })}
    </>
  )
  const inactive = disabled || loading

  if (to && !inactive) {
    return (
      <Link ref={ref} to={to} className={classes} {...props}>
        {content}
      </Link>
    )
  }
  if (href && !inactive) {
    return (
      <a ref={ref} href={href} className={classes} {...props}>
        {content}
      </a>
    )
  }
  return (
    <button ref={ref} type={type} className={classes} disabled={inactive} aria-busy={loading || undefined} {...props}>
      {content}
    </button>
  )
}

export default Button
