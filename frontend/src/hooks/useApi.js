/**
 * Data fetching hook for service calls.
 *
 *   const { data, loading, error, refetch, setData } =
 *     useApi(() => complaintService.list({ page, status }), [page, status])
 *
 * - Runs `fetcher` on mount and whenever `deps` change (unless `{ immediate: false }`; then call `refetch()`).
 * - `deps` are compared by VALUE (a stable JSON key), so passing a filters object that is re-created on every
 *   render does not cause an endless request loop.
 * - Race-safe: every run gets an id and only the latest response is applied, so a slow earlier request can
 *   never overwrite newer data. Responses arriving after unmount are ignored.
 * - On error the previous data is kept (the UI can show it with an error banner) and `error` is set.
 * - `refetch(...args)` re-runs the fetcher (args are passed through) and resolves to the data, or to
 *   `undefined` when it failed (the error is in `error`), so it is safe to call from event handlers.
 * - `setData(valueOrUpdater)` allows optimistic updates after a mutation.
 *
 * Options: `immediate` (default true), `initialData` (default null), `onSuccess(data)`, `onError(error)`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isCancelError } from '@/utils/errors'

/**
 * Stable key for a deps array, compared by value: Dates serialise to ISO strings, Files to
 * name/size/lastModified, BigInts to strings, functions are ignored and repeated (circular) references are
 * replaced by a marker, so serialisation cannot throw.
 */
function depsKey(deps) {
  const seen = new WeakSet()
  return JSON.stringify(deps ?? [], (_key, value) => {
    if (typeof value === 'function') return undefined
    if (typeof value === 'bigint') return value.toString()
    if (typeof File !== 'undefined' && value instanceof File) {
      return `file:${value.name}:${value.size}:${value.lastModified}`
    }
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[circular]'
      seen.add(value)
    }
    return value
  })
}

export function useApi(fetcher, deps = [], options = {}) {
  const { immediate = true, initialData = null, onSuccess, onError } = options
  const [state, setState] = useState({ data: initialData, loading: Boolean(immediate), error: null })

  const fetcherRef = useRef(fetcher)
  const callbacksRef = useRef({ onSuccess, onError })
  const requestIdRef = useRef(0)
  const mountedRef = useRef(false)

  useLayoutEffect(() => {
    fetcherRef.current = fetcher
    callbacksRef.current = { onSuccess, onError }
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const run = useCallback(async (...args) => {
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    setState((current) => ({ ...current, loading: true, error: null }))
    try {
      const data = await fetcherRef.current(...args)
      if (mountedRef.current && requestId === requestIdRef.current) {
        setState({ data, loading: false, error: null })
        callbacksRef.current.onSuccess?.(data)
      }
      return data
    } catch (error) {
      if (mountedRef.current && requestId === requestIdRef.current) {
        if (isCancelError(error)) {
          setState((current) => ({ ...current, loading: false }))
        } else {
          setState((current) => ({ ...current, loading: false, error }))
          callbacksRef.current.onError?.(error)
        }
      }
      return undefined
    }
  }, [])

  const key = depsKey(deps)

  useEffect(() => {
    if (immediate) run()
  }, [key, immediate, run])

  const setData = useCallback((valueOrUpdater) => {
    setState((current) => ({
      ...current,
      data: typeof valueOrUpdater === 'function' ? valueOrUpdater(current.data) : valueOrUpdater,
    }))
  }, [])

  return { data: state.data, loading: state.loading, error: state.error, refetch: run, setData }
}

export default useApi
