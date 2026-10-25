/**
 * Seconds left of a wait (e.g. a rate limit's Retry-After). Restarts whenever `key` changes (pass the error
 * object, so two consecutive 429 answers both restart the clock) and stops ticking at zero.
 */
import { useEffect, useState } from 'react'

export function useCountdown(seconds, key) {
  const [deadline, setDeadline] = useState(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const start = Date.now()
    setNow(start)
    setDeadline(seconds > 0 ? start + seconds * 1000 : null)
  }, [seconds, key])

  useEffect(() => {
    if (!deadline) return undefined
    const timer = window.setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= deadline) window.clearInterval(timer)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [deadline])

  return deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : 0
}

export default useCountdown
