import { motion } from 'framer-motion'
import { Fragment, useCallback, useRef } from 'react'
import { cn } from '@/utils/cn'
import { useInViewOnce, usePrefersReducedMotion } from './hooks'
import { DURATION, EASE } from './tokens'

const motionComponents = new Map()
function motionFor(as) {
  if (typeof as === 'string') return motion[as]
  if (!motionComponents.has(as)) motionComponents.set(as, motion.create(as))
  return motionComponents.get(as)
}

/*
 * One element both moves and masks itself: it starts 125% of its height lower and clips everything below
 * its final box (plus a 20% margin for descenders), and both values travel together, so the line appears to
 * rise out of a slot in the page. No wrapper element is needed - each line stays ONE element, which keeps
 * selectors such as `#hero-title span` (one span per line) and the heading's accessible name intact.
 */
const HIDDEN = { y: '125%', clipPath: 'inset(-200% -10% 105% -10%)' }
const SHOWN = { y: '0%', clipPath: 'inset(-200% -10% -20% -10%)', transitionEnd: { clipPath: 'none' } }

/**
 * A single line (or word) that rises from a mask. Used by RevealHeading; usable alone for one-line labels.
 * For landing / public display type only - app screens don't animate their headings.
 *
 * @param {object} props
 * @param {import('react').ElementType} [props.as='span'] rendered inline-block unless `className` says `block`
 * @param {boolean} [props.visible] external trigger; without it the element watches itself
 * @param {number} [props.delay] seconds
 * @param {number} [props.duration] seconds (DURATION.reveal)
 */
export function MaskReveal({ as = 'span', visible: visibleProp, delay = 0, duration = DURATION.reveal, className, children, ...props }) {
  // Watch the PARENT: Chromium's IntersectionObserver applies the element's own clip-path, and the hidden
  // state clips this element to nothing, so it would never count as "in view". Any part of the parent above
  // the bottom 12% of the window counts (a ratio threshold could never be met by a very tall parent).
  const parentRef = useRef(null)
  const attach = useCallback((node) => {
    parentRef.current = node?.parentElement ?? null
  }, [])
  const reduced = usePrefersReducedMotion()
  const seen = useInViewOnce(parentRef, { amount: 'some', margin: '0px 0px -12% 0px' })
  const visible = visibleProp ?? seen
  const MotionTag = motionFor(as)

  if (reduced) {
    const Tag = as
    return (
      <Tag className={cn('inline-block', className)} {...props}>
        {children}
      </Tag>
    )
  }

  return (
    <MotionTag
      ref={attach}
      className={cn('inline-block', className)}
      initial={HIDDEN}
      animate={visible ? SHOWN : HIDDEN}
      transition={{ duration, delay, ease: EASE.enter }}
      {...props}
    >
      {children}
    </MotionTag>
  )
}

/**
 * Display heading whose lines rise from a mask, one after another, the first time it enters the viewport.
 *
 * - `lines={['How CivicAI', 'Works']}`: one block-level <span> per line (explicit line breaks).
 * - `children="Smart Prioritization"` with `split="words"`: one inline-block <span> per word, wrapping
 *   naturally at any width. Without `split` a string is revealed as a single line.
 * - A space is kept between lines / words, so the accessible name and text read exactly as written
 *   ("How CivicAI Works"). Reduced motion: the plain heading.
 *
 * @param {object} props
 * @param {import('react').ElementType} [props.as='h2']
 * @param {Array<import('react').ReactNode>} [props.lines]
 * @param {'words'|'none'} [props.split='none'] how a string child is split
 * @param {string} [props.lineClassName] class for every line / word element
 * @param {number} [props.delay] seconds before the first line
 * @param {number} [props.stagger=0.09] seconds between lines (words use a third of it)
 */
export function RevealHeading({
  as: Component = 'h2',
  lines,
  split = 'none',
  lineClassName,
  delay = 0,
  stagger = 0.09,
  className,
  children,
  ...props
}) {
  const ref = useRef(null)
  const visible = useInViewOnce(ref, { amount: 0.5, margin: '0px 0px -6% 0px' })
  const words = !lines && split === 'words' && typeof children === 'string'
  const parts = lines ?? (words ? children.split(/\s+/).filter(Boolean) : [children])
  const step = words ? stagger / 3 : stagger

  return (
    <Component ref={ref} className={className} {...props}>
      {parts.map((part, index) => (
        <Fragment key={index}>
          <MaskReveal
            visible={visible}
            delay={delay + index * step}
            className={cn(words ? 'inline-block' : 'block', lineClassName)}
          >
            {part}
          </MaskReveal>
          {index < parts.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </Component>
  )
}

export default RevealHeading
