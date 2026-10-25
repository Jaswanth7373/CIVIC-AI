/**
 * Shared look of text inputs, selects and textareas. Font size is 16px on small screens (iOS Safari zooms
 * into inputs smaller than 16px) and 14px from the `sm` breakpoint. Touch screens get 44px tall controls.
 * The read-only tint applies to inputs and textareas only: a <select> always matches `:read-only` (it has no
 * editable text), so a bare `read-only:` variant painted every select grey as if it were disabled.
 */
export const FIELD_BASE =
  'w-full min-w-0 rounded-lg border border-line-strong bg-surface text-base text-ink placeholder:text-ink-3 ' +
  'transition-colors hover:border-ink-3 focus:border-primary sm:text-sm ' +
  'disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-3 [&:is(input,textarea):read-only]:bg-surface-2'

export const FIELD_INVALID =
  'border-signal-500 hover:border-signal-500 focus:border-signal-500 dark:border-signal-400 dark:hover:border-signal-400'

export const FIELD_SIZES = {
  sm: 'h-8 px-2.5 text-sm pointer-coarse:h-11',
  md: 'h-10 px-3 pointer-coarse:h-11',
  lg: 'h-12 px-4',
}

/** True when an aria-invalid prop value means "invalid". */
export function isInvalidFlag(value) {
  return value === true || value === 'true'
}
