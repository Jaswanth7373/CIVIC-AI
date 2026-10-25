/**
 * useComplaintFilters - complaint list filters stored in the URL search params.
 *
 *   const list = useComplaintFilters({ defaults: { ordering: '-priority_score' } })
 *   const { data, loading } = useApi(() => complaintService.list(list.params), [list.params])
 *   <ComplaintFilters {...list.bind} categories={categories} departments={departments} />
 *   <Pagination page={list.page} onPageChange={list.setPage} ... />
 *
 * Returns:
 * - filters: the current filters `{search, status: [], category, severity, priority_level, department,
 *   assigned_officer, citizen, date_from, date_to, ordering, is_overdue, has_duplicates, needs_review}` (stable
 *   object identity while the URL does not change, so it is safe in effect / useApi dependency lists)
 * - setFilters(next | updater): writes the filters to the URL and resets to page 1 (history `replace`, so
 *   typing in the search box does not flood the back button). A partial object is merged onto the
 *   current filters: `setFilters({ status: ['assigned'] })` keeps every other filter.
 * - resetFilters(): back to the defaults
 * - page / setPage(n): the `page` param (setPage pushes a history entry, so Back returns to the previous page)
 * - params: `{...filters without empty values, page, page_size?}` ready for complaintService.list()
 * - activeCount: number of active filters (search and ordering excluded)
 * - bind: `{value, onChange, defaults}` to spread onto <ComplaintFilters>
 *
 * Options: `defaults` (filter values used when the URL has none), `pageSize` (adds `page_size` to params).
 *
 * Writes start from the LATEST URL, not from the params of the last render: react-router applies navigations in
 * a transition, so a second change made before the list re-renders (two quick selects, a select and then
 * setPage) would otherwise start from the old params and undo the first change.
 */
import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { countActiveFilters, filtersToSearchParams, normalizeFilters, parseFilters, toApiParams } from './filterParams'

/** The search params of the current history entry (the browser router keeps window.location up to date). */
function latestSearchParams(rendered) {
  return typeof window === 'undefined' ? new URLSearchParams(rendered) : new URLSearchParams(window.location.search)
}

export function useComplaintFilters({ defaults, pageSize } = {}) {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryKey = searchParams.toString()
  const defaultsKey = JSON.stringify(defaults ?? {})

  const stableDefaults = useMemo(() => JSON.parse(defaultsKey), [defaultsKey])
  const filters = useMemo(
    () => parseFilters(new URLSearchParams(queryKey), stableDefaults),
    [queryKey, stableDefaults],
  )
  const page = Math.max(1, Number.parseInt(new URLSearchParams(queryKey).get('page') ?? '', 10) || 1)

  const setFilters = useCallback(
    (next) => {
      setSearchParams(
        (rendered) => {
          const current = latestSearchParams(rendered)
          const previous = parseFilters(current, stableDefaults)
          const value = typeof next === 'function' ? next(previous) : { ...previous, ...next }
          return filtersToSearchParams(normalizeFilters(value, {}), current, stableDefaults)
        },
        { replace: true },
      )
    },
    [setSearchParams, stableDefaults],
  )

  const resetFilters = useCallback(() => setFilters(normalizeFilters({}, stableDefaults)), [setFilters, stableDefaults])

  const setPage = useCallback(
    (nextPage) => {
      setSearchParams((rendered) => {
        const next = latestSearchParams(rendered)
        const number = Math.max(1, Number(nextPage) || 1)
        if (number > 1) next.set('page', String(number))
        else next.delete('page')
        return next
      })
    },
    [setSearchParams],
  )

  const params = useMemo(() => {
    const result = { ...toApiParams(filters), page }
    if (pageSize) result.page_size = pageSize
    return result
  }, [filters, page, pageSize])

  const activeCount = useMemo(() => countActiveFilters(filters, stableDefaults), [filters, stableDefaults])

  const bind = useMemo(() => ({ value: filters, onChange: setFilters, defaults: stableDefaults }), [filters, setFilters, stableDefaults])

  return { filters, setFilters, resetFilters, page, setPage, params, activeCount, bind }
}

export default useComplaintFilters
