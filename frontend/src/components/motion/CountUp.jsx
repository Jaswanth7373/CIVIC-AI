import { animate, useInView } from 'framer-motion'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { formatNumber } from '@/utils/format'
import { usePrefersReducedMotion } from './hooks'
import { DURATION, EASE } from './tokens'

/** Decimal places of a number as written (3.9 -> 1), capped at 3. */
function decimalsOf(value) {
  if (Number.isInteger(value)) return 0
  const text = String(value)
  const point = text.indexOf('.')
  return point === -1 ? 0 : Math.min(3, text.length - point - 1)
}

/**
 * Write into the element's own text node. React created that node and keeps a reference to it, so it is
 * updated in place (`nodeValue`) - replacing it (`textContent = ...`) would detach React's node and the next
 * render would update a node that is no longer on screen.
 */
function writeText(element, text) {
  const node = element?.firstChild
  if (node && node.nodeType === 3 && node.nodeValue !== text) node.nodeValue = text
}

/**
 * A number that counts up to its value the first time it scrolls into view (dashboards, live figures).
 *
 * - Renders ONE element with ONE text node, and React always renders the final, formatted value into it:
 *   tests and screen readers that read the text get the real number, never a second copy. While counting, the
 *   text node is updated in place (no React re-render per frame).
 * - Starts at `from` (0) only when the count will actually play: the start value is written before the first
 *   paint, and counting begins once the element is in view.
 * - Reduced motion: the final value, immediately, always.
 * - When `value` changes later (a refresh), it counts from the number on screen to the new one, faster.
 * - Non-numbers (`null`, "2 d 4 h") are shown as given; `null` / `undefined` show an em dash.
 *
 * @param {object} props
 * @param {number|string|null} props.value
 * @param {(n: number) => string} [props.format] defaults to Indian digit grouping with the value's own decimals
 * @param {number} [props.duration] seconds (DURATION.count)
 * @param {number} [props.delay] seconds before the first count starts
 * @param {number} [props.from=0]
 * @param {import('react').ElementType} [props.as='span'] e.g. 'p' to keep a `<p>` contract
 */
export function CountUp({ value, format, duration = DURATION.count, delay = 0, from = 0, as: Component = 'span', className, ...props }) {
  const ref = useRef(null)
  const reduced = usePrefersReducedMotion()
  const inView = useInView(ref, { once: true, amount: 0.4 })
  const numeric = typeof value === 'number' && Number.isFinite(value)
  const digits = numeric ? decimalsOf(value) : 0
  const text = numeric ? (format ? format(value) : formatNumber(value, { digits })) : String(value ?? '—')

  // Latest formatter for the animation callbacks (an inline `format` must not restart the count).
  const formatRef = useRef({ format, digits })
  useLayoutEffect(() => {
    formatRef.current = { format, digits }
  })

  // 'idle' -> 'armed' (start value shown, waiting to be seen) -> 'running' -> 'done'
  const phaseRef = useRef('idle')
  const shownRef = useRef(null)

  // Before paint: decide what the element shows while it is not counting.
  useLayoutEffect(() => {
    const element = ref.current
    const show = (n) => {
      const { format: currentFormat, digits: currentDigits } = formatRef.current
      return currentFormat ? currentFormat(n) : formatNumber(n, { digits: currentDigits })
    }
    if (!numeric || reduced) {
      phaseRef.current = 'done'
      shownRef.current = numeric ? value : null
      writeText(element, text)
      return
    }
    if (phaseRef.current === 'idle') {
      phaseRef.current = 'armed'
      shownRef.current = from
    }
    if (shownRef.current !== value) writeText(element, show(shownRef.current))
  }, [numeric, reduced, value, from, text])

  // Count once the element is in view (and again, quicker, whenever the value changes afterwards).
  useEffect(() => {
    if (!numeric || reduced || !inView) return undefined
    const start = shownRef.current ?? value
    if (start === value) {
      phaseRef.current = 'done'
      return undefined
    }
    const first = phaseRef.current !== 'done'
    phaseRef.current = 'running'
    const show = (n) => {
      const { format: currentFormat, digits: currentDigits } = formatRef.current
      return currentFormat ? currentFormat(n) : formatNumber(n, { digits: currentDigits })
    }
    const controls = animate(start, value, {
      duration: first ? duration : Math.min(duration, DURATION.slower),
      delay: first ? delay : 0,
      ease: EASE.count,
      onUpdate: (latest) => {
        shownRef.current = latest
        writeText(ref.current, show(latest))
      },
      onComplete: () => {
        shownRef.current = value
        phaseRef.current = 'done'
        writeText(ref.current, show(value))
      },
    })
    return () => controls.stop()
  }, [numeric, reduced, inView, value, duration, delay])

  return (
    <Component ref={ref} className={className} {...props}>
      {text}
    </Component>
  )
}

export default CountUp
