import { cn } from '@/utils/cn'
import { renderIcon } from '@/utils/icons'
import { FIELD_BASE, FIELD_INVALID, FIELD_SIZES, isInvalidFlag } from './fieldStyles'
import { useFormFieldProps } from './formFieldContext'

/**
 * Text input. Inside a <FormField> the id / aria-describedby / aria-invalid / required wiring is automatic.
 *
 * @param {object} props native <input> props plus:
 * @param {import('react').ComponentType} [props.leftIcon] icon inside the field on the left
 * @param {import('react').ReactNode} [props.rightSlot] content inside the field on the right (unit, button)
 * @param {boolean} [props.invalid] error styling (also set automatically by FormField `error`)
 * @param {'sm'|'md'|'lg'} [props.size='md']
 * @param {string} [props.containerClassName] class for the wrapper when an icon / slot is used
 */
export function Input({ className, containerClassName, leftIcon, rightSlot, invalid, size = 'md', type = 'text', ref, ...props }) {
  const fieldProps = useFormFieldProps(props)
  const isInvalid = Boolean(invalid) || isInvalidFlag(fieldProps['aria-invalid'])
  const inputClass = cn(
    FIELD_BASE,
    FIELD_SIZES[size] ?? FIELD_SIZES.md,
    isInvalid && FIELD_INVALID,
    leftIcon && 'pl-9',
    rightSlot && 'pr-10',
    className,
  )
  const input = (
    <input ref={ref} type={type} {...fieldProps} aria-invalid={isInvalid || undefined} className={inputClass} />
  )
  if (!leftIcon && !rightSlot) return input
  return (
    <div className={cn('relative w-full', containerClassName)}>
      {leftIcon ? (
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-ink-3">
          {renderIcon(leftIcon, { className: 'size-4' })}
        </span>
      ) : null}
      {input}
      {rightSlot ? <span className="absolute inset-y-0 right-1.5 flex items-center">{rightSlot}</span> : null}
    </div>
  )
}

export default Input
