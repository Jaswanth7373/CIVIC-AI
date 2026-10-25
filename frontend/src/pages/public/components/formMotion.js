/**
 * Small motion helpers for the public forms (no components here, so React Fast Refresh keeps working).
 */

/**
 * Highlighter colours of the "filled in" flash. On light fields a pale marking yellow; on dark fields a
 * low-alpha road-marking yellow, which stays luminous instead of turning olive over the asphalt surface.
 */
const FILL_FROM = {
  light: { backgroundColor: 'rgb(255 226 122 / 0.6)', borderColor: '#f5b700' },
  dark: { backgroundColor: 'rgb(245 183 0 / 0.17)', borderColor: '#f5b700' },
}

/**
 * Flash form fields that were just filled in for the user (a demo account), so the eye follows the values
 * into the form. Uses the Web Animations API on the elements themselves: no re-render, nothing to clean up.
 * The flash has no end values, so each field animates back to its own colours. Callers skip it with reduced
 * motion.
 *
 * @param {Array<HTMLElement|null|undefined>} elements
 */
export function flashFilled(elements) {
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  const keyframes = [dark ? FILL_FROM.dark : FILL_FROM.light, {}]
  elements.forEach((element, index) => {
    if (!element || typeof element.animate !== 'function') return
    try {
      element.animate(keyframes, { duration: 950, delay: index * 90, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
    } catch {
      // Implicit end keyframes are unsupported in very old engines: the values are filled in all the same.
    }
  })
}
