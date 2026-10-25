import { useId } from 'react'
import { cn } from '@/utils/cn'

/**
 * Group of native radio buttons inside a <fieldset> (arrow keys move between options natively).
 * Options render as selectable cards; the checked card is outlined in the primary colour.
 *
 * @param {object} props
 * @param {string} [props.label] group legend
 * @param {string} [props.description] helper text under the legend
 * @param {Array<{value: string|number, label: string, description?: string, disabled?: boolean}>} props.options
 * @param {string|number} props.value selected value
 * @param {(value: string|number, event: Event) => void} props.onChange called with the option's value
 * @param {'vertical'|'horizontal'} [props.orientation='vertical']
 * @param {string} [props.error] error message shown under the options
 */
export function RadioGroup({
  label,
  description,
  options = [],
  value,
  onChange,
  name,
  orientation = 'vertical',
  disabled = false,
  required = false,
  error,
  className,
}) {
  const autoId = useId()
  const groupName = name ?? autoId
  const descriptionId = description ? `${autoId}-description` : undefined
  const errorId = error ? `${autoId}-error` : undefined

  return (
    <fieldset
      className={cn('min-w-0', className)}
      aria-describedby={[descriptionId, errorId].filter(Boolean).join(' ') || undefined}
      aria-invalid={error ? true : undefined}
      disabled={disabled}
    >
      {label ? (
        <legend className="mb-1 text-sm font-semibold text-ink">
          {label}
          {required ? (
            <span aria-hidden className="text-signal-600 dark:text-signal-300">
              {' '}
              *
            </span>
          ) : null}
        </legend>
      ) : null}
      {description ? (
        <p id={descriptionId} className="mb-2 text-xs text-ink-3">
          {description}
        </p>
      ) : null}
      <div className={cn('flex gap-2', orientation === 'horizontal' ? 'flex-row flex-wrap' : 'flex-col')}>
        {options.map((option) => {
          const optionId = `${autoId}-${String(option.value)}`
          const checked = value === option.value
          return (
            <label
              key={String(option.value)}
              htmlFor={optionId}
              className={cn(
                'flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border bg-surface px-3 py-2.5 pointer-coarse:min-h-11',
                'transition-[border-color,background-color,box-shadow] duration-200 ease-standard',
                checked ? 'border-primary bg-primary-soft' : 'border-line hover:border-line-strong hover:elev-raised',
                option.disabled && 'cursor-not-allowed opacity-60 hover:elev-base',
              )}
            >
              {/* The native radio stays the real control; the dot is drawn over it (pointer-events: none) and
                  springs in when the option is chosen. High-contrast mode gets the native radio back. */}
              <span className="relative mt-0.5 inline-grid size-4 shrink-0 place-items-center">
                <input
                  id={optionId}
                  type="radio"
                  name={groupName}
                  value={String(option.value)}
                  checked={checked}
                  required={required}
                  disabled={option.disabled}
                  onChange={(event) => onChange?.(option.value, event)}
                  className="peer size-4 shrink-0 cursor-pointer appearance-none rounded-full border-[1.5px] border-line-strong bg-surface transition-[border-color,scale] duration-150 ease-standard hover:border-ink-3 active:scale-90 checked:border-primary checked:hover:border-primary disabled:cursor-not-allowed forced-colors:appearance-auto"
                />
                <span
                  aria-hidden
                  className="pointer-events-none absolute size-2 scale-0 rounded-full bg-primary transition-[scale] duration-300 ease-spring-bounce peer-checked:scale-100 forced-colors:hidden"
                />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{option.label}</span>
                {option.description ? <span className="block text-xs text-ink-3">{option.description}</span> : null}
              </span>
            </label>
          )
        })}
      </div>
      {error ? (
        <p id={errorId} className="mt-1.5 text-xs font-medium text-signal-600 dark:text-signal-300">
          {error}
        </p>
      ) : null}
    </fieldset>
  )
}

export default RadioGroup
