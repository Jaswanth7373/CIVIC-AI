import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { DURATION, EASE, SPRING } from '@/components/motion/tokens'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/utils/cn'
import { IconButton } from './IconButton'
import { useModalLayer } from './overlay'
import { SheetHandle } from './SheetHandle'
import { useSheetDrag } from './useSheetDrag'

// Side panels pad their content (not their background) by the safe-area insets of a notched phone in
// landscape, and grow by the same amount (`--drawer-inset`), so the content keeps its width.
const POSITIONS = {
  left: 'inset-y-0 left-0 h-full border-r pl-[env(safe-area-inset-left)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] [--drawer-inset:env(safe-area-inset-left)]',
  right:
    'inset-y-0 right-0 h-full border-l pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] [--drawer-inset:env(safe-area-inset-right)]',
  bottom:
    'inset-x-0 bottom-0 max-h-[88dvh] rounded-t-2xl border-t pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]',
}
const WIDTHS = {
  sm: 'w-[calc(min(18rem,88vw)+var(--drawer-inset,0px))]',
  md: 'w-[calc(min(24rem,92vw)+var(--drawer-inset,0px))]',
  lg: 'w-[calc(min(32rem,94vw)+var(--drawer-inset,0px))]',
}
const OFFSCREEN = { left: { x: '-100%' }, right: { x: '100%' }, bottom: { y: '100%' } }
const ONSCREEN = { left: { x: 0 }, right: { x: 0 }, bottom: { y: 0 } }

/**
 * Off-canvas panel sliding in from the left, right or bottom (mobile navigation, filter panels, detail panels).
 * Same accessibility contract as Modal: portal, `role="dialog"` + `aria-modal`, focus trap and restore,
 * Esc / backdrop click closes, background scroll-locked and inert.
 *
 * Phones (below 640px): a right or bottom drawer becomes a bottom sheet - it rises from the bottom edge with a
 * drag handle and can be swiped down to close (from the handle or the header). A left drawer (navigation) stays
 * a side panel and can be swiped back to the left. Desktop keeps the side panels. `sheet={false}` opts out.
 * Motion: the panel slides in on a spring (no wobble) over a dimmed, softly blurred page and leaves quickly.
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose
 * @param {'left'|'right'|'bottom'} [props.side='right']
 * @param {'sm'|'md'|'lg'} [props.size='md'] width for left / right drawers
 * @param {import('react').ReactNode} [props.title]
 * @param {import('react').ReactNode} [props.description]
 * @param {import('react').ReactNode} [props.footer]
 * @param {boolean} [props.hideHeader] render only `children` (provide `aria-label` then)
 * @param {boolean} [props.sheet=true] on phones, show right / bottom drawers as a bottom sheet
 */
export function Drawer({
  open,
  onClose,
  side = 'right',
  size = 'md',
  title,
  description,
  footer,
  hideHeader = false,
  sheet: allowSheet = true,
  children,
  initialFocusRef,
  className,
  bodyClassName,
  'aria-label': ariaLabel,
}) {
  const panelRef = useRef(null)
  const titleId = useId()
  const descriptionId = useId()
  const requested = POSITIONS[side] ? side : 'right'
  const roomy = useMediaQuery(BREAKPOINTS.sm)
  const sheet = !roomy && allowSheet && requested !== 'left'
  const position = sheet ? 'bottom' : requested
  const swipeBack = !roomy && requested === 'left'

  useModalLayer({ open, onClose, containerRef: panelRef, initialFocusRef })
  const { panelProps, handleProps, dim } = useSheetDrag({
    enabled: (sheet || swipeBack) && typeof onClose === 'function',
    open,
    onDismiss: onClose,
    panelRef,
    axis: sheet ? 'y' : 'x',
    direction: sheet ? 1 : -1,
  })

  if (typeof document === 'undefined') return null

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div key="drawer" className="fixed inset-0 z-50" initial={{ opacity: 1 }} exit={{ opacity: 1 }}>
          <motion.div
            aria-hidden
            className="absolute inset-0"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: DURATION.base, ease: EASE.standard } }}
            exit={{ opacity: 0, transition: { duration: DURATION.base, ease: EASE.exit } }}
          >
            <motion.div className="absolute inset-0 bg-overlay backdrop-blur-[3px]" style={{ opacity: dim }} />
          </motion.div>
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={!hideHeader && title ? titleId : undefined}
            aria-label={hideHeader || !title ? ariaLabel : undefined}
            aria-describedby={!hideHeader && description ? descriptionId : undefined}
            tabIndex={-1}
            className={cn(
              'absolute flex flex-col border-line bg-elevated text-ink elev-overlay outline-hidden',
              POSITIONS[position],
              position !== 'bottom' && (WIDTHS[size] ?? WIDTHS.md),
              className,
            )}
            initial={OFFSCREEN[position]}
            animate={{ ...ONSCREEN[position], transition: SPRING.panel }}
            exit={{ ...OFFSCREEN[position], transition: { duration: DURATION.base, ease: EASE.exit } }}
            {...panelProps}
            {...(swipeBack ? handleProps : null)}
            // A swipe-back drawer is its own grab zone: keep the drag's position value next to its touch-action.
            style={swipeBack ? { ...panelProps.style, ...handleProps.style } : panelProps.style}
          >
            {sheet ? <SheetHandle {...handleProps} /> : null}
            {!hideHeader ? (
              <div
                {...(sheet ? handleProps : null)}
                className={cn('flex items-start gap-3 border-b border-line px-5 pb-4', sheet ? 'pt-1' : 'pt-4')}
              >
                <div className="min-w-0 flex-1">
                  {title ? (
                    <h2 id={titleId} className="font-display text-lg font-bold leading-snug text-ink">
                      {title}
                    </h2>
                  ) : null}
                  {description ? (
                    <p id={descriptionId} className="mt-1 text-sm text-ink-2">
                      {description}
                    </p>
                  ) : null}
                </div>
                <IconButton icon={X} label="Close panel" size="sm" onClick={onClose} className="-mr-1.5 -mt-0.5" />
              </div>
            ) : null}
            <div
              className={cn(
                'min-h-0 flex-1 overflow-y-auto overscroll-contain',
                // A swipe-back drawer: vertical pans scroll, horizontal ones reach the drag (see useSheetDrag).
                swipeBack && 'touch-pan-y',
                !hideHeader && 'px-5 py-4',
                bodyClassName,
              )}
            >
              {children}
            </div>
            {footer ? (
              <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3">
                {footer}
              </div>
            ) : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}

export default Drawer
