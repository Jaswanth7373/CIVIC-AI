import { useEffect } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

/**
 * Scroll behaviour for client-side navigation: a new page starts at the top, while browser back / forward
 * (a "POP" navigation) keeps the browser's own scroll restoration. Query-string changes (filters, paging)
 * do not jump. `#hash` links scroll to the matching element.
 */
export function ScrollToTop() {
  const { pathname, hash } = useLocation()
  const navigationType = useNavigationType()

  useEffect(() => {
    if (hash) {
      const target = document.getElementById(decodeURIComponent(hash.slice(1)))
      if (target) {
        target.scrollIntoView({ block: 'start' })
        return
      }
    }
    if (navigationType !== 'POP') window.scrollTo(0, 0)
  }, [pathname, hash, navigationType])

  return null
}

export default ScrollToTop
