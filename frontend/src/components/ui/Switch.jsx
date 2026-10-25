import { useId } from 'react'
import { cn } from '@/utils/cn'

/**
 * On/off switch. Implemented as a native checkbox with `role="switch"`, so Space toggles it, forms submit
 * it and screen readers announce "switch, on/off"; the track and thumb are styled siblings (`peer-*`).
 * `onChange(event)` keeps native semantics; `onCheckedChange(checked)` is a convenience.
 *
 * Motion (CSS only): the thumb travels on a spring, stretches while pressed (it leans into the direction it
 * will move), and the keyboard focus ring animates in around the track.
 *
 * @param {object} props native checkbox props plus `label`, `description`, `onCheckedChange`
 */
export function Switch({ label, description, className, id, checked, defaultChecked, onChange, onCheckedChange, disabled, ref, ...props }) {
  const autoId = useId()
  const inputId = id ?? autoId
  const descriptionId = description ? `${inputId}-description` : undefined

  const handleChange = (event) => {
    onChange?.(event)
    onCheckedChange?.(event.target.checked)
  }

  return (
    <label
      htmlFor={inputId}
      className={cn(
        'inline-flex cursor-pointer items-center gap-3 pointer-coarse:min-h-11',
        // Hover / press styling hangs off this group; a disabled switch leaves it out and stays still.
        disabled ? 'cursor-not-allowed opacity-60' : 'group/switch',
        className,
      )}
    >
      <span className="relative inline-flex h-6 w-11 shrink-0">
        <input
          ref={ref}
          id={inputId}
          type="checkbox"
          role="switch"
          checked={checked}
          defaultChecked={defaultChecked}
          disabled={disabled}
          aria-describedby={descriptionId}
          onChange={handleChange}
          className="peer sr-only"
          {...props}
        />
        <span
          aria-hidden
          className={cn(
            'h-6 w-11 rounded-full bg-line-strong transition-colors duration-200 ease-standard group-hover/switch:bg-ink-3/55',
            'peer-checked:bg-primary peer-checked:group-hover/switch:bg-primary-hover',
            'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus peer-focus-visible:animate-focus-ring',
          )}
        />
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-[0_1px_2px_rgb(15_22_23/0.25),0_2px_6px_-2px_rgb(15_22_23/0.25)]',
            'transition-[translate,width] duration-300 ease-spring group-active/switch:w-6',
            'peer-checked:translate-x-5 peer-checked:group-active/switch:translate-x-4',
          )}
        />
      </span>
      {label || description ? (
        <span className="min-w-0">
          {label ? <span className="block text-sm font-medium text-ink">{label}</span> : null}
          {description ? (
            <span id={descriptionId} className="block text-xs text-ink-3">
              {description}
            </span>
          ) : null}
        </span>
      ) : null}
    </label>
  )
}

export default Switch
