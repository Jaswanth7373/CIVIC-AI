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

const SIZES = { sm: 'sm:max-w-sm', md: 'sm:max-w-lg', lg: 'sm:max-w-2xl', xl: 'sm:max-w-4xl' }

/**
 * Accessible dialog.
 * - Rendered in a portal on <body>; `role="dialog"` + `aria-modal`, labelled by its title/description.
 * - Focus moves inside on open (to `initialFocusRef` or the first focusable element), Tab is trapped, and
 *   focus returns to the trigger on close. Esc and a click on the backdrop call `onClose`.
 * - The page behind is scroll-locked and inert.
 * - Phones (below 640px): a bottom sheet - it slides up from the bottom edge, has a drag handle, and can be
 *   swiped down to close (from the handle or the header; the body scrolls normally). The page behind brightens
 *   as it is pulled away. Its last row clears the iPhone home indicator (safe-area inset).
 * - Larger screens: a centred dialog that rises and settles on a spring while the page behind dims and softly
 *   blurs. Exits are short and accelerate away. Reduced motion: it simply appears.
 *
 * @param {object} props
 * @param {boolean} props.open
 * @param {() => void} props.onClose (without it - e.g. while saving - the sheet cannot be swiped away either)
 * @param {import('react').ReactNode} [props.title]
 * @param {import('react').ReactNode} [props.description]
 * @param {'sm'|'md'|'lg'|'xl'} [props.size='md']
 * @param {import('react').ReactNode} [props.footer] action buttons (right-aligned)
 * @param {import('react').RefObject} [props.initialFocusRef]
 * @param {boolean} [props.closeOnOverlayClick=true]
 * @param {boolean} [props.hideCloseButton=false]
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  children,
  initialFocusRef,
  closeOnOverlayClick = true,
  hideCloseButton = false,
  className,
  bodyClassName,
  'aria-label': ariaLabel,
}) {
  const panelRef = useRef(null)
  const pressedBackdropRef = useRef(false)
  const titleId = useId()
  const descriptionId = useId()

  const roomy = useMediaQuery(BREAKPOINTS.sm)
  const sheet = !roomy
  useModalLayer({ open, onClose, containerRef: panelRef, initialFocusRef })
  const { panelProps, handleProps, dim } = useSheetDrag({
    enabled: sheet && typeof onClose === 'function',
    open,
    onDismiss: onClose,
    panelRef,
  })

  if (typeof document === 'undefined') return null

  const hasHeader = Boolean(title) || !hideCloseButton

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div key="modal" className="fixed inset-0 z-50" initial={{ opacity: 1 }} exit={{ opacity: 1 }}>
          <motion.div
            aria-hidden
            className="absolute inset-0"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: DURATION.base, ease: EASE.standard } }}
            exit={{ opacity: 0, transition: { duration: DURATION.base, ease: EASE.exit } }}
          >
            <motion.div className="absolute inset-0 bg-overlay backdrop-blur-[3px]" style={{ opacity: dim }} />
          </motion.div>
          <div
            className="absolute inset-0 flex items-end justify-center overflow-y-auto sm:items-center sm:p-6"
            onPointerDown={(event) => {
              pressedBackdropRef.current = event.target === event.currentTarget
            }}
            onClick={(event) => {
              if (closeOnOverlayClick && pressedBackdropRef.current && event.target === event.currentTarget) onClose?.()
            }}
          >
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby={title ? titleId : undefined}
              aria-label={title ? undefined : ariaLabel}
              aria-describedby={description ? descriptionId : undefined}
              tabIndex={-1}
              className={cn(
                'relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-b-0 border-line bg-elevated text-ink elev-overlay outline-hidden',
                'sm:max-h-[min(88dvh,56rem)] sm:rounded-2xl sm:border-b',
                SIZES[size] ?? SIZES.md,
                className,
              )}
              initial={roomy ? { opacity: 0, y: 18, scale: 0.96 } : { opacity: 1, y: '100%' }}
              animate={{
                opacity: 1,
                y: 0,
                scale: 1,
                transition: { ...SPRING.panel, opacity: { duration: DURATION.base, ease: EASE.standard } },
              }}
              exit={
                roomy
                  ? { opacity: 0, y: 8, scale: 0.98, transition: { duration: DURATION.fast, ease: EASE.exit } }
                  : { y: '100%', transition: { duration: DURATION.base, ease: EASE.exit } }
              }
              {...panelProps}
            >
              {sheet ? <SheetHandle {...handleProps} /> : null}
              {hasHeader ? (
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
                  {!hideCloseButton ? (
                    <IconButton icon={X} label="Close dialog" size="sm" onClick={onClose} className="-mr-1.5 -mt-0.5" />
                  ) : null}
                </div>
              ) : null}
              <div
                className={cn(
                  'min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4',
                  sheet && !footer && 'pb-[max(1rem,env(safe-area-inset-bottom))]',
                  bodyClassName,
                )}
              >
                {children}
              </div>
              {footer ? (
                <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:rounded-b-2xl sm:pb-3">
                  {footer}
                </div>
              ) : null}
            </motion.div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  )
}

export default Modal
