/**
 * Access denied - ProtectedRoute sends a logged-in user here when they open another role's area (the
 * attempted path arrives as `location.state.from`). The page says who they are signed in as and which
 * kind of account the area needs, then offers their own dashboard, the home page, or logging in with
 * another account (which returns them to the page they wanted).
 *
 * The "road closed" moment: a checkpoint in CSS 3D - the striped boom lowers across the road under the red
 * "no entry" disc while its hazard lamp blinks (RoadClosedScene). The heading rises from a mask once.
 */
import { House, LayoutDashboard, LogIn } from 'lucide-react'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { ROLE_PORTAL_LABELS } from '@/components/layout/navigation'
import { RevealHeading } from '@/components/motion/MaskReveal'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/hooks/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useToast } from '@/hooks/useToast'
import { cn } from '@/utils/cn'
import { ROLE_LABELS } from '@/utils/constants'
import { getErrorMessage } from '@/utils/errors'
import { MUTED_TEXT_AA } from './components/contrast'
import { RoadClosedScene } from './components/RoadClosedScene'
import { PAGE_TITLE_CLASS } from './components/Section'
import { withNext } from './components/authUtils'

const ARTICLE = { citizen: 'a', officer: 'an', admin: 'an' }

export default function UnauthorizedPage() {
  useDocumentTitle('Access denied')
  const location = useLocation()
  const navigate = useNavigate()
  const toast = useToast()
  const { user, role, homePath, logout } = useAuth()
  const [leaving, setLeaving] = useState(false)
  const from = typeof location.state?.from === 'string' ? location.state.from : null
  const area = /^\/(citizen|officer|admin)(\/|$)/.exec(from ?? '')?.[1] ?? null

  const switchAccount = async () => {
    setLeaving(true)
    try {
      await logout()
      toast.success('Logged out', 'Log in with the account that has access.')
      navigate(withNext('/login', from), { replace: true })
    } catch (error) {
      toast.error('Could not log out', getErrorMessage(error))
      setLeaving(false)
    }
  }

  let explanation = 'Log in with an account that has access to this page.'
  if (user) {
    const who = `You're signed in as ${user.full_name || user.email}, ${ARTICLE[role] ?? 'a'} ${(ROLE_LABELS[role] ?? 'user').toLowerCase()} account.`
    explanation = area
      ? `${who} The ${ROLE_PORTAL_LABELS[area].toLowerCase()} is only for ${ROLE_LABELS[area].toLowerCase()} accounts.`
      : `${who} This page belongs to another kind of account.`
  }

  return (
    <div className={cn('bg-bg', MUTED_TEXT_AA)}>
      <div className="mx-auto grid w-full max-w-7xl items-center gap-8 px-4 py-8 sm:gap-10 sm:px-6 sm:py-12 md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:min-h-[calc(100svh-var(--public-header-h)-4rem)] lg:gap-16 lg:px-8 lg:py-16">
        <RoadClosedScene variant="checkpoint" className="elev-raised mx-auto max-w-2xl md:max-w-none" />
        <div className="min-w-0">
          <RevealHeading as="h1" split="words" className={cn(PAGE_TITLE_CLASS, 'text-ink')}>
            You don't have access to this page
          </RevealHeading>
          <p className="lead-fluid mt-4 text-ink-2">{explanation}</p>
          {from ? (
            <p className="mt-5 inline-flex max-w-full items-center gap-2 rounded-md bg-sunken px-2.5 py-1 text-sm text-ink-2">
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-signal-500" />
              <span className="sr-only">Page you opened: </span>
              <span className="truncate">{from}</span>
            </p>
          ) : null}
          <div className="mt-7 flex flex-wrap gap-3">
            {user ? (
              <>
                <Button to={homePath} leftIcon={LayoutDashboard} size="lg">
                  Go to your dashboard
                </Button>
                <Button to="/" variant="outline" leftIcon={House} size="lg">
                  Go home
                </Button>
                <Button variant="ghost" leftIcon={LogIn} loading={leaving} onClick={switchAccount} size="lg">
                  Log in with another account
                </Button>
              </>
            ) : (
              <>
                <Button to={withNext('/login', from)} leftIcon={LogIn} size="lg">
                  Log in
                </Button>
                <Button to="/" variant="outline" leftIcon={House} size="lg">
                  Go home
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
