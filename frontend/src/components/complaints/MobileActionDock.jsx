/**
 * MobileActionDock - the floating action bar of the complaint detail pages on phones: one line of context
 * (the next step, or what the button does) and the page's primary action, under the thumb once the page's own
 * button has scrolled away.
 *
 * Props:
 * - label: accessible name of the dock region (default "Quick actions")
 * - eyebrow: short context label above the title (e.g. the complaint number)
 * - title: the context line (clamped to two lines)
 * - icon: optional lucide icon shown in a road-marking yellow plate
 * - watch: ref to the page's own copy of the action (the header button, the next-step strip). The dock stays
 *   out of sight - off screen, `inert` and hidden from assistive technology - while that element is on screen,
 *   so the action is never offered twice at once; it slides in when the element scrolls out of view and away
 *   again when it comes back. Without `watch` the dock is always shown.
 * - children: the action(s) - usually ONE primary button, at most one more compact control
 * - className
 *
 * Placement: render it as the LAST element of the page. It is sticky (see styles/app.css section 3), so it
 * floats above the bottom of the screen - and above the citizen tab bar - while the page scrolls, and comes
 * to rest after the last card (its space is reserved there, so it never covers the last card's actions).
 * Hidden from the md breakpoint up, where the page header holds the actions. The buttons repeat the page's own
 * primary action (same handler, same label): the dock is a shortcut, not a second workflow.
 *
 * Below 400px the context column is dropped and the button takes the full width, so a long complaint number or
 * step never has to squeeze into a sliver next to it.
 *
 * Motion: it rises in with the panel spring and sinks away the same way (reduced motion: it simply appears and
 * disappears).
 */
import { motion } from 'framer-motion'
import { useEffect, useState } from 'react'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { SPRING } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { renderIcon } from '@/utils/icons'
import '@/styles/app.css'

/**
 * The part of the screen where the page's own action counts as visible: below the sticky top bar (64px) and
 * above the strip the dock and the citizen tab bar cover at the bottom.
 */
const VISIBLE_AREA = '-64px 0px -96px 0px'

/** True while `watch`'s element is out of view (or when there is nothing to watch). */
function useShownWhenAway(watch) {
  const [away, setAway] = useState(!watch)
  useEffect(() => {
    const node = watch?.current
    if (!node || typeof IntersectionObserver === 'undefined') {
      setAway(true)
      return undefined
    }
    const observer = new IntersectionObserver(([entry]) => setAway(!entry.isIntersecting), { rootMargin: VISIBLE_AREA })
    observer.observe(node)
    return () => observer.disconnect()
  }, [watch])
  return away
}

export function MobileActionDock({ label = 'Quick actions', eyebrow, title, icon, watch, children, className }) {
  const reduced = usePrefersReducedMotion()
  const shown = useShownWhenAway(watch)
  const context = Boolean(title || eyebrow)
  return (
    <div
      role="region"
      aria-label={label}
      aria-hidden={shown ? undefined : true}
      inert={!shown}
      data-shown={shown ? '' : undefined}
      className={cn('app-dock md:hidden', className)}
    >
      <motion.div
        className="flex items-center gap-3 rounded-2xl border border-line bg-elevated/95 px-3 py-2.5 elev-floating backdrop-blur-md backdrop-saturate-150"
        initial={false}
        // A short sink is enough while hidden: it stays inside the page's bottom padding, so hiding the dock never
        // changes how far the page scrolls.
        animate={shown ? { y: 0, opacity: 1 } : { y: 20, opacity: 0 }}
        transition={reduced ? { duration: 0 } : SPRING.panel}
      >
        {icon ? (
          <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-marking-400 text-asphalt-950">
            {renderIcon(icon, { className: 'size-[18px]', strokeWidth: 2.4 })}
          </span>
        ) : null}
        {context ? (
          <div className="hidden min-w-0 flex-1 min-[400px]:block">
            {eyebrow ? <p className="truncate text-[11px] font-semibold leading-4 text-ink-3 tabular">{eyebrow}</p> : null}
            {title ? <p className="line-clamp-2 text-[13px] font-semibold leading-snug text-ink">{title}</p> : null}
          </div>
        ) : null}
        <div
          className={cn(
            'flex items-center gap-2',
            context ? 'flex-1 shrink-0 [&>*]:flex-1 min-[400px]:flex-none min-[400px]:[&>*]:flex-none' : 'flex-1 [&>*]:flex-1',
          )}
        >
          {children}
        </div>
      </motion.div>
    </div>
  )
}

export default MobileActionDock
