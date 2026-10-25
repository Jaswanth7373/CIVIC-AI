/**
 * Tone -> Tailwind class maps shared by Badge, StatCard, ProgressBar, ScoreRing, Alert and Avatar.
 *
 * Class names are written out in full (never built with string interpolation) so Tailwind's source scanner
 * can find them. Soft tones pair a tinted background with a dark text colour in light mode and a translucent
 * background with a light text colour in dark mode, keeping WCAG AA contrast in both themes.
 */
export const TONE_NAMES = Object.freeze([
  'neutral',
  'green',
  'yellow',
  'orange',
  'red',
  'blue',
  'violet',
  'teal',
  'magenta',
  'slate',
])

const ALIASES = {
  primary: 'green',
  success: 'green',
  warning: 'yellow',
  danger: 'red',
  error: 'red',
  critical: 'red',
  info: 'blue',
  purple: 'violet',
  pink: 'magenta',
  gray: 'neutral',
  grey: 'neutral',
}

/** Normalise a tone name (accepts aliases such as "success" or "danger"); unknown tones become neutral. */
export function resolveTone(tone) {
  if (TONE_NAMES.includes(tone)) return tone
  return ALIASES[tone] ?? 'neutral'
}

/** Tinted badge / chip: background + text + inset ring. */
export const toneSoft = {
  neutral: 'bg-asphalt-100 text-asphalt-700 ring-asphalt-200 dark:bg-asphalt-800 dark:text-asphalt-200 dark:ring-asphalt-700',
  green: 'bg-sign-50 text-sign-700 ring-sign-200 dark:bg-sign-500/15 dark:text-sign-300 dark:ring-sign-500/30',
  yellow: 'bg-marking-50 text-marking-800 ring-marking-200 dark:bg-marking-500/15 dark:text-marking-300 dark:ring-marking-500/30',
  orange: 'bg-hazard-50 text-hazard-700 ring-hazard-200 dark:bg-hazard-500/15 dark:text-hazard-300 dark:ring-hazard-500/30',
  red: 'bg-signal-50 text-signal-700 ring-signal-200 dark:bg-signal-500/15 dark:text-signal-300 dark:ring-signal-500/30',
  blue: 'bg-guide-50 text-guide-700 ring-guide-200 dark:bg-guide-500/20 dark:text-guide-200 dark:ring-guide-400/30',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:ring-violet-500/30',
  teal: 'bg-teal-50 text-teal-700 ring-teal-200 dark:bg-teal-500/15 dark:text-teal-300 dark:ring-teal-500/30',
  magenta: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200 dark:bg-fuchsia-500/15 dark:text-fuchsia-300 dark:ring-fuchsia-500/30',
  slate: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-500/20 dark:text-slate-300 dark:ring-slate-400/30',
}

/** Solid badge (e.g. "Verified" = dark green). */
export const toneSolid = {
  neutral: 'bg-asphalt-600 text-white ring-asphalt-600',
  green: 'bg-sign-700 text-white ring-sign-700 dark:bg-sign-600 dark:ring-sign-600',
  yellow: 'bg-marking-500 text-asphalt-950 ring-marking-500',
  orange: 'bg-hazard-600 text-white ring-hazard-600',
  red: 'bg-signal-600 text-white ring-signal-600',
  blue: 'bg-guide-600 text-white ring-guide-600',
  violet: 'bg-violet-600 text-white ring-violet-600',
  teal: 'bg-teal-700 text-white ring-teal-700',
  magenta: 'bg-fuchsia-700 text-white ring-fuchsia-700',
  slate: 'bg-slate-600 text-white ring-slate-600',
}

/** Outline badge: transparent background, coloured text and ring. */
export const toneOutline = {
  neutral: 'bg-transparent text-asphalt-700 ring-asphalt-300 dark:text-asphalt-200 dark:ring-asphalt-600',
  green: 'bg-transparent text-sign-700 ring-sign-300 dark:text-sign-300 dark:ring-sign-500/50',
  yellow: 'bg-transparent text-marking-800 ring-marking-300 dark:text-marking-300 dark:ring-marking-500/50',
  orange: 'bg-transparent text-hazard-700 ring-hazard-300 dark:text-hazard-300 dark:ring-hazard-500/50',
  red: 'bg-transparent text-signal-700 ring-signal-300 dark:text-signal-300 dark:ring-signal-500/50',
  blue: 'bg-transparent text-guide-700 ring-guide-300 dark:text-guide-200 dark:ring-guide-400/50',
  violet: 'bg-transparent text-violet-700 ring-violet-300 dark:text-violet-300 dark:ring-violet-500/50',
  teal: 'bg-transparent text-teal-700 ring-teal-300 dark:text-teal-300 dark:ring-teal-500/50',
  magenta: 'bg-transparent text-fuchsia-700 ring-fuchsia-300 dark:text-fuchsia-300 dark:ring-fuchsia-500/50',
  slate: 'bg-transparent text-slate-700 ring-slate-300 dark:text-slate-300 dark:ring-slate-500/50',
}

/** Icon chip (StatCard, EmptyState-like accents): background + icon colour, no ring. */
export const toneChip = {
  neutral: 'bg-sunken text-ink-2',
  green: 'bg-sign-50 text-sign-700 dark:bg-sign-500/15 dark:text-sign-300',
  yellow: 'bg-marking-50 text-marking-700 dark:bg-marking-500/15 dark:text-marking-300',
  orange: 'bg-hazard-50 text-hazard-700 dark:bg-hazard-500/15 dark:text-hazard-300',
  red: 'bg-signal-50 text-signal-700 dark:bg-signal-500/15 dark:text-signal-300',
  blue: 'bg-guide-50 text-guide-700 dark:bg-guide-500/20 dark:text-guide-200',
  violet: 'bg-violet-50 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  teal: 'bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300',
  magenta: 'bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-500/15 dark:text-fuchsia-300',
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-500/20 dark:text-slate-300',
}

/**
 * Filled bar (ProgressBar, ConfidenceBar). Every fill keeps at least 3:1 against the bar's track (bg-sunken) and
 * the card around it in its theme (WCAG 1.4.11 non-text contrast), so the step differs per theme where needed:
 * e.g. guide-500 is 5.19:1 on the light track but 2.99:1 on the dark one, where guide-450 is used (3.79:1 on the
 * track, 3.30:1 on the card, and still 5:1 under white labels such as the priority-weights bar segments).
 * Road-marking yellow has no step that stays recognisably yellow and reaches 3:1 on the light track, so the
 * light-mode fill keeps marking-500 and gets a 1px marking-700 edge (3.55:1) instead.
 */
export const toneBar = {
  neutral: 'bg-asphalt-500 dark:bg-asphalt-400',
  green: 'bg-sign-500',
  yellow: 'bg-marking-500 shadow-[inset_0_0_0_1px_var(--color-marking-700)] dark:shadow-none',
  orange: 'bg-hazard-600 dark:bg-hazard-500',
  red: 'bg-signal-500',
  blue: 'bg-guide-500 dark:bg-guide-450',
  violet: 'bg-violet-500',
  teal: 'bg-teal-700 dark:bg-teal-500',
  magenta: 'bg-fuchsia-600 dark:bg-fuchsia-500',
  slate: 'bg-slate-500',
}

/** SVG stroke colour (ScoreRing). */
export const toneStroke = {
  neutral: 'stroke-asphalt-400',
  green: 'stroke-sign-500',
  yellow: 'stroke-marking-500',
  orange: 'stroke-hazard-500',
  red: 'stroke-signal-500',
  blue: 'stroke-guide-500',
  violet: 'stroke-violet-500',
  teal: 'stroke-teal-500',
  magenta: 'stroke-fuchsia-500',
  slate: 'stroke-slate-500',
}

/** Dot / small indicator colour. */
export const toneDot = {
  neutral: 'bg-asphalt-400',
  green: 'bg-sign-500',
  yellow: 'bg-marking-500',
  orange: 'bg-hazard-500',
  red: 'bg-signal-500',
  blue: 'bg-guide-500',
  violet: 'bg-violet-500',
  teal: 'bg-teal-500',
  magenta: 'bg-fuchsia-500',
  slate: 'bg-slate-500',
}
