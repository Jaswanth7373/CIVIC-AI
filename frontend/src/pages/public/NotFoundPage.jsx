/**
 * Page not found - used for unknown public paths (inside the public layout) and for unknown paths inside a
 * role area (inside the dashboard shell), so it adapts its spacing to where it is shown. It names the
 * address that failed, offers the visitor's dashboard (when logged in) and the home page, and lists a few
 * real destinations.
 *
 * The "road closed" moment: a road in CSS 3D running to the horizon, closed by a striped barrier with blinking
 * hazard lamps and the "no through road" sign (RoadClosedScene). On the public site the heading rises from a
 * mask once; inside the dashboard shell it stays still (app screens don't animate their headings).
 */
import { House, LayoutDashboard } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { RevealHeading } from '@/components/motion/MaskReveal'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/hooks/useAuth'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { cn } from '@/utils/cn'
import { isProtectedPath } from '@/utils/navigation'
import { MUTED_TEXT_AA } from './components/contrast'
import { RoadClosedScene } from './components/RoadClosedScene'
import { PAGE_TITLE_CLASS } from './components/Section'

export default function NotFoundPage() {
  useDocumentTitle('Page not found')
  const location = useLocation()
  const { isAuthenticated, homePath, role } = useAuth()
  const inDashboard = isProtectedPath(location.pathname)
  const canReport = !isAuthenticated || role === 'citizen'

  const links = [
    canReport ? { label: 'Report an issue', to: '/citizen/report' } : null,
    { label: 'How CivicAI works', to: '/how-it-works' },
    { label: 'Features', to: '/features' },
    { label: 'Contact the team', to: '/contact' },
  ].filter(Boolean)

  const headingClass = cn(PAGE_TITLE_CLASS, 'text-ink')

  return (
    <div className={cn(MUTED_TEXT_AA, inDashboard ? 'py-4 sm:py-8' : 'bg-bg')}>
      <div
        className={cn(
          'mx-auto grid w-full items-center gap-8 sm:gap-10',
          inDashboard
            ? 'max-w-5xl md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:gap-10'
            : 'max-w-7xl px-4 py-8 sm:px-6 sm:py-12 md:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] md:gap-10 lg:min-h-[calc(100svh-var(--public-header-h)-4rem)] lg:gap-16 lg:px-8 lg:py-16',
        )}
      >
        <RoadClosedScene variant="dead-end" className={cn('elev-raised', inDashboard ? 'max-w-xl' : 'mx-auto max-w-2xl md:max-w-none')} />
        <div className="min-w-0">
          {inDashboard ? (
            <h1 className={headingClass}>Page not found</h1>
          ) : (
            <RevealHeading as="h1" split="words" className={headingClass}>
              Page not found
            </RevealHeading>
          )}
          <p className="lead-fluid mt-4 text-ink-2">
            This road doesn't lead anywhere. The page may have moved, or the address may have a typo.
          </p>
          <p className="mt-5 inline-flex max-w-full items-center gap-2 rounded-md bg-sunken px-2.5 py-1 text-sm text-ink-2">
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-signal-500" />
            <span className="sr-only">Address you opened: </span>
            <span className="truncate">{location.pathname}</span>
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            {isAuthenticated ? (
              <Button to={homePath} leftIcon={LayoutDashboard} size="lg">
                Go to your dashboard
              </Button>
            ) : null}
            <Button to="/" variant={isAuthenticated ? 'outline' : 'primary'} leftIcon={House} size="lg">
              Go home
            </Button>
          </div>
          <nav aria-label="Other places to go" className="mt-9 border-t border-line pt-5">
            <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
              {links.map((link) => (
                <li key={link.to}>
                  <Link to={link.to} className="font-semibold text-primary-ink underline-offset-4 hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </div>
    </div>
  )
}
