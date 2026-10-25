/**
 * Axios client for the CivicAI REST API, with JWT handling.
 *
 * Authentication flow (djangorestframework-simplejwt with rotation + blacklist):
 * - `POST /auth/login/` returns `{access, refresh}`; both are kept in localStorage under
 *   `civicai.access` / `civicai.refresh` so a reload keeps the session.
 * - A request interceptor adds `Authorization: Bearer <access>`. If the access token's `exp` claim has
 *   already passed, it refreshes first instead of sending a request that is certain to fail.
 * - A response interceptor handles an unexpected 401 by refreshing ONCE and replaying the request. Refreshing
 *   is "single flight": the first 401 starts `POST /auth/refresh/`, every other request that fails meanwhile
 *   awaits the same promise (the queue) and is replayed with the new token. A request is never retried twice.
 * - When the refresh token itself is rejected, the session is over: tokens are cleared, a
 *   `civicai:session-expired` event tells AuthContext, and the user is sent to `/login?next=<page>` (only from
 *   protected pages - a visitor on the landing page is not bounced to the login form).
 *
 * Per-request options (axios config): `skipAuth` (public endpoint, send no token), `skipAuthRefresh`
 * (do not refresh on 401), `skipAuthRedirect` (expire silently, no redirect).
 */
import axios from 'axios'
import { buildLoginPath, isProtectedPath } from '@/utils/navigation'
import { STORAGE_KEYS, storage } from '@/utils/storage'

/** API base URL without a trailing slash, e.g. http://localhost:8000/api */
export const API_URL = String(import.meta.env.VITE_API_URL || 'http://localhost:8000/api').replace(/\/+$/, '')
export const DEFAULT_TIMEOUT_MS = 30_000
/** AI endpoints (analysis, verification) can take a while, especially the first call that loads a model. */
export const AI_TIMEOUT_MS = 180_000
export const SESSION_EXPIRED_EVENT = 'civicai:session-expired'

/* ----------------------------------------------------------------------------------------------------------
 * Token storage
 * -------------------------------------------------------------------------------------------------------- */
export function getAccessToken() {
  return storage.get(STORAGE_KEYS.accessToken)
}

export function getRefreshToken() {
  return storage.get(STORAGE_KEYS.refreshToken)
}

/**
 * Server time minus local time, learned from the `iat` (issued-at) claim of freshly issued access tokens.
 * Expiry checks use it so a phone whose clock is wrong does not treat every token as expired.
 */
let serverClockOffsetMs = 0

/** Store freshly issued tokens; `refresh` is optional because a refresh may return only a new access token. */
export function setTokens({ access, refresh } = {}) {
  if (access) {
    storage.set(STORAGE_KEYS.accessToken, access)
    const issuedAt = decodeJwt(access)?.iat
    if (typeof issuedAt === 'number') serverClockOffsetMs = issuedAt * 1000 - Date.now()
  }
  if (refresh) storage.set(STORAGE_KEYS.refreshToken, refresh)
}

export function clearTokens() {
  storage.remove(STORAGE_KEYS.accessToken)
  storage.remove(STORAGE_KEYS.refreshToken)
}

export function hasStoredSession() {
  return Boolean(getAccessToken() || getRefreshToken())
}

/**
 * Decode a JWT payload (base64url JSON) WITHOUT verifying it. Only used to read `exp` / `user_id` for
 * client-side decisions; the server always verifies the signature.
 */
export function decodeJwt(token) {
  if (!token || typeof token !== 'string') return null
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')
    const json = decodeURIComponent(
      Array.from(atob(base64), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''),
    )
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * True when the token's `exp` is within `skewSeconds` of the (server-corrected) current time.
 * An unknown expiry returns false: the server stays the authority and answers 401 if needed.
 */
export function isTokenExpired(token, skewSeconds = 20) {
  const exp = decodeJwt(token)?.exp
  if (typeof exp !== 'number') return false
  return exp * 1000 <= Date.now() + serverClockOffsetMs + skewSeconds * 1000
}

/* ----------------------------------------------------------------------------------------------------------
 * Query string and multipart helpers
 * -------------------------------------------------------------------------------------------------------- */

/**
 * Serialise query params the way the Django filters expect: empty values are dropped (an empty filter means
 * "no filter"), arrays become comma lists (`status=submitted,analyzed`), dates become ISO strings.
 */
export function serializeParams(params) {
  const search = new URLSearchParams()
  Object.entries(params ?? {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return
    if (Array.isArray(value)) {
      const items = value.filter((item) => item !== undefined && item !== null && item !== '')
      if (items.length) search.append(key, items.join(','))
      return
    }
    if (value instanceof Date) {
      search.append(key, value.toISOString())
      return
    }
    search.append(key, String(value))
  })
  return search.toString()
}

const isBlob = (value) => typeof Blob !== 'undefined' && value instanceof Blob
const isFormData = (value) => typeof FormData !== 'undefined' && value instanceof FormData

function appendFormValue(formData, key, value) {
  if (value === undefined || value === null) return
  if (isBlob(value)) formData.append(key, value, value.name || 'upload')
  else if (value instanceof Date) formData.append(key, value.toISOString())
  else if (typeof value === 'boolean') formData.append(key, value ? 'true' : 'false')
  else if (typeof value === 'object') formData.append(key, JSON.stringify(value))
  else formData.append(key, String(value))
}

/**
 * Build multipart/form-data from a plain object (for endpoints that accept file uploads).
 * - `undefined` / `null` values are skipped (the field is simply not sent).
 * - File / Blob values are appended as files (with their filename).
 * - Arrays of files or primitives repeat the key (`images=a.jpg&images=b.jpg`), which DRF reads with
 *   `getlist`; empty arrays are skipped. Arrays containing objects are sent as one JSON string.
 * - Plain objects are sent as JSON strings (parsed by DRF JSONField); booleans as "true"/"false";
 *   Dates as ISO strings.
 * An existing FormData is returned unchanged.
 */
export function buildFormData(data = {}) {
  if (isFormData(data)) return data
  const formData = new FormData()
  Object.entries(data ?? {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      const items = value.filter((item) => item !== undefined && item !== null)
      const hasObjects = items.some((item) => typeof item === 'object' && !isBlob(item) && !(item instanceof Date))
      if (hasObjects) formData.append(key, JSON.stringify(items))
      else items.forEach((item) => appendFormValue(formData, key, item))
      return
    }
    appendFormValue(formData, key, value)
  })
  return formData
}

/** True when a plain object contains a File/Blob at the top level (directly or inside an array). */
export function containsFile(data) {
  if (!data || typeof data !== 'object' || isFormData(data)) return false
  return Object.values(data).some((value) => isBlob(value) || (Array.isArray(value) && value.some(isBlob)))
}

/**
 * Request body for endpoints that accept JSON or multipart ("dataOrFormData"): FormData is sent as-is,
 * objects containing files are converted with `buildFormData`, everything else is sent as JSON.
 */
export function toRequestBody(data) {
  if (data == null) return {}
  if (isFormData(data)) return data
  return containsFile(data) ? buildFormData(data) : data
}

/* ----------------------------------------------------------------------------------------------------------
 * Session expiry and navigation
 * -------------------------------------------------------------------------------------------------------- */
let navigate = (to) => window.location.assign(to)

/** App.jsx registers the router's navigate so session-expiry redirects stay inside the SPA. */
export function setNavigator(fn) {
  navigate = typeof fn === 'function' ? fn : (to) => window.location.assign(to)
}

/** Send the user to the login page, remembering the protected page they were on. */
export function redirectToLogin() {
  const { pathname, search, hash } = window.location
  if (!isProtectedPath(pathname)) return
  navigate(buildLoginPath({ pathname, search, hash }))
}

/** End the local session after the server rejected our tokens. Idempotent across concurrent failures. */
function expireSession({ redirect = true } = {}) {
  if (!hasStoredSession()) return
  clearTokens()
  window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
  if (redirect) redirectToLogin()
}

/* ----------------------------------------------------------------------------------------------------------
 * Axios instance
 * -------------------------------------------------------------------------------------------------------- */
const api = axios.create({
  baseURL: API_URL,
  timeout: DEFAULT_TIMEOUT_MS,
  headers: { Accept: 'application/json' },
  paramsSerializer: { serialize: serializeParams },
})

/** Endpoints that must never carry a (possibly stale) token: simplejwt would reject the request with 401. */
const PUBLIC_AUTH_PATHS = ['/auth/login/', '/auth/register/', '/auth/refresh/']
/** Endpoints where a 401 must not trigger a refresh (login failure = wrong password, not an expired session). */
const NO_REFRESH_PATHS = [...PUBLIC_AUTH_PATHS, '/auth/logout/']

const matchesPath = (url, paths) => paths.some((path) => String(url ?? '').includes(path))

function setAuthorization(config, token) {
  if (typeof config.headers?.set === 'function') config.headers.set('Authorization', `Bearer ${token}`)
  else config.headers = { ...config.headers, Authorization: `Bearer ${token}` }
}

function readAuthorization(config) {
  const value =
    typeof config.headers?.get === 'function' ? config.headers.get('Authorization') : config.headers?.Authorization
  return String(value ?? '').replace(/^Bearer\s+/i, '')
}

let refreshPromise = null

/** The refresh token was refused (expired / blacklisted) - as opposed to the server being unreachable. */
function isRefreshRejected(error) {
  return Boolean(error?.isMissingRefreshToken || [400, 401, 403].includes(error?.response?.status))
}

/**
 * Exchange the refresh token for a new access token (single flight - concurrent callers share one request).
 * With refresh-token rotation another tab may have rotated the token first; in that case the tokens it
 * stored are used instead of ending the session.
 */
export function refreshAccessToken() {
  if (refreshPromise) return refreshPromise
  const refresh = getRefreshToken()
  if (!refresh) {
    const error = new Error('No refresh token is stored.')
    error.isMissingRefreshToken = true
    return Promise.reject(error)
  }
  refreshPromise = axios
    .post(`${API_URL}/auth/refresh/`, { refresh }, { timeout: DEFAULT_TIMEOUT_MS, headers: { Accept: 'application/json' } })
    .then(({ data }) => {
      setTokens({ access: data.access, refresh: data.refresh || refresh })
      return data.access
    })
    .catch((error) => {
      const current = getRefreshToken()
      if (current && current !== refresh && getAccessToken()) return getAccessToken()
      throw error
    })
    .finally(() => {
      refreshPromise = null
    })
  return refreshPromise
}

/**
 * Make sure the stored access token is usable (refreshing it if it expired). Returns the token or null.
 * Used before logout so the refresh token sent to /auth/logout/ is the current (rotated) one.
 */
export async function ensureFreshAccessToken({ redirect = false } = {}) {
  const access = getAccessToken()
  if (access && !isTokenExpired(access)) return access
  if (!getRefreshToken()) return access ?? null
  try {
    return await refreshAccessToken()
  } catch (error) {
    if (isRefreshRejected(error)) expireSession({ redirect })
    return null
  }
}

api.interceptors.request.use(async (config) => {
  if (config.skipAuth || matchesPath(config.url, PUBLIC_AUTH_PATHS)) return config
  let token = getAccessToken()
  if (token && isTokenExpired(token) && getRefreshToken()) {
    try {
      token = await refreshAccessToken()
    } catch (error) {
      if (isRefreshRejected(error)) {
        expireSession({ redirect: !config.skipAuthRedirect })
        token = null
      }
    }
  }
  if (token) setAuthorization(config, token)
  return config
})

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const { config, response } = error
    if (
      !config ||
      response?.status !== 401 ||
      config._authRetried ||
      config.skipAuth ||
      config.skipAuthRefresh ||
      matchesPath(config.url, NO_REFRESH_PATHS)
    ) {
      return Promise.reject(error)
    }
    if (!getRefreshToken()) {
      expireSession({ redirect: !config.skipAuthRedirect })
      return Promise.reject(error)
    }
    config._authRetried = true
    try {
      // Another request may already have refreshed while this one was in flight: reuse that token.
      const current = getAccessToken()
      const sent = readAuthorization(config)
      const token = current && current !== sent && !isTokenExpired(current) ? current : await refreshAccessToken()
      setAuthorization(config, token)
      return api(config)
    } catch (refreshError) {
      if (isRefreshRejected(refreshError)) {
        expireSession({ redirect: !config.skipAuthRedirect })
        error.isSessionExpired = true
      }
      return Promise.reject(error)
    }
  },
)

export default api
