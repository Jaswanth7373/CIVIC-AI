/**
 * Drives the landing hero's one orchestrated moment: once the real AI result has arrived (`ready`), the
 * work-order fields are revealed one after another - step 1 draws the detection box, 2 shows the category,
 * 3 the severity hint, 4 the routed department.
 *
 * Users who prefer reduced motion get the final state at once (no staged reveal). `replay()` runs the
 * sequence again on request (it is user-triggered motion, so it is allowed).
 */
import { useReducedMotion } from 'framer-motion'
import { useCallback, useEffect, useState } from 'react'

export function useRevealSequence(ready, total, { interval = 560, startDelay = 180 } = {}) {
  const reducedMotion = useReducedMotion()
  const [step, setStep] = useState(0)
  const [run, setRun] = useState(0)

  useEffect(() => {
    if (!ready) {
      setStep(0)
      return undefined
    }
    if (reducedMotion) {
      setStep(total)
      return undefined
    }
    setStep(0)
    const timers = Array.from({ length: total }, (_, index) =>
      window.setTimeout(() => setStep(index + 1), startDelay + index * interval),
    )
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [ready, total, reducedMotion, run, interval, startDelay])

  const replay = useCallback(() => setRun((current) => current + 1), [])

  return { step, replay, animated: !reducedMotion }
}

export default useRevealSequence
