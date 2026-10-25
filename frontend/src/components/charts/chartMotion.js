/**
 * Chart motion - the charts' share of the motion vocabulary (components/motion/tokens.js): one set of entrance
 * timings for every CivicAI chart, so a dashboard's charts arrive like parts of one instrument panel.
 *
 * - Charts mount their plot the first time it scrolls into view (ChartShell), so an entrance is seen instead
 *   of finishing off-screen. With reduced motion Recharts draws the final state at once (`theme.animate`).
 * - Bars rise one after another: `barMotion(count)` returns Recharts props - a duration, linear timing and an
 *   `animationInterpolateFn` (Recharts 3.9+) - that give every bar its own eased progress on Recharts' own
 *   animation clock. Hover layers, resizing and later data changes therefore keep Recharts' behaviour, and new
 *   values morph bar by bar as well. The cascade has at most STAGGER.max steps (later bars share the last).
 * - Lines draw with the symmetric curve (a pen stroke), donuts sweep with the entrance curve, tooltips glide
 *   between positions with the house curve.
 * Value labels appear when a bar animation ends (Recharts hides them while it runs); `chart-values` fades
 * them in (styles/admin.css).
 */
import { cubicBezier } from 'framer-motion'
import { EASE, STAGGER } from '@/components/motion/tokens'

const bezier = (points) => `cubic-bezier(${points.join(',')})`
const easeEnter = cubicBezier(...EASE.enter)

/** Recharts easing strings for the house curves. */
export const CHART_EASING = Object.freeze({
  enter: bezier(EASE.enter),
  inOut: bezier(EASE.inOut),
  standard: bezier(EASE.standard),
})

/** Line series: drawn left to right like a pen stroke. */
export const LINE_MOTION = Object.freeze({ animationBegin: 0, animationDuration: 1150, animationEasing: CHART_EASING.inOut })

/** Area series: the band rises from the baseline. */
export const AREA_MOTION = Object.freeze({ animationBegin: 0, animationDuration: 950, animationEasing: CHART_EASING.enter })

/** Donut slices: one sweep from twelve o'clock. */
export const PIE_MOTION = Object.freeze({ animationBegin: 0, animationDuration: 950, animationEasing: CHART_EASING.enter })

/** Tooltip box: glides to the hovered item instead of jumping. */
export const TOOLTIP_MOTION = Object.freeze({ animationDuration: 170, animationEasing: CHART_EASING.standard })

/** One bar's own rise (ms) and the delay between neighbouring bars (ms). */
const BAR_ITEM_MS = 660
const BAR_STEP_MS = Math.round(STAGGER.step * 1000)
const BAR_MAX_STEPS = STAGGER.max

const mix = (from, to, progress) => from + (to - from) * progress

/**
 * Recharts props for a bar series of `count` bars that rise one after another:
 * `<Bar {...barMotion(rows.length)} isAnimationActive={theme.animate} />`.
 *
 * The animation runs on a linear clock of `animationDuration`; each bar maps that clock to its own window
 * (starting `index` steps later, lasting BAR_ITEM_MS) and eases it with the entrance curve. Statuses follow
 * Recharts' default bar interpolation: added bars grow from their stack start, matched bars move from their
 * previous geometry, removed bars shrink away and are dropped at the end.
 *
 * @param {number} count number of bars in the series
 * @returns {{animationDuration: number, animationEasing: 'linear', animationInterpolateFn: Function}}
 */
export function barMotion(count) {
  const steps = Math.max(0, Math.min((Number(count) || 0) - 1, BAR_MAX_STEPS))
  const duration = BAR_ITEM_MS + steps * BAR_STEP_MS

  const progress = (time, index) => {
    const elapsed = time * duration - Math.min(index, BAR_MAX_STEPS) * BAR_STEP_MS
    return easeEnter(Math.min(1, Math.max(0, elapsed / BAR_ITEM_MS)))
  }

  const animationInterpolateFn = (items, time, layout) => {
    if (items == null) return []
    if (time >= 1) return items.flatMap((item) => (item.status === 'removed' ? [] : [item.next]))
    return items.flatMap((item, index) => {
      const p = progress(time, index)
      if (item.status === 'removed') {
        const prev = item.prev
        return layout === 'horizontal'
          ? [{ ...prev, height: mix(prev.height, 0, p), y: mix(prev.y, prev.y + prev.height, p) }]
          : [{ ...prev, width: mix(prev.width, 0, p) }]
      }
      if (item.status === 'matched') {
        const { prev, next } = item
        return [
          {
            ...next,
            x: mix(prev.x, next.x, p),
            y: mix(prev.y, next.y, p),
            width: mix(prev.width, next.width, p),
            height: mix(prev.height, next.height, p),
          },
        ]
      }
      const next = item.next
      return layout === 'horizontal'
        ? [{ ...next, height: mix(0, next.height, p), y: mix(next.stackedBarStart ?? next.y + next.height, next.y, p) }]
        : [{ ...next, width: mix(0, next.width, p), x: mix(next.stackedBarStart ?? next.x, next.x, p) }]
    })
  }

  return { animationDuration: duration, animationEasing: 'linear', animationInterpolateFn }
}
