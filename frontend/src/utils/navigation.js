/**
 * Route helpers for authentication redirects.
 *
 * `?next=` values come from the URL, so they are untrusted: `safeNextPath` only accepts internal paths
 * (blocks open redirects such as `//evil.example` or `https://...`) and never sends a user into another
 * role's area, which would only bounce them to /unauthorized.
 */
import { ROLE_HOME } from '@/utils/constants'

const PROTECTED_PATH = /^\/(citizen|officer|admin)(\/|$)/
const GUEST_ONLY_PATH = /^\/(login|register)(\/|$|\?)/

/** True for paths inside the role dashboards (/citizen, /officer, /admin). */
export function isProtectedPath(pathname = '') {
  return PROTECTED_PATH.test(pathname)
}

/** Dashboard path for a role, or "/" when the role is unknown. */
export function getHomePath(role) {
  return ROLE_HOME[role] ?? '/'
}

/** "/login?next=<current path>" for a location-like `{ pathname, search, hash }`. */
export function buildLoginPath(location) {
  if (!location) return '/login'
  const next = `${location.pathname ?? ''}${location.search ?? ''}${location.hash ?? ''}`
  return next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login'
}

/**
 * Where to go after login: the requested `next` path when it is internal and allowed for `role`,
 * otherwise the role's dashboard.
 */
export function safeNextPath(next, role) {
  const home = getHomePath(role)
  if (!next || typeof next !== 'string') return home
  const path = next.trim()
  // URL parsing (the browser's and React Router's) drops tabs / newlines and reads "\" as "/", so "/<TAB>/evil.example"
  // would become the external "//evil.example": refuse control characters and backslashes outright.
  if ([...path].some((char) => char < ' ' || char === '\u007f' || char === '\\')) return home
  if (!path.startsWith('/') || path.startsWith('//')) return home
  if (GUEST_ONLY_PATH.test(path)) return home
  const area = PROTECTED_PATH.exec(path)?.[1]
  if (area && area !== role) return home
  return path
}
