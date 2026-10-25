/**
 * Button class maps shared by Button and IconButton (kept in a .js module so the component files export
 * components only, as React Fast Refresh requires).
 *
 * Motion: `pressable` (index.css) gives every button the same press feedback - a quick 3% squeeze on press
 * and a springy release - in CSS only, with no per-button JavaScript. Filled call-to-action variants also
 * lift on hover with a soft shadow in their own colour (green for primary, sodium yellow for "Report").
 * Text links don't squeeze (--press-scale: 1).
 */
export const BUTTON_BASE =
  'pressable relative inline-flex shrink-0 select-none items-center justify-center gap-2 whitespace-nowrap font-semibold ' +
  'disabled:pointer-events-none disabled:opacity-55 aria-disabled:pointer-events-none aria-disabled:opacity-55'

export const BUTTON_VARIANTS = {
  primary:
    'bg-primary text-white hover:bg-primary-hover hover:shadow-[0_10px_22px_-12px_rgb(11_110_79/0.7)] active:bg-sign-800 dark:hover:shadow-[0_10px_24px_-12px_rgb(18_132_95/0.75)]',
  secondary: 'bg-primary-soft text-primary-ink hover:bg-sign-100 dark:hover:bg-sign-500/25',
  outline: 'border border-line-strong bg-surface text-ink hover:border-ink-3 hover:bg-surface-2',
  ghost: 'text-ink-2 hover:bg-sunken hover:text-ink',
  danger:
    'bg-signal-600 text-white hover:bg-signal-700 hover:shadow-[0_10px_22px_-12px_rgb(181_40_23/0.7)] active:bg-signal-800',
  warning:
    'bg-marking-500 text-asphalt-950 hover:bg-marking-400 hover:shadow-[0_10px_24px_-10px_rgb(204_150_0/0.75)] active:bg-marking-600',
  link: 'h-auto px-0 text-primary-ink underline-offset-4 [--press-scale:1] hover:underline',
}

/** Heights grow to 44px on touch screens (pointer: coarse) so every button is an easy tap target. */
export const BUTTON_SIZES = {
  sm: 'h-8 rounded-md px-3 text-[13px] pointer-coarse:min-h-11',
  md: 'h-10 rounded-lg px-4 text-sm pointer-coarse:min-h-11',
  lg: 'h-12 rounded-lg px-5 text-base [--press-scale:0.98]',
  icon: 'size-10 rounded-lg p-0 pointer-coarse:size-11',
}

export const BUTTON_ICON_SIZES = { sm: 'size-4', md: 'size-[18px]', lg: 'size-5', icon: 'size-5' }
