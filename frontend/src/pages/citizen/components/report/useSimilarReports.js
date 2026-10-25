/**
 * useSimilarReports - "Similar issue already reported nearby" check before the final submit.
 *
 * Sends the description, the pin and the photo to POST /api/ai/duplicates/ (multipart form; nothing is
 * stored) and returns the nearby complaints the duplicate engine scored as similar:
 * `[{complaint: ComplaintMini, text_similarity, image_similarity | null, location_similarity,
 *    overall_similarity, distance_m, category_match, explanation, is_duplicate}]`, best match first.
 *
 * The check runs while `enabled` (the review step is open) and re-runs when the inputs change; answers are
 * numbered so only the newest one is applied. It never blocks submitting: a failed check reports
 * `status: 'error'` with a retry, and the citizen can still send the report.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { aiService } from '@/services/aiService'
import { fileKey } from './reportForm'

export function useSimilarReports({ enabled, description, position, image }) {
  const text = String(description ?? '').trim()
  const key =
    enabled && text && position ? `${text}|${position.lat},${position.lng}|${fileKey(image)}` : ''
  const inputsRef = useRef({ text, position, image })
  const requestIdRef = useRef(0)
  const [retryToken, setRetryToken] = useState(0)
  const [state, setState] = useState({ key: '', status: 'idle', items: [], error: null })

  useEffect(() => {
    inputsRef.current = { text, position, image }
  })

  useEffect(() => {
    if (!key) return
    requestIdRef.current += 1
    const requestId = requestIdRef.current
    const { text: words, position: pin, image: file } = inputsRef.current
    const body = new FormData()
    body.append('description', words)
    body.append('latitude', String(pin.lat))
    body.append('longitude', String(pin.lng))
    if (file) body.append('image', file, file.name || 'photo.jpg')
    setState((current) => ({ ...current, key, status: 'loading', error: null }))
    aiService
      .duplicates(body)
      .then((data) => {
        if (requestId !== requestIdRef.current) return
        const items = (Array.isArray(data) ? data : [])
          .filter((item) => item?.complaint)
          .sort((a, b) => (Number(b.overall_similarity) || 0) - (Number(a.overall_similarity) || 0))
        setState({ key, status: 'done', items, error: null })
      })
      .catch((error) => {
        if (requestId === requestIdRef.current) setState({ key, status: 'error', items: [], error })
      })
  }, [key, retryToken])

  const retry = useCallback(() => setRetryToken((value) => value + 1), [])

  if (!key) return { status: 'idle', items: [], error: null, retry }
  if (state.key !== key || state.status === 'loading') return { status: 'loading', items: [], error: null, retry }
  return { status: state.status, items: state.items, error: state.error, retry }
}

export default useSimilarReports
