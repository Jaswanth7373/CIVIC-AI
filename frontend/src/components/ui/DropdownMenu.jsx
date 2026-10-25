import { AnimatePresence, motion } from 'framer-motion'
import { Check } from 'lucide-react'
import { cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { DURATION, EASE, SPRING } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { renderIcon } from '@/utils/icons'
import { floatingOffset, floatingOrigin, floatingStyle, useAnchoredPosition } from './floating'
import { useDismissableLayer } from './overlay'

const ITEM_SELECTOR = '[role^="menuitem"]:not([aria-disabled="true"])'

/**
 * Menu button following the WAI-ARIA menu pattern.
 * - The trigger gets aria-haspopup / aria-expanded / aria-controls; Enter, Space or ArrowDown open the menu
 *   and focus the first item (ArrowUp: the last item).
 * - Inside: ArrowUp / ArrowDown / Home / End move focus, Esc closes and returns focus to the trigger,
 *   Tab closes. Clicking outside closes.
 * - The menu is portalled and fixed-positioned next to the trigger (never clipped by scroll containers).
 * - Motion: it grows out of the trigger corner on a light spring, items highlight with the house curve, and it
 *   leaves quickly. It sits on the "floating" elevation.
 *
 * @param {object} props
 * @param {import('react').ReactElement} props.trigger a button element (e.g. <IconButton .../>)
 * @param {Array<{label?: string, icon?: import('react').ComponentType, onClick?: Function, to?: string,
 *   href?: string, danger?: boolean, divider?: boolean, disabled?: boolean, checked?: boolean, description?: string}>} props.items
 *   `divider: true` renders a separator; `checked` (true/false) renders a radio-style item with a tick.
 * @param {'start'|'end'} [props.align='end']
 * @param {'bottom'|'top'} [props.side='bottom']
 * @param {import('react').ReactNode} [props.header] content above the items (e.g. the signed-in user)
 * @param {string} [props.label] accessible name of the menu
 */
export function DropdownMenu({ trigger, items = [], align = 'end', side = 'bottom', header, label, className, menuClassName, onOpenChange }) {
  const [open, setOpenState] = useState(false)
  const anchorRef = useRef(null)
  const menuRef = useRef(null)
  const focusTargetRef = useRef('first')
  const menuId = useId()

  const setOpen = useCallback(
    (next) => {
      setOpenState(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )

  const position = useAnchoredPosition(open, anchorRef, menuRef, { placement: `${side}-${align}`, offset: 6 })

  const focusTrigger = () => {
    anchorRef.current?.querySelector('button, [href], [tabindex]:not([tabindex="-1"])')?.focus()
  }

  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) focusTrigger()
  }

  useDismissableLayer({
    open,
    refs: [anchorRef, menuRef],
    onDismiss: () => close(false),
    onEscape: () => close(true),
  })

  // Once positioned, move focus to the first (or last) item, as the menu pattern requires.
  const positioned = Boolean(position)
  useEffect(() => {
    if (!open || !positioned) return
    const menuItems = Array.from(menuRef.current?.querySelectorAll(ITEM_SELECTOR) ?? [])
    const target = focusTargetRef.current === 'last' ? menuItems[menuItems.length - 1] : menuItems[0]
    target?.focus({ preventScroll: true })
  }, [open, positioned])

  const handleMenuKeyDown = (event) => {
    const menuItems = Array.from(menuRef.current?.querySelectorAll(ITEM_SELECTOR) ?? [])
    if (!menuItems.length) return
    const index = menuItems.indexOf(document.activeElement)
    const focusAt = (next) => menuItems[(next + menuItems.length) % menuItems.length]?.focus()
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusAt(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusAt(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusAt(menuItems.length - 1)
    } else if (event.key === 'Tab') {
      close(false)
    }
  }

  const triggerElement = isValidElement(trigger)
    ? cloneElement(trigger, {
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': open ? menuId : undefined,
        onClick: (event) => {
          trigger.props.onClick?.(event)
          if (event.defaultPrevented) return
          focusTargetRef.current = 'first'
          setOpen(!open)
        },
        onKeyDown: (event) => {
          trigger.props.onKeyDown?.(event)
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            focusTargetRef.current = event.key === 'ArrowUp' ? 'last' : 'first'
            setOpen(true)
          }
        },
      })
    : trigger

  const itemClass = (item) =>
    cn(
      'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors duration-150 ease-standard focus-visible:-outline-offset-2 pointer-coarse:min-h-11',
      item.danger
        ? 'text-signal-600 hover:bg-signal-50 focus:bg-signal-50 dark:text-signal-300 dark:hover:bg-signal-500/15 dark:focus:bg-signal-500/15'
        : 'text-ink hover:bg-surface-2 focus:bg-surface-2 dark:hover:bg-white/[0.06] dark:focus:bg-white/[0.06]',
      item.disabled && 'pointer-events-none opacity-50',
    )

  const renderItem = (item, index) => {
    if (item.divider) return <div key={`divider-${index}`} role="separator" className="my-1 h-px bg-line" />
    const isRadio = typeof item.checked === 'boolean'
    const content = (
      <>
        {renderIcon(item.icon, { className: cn('size-4 shrink-0', item.danger ? '' : 'text-ink-3') })}
        <span className="min-w-0 flex-1">
          <span className="block truncate">{item.label}</span>
          {item.description ? <span className="block text-xs text-ink-3">{item.description}</span> : null}
        </span>
        {isRadio && item.checked ? <Check aria-hidden className="size-4 shrink-0 text-primary-ink" /> : null}
      </>
    )
    const common = {
      role: isRadio ? 'menuitemradio' : 'menuitem',
      'aria-checked': isRadio ? item.checked : undefined,
      'aria-disabled': item.disabled || undefined,
      tabIndex: -1,
      className: itemClass(item),
    }
    const select = (event) => {
      if (item.disabled) return
      item.onClick?.(event)
      close(!item.to && !item.href)
    }
    if (item.to) {
      return (
        <Link key={item.label ?? index} to={item.to} onClick={select} {...common}>
          {content}
        </Link>
      )
    }
    if (item.href) {
      return (
        <a key={item.label ?? index} href={item.href} onClick={select} {...common}>
          {content}
        </a>
      )
    }
    return (
      <button key={item.label ?? index} type="button" onClick={select} {...common}>
        {content}
      </button>
    )
  }

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
                  ref={menuRef}
                  id={menuId}
                  role="menu"
                  aria-label={label}
                  onKeyDown={handleMenuKeyDown}
                  style={floatingStyle(position, {
                    maxHeight: position?.maxHeight,
                    transformOrigin: floatingOrigin(position?.side ?? side, align),
                  })}
                  initial={{ opacity: 0, scale: 0.95, ...floatingOffset(side, 6) }}
                  animate={{ opacity: 1, scale: 1, x: 0, y: 0, transition: { ...SPRING.pop, opacity: { duration: DURATION.fast, ease: EASE.standard } } }}
                  exit={{ opacity: 0, scale: 0.97, ...floatingOffset(side, 3), transition: { duration: 0.12, ease: EASE.exit } }}
                  className={cn(
                    'z-[60] min-w-52 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-line bg-elevated py-1 elev-floating scrollbar-thin',
                    menuClassName,
                  )}
                >
                  {header ? <div className="border-b border-line px-3 pb-2.5 pt-2">{header}</div> : null}
                  {header ? <div className="h-1" aria-hidden /> : null}
                  {items.filter((item) => item && !item.hidden).map(renderItem)}
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )
        : null}
    </>
  )
}

export default DropdownMenu
