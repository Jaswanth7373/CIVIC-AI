/**
 * Authentication state for the whole app.
 *
 * Bootstrapping: when tokens are stored, the provider calls GET /auth/profile/ once to restore the user
 * (`initializing` is true meanwhile, so ProtectedRoute shows a loader instead of redirecting). If the server
 * rejects the tokens they are cleared; if the server cannot be reached, the tokens are kept and
 * `sessionError` is set so the UI can offer a retry instead of logging the user out.
 *
 * Exposes: user, role, isAuthenticated, initializing, sessionError, homePath, login, register, logout,
 * updateProfile, refreshUser, hasRole.
 *
 * It also listens for:
 * - `civicai:session-expired` (dispatched by services/api.js when the refresh token is rejected),
 * - `storage` events, so logging out in one tab logs out every tab, and logging in elsewhere is picked up.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AuthContext } from '@/context/contexts'
import { useToast } from '@/hooks/useToast'
import {
  SESSION_EXPIRED_EVENT,
  clearTokens,
  decodeJwt,
  ensureFreshAccessToken,
  getAccessToken,
  getRefreshToken,
  hasStoredSession,
  setTokens,
} from '@/services/api'
import { authService } from '@/services/authService'
import { getHomePath } from '@/utils/navigation'
import { STORAGE_KEYS } from '@/utils/storage'

export function AuthProvider({ children }) {
  const toast = useToast()
  const [user, setUser] = useState(null)
  const [initializing, setInitializing] = useState(() => hasStoredSession())
  const [sessionError, setSessionError] = useState(null)
  const userRef = useRef(null)

  useEffect(() => {
    userRef.current = user
  }, [user])

  /** Load the current user from the API; returns the user or null. Never throws. */
  const loadProfile = useCallback(async () => {
    if (!hasStoredSession()) {
      setUser(null)
      return null
    }
    try {
      const profile = await authService.getProfile({ skipAuthRedirect: true })
      setUser(profile)
      setSessionError(null)
      return profile
    } catch (error) {
      if (error?.response) {
        // The server answered: the stored session is not valid any more.
        if ([401, 403].includes(error.response.status)) clearTokens()
        setUser(null)
        setSessionError(null)
      } else {
        // Network failure: keep the tokens so a retry can restore the session.
        setSessionError(error)
      }
      return null
    }
  }, [])

  useEffect(() => {
    if (!hasStoredSession()) return undefined
    let active = true
    loadProfile().finally(() => {
      if (active) setInitializing(false)
    })
    return () => {
      active = false
    }
  }, [loadProfile])

  useEffect(() => {
    const handleExpired = () => {
      if (userRef.current) toast.warning('Session expired', 'Log in again to continue.')
      setUser(null)
    }
    const handleStorage = (event) => {
      if (event.key !== null && event.key !== STORAGE_KEYS.accessToken && event.key !== STORAGE_KEYS.refreshToken) {
        return
      }
      if (!hasStoredSession()) {
        setUser(null)
        return
      }
      const tokenUserId = decodeJwt(getAccessToken())?.user_id
      const current = userRef.current
      if (!current || (tokenUserId != null && String(tokenUserId) !== String(current.id))) loadProfile()
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleExpired)
    window.addEventListener('storage', handleStorage)
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, handleExpired)
      window.removeEventListener('storage', handleStorage)
    }
  }, [toast, loadProfile])

  const startSession = useCallback((data) => {
    setTokens({ access: data.access, refresh: data.refresh })
    setUser(data.user)
    setSessionError(null)
    return data.user
  }, [])

  /** `login({email, password})` or `login(email, password)` -> the logged-in user. Rejects with the API error. */
  const login = useCallback(
    async (emailOrCredentials, password) => {
      const credentials =
        typeof emailOrCredentials === 'object' && emailOrCredentials !== null
          ? emailOrCredentials
          : { email: emailOrCredentials, password }
      const data = await authService.login(credentials)
      return startSession(data)
    },
    [startSession],
  )

  /** Create a citizen account and sign in -> the new user. */
  const register = useCallback(
    async (payload) => {
      const data = await authService.register(payload)
      return startSession(data)
    },
    [startSession],
  )

  /**
   * Log out: blacklist the refresh token on the server (best effort), then clear the local session.
   * The access token is refreshed first if needed, so the CURRENT rotated refresh token is the one revoked.
   */
  const logout = useCallback(async () => {
    try {
      await ensureFreshAccessToken()
      const refresh = getRefreshToken()
      if (refresh) await authService.logout(refresh)
    } catch {
      // The server may be unreachable or the token already invalid; the local logout below still happens.
    }
    clearTokens()
    setUser(null)
    setSessionError(null)
  }, [])

  /** PATCH /auth/profile/ (JSON or multipart) and keep the context user in sync -> the updated user. */
  const updateProfile = useCallback(async (dataOrFormData) => {
    const updated = await authService.updateProfile(dataOrFormData)
    setUser(updated)
    return updated
  }, [])

  /** Re-fetch the profile (e.g. after civic points changed, or to retry after a network failure). */
  const refreshUser = useCallback(async () => {
    const profile = await loadProfile()
    setInitializing(false)
    return profile
  }, [loadProfile])

  const role = user?.role ?? null

  /** `hasRole('admin')`, `hasRole('officer', 'admin')` or `hasRole(['officer', 'admin'])`. */
  const hasRole = useCallback(
    (...roles) => {
      if (!role) return false
      return roles.flat().includes(role)
    },
    [role],
  )

  const value = useMemo(
    () => ({
      user,
      role,
      isAuthenticated: Boolean(user),
      initializing,
      sessionError,
      homePath: getHomePath(role),
      login,
      register,
      logout,
      updateProfile,
      refreshUser,
      hasRole,
    }),
    [user, role, initializing, sessionError, login, register, logout, updateProfile, refreshUser, hasRole],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export default AuthProvider
