import { CircleAlert } from 'lucide-react'
import { useId, useMemo } from 'react'
import { cn } from '@/utils/cn'
import { FormFieldContext } from './formFieldContext'

/**
 * Label + control + hint + error, correctly linked for assistive technology.
 * Input / Textarea / Select placed inside receive the id, aria-describedby, aria-invalid and required
 * attributes automatically (see formFieldContext.js).
 *
 *   <FormField label="Email" htmlFor="email" error={errors.email} required>
 *     <Input id="email" type="email" ... />
 *   </FormField>
 *
 * @param {object} props
 * @param {import('react').ReactNode} props.label
 * @param {string} [props.htmlFor] id of the control (generated when omitted)
 * @param {import('react').ReactNode} [props.hint] helper text
 * @param {string} [props.error] error message (also switches the control to its invalid style)
 * @param {boolean} [props.required] shows an asterisk and marks the control required
 * @param {boolean} [props.optional] shows "(optional)" next to the label
 *
 * The error message eases in from just above its place when it appears (CSS @starting-style).
 */
export function FormField({ label, htmlFor, hint, error, required = false, optional = false, className, labelClassName, children }) {
  const autoId = useId()
  const id = htmlFor ?? `field-${autoId}`
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined

  const context = useMemo(
    () => ({
      id,
      describedBy: [hintId, errorId].filter(Boolean).join(' ') || undefined,
      invalid: Boolean(error),
      required: required || undefined,
    }),
    [id, hintId, errorId, error, required],
  )

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {label ? (
        <label htmlFor={id} className={cn('text-sm font-semibold text-ink', labelClassName)}>
          {label}
          {required ? (
            <span aria-hidden className="text-signal-600 dark:text-signal-300">
              {' '}
              *
            </span>
          ) : null}
          {optional && !required ? <span className="font-normal text-ink-3"> (optional)</span> : null}
        </label>
      ) : null}
      <FormFieldContext.Provider value={context}>{children}</FormFieldContext.Provider>
      {hint ? (
        <p id={hintId} className="text-xs text-ink-3">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          className="flex items-start gap-1.5 text-xs font-medium text-signal-600 transition-[opacity,translate] duration-200 ease-standard starting:-translate-y-1 starting:opacity-0 dark:text-signal-300"
        >
          <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  )
}

export default FormField
