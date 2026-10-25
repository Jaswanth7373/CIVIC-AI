/**
 * Unread notification count + recent notifications for the bell.
 *
 * Technique: lightweight polling. While a user is logged in, GET /notifications/unread-count/ runs every
 * 30 seconds and whenever the window regains focus or the tab becomes visible again (hidden tabs skip the
 * interval to save requests). When the count changes, the 5 most recent notifications are re-fetched so the
 * bell dropdown is current. `markRead` / `markAllRead` update the local state optimistically and re-sync with
 * the server if the API call fails.
 *
 * State is keyed by user id, so switching accounts never shows the previous user's notifications.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NotificationContext } from '@/context/contexts'
import { useAuth } from '@/hooks/useAuth'
import { notificationService } from '@/services/notificationService'

const POLL_INTERVAL_MS = 30_000
const RECENT_LIMIT = 5
const EMPTY = { userId: null, count: 0, recent: [], recentLoaded: false }

export function NotificationProvider({ children }) {
  const { user, isAuthenticated } = useAuth()
  const userId = isAuthenticated ? (user?.id ?? null) : null
  const [state, setState] = useState(EMPTY)
  const [loadingRecent, setLoadingRecent] = useState(false)

  // Refs give event handlers and async callbacks the latest values without re-creating them.
  const userIdRef = useRef(userId)
  const stateRef = useRef(state)
  const lastCountRef = useRef({ userId: null, count: null })

  useEffect(() => {
    userIdRef.current = userId
  }, [userId])

  useEffect(() => {
    stateRef.current = state
  }, [state])

  /** Apply `update(prevForUser)` only while `forUser` is still the logged-in user. */
  const updateFor = useCallback((forUser, update) => {
    setState((prev) => {
      if (userIdRef.current !== forUser) return prev
      const base = prev.userId === forUser ? prev : { ...EMPTY, userId: forUser }
      return update(base)
    })
  }, [])

  const loadRecent = useCallback(async () => {
    const forUser = userIdRef.current
    if (forUser == null) return []
    setLoadingRecent(true)
    try {
      const data = await notificationService.list({ page_size: RECENT_LIMIT })
      const recent = (Array.isArray(data) ? data : (data?.results ?? [])).slice(0, RECENT_LIMIT)
      updateFor(forUser, (base) => ({ ...base, recent, recentLoaded: true }))
      return recent
    } catch {
      return []
    } finally {
      setLoadingRecent(false)
    }
  }, [updateFor])

  /** Poll the unread count; re-fetch the recent list when it changed. Resolves to the count (or null on error). */
  const refresh = useCallback(async () => {
    const forUser = userIdRef.current
    if (forUser == null) return 0
    try {
      const data = await notificationService.unreadCount()
      const count = Number(data?.count) || 0
      const last = lastCountRef.current
      const changed = last.userId !== forUser || last.count !== count
      lastCountRef.current = { userId: forUser, count }
      updateFor(forUser, (base) => ({ ...base, count }))
      if (changed || !stateRef.current.recentLoaded) loadRecent()
      return count
    } catch {
      // Keep the last known count; the next poll tries again.
      return null
    }
  }, [loadRecent, updateFor])

  useEffect(() => {
    if (userId == null) return undefined
    refresh()
    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh()
    }, POLL_INTERVAL_MS)
    const handleFocus = () => refresh()
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [userId, refresh])

  /** Mark one notification read -> the updated Notification (rejects with the API error). */
  const markRead = useCallback(
    async (id) => {
      const forUser = userIdRef.current
      const known = stateRef.current.userId === forUser ? stateRef.current.recent.find((item) => item.id === id) : null
      const wasUnread = Boolean(known && !known.is_read)
      const now = new Date().toISOString()
      updateFor(forUser, (base) => ({
        ...base,
        count: wasUnread ? Math.max(0, base.count - 1) : base.count,
        recent: base.recent.map((item) => (item.id === id ? { ...item, is_read: true, read_at: item.read_at ?? now } : item)),
      }))
      try {
        const updated = await notificationService.markRead(id)
        updateFor(forUser, (base) => ({
          ...base,
          recent: base.recent.map((item) => (item.id === id ? { ...item, ...updated } : item)),
        }))
        // Not in the recent list (e.g. marked from the notifications page): ask the server for the new count.
        if (!known) refresh()
        return updated
      } catch (error) {
        refresh()
        throw error
      }
    },
    [refresh, updateFor],
  )

  /** Mark everything read -> `{updated: n}` (rejects with the API error after restoring the previous state). */
  const markAllRead = useCallback(async () => {
    const forUser = userIdRef.current
    const snapshot = stateRef.current.userId === forUser ? stateRef.current : null
    const now = new Date().toISOString()
    updateFor(forUser, (base) => ({
      ...base,
      count: 0,
      recent: base.recent.map((item) => ({ ...item, is_read: true, read_at: item.read_at ?? now })),
    }))
    try {
      const result = await notificationService.markAllRead()
      lastCountRef.current = { userId: forUser, count: 0 }
      return result
    } catch (error) {
      if (snapshot) updateFor(forUser, () => snapshot)
      throw error
    }
  }, [updateFor])

  /** Delete a notification and drop it from the recent list. */
  const remove = useCallback(
    async (id) => {
      const forUser = userIdRef.current
      await notificationService.remove(id)
      updateFor(forUser, (base) => ({ ...base, recent: base.recent.filter((item) => item.id !== id) }))
      refresh()
    },
    [refresh, updateFor],
  )

  // Values that belong to another (or no) user are never exposed.
  const current = state.userId === userId && userId != null ? state : EMPTY

  const value = useMemo(
    () => ({
      unreadCount: current.count,
      recent: current.recent,
      recentLoaded: current.recentLoaded,
      loadingRecent,
      refresh,
      loadRecent,
      markRead,
      markAllRead,
      remove,
    }),
    [current.count, current.recent, current.recentLoaded, loadingRecent, refresh, loadRecent, markRead, markAllRead, remove],
  )

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
}

export default NotificationProvider
