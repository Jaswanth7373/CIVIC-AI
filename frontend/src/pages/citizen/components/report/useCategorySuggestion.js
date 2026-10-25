/**
 * useCategorySuggestion - the live "AI suggestion" while the citizen fills in the report.
 *
 * As soon as there is a photo and/or at least SUGGEST_MIN_CHARS characters of description, the inputs are
 * sent to POST /api/ai/classify/ (nothing is stored). Technique:
 * - the inputs are reduced to a key (file identity + trimmed text); the key is debounced (700 ms), so typing
 *   costs one request per pause, not one per keystroke;
 * - every request is numbered and only the newest answer is applied, so a slow, stale answer can never
 *   replace a newer one (classify has no cancellation hook, so stale answers are dropped instead);
 * - text under the threshold is not sent (a photo alone still gets a suggestion).
 *
 * Returns `{status, result, error, retry}`:
 * - status: 'idle' (nothing to classify) | 'waiting' (inputs changed, request pending or debouncing) |
 *   'done' | 'error'
 * - result: the classify response `{vision, text, fusion, category, is_demo, mode}` of the latest finished
 *   request (kept while a newer one runs, so the chip does not flicker)
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDebounce } from '@/hooks/useDebounce'
import { aiService } from '@/services/aiService'
import { SUGGEST_MIN_CHARS, fileKey } from './reportForm'

export function useCategorySuggestion({ image, description }) {
  const text = String(description ?? '').trim()
  const useText = text.length >= SUGGEST_MIN_CHARS
  const key = image || useText ? `${fileKey(image)}|${useText ? text : ''}` : ''
  const debouncedKey = useDebounce(key, 700)

  const inputsRef = useRef({ image, text: useText ? text : '' })
  const requestIdRef = useRef(0)
  const [retryToken, setRetryToken] = useState(0)
  const [state, setState] = useState({ key: '', status: 'idle', result: null, error: null })

  useEffect(() => {
    inputsRef.current = { image, text: useText ? text : '' }
  })

  useEffect(() => {
    if (!debouncedKey) return
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    const { image: file, text: words } = inputsRef.current
    const body = new FormData()
    if (file) body.append('image', file, file.name || 'photo.jpg')
    if (words) body.append('description', words)
    setState((current) => ({ ...current, key: debouncedKey, status: 'loading', error: null }))
    aiService
      .classify(body)
      .then((result) => {
        if (requestId === requestIdRef.current) setState({ key: debouncedKey, status: 'done', result, error: null })
      })
      .catch((error) => {
        if (requestId === requestIdRef.current) {
          setState((current) => ({ ...current, key: debouncedKey, status: 'error', error }))
        }
      })
  }, [debouncedKey, retryToken])

  const retry = useCallback(() => setRetryToken((value) => value + 1), [])

  if (!key) return { status: 'idle', result: null, error: null, retry }
  if (state.key !== key || state.status === 'loading') {
    // Keep showing the previous suggestion only while the photo is the same (the text is being edited);
    // a different photo must never show the old photo's answer, even dimmed.
    const samePhoto = state.key && state.key.split('|')[0] === key.split('|')[0]
    return { status: 'waiting', result: samePhoto ? state.result : null, error: null, retry }
  }
  return { status: state.status, result: state.result, error: state.error, retry }
}

export default useCategorySuggestion
