import { useId, useState } from 'react'
import { cn } from '@/utils/cn'
import { FIELD_BASE, FIELD_INVALID, isInvalidFlag } from './fieldStyles'
import { useFormFieldProps } from './formFieldContext'

/**
 * Multi-line text field. With `maxLength` it shows a live "123/2000" counter (linked via
 * aria-describedby); the counter turns orange near the limit and red at the limit. Works controlled
 * (`value` + `onChange`) or uncontrolled (`defaultValue`).
 *
 * @param {object} props native <textarea> props plus `invalid`, `showCount` (default true) and `containerClassName`
 */
export function Textarea({
  className,
  containerClassName,
  maxLength,
  showCount = true,
  invalid,
  rows = 4,
  value,
  defaultValue,
  onChange,
  ref,
  ...props
}) {
  const fieldProps = useFormFieldProps(props)
  const counterId = useId()
  const [uncontrolledLength, setUncontrolledLength] = useState(() => String(defaultValue ?? '').length)
  const controlled = value !== undefined
  const length = controlled ? String(value ?? '').length : uncontrolledLength
  const isInvalid = Boolean(invalid) || isInvalidFlag(fieldProps['aria-invalid'])
  const withCounter = Boolean(maxLength) && showCount

  const handleChange = (event) => {
    if (!controlled) setUncontrolledLength(event.target.value.length)
    onChange?.(event)
  }

  const describedBy = [fieldProps['aria-describedby'], withCounter ? counterId : null].filter(Boolean).join(' ') || undefined

  return (
    <div className={cn('w-full', containerClassName)}>
      <textarea
        ref={ref}
        rows={rows}
        maxLength={maxLength}
        value={value}
        defaultValue={defaultValue}
        onChange={handleChange}
        {...fieldProps}
        aria-describedby={describedBy}
        aria-invalid={isInvalid || undefined}
        className={cn(FIELD_BASE, 'block min-h-24 resize-y px-3 py-2.5 leading-relaxed', isInvalid && FIELD_INVALID, className)}
      />
      {withCounter ? (
        <p
          id={counterId}
          className={cn(
            'mt-1 text-right text-xs tabular transition-colors duration-200 ease-standard',
            length >= maxLength
              ? 'font-semibold text-signal-600 dark:text-signal-300'
              : length >= maxLength * 0.9
                ? 'text-hazard-700 dark:text-hazard-300'
                : 'text-ink-3',
          )}
        >
          {`${length}/${maxLength}`}
        </p>
      ) : null}
    </div>
  )
}

export default Textarea
