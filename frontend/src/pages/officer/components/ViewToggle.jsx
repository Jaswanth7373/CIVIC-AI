/**
 * ViewToggle - a segmented switch between views of the same data ("List" / "Map"): toggle buttons
 * (aria-pressed) in a labelled group, styled like the administrator's list / map switch.
 *
 * Props:
 * - value: the selected option's value
 * - onChange(value)
 * - label: accessible name of the group ("Show complaints as")
 * - options: [{value, label, icon?}]
 * - className
 */
import { cn } from '@/utils/cn'
import { renderIcon } from '@/utils/icons'

export function ViewToggle({ value, onChange, label, options = [], className }) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex shrink-0 rounded-lg bg-sunken p-0.5', className)}>
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              if (!selected) onChange?.(option.value)
            }}
            className={cn(
              'inline-flex h-9 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-sm font-semibold transition-colors pointer-coarse:h-11',
              selected ? 'bg-surface text-ink shadow-[var(--shadow-raise)]' : 'text-ink-2 hover:text-ink',
            )}
          >
            {renderIcon(option.icon, { className: 'size-4' })}
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

export default ViewToggle
