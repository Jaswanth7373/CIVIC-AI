/**
 * Hooks shared by the admin insight pages.
 *
 * - useInsightFilters({ keys }) - the page's global filters, stored in the URL with exactly the parameter
 *   names of the complaint list (date_from, date_to, department, category, severity, status) through
 *   useComplaintFilters. A reload keeps the view, a link can be shared, and a number on a dashboard can open
 *   the matching complaint list. Returns `{filters, params, setFilters, reset, activeCount}`; `params` holds
 *   only the requested keys with a value, ready for analyticsService calls.
 * - useReferenceData() - departments and categories (public, non-paginated) for the filter selects and for
 *   naming category slugs.
 */
import { useCallback, useMemo } from 'react'
import { useComplaintFilters } from '@/components/complaints'
import { useApi } from '@/hooks/useApi'
import { categoryService } from '@/services/categoryService'
import { departmentService } from '@/services/departmentService'

const DEFAULT_KEYS = Object.freeze(['date_from', 'date_to', 'department', 'category'])

function hasValue(value) {
  return Array.isArray(value) ? value.length > 0 : value !== '' && value !== null && value !== undefined
}

export function useInsightFilters({ keys = DEFAULT_KEYS } = {}) {
  const { filters, setFilters } = useComplaintFilters()
  const keyList = keys.join(',')

  const params = useMemo(() => {
    const result = {}
    keyList.split(',').forEach((key) => {
      if (hasValue(filters[key])) result[key] = filters[key]
    })
    return result
  }, [filters, keyList])

  const activeCount = useMemo(() => {
    const names = keyList.split(',')
    const dates = names.some((key) => (key === 'date_from' || key === 'date_to') && hasValue(filters[key])) ? 1 : 0
    return names.filter((key) => key !== 'date_from' && key !== 'date_to' && hasValue(filters[key])).length + dates
  }, [filters, keyList])

  const reset = useCallback(() => {
    const cleared = {}
    keyList.split(',').forEach((key) => {
      cleared[key] = key === 'status' ? [] : ''
    })
    setFilters(cleared)
  }, [keyList, setFilters])

  return { filters, params, setFilters, reset, activeCount }
}

/** `{departments, categories}` for filter options (both lists are public and non-paginated). */
export function useReferenceData() {
  const { data, loading, error, refetch } = useApi(
    () =>
      Promise.all([departmentService.list(), categoryService.list()]).then(([departments, categories]) => ({
        departments: Array.isArray(departments) ? departments : [],
        categories: Array.isArray(categories) ? categories : [],
      })),
    [],
  )
  return {
    departments: data?.departments ?? [],
    categories: data?.categories ?? [],
    loading,
    error,
    refetch,
  }
}
