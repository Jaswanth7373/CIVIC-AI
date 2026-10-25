/**
 * useLeaveGuard - warn before unsaved input is lost.
 *
 * Two exits are covered while `when` is true:
 * - in-app navigation (sidebar, tab bar, back button): react-router's `useBlocker` (data routers) holds the
 *   navigation and the shared ConfirmDialog asks "Leave this page?"; confirming lets it through, cancelling
 *   keeps the person on the page. Navigations that stay on the same path (e.g. ?query changes) pass freely.
 * - closing or reloading the tab: the browser's own `beforeunload` prompt (browsers show their fixed text).
 *
 * @param {boolean} when
 * @param {{title?: string, message?: string, confirmLabel?: string, cancelLabel?: string}} [copy]
 */
import { useCallback, useEffect, useRef } from 'react'
import { useBlocker } from 'react-router-dom'
import { useConfirm } from '@/hooks/useConfirm'

export function useLeaveGuard(when, copy = {}) {
  const confirm = useConfirm()
  const copyRef = useRef(copy)
  useEffect(() => {
    copyRef.current = copy
  })

  const shouldBlock = useCallback(
    ({ currentLocation, nextLocation }) => when && currentLocation.pathname !== nextLocation.pathname,
    [when],
  )
  const blocker = useBlocker(shouldBlock)
  const blockerRef = useRef(blocker)
  useEffect(() => {
    blockerRef.current = blocker
  })

  useEffect(() => {
    if (blocker.state !== 'blocked') return undefined
    let active = true
    const text = copyRef.current
    confirm({
      title: text.title ?? 'Leave this page?',
      message: text.message ?? 'Your changes have not been saved and will be lost.',
      confirmLabel: text.confirmLabel ?? 'Leave page',
      cancelLabel: text.cancelLabel ?? 'Stay on page',
      tone: 'warning',
    }).then((ok) => {
      const current = blockerRef.current
      if (!active || current.state !== 'blocked') return
      if (ok) current.proceed()
      else current.reset()
    })
    return () => {
      active = false
    }
  }, [blocker.state, confirm])

  useEffect(() => {
    if (!when) return undefined
    const handleBeforeUnload = (event) => {
      event.preventDefault()
      // Older browsers need returnValue set to show their (fixed) confirmation text.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [when])
}

export default useLeaveGuard
