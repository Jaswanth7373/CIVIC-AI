import { motion, useScroll, useSpring, useTransform } from 'framer-motion'
import { createPortal } from 'react-dom'
import { cn } from '@/utils/cn'
import { usePrefersReducedMotion } from './hooks'
import { SPRING } from './tokens'

/**
 * Reading progress for long public pages (the landing): a road-marking lane line that extends across the
 * window as the reader scrolls. It is revealed with `clip-path` rather than scaled, so the dashes keep their
 * real length. Rendered in a portal on <body> so page transforms never re-anchor it.
 *
 * Sits under the public header by default (`top: var(--public-header-h)`); pass `placement="top"` to use the
 * window's top edge. Reduced motion: follows the scroll position exactly, without spring smoothing.
 *
 * @param {{placement?: 'header'|'top', className?: string}} props
 */
export function ScrollProgress({ placement = 'header', className }) {
  const reduced = usePrefersReducedMotion()
  const { scrollYProgress } = useScroll()
  const smooth = useSpring(scrollYProgress, SPRING.scroll)
  const clipPath = useTransform(reduced ? scrollYProgress : smooth, (value) => `inset(0 ${(100 - value * 100).toFixed(2)}% 0 0)`)

  if (typeof document === 'undefined') return null
  return createPortal(
    <motion.div
      aria-hidden
      style={{ clipPath, top: placement === 'top' ? 0 : 'var(--public-header-h)' }}
      className={cn('scroll-progress lane-line-x pointer-events-none fixed inset-x-0 z-40 h-[3px]', className)}
    />,
    document.body,
  )
}

export default ScrollProgress
