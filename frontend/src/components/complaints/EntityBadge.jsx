/**
 * EntityBadge - internal building block of CategoryBadge and DepartmentBadge.
 *
 * Props: { name, icon, color, size = 'sm' | 'md' | 'lg', fallbackIcon, srPrefix, title, className }
 *
 * Renders a neutral chip with a small "sign plate" in the entity's own colour (category / department colours
 * are data stored in the database) carrying its icon. The name is set in normal ink, never in the entity
 * colour, so light colours such as road-marking yellow stay readable; the icon on the plate gets white or
 * near-black ink, whichever has the higher WCAG contrast with the plate (see charts/palette.readableInk).
 */
import { CircleHelp } from 'lucide-react'
import { readableInk, safeColor } from '@/components/charts/palette'
import { cn } from '@/utils/cn'
import { getIcon, renderIcon } from '@/utils/icons'

const SIZES = {
  sm: { root: 'gap-1 rounded-sm py-0.5 pl-0.5 pr-1.5 text-[11px]', plate: 'size-4 rounded-[3px]', icon: 'size-2.5' },
  md: { root: 'gap-1.5 rounded-md py-0.5 pl-0.5 pr-2 text-xs', plate: 'size-5 rounded-[4px]', icon: 'size-3' },
  lg: { root: 'gap-2 rounded-md py-1 pl-1 pr-2.5 text-sm', plate: 'size-6 rounded-[5px]', icon: 'size-3.5' },
}

export function EntityBadge({ name, icon, color, size = 'md', fallbackIcon = CircleHelp, srPrefix, title, className }) {
  const fill = safeColor(color, '#6a7a77')
  const sizes = SIZES[size] ?? SIZES.md
  return (
    <span
      title={title}
      className={cn(
        'inline-flex max-w-full shrink-0 items-center whitespace-nowrap bg-surface-2 font-semibold leading-5 text-ink ring-1 ring-inset ring-line',
        sizes.root,
        className,
      )}
    >
      <span
        aria-hidden
        className={cn('grid shrink-0 place-items-center', sizes.plate)}
        style={{ backgroundColor: fill, color: readableInk(fill) }}
      >
        {renderIcon(getIcon(icon, fallbackIcon), { className: sizes.icon, strokeWidth: 2.4 })}
      </span>
      {srPrefix ? <span className="sr-only">{srPrefix}</span> : null}
      <span className="truncate">{name}</span>
    </span>
  )
}

export default EntityBadge
