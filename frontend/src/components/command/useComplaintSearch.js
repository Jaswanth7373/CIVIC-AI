/**
 * Live complaint search for the command palette, through the existing complaints list service
 * (`GET /complaints/?search=` - number, title, description, address and area; scoped by the server to what the
 * signed-in user may see: a citizen's own complaints, an officer's assigned ones, everything for admins).
 *
 * - Searches once `term` has at least MIN_LENGTH characters (pass an already debounced term).
 * - Each new term aborts the previous request, so a slow answer can never overwrite a newer one.
 * - While a new term loads, the previous results stay available (`results`), flagged by `status: 'loading'`;
 *   `resultsTerm` names the term they answer, so the palette can show them as stale (dimmed, not selectable)
 *   instead of passing them off as matches for what is typed now.
 *
 * @param {string} term
 * @returns {{status: 'idle'|'loading'|'done'|'error', term: string, resultsTerm: string, results: object[],
 *   count: number, retry: () => void}}
 */
import { useCallback, useEffect, useState } from 'react'
import { complaintService } from '@/services/complaintService'
import { isCancelError } from '@/utils/errors'

export const MIN_LENGTH = 2
const PAGE_SIZE = 6

const IDLE = Object.freeze({ status: 'idle', term: '', resultsTerm: '', results: [], count: 0 })

export function useComplaintSearch(term) {
  const query = term.trim()
  const enabled = query.length >= MIN_LENGTH
  const [state, setState] = useState(IDLE)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) return undefined
    const controller = new AbortController()
    setState((previous) => ({ ...previous, status: 'loading', term: query }))
    complaintService
      .list({ search: query, page_size: PAGE_SIZE }, { signal: controller.signal })
      .then((data) => {
        const rows = Array.isArray(data) ? data : (data?.results ?? [])
        setState({
          status: 'done',
          term: query,
          resultsTerm: query,
          results: rows.slice(0, PAGE_SIZE),
          count: Number(data?.count ?? rows.length),
        })
      })
      .catch((error) => {
        if (controller.signal.aborted || isCancelError(error)) return
        setState({ status: 'error', term: query, resultsTerm: query, results: [], count: 0 })
      })
    return () => controller.abort()
  }, [query, enabled, attempt])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])

  if (!enabled) return { ...IDLE, retry }
  // A term typed but not requested yet (the effect runs after this render): it is loading.
  if (state.term !== query) return { ...state, status: 'loading', retry }
  return { ...state, retry }
}

export default useComplaintSearch
