import { cloneElement, isValidElement, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/utils/cn'
import { floatingOrigin, floatingStyle, useAnchoredPosition } from './floating'

/* Entrance from the side the tooltip appears on (CSS @starting-style, so no JavaScript animation runs). */
const ENTER_FROM = {
  top: 'starting:translate-y-1',
  bottom: 'starting:-translate-y-1',
  left: 'starting:translate-x-1',
  right: 'starting:-translate-x-1',
}

/**
 * Short explanation shown on hover (mouse / pen) and keyboard focus; Esc hides it.
 * Accessibility: the text is always present in a visually hidden element referenced by the child's
 * `aria-describedby`, so screen readers announce it on focus without waiting for the visual tooltip
 * (which is aria-hidden to avoid double reading). Touch users get it by focusing (tapping) the control.
 * Motion: it springs out of its anchor (scale + a 4px slide from that side); still with reduced motion.
 *
 * @param {object} props
 * @param {import('react').ReactNode} props.content tooltip text
 * @param {import('react').ReactElement} props.children the trigger (should be focusable, e.g. a button)
 * @param {'top'|'bottom'|'left'|'right'} [props.side='top']
 * @param {number} [props.delay=250] ms before showing on hover
 */
export function Tooltip({ content, children, side = 'top', delay = 250, disabled = false, className }) {
  const [open, setOpen] = useState(false)
  const anchorRef = useRef(null)
  const tipRef = useRef(null)
  const timerRef = useRef(0)
  const descriptionId = useId()
  const position = useAnchoredPosition(open, anchorRef, tipRef, { placement: side, offset: 8 })

  useEffect(() => () => window.clearTimeout(timerRef.current), [])

  useEffect(() => {
    if (!open) return undefined
    const handleKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [open])

  if (!content || disabled) return children

  const show = (immediate = false) => {
    window.clearTimeout(timerRef.current)
    if (immediate) setOpen(true)
    else timerRef.current = window.setTimeout(() => setOpen(true), delay)
  }
  const hide = () => {
    window.clearTimeout(timerRef.current)
    setOpen(false)
  }

  const child = isValidElement(children)
    ? cloneElement(children, {
        'aria-describedby': [children.props['aria-describedby'], descriptionId].filter(Boolean).join(' '),
      })
    : children

  return (
    <span
      ref={anchorRef}
      className={cn('inline-flex max-w-full', className)}
      onPointerEnter={(event) => event.pointerType !== 'touch' && show()}
      onPointerLeave={hide}
      onFocus={() => show(true)}
      onBlur={hide}
    >
      {child}
      <span id={descriptionId} className="sr-only">
        {content}
      </span>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={tipRef}
              aria-hidden
              style={floatingStyle(position, { transformOrigin: floatingOrigin(position?.side ?? side, 'center') })}
              className={cn(
                'pointer-events-none z-[70] max-w-xs rounded-lg bg-asphalt-900 px-2.5 py-1.5 text-xs font-medium leading-snug text-asphalt-50 elev-floating dark:bg-asphalt-700',
                'transition-[opacity,scale,translate] duration-200 ease-spring starting:scale-90 starting:opacity-0',
                ENTER_FROM[position?.side ?? side] ?? ENTER_FROM.top,
              )}
            >
              {content}
            </div>,
            document.body,
          )
        : null}
    </span>
  )
}

export default Tooltip
