import { AnimatePresence, motion } from 'framer-motion'
import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DURATION, EASE, SPRING } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { floatingOffset, floatingOrigin, floatingStyle, useAnchoredPosition } from './floating'
import { getFocusableElements, useDismissableLayer } from './overlay'

const TRIGGER_SELECTOR = 'button, [href], [tabindex]:not([tabindex="-1"])'

/**
 * Non-modal floating panel anchored to a trigger (e.g. the notification bell dropdown).
 * The trigger gets aria-haspopup="dialog" / aria-expanded; the panel is a labelled `role="dialog"`.
 * Opening moves focus into the panel (`initialFocus`, else its first focusable element); Esc closes and returns
 * focus to the trigger; clicking outside closes.
 *
 * Keyboard: the panel is portalled to the end of <body>, but Tab behaves as if it sat right after the trigger.
 * Tab from its last element closes it and moves on to the element after the trigger; Shift+Tab from its first
 * element (or the panel itself) closes it and returns to the trigger. Focus leaving for anywhere else (a click,
 * a screen reader's cursor) closes it too. When the focused element inside goes away (e.g. "Mark all read"
 * disables itself) focus stays in the panel instead of falling back to the top of the page.
 *
 * Motion: the panel grows out of the trigger (transform origin on the trigger's side) on a light spring and
 * leaves quickly; it sits on the "floating" elevation.
 *
 * @param {object} props
 * @param {import('react').ReactElement} props.trigger
 * @param {import('react').ReactNode | ((api: {close: () => void}) => import('react').ReactNode)} props.children
 * @param {string} props.label accessible name of the panel
 * @param {string} [props.placement='bottom-end'] side-align, e.g. bottom-start, top, right
 * @param {(open: boolean) => void} [props.onOpenChange]
 * @param {(panel: HTMLElement) => HTMLElement | null | undefined} [props.initialFocus] element to focus on open;
 *   returning null focuses the panel itself (labelled, so screen readers announce it)
 */
export function Popover({ trigger, children, label, placement = 'bottom-end', className, panelClassName, onOpenChange, initialFocus }) {
  const [open, setOpenState] = useState(false)
  const anchorRef = useRef(null)
  const panelRef = useRef(null)
  const panelId = useId()
  const initialFocusRef = useRef(initialFocus)

  useEffect(() => {
    initialFocusRef.current = initialFocus
  })

  // Read by the focus handlers: a panel that is only playing its exit animation must not take focus back.
  const openRef = useRef(false)
  const setOpen = useCallback(
    (next) => {
      openRef.current = next
      setOpenState(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )

  const position = useAnchoredPosition(open, anchorRef, panelRef, { placement, offset: 8 })
  const [requestedSide = 'bottom', requestedAlign = 'center'] = String(placement).split('-')

  const close = useCallback(
    (restoreFocus = false) => {
      setOpen(false)
      if (restoreFocus) anchorRef.current?.querySelector(TRIGGER_SELECTOR)?.focus()
    },
    [setOpen],
  )

  /** Close, then continue the page's tab order after the trigger (as if the panel sat right behind it). */
  const closeToNext = () => {
    const trigger = anchorRef.current?.querySelector(TRIGGER_SELECTOR)
    setOpen(false)
    if (!trigger) return
    const order = getFocusableElements(document.body).filter((element) => !panelRef.current?.contains(element))
    const index = order.indexOf(trigger)
    ;(index !== -1 ? (order[index + 1] ?? trigger) : trigger).focus()
  }

  const handlePanelKeyDown = (event) => {
    if (event.key !== 'Tab' || event.defaultPrevented) return
    const panel = panelRef.current
    const focusable = getFocusableElements(panel)
    const active = document.activeElement
    if (event.shiftKey && (active === panel || active === focusable[0] || !focusable.length)) {
      event.preventDefault()
      close(true)
    } else if (!event.shiftKey && (active === focusable[focusable.length - 1] || !focusable.length)) {
      event.preventDefault()
      closeToNext()
    }
  }

  const handlePanelBlur = (event) => {
    const next = event.relatedTarget
    const panel = panelRef.current
    if (!openRef.current) return
    if (!next) {
      // The focused element went away (disabled or removed) while the panel stays open: keep focus inside.
      window.requestAnimationFrame(() => {
        if (openRef.current && panel?.isConnected && document.hasFocus() && document.activeElement === document.body) {
          panel.focus({ preventScroll: true })
        }
      })
      return
    }
    if (panel?.contains(next) || anchorRef.current?.contains(next)) return
    close(false)
  }

  useDismissableLayer({
    open,
    refs: [anchorRef, panelRef],
    onDismiss: () => close(false),
    onEscape: () => close(true),
  })

  const positioned = Boolean(position)
  useEffect(() => {
    if (!open || !positioned) return
    const panel = panelRef.current
    if (!panel) return
    const chooser = initialFocusRef.current
    const target = chooser ? (chooser(panel) ?? panel) : (getFocusableElements(panel)[0] ?? panel)
    target.focus({ preventScroll: true })
  }, [open, positioned])

  const triggerElement = isValidElement(trigger)
    ? cloneElement(trigger, {
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-controls': open ? panelId : undefined,
        onClick: (event) => {
          trigger.props.onClick?.(event)
          if (!event.defaultPrevented) setOpen(!open)
        },
      })
    : trigger

  const api = { close: () => close(true) }

  return (
    <>
      <span ref={anchorRef} className={cn('relative inline-flex', className)}>
        {triggerElement}
      </span>
      {typeof document !== 'undefined'
        ? createPortal(
            <AnimatePresence>
              {open ? (
                <motion.div
                  ref={panelRef}
                  id={panelId}
                  role="dialog"
                  aria-label={label}
                  tabIndex={-1}
                  onKeyDown={handlePanelKeyDown}
                  onBlur={handlePanelBlur}
                  style={floatingStyle(position, {
                    maxHeight: position?.maxHeight,
                    transformOrigin: floatingOrigin(position?.side ?? requestedSide, requestedAlign),
                  })}
                  initial={{ opacity: 0, scale: 0.95, ...floatingOffset(requestedSide, 6) }}
                  animate={{ opacity: 1, scale: 1, x: 0, y: 0, transition: { ...SPRING.pop, opacity: { duration: DURATION.fast, ease: EASE.standard } } }}
                  exit={{ opacity: 0, scale: 0.97, ...floatingOffset(requestedSide, 3), transition: { duration: 0.12, ease: EASE.exit } }}
                  className={cn(
                    'z-[60] flex max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-line bg-elevated text-ink elev-floating outline-hidden',
                    panelClassName,
                  )}
                >
                  {typeof children === 'function' ? children(api) : children}
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  )
}

export default Popover
