/**
 * Theme provider: light / dark / system.
 *
 * - The choice is persisted in localStorage (`civicai.theme`) as a raw string. index.html reads the same key
 *   in an inline script before React loads, so the first paint already has the right theme (no flash).
 * - "system" follows the OS setting live through a `prefers-color-scheme` media-query listener.
 * - The resolved theme toggles the `.dark` class on <html>; Tailwind's `dark:` variant and the semantic CSS
 *   tokens in index.css switch on that class.
 * - A `storage` event listener keeps several open tabs in sync.
 *
 * Switching (cinematic plan 6.2): when the look actually changes, the new theme grows in a circle from the
 * control that asked for it - `setTheme(theme, { origin })` / `toggleTheme({ origin })`, where `origin` is a
 * point `{x, y}` in viewport pixels or an element (its centre is used) - through the View Transitions API, like
 * a street switching its lights on or off. Without the API, with reduced motion or in a hidden tab the theme
 * flips at once. Either way no colour transition runs for the flip, so every surface changes in the same frame
 * (see withoutTransitions; index.css "System additions" 1-2).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import { keepInputLive } from '@/components/ui/viewTransitionInput'
import { ThemeContext } from '@/context/contexts'
import { STORAGE_KEYS, storage } from '@/utils/storage'

const THEMES = ['light', 'dark', 'system']
const DARK_QUERY = '(prefers-color-scheme: dark)'
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** The reveal: long enough to read as light spreading from the toggle, short enough to never be in the way. */
const REVEAL_DURATION_MS = 620
const REVEAL_EASING = 'cubic-bezier(0.65, 0, 0.35, 1)'

function readStoredTheme() {
  const value = storage.get(STORAGE_KEYS.theme)
  return THEMES.includes(value) ? value : 'system'
}

function systemPrefersDark() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.(DARK_QUERY).matches)
}

/** True when the theme change may be animated: the API exists, the tab is visible and motion is welcome. */
function canRevealTheme() {
  return (
    typeof document !== 'undefined' &&
    typeof document.startViewTransition === 'function' &&
    document.visibilityState === 'visible' &&
    !window.matchMedia?.(REDUCED_MOTION_QUERY).matches
  )
}

/** True for a CSS transition (CSSTransition is the only kind of animation with a `transitionProperty`). */
const isCssTransition = (animation) => typeof animation.transitionProperty === 'string'

/** Properties whose values come from the colour tokens: background-color, border-*-color, fill, shadows... */
const COLOUR_PROPERTY = /(^|-)color$|^(fill|stroke|box-shadow|text-shadow)$|^--/

/**
 * Run `apply` (which flips the theme class) so that nothing eases from the old palette to the new one: every
 * surface changes in the same frame, never a half-light, half-dark one.
 *
 * The flip costs one full style recalculation anyway (the class swaps the colour tokens every element
 * inherits). `document.getAnimations()` runs that recalculation at once and lists the CSS transitions; these
 * jump to their end: every transition the flip has just started (colour easings on buttons, links, cards...)
 * and every colour transition already under way (e.g. the theme button's hover background fading out as its
 * menu closes - it would fade the old theme's grey over the new one). Other motion in flight - a drawer
 * sliding, a hover lift - is left alone.
 *
 * Browsers without getAnimations() fall back to a `* { transition: none }` guard (index.css "System additions"
 * 2). It is not the default because setting and removing it re-styles every element twice more - about 55 ms
 * each on the 8,000-element landing page, during which the theme reveal cannot start.
 */
function withoutTransitions(apply) {
  const root = document.documentElement
  if (typeof document.getAnimations !== 'function') {
    root.setAttribute('data-theme-switching', '')
    try {
      apply()
    } finally {
      // Reading layout forces the style recalculation now, while transitions are still off.
      void document.body?.offsetHeight
      root.removeAttribute('data-theme-switching')
    }
    return
  }
  const running = new Set(document.getAnimations())
  try {
    apply()
  } finally {
    for (const animation of document.getAnimations()) {
      if (isCssTransition(animation) && (!running.has(animation) || COLOUR_PROPERTY.test(animation.transitionProperty))) {
        try {
          animation.finish()
        } catch {
          // Cannot be finished (already cancelled): nothing left to ease.
        }
      }
    }
  }
}

/** `{x, y}` viewport point for the reveal: a point, an element's centre, or the top-right corner. */
function resolveOrigin(origin) {
  if (origin && typeof origin.getBoundingClientRect === 'function') {
    const rect = origin.getBoundingClientRect()
    if (rect.width || rect.height) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  } else if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
    return { x: origin.x, y: origin.y }
  }
  return { x: window.innerWidth - 32, y: 32 }
}

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(readStoredTheme)
  const [systemDark, setSystemDark] = useState(systemPrefersDark)

  useEffect(() => {
    const media = window.matchMedia?.(DARK_QUERY)
    if (!media) return undefined
    // An OS switch is not a click on our toggle, so it is not revealed - but it still flips in one frame.
    const handleChange = (event) => withoutTransitions(() => flushSync(() => setSystemDark(event.matches)))
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    const handleStorage = (event) => {
      if (event.key === STORAGE_KEYS.theme || event.key === null) setThemeState(readStoredTheme())
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [])

  const resolvedTheme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme

  // Layout effect: apply the class before the browser paints the updated tree.
  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', resolvedTheme === 'dark')
  }, [resolvedTheme])

  /**
   * @param {'light'|'dark'|'system'} next
   * @param {{origin?: {x: number, y: number} | Element}} [options] where the reveal starts (e.g. the toggle)
   */
  const setTheme = useCallback((next, options) => {
    const value = THEMES.includes(next) ? next : 'system'
    const save = () => {
      storage.set(STORAGE_KEYS.theme, value)
      setThemeState(value)
    }
    if (typeof document === 'undefined') {
      save()
      return
    }

    const root = document.documentElement
    const willBeDark = value === 'dark' || (value === 'system' && systemPrefersDark())
    // Only the stored choice changes (e.g. Dark -> System while the OS is dark): nothing to reveal.
    if (willBeDark === root.classList.contains('dark')) {
      save()
      return
    }

    const flip = () => withoutTransitions(() => flushSync(save))
    if (!canRevealTheme()) {
      flip()
      return
    }

    const { x, y } = resolveOrigin(options?.origin)
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
    root.dataset.viewTransition = 'theme'
    let transition
    try {
      transition = document.startViewTransition(flip)
    } catch {
      delete root.dataset.viewTransition
      flip()
      return
    }
    // A click during the reveal would land on the transition layer: it ends the reveal and reaches the page.
    keepInputLive(transition)
    transition.ready
      .then(() => {
        root.animate(
          { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
          { duration: REVEAL_DURATION_MS, easing: REVEAL_EASING, pseudoElement: '::view-transition-new(root)' },
        )
      })
      // `ready` rejects when the transition is skipped (e.g. another one started): the theme is applied anyway.
      .catch(() => {})
    transition.finished.finally(() => {
      if (root.dataset.viewTransition === 'theme') delete root.dataset.viewTransition
    })
  }, [])

  const toggleTheme = useCallback(
    (options) => {
      setTheme(resolvedTheme === 'dark' ? 'light' : 'dark', options)
    },
    [resolvedTheme, setTheme],
  )

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      isDark: resolvedTheme === 'dark',
      setTheme,
      toggleTheme,
      themes: THEMES,
    }),
    [theme, resolvedTheme, setTheme, toggleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export default ThemeProvider
