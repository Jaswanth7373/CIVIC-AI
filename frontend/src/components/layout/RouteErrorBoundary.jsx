import { House, RefreshCw } from 'lucide-react'
import { isRouteErrorResponse, useRouteError } from 'react-router-dom'
import { DeadEndIllustration, DetourIllustration, RoadworksIllustration } from '@/components/illustrations'
import { Button } from '@/components/ui'
import { useAuth } from '@/hooks/useAuth'

const CHUNK_ERROR = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError/i

/**
 * Router `errorElement`: shown instead of a screen that threw while rendering or loading. Each case has its own
 * road-sign scene, so the screen says at a glance what kind of stop this is:
 * - 404 responses: "Page not found" - a dead-end sign behind a barrier.
 * - A lazy page chunk that failed to load (usually a new deployment replaced the files, or the network
 *   dropped): a detour sign; offers a reload, which fetches the current version.
 * - Anything else: road works; a plain explanation, a reload button and a way home. Technical details are only
 *   shown in development builds.
 */
export function RouteErrorBoundary() {
  const error = useRouteError()
  const { homePath, isAuthenticated } = useAuth()
  const home = isAuthenticated ? homePath : '/'

  let kind = 'error'
  let title = 'Something went wrong on this screen'
  let message = 'An unexpected error stopped this page from loading. Reload the page to try again.'
  if (isRouteErrorResponse(error) && error.status === 404) {
    kind = 'notFound'
    title = 'Page not found'
    message = "The page you're looking for doesn't exist or has moved."
  } else if (CHUNK_ERROR.test(String(error?.message ?? error))) {
    kind = 'reload'
    title = 'CivicAI needs to reload'
    message = 'A newer version is available, or the connection dropped while loading this screen. Reload to continue.'
  }

  const details = import.meta.env.DEV && error instanceof Error ? error.stack || error.message : null
  const Scene = kind === 'notFound' ? DeadEndIllustration : kind === 'reload' ? DetourIllustration : RoadworksIllustration

  return (
    <div className="grid min-h-[60vh] place-items-center bg-bg px-4 py-12 text-ink">
      <div role="alert" className="w-full max-w-lg rounded-2xl border border-line bg-surface px-6 pb-7 pt-6 text-center elev-raised sm:px-8">
        <Scene className="mx-auto mb-4 w-[17rem]" />
        <h1 className="font-display text-2xl font-extrabold text-ink">{title}</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-ink-2">{message}</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button leftIcon={RefreshCw} onClick={() => window.location.reload()}>
            Reload page
          </Button>
          <Button variant="outline" leftIcon={House} href={home}>
            Go to {isAuthenticated ? 'dashboard' : 'home page'}
          </Button>
        </div>
        {details ? (
          <details className="mt-6 text-left">
            <summary className="cursor-pointer text-xs font-semibold text-ink-3">Technical details (development only)</summary>
            <pre className="scrollbar-thin mt-2 max-h-60 overflow-auto rounded-lg bg-sunken p-3 text-xs text-ink-2">{details}</pre>
          </details>
        ) : null}
      </div>
    </div>
  )
}

export default RouteErrorBoundary
