/**
 * LaneDivider - the dashed road marking under a public page's intro (styles/public.css, section 2).
 *
 * The marking is painted on once, left to right, as the page opens; afterwards its dashes travel with the
 * scroll, a little slower than the page, so reading down the page feels like driving down the road. Only the
 * strip's transform changes (no layout, no paint per frame). Decorative (aria-hidden). Reduced motion: a still
 * marking.
 *
 * @param {{className?: string, delay?: number}} props
 */
import { motion, useScroll, useTransform } from 'framer-motion'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import '@/styles/public.css'

/** One dash + gap of the marking (px), so the loop is seamless. */
const PERIOD = 52

export function LaneDivider({ className, delay = 0.3 }) {
  const reduced = usePrefersReducedMotion()
  const { scrollY } = useScroll()
  const x = useTransform(scrollY, (value) => -((value * 0.45) % PERIOD))

  return (
    <motion.div
      aria-hidden
      className={cn('pub-lane-divider', className)}
      initial={reduced ? false : { clipPath: 'inset(0 100% 0 0)' }}
      animate={{ clipPath: 'inset(0 0% 0 0)' }}
      transition={{ duration: 1.2, ease: EASE.enter, delay }}
    >
      <motion.span style={reduced ? undefined : { x }} />
    </motion.div>
  )
}

export default LaneDivider
