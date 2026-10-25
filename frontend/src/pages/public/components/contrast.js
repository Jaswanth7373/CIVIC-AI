/**
 * Local AA-contrast fix for muted text on the public pages.
 *
 * The shared muted-text token `--c-ink-3` (#6c7c80 light / #7a8a88 dark, src/index.css) measures 4.35:1 on
 * white, 4.07:1 on surface-2 and 3.82:1 on the concrete page colour in light mode, and 4.29:1 on surface-2 in
 * dark mode - below WCAG AA (4.5:1) for small text. Until the token itself is adjusted (requested from the
 * foundation owner), the public pages redefine it on their root element: #5c6b6f (light, >= 4.52:1 on every
 * light surface) and #83938f (dark, >= 4.81:1 on every dark surface). `text-ink-3` reads the variable, so
 * every muted label inside the page - including shared components - picks the darker value up.
 */
export const MUTED_TEXT_AA = '[--c-ink-3:#5c6b6f] dark:[--c-ink-3:#83938f]'
