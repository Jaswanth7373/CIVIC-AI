/**
 * Shared behaviour for floating layers (Modal, Drawer, DropdownMenu, Popover).
 *
 * Layer stack: every open layer registers here; ONE document-level keydown listener sends Escape to the
 * top-most layer only, so pressing Esc in a menu opened inside a modal closes the menu, not the modal.
 *
 * Modal layers (`useModalLayer`) additionally:
 * - trap focus: Tab / Shift+Tab cycle through the focusable elements inside the dialog;
 * - move focus into the dialog on open and give it back to the previously focused element on close;
 * - lock page scrolling (with scrollbar-width compensation so the page does not jump);
 * - mark the app root `inert`, so the page behind the dialog cannot be clicked, focused or read by a screen
 *   reader. Dialogs, menus and toasts are portalled to <body>, outside #root, so they stay interactive.
 */
import { useEffect, useRef } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Visible, focusable descendants of `container`, in DOM order. */
export function getFocusableElements(container) {
  if (!container) return []
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.closest('[inert]') && element.getClientRects().length > 0,
  )
}

/* ---- layer stack --------------------------------------------------------------------------------------- */
const layers = []

function trapTab(event, container) {
  const focusable = getFocusableElements(container)
  if (!focusable.length) {
    event.preventDefault()
    container.focus({ preventScroll: true })
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement
  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (active === last || !container.contains(active))) {
    event.preventDefault()
    first.focus()
  }
}

function handleKeyDown(event) {
  const top = layers[layers.length - 1]
  if (!top) return
  if (event.key === 'Escape' && top.onEscape) {
    event.preventDefault()
    top.onEscape(event)
  } else if (event.key === 'Tab' && top.trapRef?.current) {
    trapTab(event, top.trapRef.current)
  }
}

/** True while any floating layer (dialog, drawer, menu, popover) is open. */
export function hasOpenLayers() {
  return layers.length > 0
}

/** Register a layer `{ onEscape, trapRef }`; returns the unregister function. */
export function pushLayer(layer) {
  if (!layers.length) document.addEventListener('keydown', handleKeyDown)
  layers.push(layer)
  return () => {
    const index = layers.indexOf(layer)
    if (index !== -1) layers.splice(index, 1)
    if (!layers.length) document.removeEventListener('keydown', handleKeyDown)
  }
}

/* ---- scroll lock + inert app root ------------------------------------------------------------------------ */
let modalCount = 0
let savedBodyStyle = null

function acquireModal() {
  modalCount += 1
  if (modalCount > 1) return
  const { body, documentElement } = document
  const scrollbarWidth = window.innerWidth - documentElement.clientWidth
  savedBodyStyle = { overflow: body.style.overflow, paddingRight: body.style.paddingRight }
  body.style.overflow = 'hidden'
  if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`
  document.getElementById('root')?.setAttribute('inert', '')
}

function releaseModal() {
  modalCount = Math.max(0, modalCount - 1)
  if (modalCount > 0) return
  if (savedBodyStyle) {
    document.body.style.overflow = savedBodyStyle.overflow
    document.body.style.paddingRight = savedBodyStyle.paddingRight
    savedBodyStyle = null
  }
  document.getElementById('root')?.removeAttribute('inert')
}

/* ---- hooks -------------------------------------------------------------------------------------------- */

/** Keep the latest value of a callback in a ref (so effects do not re-run when an inline handler changes). */
function useLatest(value) {
  const ref = useRef(value)
  useEffect(() => {
    ref.current = value
  })
  return ref
}

/**
 * Dialog behaviour for Modal and Drawer: layer registration (Esc -> onClose), focus trap, initial focus,
 * focus restore, scroll lock and inert background while `open`.
 */
export function useModalLayer({ open, onClose, containerRef, initialFocusRef }) {
  const onCloseRef = useLatest(onClose)

  useEffect(() => {
    if (!open) return undefined
    const previouslyFocused = document.activeElement
    acquireModal()
    const removeLayer = pushLayer({
      onEscape: () => onCloseRef.current?.(),
      trapRef: containerRef,
    })
    const frame = window.requestAnimationFrame(() => {
      const container = containerRef.current
      if (!container || container.contains(document.activeElement)) return
      const target = initialFocusRef?.current ?? getFocusableElements(container)[0] ?? container
      target.focus({ preventScroll: true })
    })
    return () => {
      window.cancelAnimationFrame(frame)
      removeLayer()
      releaseModal()
      if (previouslyFocused instanceof HTMLElement && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true })
      }
    }
  }, [open, containerRef, initialFocusRef, onCloseRef])
}

/**
 * Light-dismiss behaviour for menus and popovers: pointer-down outside every element in `refs` calls
 * `onDismiss`; Escape (when this is the top layer) calls `onEscape`.
 */
export function useDismissableLayer({ open, refs, onDismiss, onEscape }) {
  const refsRef = useLatest(refs)
  const onDismissRef = useLatest(onDismiss)
  const onEscapeRef = useLatest(onEscape)

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event) => {
      const inside = refsRef.current.some((ref) => ref.current?.contains(event.target))
      if (!inside) onDismissRef.current?.(event)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    const removeLayer = pushLayer({ onEscape: (event) => onEscapeRef.current?.(event) })
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      removeLayer()
    }
  }, [open, refsRef, onDismissRef, onEscapeRef])
}
