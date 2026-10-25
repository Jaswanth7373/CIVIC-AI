import { ChevronDown } from 'lucide-react'
import { cn } from '@/utils/cn'
import { FIELD_BASE, FIELD_INVALID, FIELD_SIZES, isInvalidFlag } from './fieldStyles'
import { useFormFieldProps } from './formFieldContext'

/**
 * Native <select>, styled like Input (native = best keyboard, screen-reader and mobile picker support).
 *
 * @param {object} props native <select> props plus:
 * @param {Array<{value: string|number, label: string, disabled?: boolean}|string>} [props.options] (or pass <option> children)
 * @param {string} [props.placeholder] adds a first option with value "" (e.g. "All categories")
 * @param {boolean} [props.invalid]
 * @param {'sm'|'md'|'lg'} [props.size='md']
 */
export function Select({ options, placeholder, invalid, size = 'md', className, containerClassName, children, ref, ...props }) {
  const fieldProps = useFormFieldProps(props)
  const isInvalid = Boolean(invalid) || isInvalidFlag(fieldProps['aria-invalid'])
  return (
    <div className={cn('relative w-full', containerClassName)}>
      <select
        ref={ref}
        {...fieldProps}
        aria-invalid={isInvalid || undefined}
        className={cn(
          FIELD_BASE,
          FIELD_SIZES[size] ?? FIELD_SIZES.md,
          'cursor-pointer appearance-none pr-9',
          isInvalid && FIELD_INVALID,
          className,
        )}
      >
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options
          ? options.map((option) =>
              typeof option === 'object' && option !== null ? (
                <option key={String(option.value)} value={option.value} disabled={option.disabled}>
                  {option.label}
                </option>
              ) : (
                <option key={String(option)} value={option}>
                  {option}
                </option>
              ),
            )
          : children}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
    </div>
  )
}

export default Select
