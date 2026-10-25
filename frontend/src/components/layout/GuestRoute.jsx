import { useState } from 'react'
import { Navigate, Outlet, useSearchParams } from 'react-router-dom'
import { PageLoader } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'
import { safeNextPath } from '@/utils/navigation'
import { PAGE_LOADING_AREA } from './PublicLayout'

/**
 * Guard for /login and /register: a logged-in user is sent to `?next=` (when it is a safe internal path
 * for their role) or to their dashboard. This also completes the post-login redirect automatically: as soon
 * as `login()` sets the user, this guard navigates away from the login page.
 *
 * While a stored session is being checked, the page area shows the loader over the first screen (and the
 * public footer stays out of the layout meanwhile, like during a page's first load - see PublicLayout).
 *
 * The hand-off never paints an empty public layout: after a sign-in on this page the form stays on screen (in
 * its busy state) next to the redirect, until the dashboard shell takes over - route changes are transitions,
 * so the outgoing page stays painted while the next one loads. A visitor who arrives already signed in never
 * saw the form, so they keep the page loader instead of a flash of it.
 */
export function GuestRoute({ children }) {
  const { user, initializing } = useAuth()
  const [searchParams] = useSearchParams()
  // Did this visit show the guest page (the login / register form)? Derived during render, set once.
  const [formShown, setFormShown] = useState(false)
  if (!initializing && !user && !formShown) setFormShown(true)

  if (initializing) return <PageLoader label="Checking your session" className={PAGE_LOADING_AREA} />
  if (user) {
    return (
      <>
        <Navigate to={safeNextPath(searchParams.get('next'), user.role)} replace />
        {formShown ? (children ?? <Outlet />) : <PageLoader label="Opening your dashboard" className={PAGE_LOADING_AREA} />}
      </>
    )
  }
  return children ?? <Outlet />
}

export default GuestRoute
