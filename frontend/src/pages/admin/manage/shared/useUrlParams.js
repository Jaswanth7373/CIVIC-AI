/**
 * useUrlParams - list-screen state (filters, tab, page) kept in the URL search params.
 *
 *   const { values, setValues, page, setPage, reset } = useUrlParams({ role: '', is_active: '', search: '' })
 *
 * Why the URL: a filtered user list or an audit-log query survives a reload, can be bookmarked or shared with
 * another administrator, and the browser back button restores the previous view.
 *
 * - `values`: every key of `defaults`, read from the URL (missing keys take their default). Stable identity
 *   while the URL does not change, so it is safe in `useApi` dependency lists.
 * - `setValues(patch, { keepPage })`: merges `patch` into the URL; a value equal to its default is removed so
 *   links stay short. A filter change goes back to page 1 unless `keepPage` (history `replace`, so typing in a
 *   search box does not flood the back button).
 * - `page` / `setPage(n)`: the `page` param (pushes a history entry, so Back returns to the previous page).
 * - `reset()`: removes every key of `defaults` and the page.
 * Params that are not in `defaults` (another component's state) are never touched.
 */
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

export function useUrlParams(defaults = {}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const query = searchParams.toString()
  const defaultsKey = JSON.stringify(defaults)

  const values = useMemo(() => {
    const params = new URLSearchParams(query)
    const fallback = JSON.parse(defaultsKey)
    return Object.fromEntries(
      Object.keys(fallback).map((key) => [key, params.has(key) ? (params.get(key) ?? '') : String(fallback[key] ?? '')]),
    )
  }, [query, defaultsKey])

  const page = Math.max(1, Number.parseInt(new URLSearchParams(query).get('page') ?? '', 10) || 1)

  const setValues = useCallback(
    (patch, { keepPage = false } = {}) => {
      const fallback = JSON.parse(defaultsKey)
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          Object.entries(patch ?? {}).forEach(([key, value]) => {
            const text = value == null ? '' : String(value)
            if (text === String(fallback[key] ?? '')) next.delete(key)
            else next.set(key, text)
          })
          if (!keepPage) next.delete('page')
          return next
        },
        { replace: true },
      )
    },
    [defaultsKey, setSearchParams],
  )

  const setPage = useCallback(
    (number) => {
      setSearchParams((current) => {
        const next = new URLSearchParams(current)
        const value = Math.max(1, Number(number) || 1)
        if (value > 1) next.set('page', String(value))
        else next.delete('page')
        return next
      })
    },
    [setSearchParams],
  )

  const reset = useCallback(() => {
    const fallback = JSON.parse(defaultsKey)
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        Object.keys(fallback).forEach((key) => next.delete(key))
        next.delete('page')
        return next
      },
      { replace: true },
    )
  }, [defaultsKey, setSearchParams])

  return { values, setValues, page, setPage, reset }
}

export default useUrlParams
