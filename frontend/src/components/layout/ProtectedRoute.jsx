import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Button, ErrorState, Logo, PageLoader } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { buildLoginPath } from '@/utils/navigation'

/**
 * Route guard for the role dashboards.
 * - While the session is being restored from stored tokens: full-screen loader (no premature redirect).
 * - Not logged in: redirect to /login?next=<requested page>, so the user lands back here after login.
 * - Server unreachable during restore: an error screen with "Try again" instead of a misleading logout.
 * - Logged in with another role: redirect to /unauthorized.
 *
 * Renders `children` when given, otherwise the nested route (<Outlet />).
 *
 * @param {{roles?: Array<'citizen'|'officer'|'admin'>, children?: import('react').ReactNode}} props
 */
export function ProtectedRoute({ roles, children }) {
  const { user, initializing, sessionError, refreshUser, logout } = useAuth()
  const location = useLocation()

  if (initializing) return <PageLoader fullScreen label="Checking your session" />

  if (!user) {
    if (sessionError) {
      return (
        <main className="grid min-h-dvh place-items-center bg-bg px-4">
          <div className="flex w-full max-w-md flex-col items-center gap-6">
            <Logo />
            <ErrorState
              className="w-full"
              title="Can't reach the CivicAI server"
              error={sessionError}
              onRetry={refreshUser}
              action={
                <Button variant="ghost" onClick={logout}>
                  Log out
                </Button>
              }
            />
          </div>
        </main>
      )
    }
    return <Navigate to={buildLoginPath(location)} replace />
  }

  if (roles?.length && !roles.includes(user.role)) {
    return <Navigate to="/unauthorized" replace state={{ from: location.pathname }} />
  }

  return children ?? <Outlet />
}

export default ProtectedRoute
