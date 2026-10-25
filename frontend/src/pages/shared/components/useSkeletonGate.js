/**
 * useSkeletonGate - decides how a dashboard's first load looks, so content never animates twice and
 * skeletons never flash for a moment:
 *
 * - The data arrives within `delay` ms (the usual case): nothing is shown meanwhile, then the content plays
 *   its entrance cascade (`cascade: true`).
 * - The data takes longer: skeletons appear after `delay` ms (`showSkeleton: true`), and when the data comes the
 *   content simply replaces them (`cascade: false`) - no blank frame between skeleton and cascade.
 *
 * @param {boolean} pending true while the first load is in flight
 * @param {number} [delay=300]
 * @returns {{ showSkeleton: boolean, cascade: boolean, waiting: boolean }} `waiting`: still inside the delay
 */
import { useEffect, useState } from 'react'

export function useSkeletonGate(pending, delay = 300) {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!pending) return undefined
    const timer = window.setTimeout(() => setLate(true), delay)
    return () => window.clearTimeout(timer)
  }, [pending, delay])
  return { showSkeleton: pending && late, cascade: !pending && !late, waiting: pending && !late }
}

export default useSkeletonGate
