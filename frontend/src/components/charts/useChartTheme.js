/**
 * useChartTheme() - colours for Recharts, read from the design tokens and kept in sync with the theme.
 *
 * Recharts draws SVG and needs real colour values (it cannot use Tailwind classes), so this hook reads the
 * semantic CSS variables (`--c-surface`, `--c-line`, `--c-ink-3` ...) from <html> with getComputedStyle and
 * returns them as plain strings, together with the categorical palette selected for the current mode.
 *
 * Theme changes: ThemeProvider toggles the `.dark` class on <html>. One shared MutationObserver watches that
 * class attribute and notifies every subscribed chart through `useSyncExternalStore`, so all charts
 * re-render with the new colours in the same frame (and the observer disconnects when no chart is mounted).
 *
 * Returned shape:
 * `{ mode, isDark, surface, surface2, sunken, line, lineStrong, ink, ink2, ink3, primary, fontFamily,
 *    grid, axis, tick, cursor, scanCore, scanGlow, palette, otherColor, magnitude, animate }`
 * - grid: hairline gridline colour (one step off the surface; solid, never dashed)
 * - axis: baseline / axis line colour; tick: tick label colour (muted ink)
 * - cursor: hover band behind bars
 * - magnitude: the neutral bar colour of rankings whose rows are categories / departments (palette.js)
 * - scanCore / scanGlow: the line-chart crosshair, drawn as the AI scan head (road-marking yellow: a deeper
 *   step on light surfaces, a brighter one at night)
 * - animate: false when the user prefers reduced motion (Recharts' `isAnimationActive`), or when the chart
 *   was asked not to animate: `useChartTheme({ animate: false })` (a wrapper's `animate` prop). Under
 *   `ChartEntranceContext` = false (a return visit) it is false while the chart draws its first frame - so it
 *   appears in its final state - and true SETTLE_MS later, so later data changes still morph.
 */
import { useReducedMotion } from 'framer-motion'
import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ChartEntranceContext } from './chartContext'
import { CHART_PALETTE, MAGNITUDE_COLOR, OTHER_SERIES_COLOR } from './palette'

/** Token fallbacks (index.css values) for environments without computed styles. */
const FALLBACK = {
  light: {
    surface: '#ffffff',
    surface2: '#f6f8f7',
    sunken: '#e4e9e7',
    line: '#d6ddda',
    lineStrong: '#b9c4c0',
    ink: '#142022',
    ink2: '#45555a',
    ink3: '#58686c',
    primary: '#0b6e4f',
  },
  dark: {
    surface: '#172022',
    surface2: '#1c2628',
    sunken: '#0b1112',
    line: '#2a3537',
    lineStrong: '#3a4749',
    ink: '#e6ecea',
    ink2: '#a7b4b1',
    ink3: '#8e9e9c',
    primary: '#12845f',
  },
}

const VARIABLES = {
  surface: '--c-surface',
  surface2: '--c-surface-2',
  sunken: '--c-sunken',
  line: '--c-line',
  lineStrong: '--c-line-strong',
  ink: '--c-ink',
  ink2: '--c-ink-2',
  ink3: '--c-ink-3',
  primary: '--c-primary',
}

const listeners = new Set()
let observer = null

function subscribe(listener) {
  listeners.add(listener)
  if (!observer && typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
    observer = new MutationObserver(() => listeners.forEach((notify) => notify()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size && observer) {
      observer.disconnect()
      observer = null
    }
  }
}

function getSnapshot() {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

function getServerSnapshot() {
  return 'light'
}

/** Read the chart colours for `mode` from the current computed styles (pure apart from the DOM read). */
export function readChartTheme(mode = 'light') {
  const fallback = FALLBACK[mode] ?? FALLBACK.light
  const styles =
    typeof window !== 'undefined' && typeof document !== 'undefined' ? window.getComputedStyle(document.documentElement) : null
  const colors = {}
  Object.entries(VARIABLES).forEach(([key, variable]) => {
    const value = styles?.getPropertyValue(variable).trim()
    colors[key] = value || fallback[key]
  })
  const fontFamily = styles?.getPropertyValue('--font-sans').trim() || '"Public Sans", system-ui, sans-serif'
  return {
    mode,
    isDark: mode === 'dark',
    ...colors,
    fontFamily,
    grid: colors.line,
    axis: colors.lineStrong,
    tick: colors.ink3,
    cursor: colors.sunken,
    scanCore: mode === 'dark' ? 'rgb(255 212 71 / 0.85)' : 'rgb(204 150 0 / 0.75)',
    scanGlow: mode === 'dark' ? 'rgb(255 199 87 / 0.08)' : 'rgb(245 183 0 / 0.09)',
    palette: CHART_PALETTE[mode] ?? CHART_PALETTE.light,
    otherColor: OTHER_SERIES_COLOR[mode] ?? OTHER_SERIES_COLOR.light,
    magnitude: MAGNITUDE_COLOR[mode] ?? MAGNITUDE_COLOR.light,
  }
}

/** Time a chart gets to draw its first frame (measure, lay out, render) before animation is switched on. */
const SETTLE_MS = 900

export function useChartTheme({ animate = true } = {}) {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const reducedMotion = useReducedMotion()
  const entrance = useContext(ChartEntranceContext)
  const [settled, setSettled] = useState(entrance)
  useEffect(() => {
    if (settled) return undefined
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [settled])
  const animated = animate !== false && !reducedMotion && settled
  return useMemo(() => ({ ...readChartTheme(mode), animate: animated }), [mode, animated])
}

export default useChartTheme
