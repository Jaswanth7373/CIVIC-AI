/**
 * Debounce a changing value: returns `value` only after it has stopped changing for `delay` ms.
 * Typical use: `const term = useDebounce(search, 300)` so a list is fetched once the user pauses typing,
 * instead of on every keystroke.
 */
import { useEffect, useState } from 'react'

export function useDebounce(value, delay = 300) {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])

  return debounced
}

export default useDebounce
