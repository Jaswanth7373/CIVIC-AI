/**
 * ComplaintsMapCard - the map view of the officer's complaint list (/officer/complaints?view=map): clustered,
 * category-coloured pins; a pin opens a summary with a link to the work order.
 *
 * The page owns the request (GET /complaints/map/ with the list's scope and filters and no paging), so its
 * Refresh button and summary line work in both views; this card only draws the result. The Leaflet map itself
 * is lazy-loaded, so the list view never downloads Leaflet.
 *
 * Props:
 * - points: map pins, or null before the first response
 * - loading: a request is running (first load: a skeleton; refresh: a moving bar over the last pins)
 * - error: the last request failed (no pins yet: an error state with "Try again"; else a warning above the map)
 * - onRetry(): repeat the request
 * - emptyMessage: shown over the map when there is no pin to show
 * - className
 */
import { MapPinned, RefreshCw } from 'lucide-react'
import { Suspense, lazy } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ErrorState } from '@/components/ui/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/utils/cn'
import { formatNumber } from '@/utils/format'
import { OFFICER_BASE_PATH } from './officerUtils'

const ComplaintMap = lazy(() => import('@/components/maps/ComplaintMap'))

/** GET /complaints/map/ returns at most this many pins, newest first (MAP_MAX_POINTS on the server). */
const MAP_MAX_POINTS = 3000
const MAP_HEIGHT = 'h-[420px] sm:h-[560px] xl:h-[640px]'

function MapSkeleton() {
  return <Skeleton className={cn('w-full rounded-xl', MAP_HEIGHT)} />
}

export function ComplaintsMapCard({ points, loading = false, error = null, onRetry, emptyMessage, className }) {
  const pins = Array.isArray(points) ? points : null

  return (
    <Card className={className}>
      <CardHeader
        icon={MapPinned}
        title="Complaints on the map"
        description="Pins take the category colour; numbered circles group nearby complaints and split as you zoom in. Select a pin for its summary and a link to the work order."
      />
      <CardBody>
        {error && pins ? (
          <Alert
            tone="danger"
            title="The map could not be refreshed"
            className="mb-3"
            action={
              <Button size="sm" variant="outline" leftIcon={RefreshCw} onClick={() => onRetry?.()}>
                Try again
              </Button>
            }
          >
            Showing the last pins that loaded.
          </Alert>
        ) : null}

        {error && !pins ? (
          <ErrorState bordered={false} title="The map could not be loaded" error={error} onRetry={onRetry ? () => onRetry() : undefined} />
        ) : !pins ? (
          <MapSkeleton />
        ) : (
          <div className="relative" aria-busy={loading || undefined}>
            {loading ? (
              <div aria-hidden className="absolute inset-x-0 top-0 z-10 h-1 overflow-hidden rounded-t-xl bg-sunken">
                <div className="lane-line-x animate-lane h-full w-full" />
              </div>
            ) : null}
            <Suspense fallback={<MapSkeleton />}>
              <ComplaintMap points={pins} basePath={OFFICER_BASE_PATH} height={null} className={MAP_HEIGHT} emptyMessage={emptyMessage} />
            </Suspense>
          </div>
        )}

        {pins && pins.length >= MAP_MAX_POINTS ? (
          <p className="mt-3 text-xs text-ink-3">
            The map shows the newest {formatNumber(MAP_MAX_POINTS)} of these complaints. Narrow the filters to see older ones.
          </p>
        ) : null}
      </CardBody>
    </Card>
  )
}

export default ComplaintsMapCard
