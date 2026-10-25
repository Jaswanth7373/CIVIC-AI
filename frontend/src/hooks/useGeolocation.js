/**
 * Browser geolocation for "Use my location".
 *
 *   const { position, error, loading, locate, supported } = useGeolocation()
 *   const pos = await locate()   // { lat, lng, accuracy, timestamp } or null (then `error` explains why)
 *
 * Technique: the W3C Geolocation API (`navigator.geolocation.getCurrentPosition`) with
 * `enableHighAccuracy` (GPS on phones) and a timeout. If the high-accuracy attempt times out - common indoors
 * - it retries once in low-accuracy mode (Wi-Fi / cell based), which answers much faster.
 * Coordinates are rounded to 6 decimals (about 0.1 m), matching the backend's Decimal(9, 6) fields.
 *
 * Errors are translated into friendly, actionable messages with a stable `code`:
 * unsupported | insecure_origin | permission_denied | unavailable | timeout.
 * (Browsers only allow geolocation on HTTPS or localhost, so an insecure origin is detected up front.)
 * `locate()` never rejects, so it can be called directly from a click handler.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const DEFAULT_OPTIONS = { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 }
const LOW_ACCURACY_RETRY = { enableHighAccuracy: false, timeout: 15_000, maximumAge: 60_000 }

const MESSAGES = {
  unsupported: "This browser can't share your location. Pick the spot on the map instead.",
  insecure_origin:
    'Location only works on a secure connection (HTTPS or localhost). Open CivicAI over HTTPS, or pick the spot on the map.',
  permission_denied:
    'Location permission was denied. Allow location access for this site in your browser settings, or pick the spot on the map.',
  unavailable:
    "Your position couldn't be determined. Turn on location services (GPS) and try again, or pick the spot on the map.",
  timeout: 'Finding your location took too long. Try again with GPS on or near a window, or pick the spot on the map.',
}

export function geolocationError(code) {
  return { code, message: MESSAGES[code] ?? MESSAGES.unavailable }
}

function translateError(error) {
  if (!error) return geolocationError('unavailable')
  if (error.code === 1) {
    // Chrome reports insecure origins as PERMISSION_DENIED with an explanatory message.
    return /secure origin/i.test(error.message ?? '') ? geolocationError('insecure_origin') : geolocationError('permission_denied')
  }
  if (error.code === 3) return geolocationError('timeout')
  return geolocationError('unavailable')
}

const round6 = (value) => Math.round(value * 1e6) / 1e6

export function useGeolocation(options) {
  const supported = typeof navigator !== 'undefined' && 'geolocation' in navigator
  const [state, setState] = useState({ position: null, error: null, loading: false })
  const optionsRef = useRef(options)
  const mountedRef = useRef(false)

  useEffect(() => {
    optionsRef.current = options
  })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const update = useCallback((next) => {
    if (mountedRef.current) setState(next)
  }, [])

  const locate = useCallback(
    () =>
      new Promise((resolve) => {
        if (!supported) {
          update({ position: null, error: geolocationError('unsupported'), loading: false })
          resolve(null)
          return
        }
        if (typeof window !== 'undefined' && window.isSecureContext === false) {
          update({ position: null, error: geolocationError('insecure_origin'), loading: false })
          resolve(null)
          return
        }
        setState((current) => ({ ...current, error: null, loading: true }))

        const attempt = (geoOptions, isRetry) => {
          navigator.geolocation.getCurrentPosition(
            (result) => {
              const position = {
                lat: round6(result.coords.latitude),
                lng: round6(result.coords.longitude),
                accuracy: Math.round(result.coords.accuracy),
                timestamp: result.timestamp,
              }
              update({ position, error: null, loading: false })
              resolve(position)
            },
            (error) => {
              if (error?.code === 3 && geoOptions.enableHighAccuracy && !isRetry) {
                attempt(LOW_ACCURACY_RETRY, true)
                return
              }
              update((current) => ({ ...current, error: translateError(error), loading: false }))
              resolve(null)
            },
            geoOptions,
          )
        }

        attempt({ ...DEFAULT_OPTIONS, ...(optionsRef.current ?? {}) }, false)
      }),
    [supported, update],
  )

  const clear = useCallback(() => update({ position: null, error: null, loading: false }), [update])

  return { ...state, locate, clear, supported }
}

export default useGeolocation
