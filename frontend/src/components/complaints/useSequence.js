/**
 * useSequence - timing for a "one stop after another" entrance (timeline stops, stepper discs, bars that grow
 * to their values): the first time the element behind `ref` scrolls into view, item i starts after
 * `delay(i)` seconds. The cascade is compressed so it never takes longer than `maxTotal`, however many items
 * there are.
 *
 * Returns `{ play, inView, settled, reduced, step, delay }`:
 * - play: the entrance runs for the items that are on screen now (false with reduced motion and once the
 *   entrance has finished - items mounted later, such as "Show all" or a live update, use a short entrance)
 * - inView: the trigger (true straight away with reduced motion)
 * - settled: the entrance is over
 * - step: seconds between two items
 * - delay(i): seconds before item i starts
 */
import { useCallback, useEffect, useState } from 'react'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'

export function useSequence(ref, { count = 1, step = 0.085, maxTotal = 1.05, base = 0.08, tail = 0.6, margin = '0px 0px -8% 0px' } = {}) {
  const reduced = usePrefersReducedMotion()
  const inView = useInViewOnce(ref, { margin })
  const [settled, setSettled] = useState(false)
  const span = Math.max(0, count - 1)
  const gap = span ? Math.min(step, maxTotal / span) : step

  useEffect(() => {
    if (settled || reduced || !inView) return undefined
    const timer = window.setTimeout(() => setSettled(true), (base + gap * span + tail) * 1000)
    return () => window.clearTimeout(timer)
  }, [settled, reduced, inView, base, gap, span, tail])

  const delay = useCallback((index) => base + Math.min(Math.max(0, index), span) * gap, [base, gap, span])

  return { play: !reduced && !settled, inView, settled: settled || reduced, reduced, step: gap, delay }
}

export default useSequence
