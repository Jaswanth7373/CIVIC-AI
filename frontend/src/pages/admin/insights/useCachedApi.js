/**
 * Stale-while-revalidate for the insight pages, and a once-per-session intro flag.
 *
 * - useCachedApi(name, fetcher, deps): `useApi` plus a module-level cache of the last response of each
 *   request (`name` + `deps`, compared by value, per signed-in user). A page that mounts again - the operator
 *   comes back to the dashboard from a complaint - paints the last numbers at once and refreshes them in the
 *   background: while cached data is on screen `loading` stays false (no skeleton, no dimming) and
 *   `refreshing` reports the request. Switching back to a filter seen before is instant too. Optimistic
 *   `setData` updates reach the cache as well. The cache lives as long as the tab's JavaScript does (a reload
 *   starts empty, so tests and first visits always fetch) and is capped at MAX_ENTRIES responses.
 * - useSessionIntro(key): true on the first visit of the browser session (sessionStorage), so entrances (the
 *   scan band, count-ups, panel rises, chart draws) play once per session, not on every return to the page.
 *   Without storage (private mode) it answers false: the page simply shows its final state.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'

const MAX_ENTRIES = 48
const cache = new Map()

function remember(key, data) {
  if (data === undefined) return
  cache.delete(key) // re-insert: Map order doubles as least-recently-stored order
  cache.set(key, data)
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value)
}

export function useCachedApi(name, fetcher, deps = []) {
  const { user } = useAuth()
  const key = `${user?.id ?? 'guest'}|${name}|${JSON.stringify(deps)}`
  const keyRef = useRef(key)
  const fetcherRef = useRef(fetcher)
  // Latest key and fetcher for the request and the optimistic updates (before useApi's effect runs).
  useLayoutEffect(() => {
    keyRef.current = key
    fetcherRef.current = fetcher
  })

  // The request (re)runs for each key: the caller's deps compared by value, and the signed-in user.
  const api = useApi(() => fetcherRef.current(key), [key], {
    initialData: cache.has(key) ? cache.get(key) : null,
    onSuccess: (data) => remember(key, data),
  })
  const { setData: setApiData } = api

  const setData = useCallback(
    (valueOrUpdater) =>
      setApiData((current) => {
        const next = typeof valueOrUpdater === 'function' ? valueOrUpdater(current) : valueOrUpdater
        remember(keyRef.current, next)
        return next
      }),
    [setApiData],
  )

  const cached = cache.has(key)
  return {
    ...api,
    // The cache always holds the newest response for this key (onSuccess / setData write it before the
    // re-render), so it is the right thing to show while the request for this key is still running.
    data: cached ? cache.get(key) : api.data,
    loading: api.loading && !cached,
    refreshing: api.loading,
    setData,
  }
}

const INTRO_PREFIX = 'civicai.intro.'

export function useSessionIntro(key) {
  const storageKey = `${INTRO_PREFIX}${key}`
  // The initializer only reads (StrictMode may run it twice); the flag is written after the first render.
  const [first] = useState(() => {
    try {
      return !window.sessionStorage.getItem(storageKey)
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      window.sessionStorage.setItem(storageKey, '1')
    } catch {
      // Storage unavailable: nothing to remember (and the initializer above already skipped the intro).
    }
  }, [storageKey])
  return first
}
