import { useId } from 'react'
import { cn } from '@/utils/cn'

/*
 * The native checkbox stays the real, focusable, clickable control (appearance reset, so it can be styled);
 * the tick is an SVG drawn over it with pointer-events: none, so clicks and tests still hit the input itself.
 * Checking fills the box in sign green and draws the tick stroke; pressing squeezes the box slightly.
 * Windows high-contrast mode gets the native checkbox back.
 */
const BOX =
  'peer size-[18px] shrink-0 cursor-pointer appearance-none rounded-[5px] border-[1.5px] border-line-strong bg-surface ' +
  'transition-[background-color,border-color,scale] duration-150 ease-standard hover:border-ink-3 active:scale-90 ' +
  'checked:border-primary checked:bg-primary checked:hover:border-primary-hover checked:hover:bg-primary-hover ' +
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:active:scale-100 forced-colors:appearance-auto'

const TICK =
  'pointer-events-none absolute size-3 text-white opacity-0 [stroke-dasharray:1] [stroke-dashoffset:1] ' +
  'transition-[stroke-dashoffset,opacity] duration-200 ease-standard peer-checked:opacity-100 peer-checked:[stroke-dashoffset:0] ' +
  'forced-colors:hidden'

/**
 * Native checkbox with a label and optional description (the whole row is clickable, 44px tall on touch
 * screens). `onChange(event)` keeps native semantics; `onCheckedChange(checked)` is a convenience.
 *
 * @param {object} props native <input type="checkbox"> props plus `label`, `description`, `onCheckedChange`
 */
export function Checkbox({ label, description, className, id, onChange, onCheckedChange, disabled, ref, ...props }) {
  const autoId = useId()
  const inputId = id ?? autoId
  const descriptionId = description ? `${inputId}-description` : undefined
  const labelled = Boolean(label || description)

  const handleChange = (event) => {
    onChange?.(event)
    onCheckedChange?.(event.target.checked)
  }

  const control = (
    <span className={cn('relative inline-grid shrink-0 place-items-center', labelled ? 'mt-0.5 pointer-coarse:mt-0' : className)}>
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        disabled={disabled}
        aria-describedby={descriptionId}
        onChange={handleChange}
        className={BOX}
        {...props}
      />
      <svg aria-hidden viewBox="0 0 16 16" className={TICK}>
        <path
          d="M3.4 8.6 6.5 11.6 12.8 4.8"
          pathLength="1"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )

  if (!labelled) return control

  return (
    <label
      htmlFor={inputId}
      className={cn(
        'inline-flex cursor-pointer items-start gap-2.5 pointer-coarse:min-h-11 pointer-coarse:items-center',
        disabled && 'cursor-not-allowed opacity-60',
        className,
      )}
    >
      {control}
      <span className="min-w-0">
        {label ? <span className="block text-sm font-medium text-ink">{label}</span> : null}
        {description ? (
          <span id={descriptionId} className="block text-xs text-ink-3">
            {description}
          </span>
        ) : null}
      </span>
    </label>
  )
}

export default Checkbox
