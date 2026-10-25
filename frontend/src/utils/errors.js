/**
 * Turn API / network failures into messages people can act on.
 *
 * The backend's global exception handler always answers with
 *   {"detail": "Human readable summary", "errors"?: {"field": ["message", ...]}, "code": "validation_error"}
 * (apps/core/exceptions.py). `getErrorMessage` prefers that `detail`, then falls back to status-specific copy
 * that says what happened and how to fix it. `getFieldErrors` flattens `errors` for forms, so each input can
 * show its own message.
 */
import axios from 'axios'

export const DEFAULT_ERROR_MESSAGE = 'Something went wrong. Please try again.'

const STATUS_MESSAGES = {
  400: 'Some details are not valid. Check the form and try again.',
  401: 'Your session has expired. Log in again to continue.',
  403: "You don't have permission to do that.",
  404: "We couldn't find what you were looking for. It may have been removed.",
  409: 'This action conflicts with the current state. Refresh the page and try again.',
  413: 'The file is too large to upload. Choose a smaller image.',
  415: 'This file type is not supported.',
  429: 'Too many requests. Wait a moment and try again.',
  500: 'The server ran into a problem. Try again in a moment.',
  502: 'The CivicAI server is not reachable right now. Try again in a moment.',
  503: 'The CivicAI server is temporarily unavailable. Try again in a moment.',
  504: 'The server took too long to respond. Try again in a moment.',
}

/** HTTP status of an axios error (or undefined for network failures and non-HTTP errors). */
export function getErrorStatus(error) {
  return error?.response?.status
}

/** True when the request was cancelled on purpose (AbortController / component unmount). */
export function isCancelError(error) {
  return axios.isCancel(error) || error?.name === 'CanceledError' || error?.code === 'ERR_CANCELED'
}

/** True when the browser never got an HTTP response (offline, DNS, CORS, server down). */
export function isNetworkError(error) {
  return Boolean(error?.isAxiosError && !error.response && !isCancelError(error))
}

export function isTimeoutError(error) {
  return error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT'
}

/** First readable message inside a DRF `errors` value (string | string[] | nested object). */
function firstMessage(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = firstMessage(item)
      if (message) return message
    }
    return ''
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      const message = firstMessage(item)
      if (message) return message
    }
  }
  return ''
}

/**
 * Best human readable message for any thrown value.
 * @param {unknown} error axios error, Error, string or API payload
 * @param {string} [fallback] message used when nothing better is available
 */
export function getErrorMessage(error, fallback = DEFAULT_ERROR_MESSAGE) {
  if (!error) return fallback
  if (typeof error === 'string') return error
  if (isCancelError(error)) return 'The request was cancelled.'

  const data = error.response?.data
  if (data && typeof data === 'object' && !(typeof Blob !== 'undefined' && data instanceof Blob)) {
    if (typeof data.detail === 'string' && data.detail.trim()) return data.detail
    const fieldMessage = firstMessage(data.errors)
    if (fieldMessage) return fieldMessage
  } else if (typeof data === 'string' && data.trim() && data.length < 300 && !data.trim().startsWith('<')) {
    return data.trim()
  }

  if (isTimeoutError(error)) return 'The server took too long to respond. Check your connection and try again.'
  if (isNetworkError(error)) {
    return "Can't reach the CivicAI server. Check your internet connection and that the API is running."
  }

  const status = getErrorStatus(error)
  if (status) return STATUS_MESSAGES[status] ?? (status >= 500 ? STATUS_MESSAGES[500] : fallback)
  if (error instanceof Error && error.message) return error.message
  return fallback
}

/**
 * Field errors for forms: `{ field: "message" }`.
 * Nested serializer errors are flattened with dots (`citizen_profile.city`) and every field also gets its
 * plain name when unambiguous, so a flat form field named `city` still finds its message. Multiple messages
 * for one field are joined with a space.
 */
export function getFieldErrors(error) {
  const source = error?.response?.data?.errors ?? error?.errors
  if (!source || typeof source !== 'object') return {}
  const result = {}

  const walk = (value, path) => {
    if (value == null) return
    if (typeof value === 'string') {
      result[path] = result[path] ? `${result[path]} ${value}` : value
      return
    }
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item === 'string')) {
        walk(value.join(' '), path)
      } else {
        value.forEach((item, index) => walk(item, `${path}.${index}`))
      }
      return
    }
    if (typeof value === 'object') {
      Object.entries(value).forEach(([key, item]) => walk(item, path ? `${path}.${key}` : key))
    }
  }

  Object.entries(source).forEach(([key, value]) => walk(value, key))

  Object.keys(result).forEach((path) => {
    const leaf = path.split('.').pop()
    if (path.includes('.') && Number.isNaN(Number(leaf)) && !(leaf in result)) result[leaf] = result[path]
  })
  return result
}

/** Non-field errors (`non_field_errors` / `detail`) as one string, or ''. */
export function getNonFieldError(error) {
  const fields = getFieldErrors(error)
  return fields.non_field_errors ?? ''
}
