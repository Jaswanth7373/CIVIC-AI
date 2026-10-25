/**
 * Toast notifications.
 *
 * API (via `useToast()`): `toast.success(title, description?, options?)`, `toast.error`, `toast.info`,
 * `toast.warning`, `toast.show({tone, title, description, duration})` and `toast.dismiss(id)`. Each call
 * returns the toast id. Copy guideline: reuse the action verb ("Complaint accepted").
 *
 * Behaviour: at most 4 toasts are kept; they auto-dismiss after a tone-dependent duration (errors stay
 * longest). The stack is an `aria-live` region so screen readers announce new toasts; error toasts use
 * `role="alert"` to be announced immediately.
 *
 * Motion ("slide and stack"): a new toast slides in from the screen edge (bottom-right on larger screens, top
 * on phones) on a light spring. Older toasts tuck behind it as a shallow stack of cards, each a little
 * smaller, so the newest is always readable and the stack never covers the page. Pointing at the stack or
 * moving keyboard focus into it fans the cards out into a list; timers pause while it is open and while the
 * browser tab is hidden. A thin line along the front toast shows the time left. Toasts can be swiped away
 * sideways. Reduced motion: no sliding or scaling, only quick fades.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { DURATION, EASE, SPRING } from '@/components/motion/tokens'
import { ToastContext } from '@/context/contexts'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/utils/cn'

const MAX_VISIBLE = 4
const DEFAULT_DURATION = { success: 4000, info: 5000, warning: 6500, error: 8000 }
/** Space between toasts when the stack is open (px). */
const GAP = 10
/** How much of each older toast shows beyond the front one while collapsed (px), and how much smaller it is. */
const PEEK = 11
const DEPTH_SCALE = 0.05
/** Collapsed: at most this many cards are drawn (front + 2 behind). */
const DRAWN_LAYERS = 3
const FALLBACK_HEIGHT = 68
/** Swipe distance (px) or speed (px/s) that dismisses a toast. */
const SWIPE_DISTANCE = 90
const SWIPE_VELOCITY = 600

const TONES = {
  success: { icon: CircleCheck, accent: 'bg-sign-500', iconClass: 'text-sign-600 dark:text-sign-300', timer: 'bg-sign-500' },
  error: { icon: CircleX, accent: 'bg-signal-500', iconClass: 'text-signal-600 dark:text-signal-300', timer: 'bg-signal-500' },
  warning: { icon: TriangleAlert, accent: 'bg-marking-500', iconClass: 'text-marking-700 dark:text-marking-300', timer: 'bg-marking-500' },
  info: { icon: Info, accent: 'bg-guide-500', iconClass: 'text-guide-600 dark:text-guide-300', timer: 'bg-guide-500' },
}

let nextToastId = 0

/** True while the browser tab is visible (timers pause while the user is away). */
function usePageVisible() {
  return useSyncExternalStore(
    (onChange) => {
      document.addEventListener('visibilitychange', onChange)
      return () => document.removeEventListener('visibilitychange', onChange)
    },
    () => document.visibilityState !== 'hidden',
    () => true,
  )
}

function ToastItem({ toast, depth, offset, measuredHeight, frontHeight, expanded, paused, edge, reduced, onDismiss, onMeasure }) {
  const contentRef = useRef(null)
  const remainingRef = useRef(toast.duration)
  const tone = TONES[toast.tone] ?? TONES.info
  const Icon = tone.icon
  const front = depth === 0
  const fromBottom = edge === 'bottom'
  const direction = fromBottom ? -1 : 1

  // Report the toast's natural height (its content, not the clipped card) so the stack can lay itself out.
  useLayoutEffect(() => {
    const node = contentRef.current
    if (!node) return undefined
    const measure = () => {
      if (node.offsetHeight) onMeasure(toast.id, node.offsetHeight)
    }
    measure()
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [toast.id, onMeasure])

  // Auto-dismiss with a pausable countdown (the time already shown is kept across pauses).
  useEffect(() => {
    if (paused || !toast.duration) return undefined
    const startedAt = Date.now()
    const timer = window.setTimeout(() => onDismiss(toast.id), remainingRef.current)
    return () => {
      window.clearTimeout(timer)
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt))
    }
  }, [paused, toast.duration, toast.id, onDismiss])

  const height = expanded || front ? (measuredHeight ?? 'auto') : frontHeight
  const scale = expanded ? 1 : 1 - depth * DEPTH_SCALE
  const hidden = !expanded && depth >= DRAWN_LAYERS

  return (
    <motion.div
      role={toast.tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto absolute inset-x-0 touch-pan-y',
        fromBottom ? 'bottom-0 origin-bottom' : 'top-0 origin-top',
        // Fills the gap to the next card, so moving the pointer across the open stack never collapses it.
        fromBottom ? 'after:absolute after:inset-x-0 after:bottom-full after:h-3' : 'after:absolute after:inset-x-0 after:top-full after:h-3',
        hidden && 'pointer-events-none',
      )}
      style={{ zIndex: 100 - depth }}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: fromBottom ? 56 : -56, scale: 0.96 }}
      animate={{
        opacity: hidden ? 0 : 1,
        y: direction * offset,
        scale,
        transition: reduced
          ? { duration: DURATION.fast }
          : { ...SPRING.pop, opacity: { duration: DURATION.base, ease: EASE.standard } },
      }}
      exit={{
        opacity: 0,
        scale: reduced ? 1 : 0.94,
        transition: { duration: DURATION.fast, ease: EASE.exit },
      }}
      drag={reduced ? false : 'x'}
      dragSnapToOrigin
      dragElastic={0.6}
      onDragEnd={(_event, info) => {
        if (Math.abs(info.offset.x) > SWIPE_DISTANCE || Math.abs(info.velocity.x) > SWIPE_VELOCITY) onDismiss(toast.id)
      }}
    >
      <motion.div
        className="relative overflow-hidden rounded-xl border border-line bg-elevated elev-floating"
        initial={false}
        animate={{ height }}
        transition={reduced ? { duration: 0 } : { duration: DURATION.base, ease: EASE.standard }}
      >
        <motion.div
          ref={contentRef}
          className="flex w-full gap-3 py-3 pl-4 pr-2"
          initial={false}
          animate={{ opacity: expanded || front ? 1 : 0 }}
          transition={{ duration: DURATION.fast, ease: EASE.standard }}
        >
          <span aria-hidden className={cn('absolute inset-y-0 left-0 w-1', tone.accent)} />
          <Icon aria-hidden className={cn('mt-0.5 size-5 shrink-0', tone.iconClass)} />
          <div className="min-w-0 flex-1 py-0.5">
            <p className="text-sm font-semibold text-ink">{toast.title}</p>
            {toast.description ? <p className="mt-0.5 text-sm text-ink-2">{toast.description}</p> : null}
          </div>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="pressable grid size-8 shrink-0 place-items-center rounded-md text-ink-3 [--press-scale:0.9] hover:bg-sunken hover:text-ink pointer-coarse:size-11"
            aria-label="Dismiss notification"
          >
            <X aria-hidden className="size-4" />
          </button>
        </motion.div>
        {toast.duration ? (
          <span
            aria-hidden
            data-paused={paused || undefined}
            style={{ '--toast-duration': `${toast.duration}ms` }}
            className={cn('toast-timer absolute inset-x-0 bottom-0 h-0.5 opacity-50', tone.timer, !front && 'invisible')}
          />
        ) : null}
      </motion.div>
    </motion.div>
  )
}

function ToastViewport({ toasts, onDismiss }) {
  const reduced = usePrefersReducedMotion()
  const roomy = useMediaQuery(BREAKPOINTS.sm)
  const pageVisible = usePageVisible()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [heights, setHeights] = useState({})
  const edge = roomy ? 'bottom' : 'top'
  const expanded = (hovered || focused) && toasts.length > 1
  const paused = hovered || focused || !pageVisible

  const measure = useCallback((id, height) => {
    setHeights((current) => (current[id] === height ? current : { ...current, [id]: height }))
  }, [])

  // An empty stack is never "open" (the pointer may have rested where the last toast was), and a toast that
  // held keyboard focus may have just been removed without a blur event.
  const viewportRef = useRef(null)
  useEffect(() => {
    if (!toasts.length) {
      setHovered(false)
      setFocused(false)
    } else if (!viewportRef.current?.contains(document.activeElement)) {
      setFocused(false)
    }
  }, [toasts])

  if (typeof document === 'undefined') return null

  // Lay the stack out from the front (newest) toast backwards.
  const frontIndex = toasts.length - 1
  const heightOf = (toast) => heights[toast.id] ?? FALLBACK_HEIGHT
  const frontHeight = toasts.length ? heightOf(toasts[frontIndex]) : FALLBACK_HEIGHT
  const placement = new Map()
  let stacked = 0
  for (let depth = 0; depth <= frontIndex; depth += 1) {
    const toast = toasts[frontIndex - depth]
    placement.set(toast.id, { depth, offset: expanded ? stacked : depth * PEEK })
    stacked += heightOf(toast) + GAP
  }

  return createPortal(
    <div
      ref={viewportRef}
      aria-live="polite"
      aria-relevant="additions"
      onPointerEnter={(event) => event.pointerType !== 'touch' && setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      // Keyboard focus opens the stack; a mouse click on "Dismiss" does not (the toast it was on disappears).
      onFocus={(event) => event.target.matches?.(':focus-visible') && setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false)
      }}
      className={cn(
        'pointer-events-none fixed z-[100] h-0 w-[min(24rem,calc(100vw-1.5rem))]',
        roomy ? 'bottom-5 right-5' : 'inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] mx-auto',
      )}
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const { depth, offset } = placement.get(toast.id)
          return (
            <ToastItem
              key={toast.id}
              toast={toast}
              depth={depth}
              offset={offset}
              measuredHeight={heights[toast.id]}
              frontHeight={frontHeight}
              expanded={expanded}
              paused={paused}
              edge={edge}
              reduced={reduced}
              onDismiss={onDismiss}
              onMeasure={measure}
            />
          )
        })}
      </AnimatePresence>
    </div>,
    document.body,
  )
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((toast) => toast.id !== id))
  }, [])

  const show = useCallback(({ tone = 'info', title, description, duration } = {}) => {
    nextToastId += 1
    const id = nextToastId
    const toast = {
      id,
      tone: TONES[tone] ? tone : 'info',
      title: title ?? '',
      description: description ?? '',
      duration: duration ?? DEFAULT_DURATION[tone] ?? DEFAULT_DURATION.info,
    }
    setToasts((list) => [...list, toast].slice(-MAX_VISIBLE))
    return id
  }, [])

  const api = useMemo(() => {
    const byTone = (tone) => (title, description, options) => show({ ...options, tone, title, description })
    const value = {
      show,
      dismiss,
      success: byTone('success'),
      error: byTone('error'),
      warning: byTone('warning'),
      info: byTone('info'),
    }
    // Supports both `const toast = useToast()` and `const { toast } = useToast()`.
    value.toast = value
    return value
  }, [show, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  )
}

export default ToastProvider
