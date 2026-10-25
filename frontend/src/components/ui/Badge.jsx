import { cn } from '@/utils/cn'
import { renderIcon } from '@/utils/icons'
import { resolveTone, toneDot, toneOutline, toneSoft, toneSolid } from './tones'

const SIZES = {
  sm: 'gap-1 rounded-sm px-1.5 py-0.5 text-[11px]',
  md: 'gap-1.5 rounded-md px-2 py-0.5 text-xs',
  lg: 'gap-1.5 rounded-md px-2.5 py-1 text-sm',
}
const ICON_SIZES = { sm: 'size-3', md: 'size-3.5', lg: 'size-4' }
const VARIANTS = { soft: toneSoft, solid: toneSolid, outline: toneOutline }

/**
 * Small status label. Colour carries meaning (see utils/constants STATUS_META / LEVEL_META ...).
 *
 * @param {object} props
 * @param {'neutral'|'green'|'yellow'|'orange'|'red'|'blue'|'violet'|'teal'|'magenta'|'slate'} [props.tone='neutral']
 * @param {'soft'|'solid'|'outline'} [props.variant='soft'] `solid` is used for e.g. "Verified" (dark green)
 * @param {'sm'|'md'|'lg'} [props.size='md']
 * @param {boolean} [props.dot] leading coloured dot
 * @param {import('react').ComponentType} [props.icon] leading lucide icon
 */
export function Badge({ tone = 'neutral', variant = 'soft', size = 'md', dot = false, icon, className, children, ...props }) {
  const resolved = resolveTone(tone)
  const palette = VARIANTS[variant] ?? toneSoft
  return (
    <span
      className={cn(
        'inline-flex max-w-full shrink-0 items-center whitespace-nowrap font-semibold leading-5 ring-1 ring-inset',
        SIZES[size] ?? SIZES.md,
        palette[resolved],
        className,
      )}
      {...props}
    >
      {dot ? (
        <span
          aria-hidden
          className={cn('size-1.5 shrink-0 rounded-full', variant === 'solid' ? 'bg-current' : toneDot[resolved])}
        />
      ) : null}
      {renderIcon(icon, { className: cn('shrink-0', ICON_SIZES[size] ?? ICON_SIZES.md) })}
      <span className="truncate">{children}</span>
    </span>
  )
}

export default Badge
