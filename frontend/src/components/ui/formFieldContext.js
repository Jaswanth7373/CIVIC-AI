/**
 * Wiring between <FormField> and the controls inside it (Input, Textarea, Select).
 *
 * FormField generates ids for the control, hint and error and shares them through this context; a control
 * rendered inside a FormField picks them up automatically, so `<label for>`, `aria-describedby`,
 * `aria-invalid` and `required` are always correct without passing ids by hand. Explicit props on the
 * control still win.
 */
import { createContext, useContext } from 'react'

export const FormFieldContext = createContext(null)
FormFieldContext.displayName = 'FormFieldContext'

/** Merge FormField-provided accessibility props into a control's props. */
export function useFormFieldProps(props) {
  const field = useContext(FormFieldContext)
  if (!field) return props
  const describedBy = [props['aria-describedby'], field.describedBy].filter(Boolean).join(' ') || undefined
  return {
    ...props,
    id: props.id ?? field.id,
    'aria-describedby': describedBy,
    'aria-invalid': props['aria-invalid'] ?? (field.invalid ? true : undefined),
    required: props.required ?? field.required,
  }
}
