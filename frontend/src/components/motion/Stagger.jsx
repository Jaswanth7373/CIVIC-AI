import { motion } from 'framer-motion'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useInViewOnce, usePrefersReducedMotion } from './hooks'
import { DURATION, EASE, STAGGER } from './tokens'

const StaggerContext = createContext(null)
/** Items past this index render plain (a list this long is off-screen there anyway). */
const ANIMATED_ITEMS = 30
const motionComponents = new Map()

/** framer-motion version of a tag name or component (cached: creating one per render would remount). */
function motionFor(as) {
  if (typeof as === 'string') return motion[as]
  if (!motionComponents.has(as)) motionComponents.set(as, motion.create(as))
  return motionComponents.get(as)
}

/**
 * Entrance for a list or grid on its FIRST load: items rise and fade in one after another once the list is in
 * view. Wrap each real item in <StaggerItem index={i}> (not skeletons - the first items to mount use up the
 * entrance). Items mounted later (paging, refresh, new rows) simply appear: the entrance plays once.
 *
 * - The cascade has at most `max` steps (8): later items arrive together with the 8th, so a long list never
 *   waits on its animation and nothing appears out of order. Beyond 30 items (surely off-screen) items render
 *   plain.
 * - Reduced motion: plain elements, nothing hidden at any time.
 *
 *   <Stagger as="ul" className="grid gap-3">
 *     {rows.map((row, i) => <StaggerItem as="li" key={row.id} index={i}>...</StaggerItem>)}
 *   </Stagger>
 *
 * @param {object} props
 * @param {import('react').ElementType} [props.as='div']
 * @param {number} [props.step] seconds between items (STAGGER.step)
 * @param {number} [props.max] how many items animate (STAGGER.max)
 * @param {number} [props.delay] seconds before the first item
 * @param {number} [props.y=12] rise distance in px
 */
export function Stagger({ as: Component = 'div', step = STAGGER.step, max = STAGGER.max, delay = 0, y = 12, children, ...props }) {
  const ref = useRef(null)
  const reduced = usePrefersReducedMotion()
  const inView = useInViewOnce(ref)
  const [done, setDone] = useState(false)
  const timerRef = useRef(0)

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  // The first batch of items to mount plays the entrance; once it has had time to finish, later items don't.
  const markPlayed = useCallback(() => {
    if (timerRef.current) return
    const total = delay + max * step + DURATION.slow
    timerRef.current = window.setTimeout(() => setDone(true), total * 1000)
  }, [delay, max, step])

  const context = useMemo(
    () => ({ inView, reduced, done, step, max, delay, y, markPlayed }),
    [inView, reduced, done, step, max, delay, y, markPlayed],
  )

  return (
    <StaggerContext.Provider value={context}>
      <Component ref={ref} {...props}>
        {children}
      </Component>
    </StaggerContext.Provider>
  )
}

/**
 * One item of a <Stagger> list. `index` is its position (0-based); items at or past `max` share the last
 * step. Outside a <Stagger> it renders the plain element.
 *
 * @param {{as?: import('react').ElementType, index?: number}} props
 */
export function StaggerItem({ as = 'div', index = 0, children, ...props }) {
  const context = useContext(StaggerContext)
  const [animated] = useState(() => Boolean(context) && !context.reduced && !context.done && index < ANIMATED_ITEMS)
  const markPlayed = context?.markPlayed

  useEffect(() => {
    if (animated) markPlayed?.()
  }, [animated, markPlayed])

  if (!animated) {
    const Plain = as
    return <Plain {...props}>{children}</Plain>
  }

  const MotionItem = motionFor(as)
  return (
    <MotionItem
      initial={{ opacity: 0, y: context.y }}
      animate={context.inView ? { opacity: 1, y: 0 } : undefined}
      transition={{ duration: DURATION.slow, ease: EASE.enter, delay: context.delay + Math.min(index, context.max - 1) * context.step }}
      {...props}
    >
      {children}
    </MotionItem>
  )
}

export default Stagger
