/**
 * `cn()` - compose Tailwind class names safely.
 *
 * 1. `clsx` turns conditional inputs (strings, arrays, `{ class: condition }` objects) into one string.
 * 2. `tailwind-merge` removes conflicting utilities so the LAST one wins, which lets components accept a
 *    `className` override: `cn('px-4 text-ink-2', 'px-2')` -> `'text-ink-2 px-2'`.
 *
 * tailwind-merge only knows Tailwind's default theme, so it is told about the CivicAI design tokens defined
 * in `src/index.css`:
 * - semantic colours (`ink-2`, `surface-2`, `line-strong` ...) and palette scales (`sign-600` ...) are
 *   registered as colours, so `text-ink-2` is grouped with text COLOURS (merges with `text-ink`) and never with
 *   font sizes (`text-sm` stays), and `bg-surface-2` merges with `bg-surface`;
 * - custom shadows (`shadow-overlay`, `shadow-raise`) are box-shadows, not shadow colours;
 * - the custom `animate-lane` animation and the `lane-line` / `tabular` utilities form proper conflict groups.
 */
import { clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/*
 * `overlay` is deliberately NOT listed: it is also the name of a shadow token (`shadow-overlay`), and an
 * explicit colour entry would make `shadow-overlay` look like a shadow COLOUR. `bg-overlay` is still
 * recognised as a background colour through tailwind-merge's default any-value colour validator.
 */
const SEMANTIC_COLORS = [
  'bg',
  'surface',
  'surface-2',
  'sunken',
  'line',
  'line-strong',
  'ink',
  'ink-2',
  'ink-3',
  'primary',
  'primary-hover',
  'primary-soft',
  'primary-ink',
  'focus',
  'sidebar',
  'sidebar-2',
]

const PALETTE_COLOR = /^(sign|marking|asphalt|signal|hazard|guide)-(50|[1-9]00|850|950)$/

/** Validator: palette steps defined in index.css, e.g. `sign-600`, `asphalt-850`. */
const isPaletteColor = (value) => PALETTE_COLOR.test(value)

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      color: [...SEMANTIC_COLORS, isPaletteColor],
      shadow: ['overlay', 'raise'],
      font: ['sans', 'display'],
      animate: ['lane'],
    },
    classGroups: {
      'lane-line': ['lane-line', 'lane-line-x'],
      'fvn-spacing': ['tabular'],
    },
  },
})

export function cn(...inputs) {
  return twMerge(clsx(inputs))
}

export default cn
