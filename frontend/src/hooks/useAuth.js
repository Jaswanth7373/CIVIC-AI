/**
 * Access the authentication context:
 * `{ user, role, isAuthenticated, initializing, sessionError, homePath, login, register, logout,
 *    updateProfile, refreshUser, hasRole }`.
 */
import { useContext } from 'react'
import { AuthContext } from '@/context/contexts'

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth() must be used inside <AuthProvider>.')
  return context
}

export default useAuth
