/**
 * ComplaintsMapPanel - the map view of the admin complaint list (lazy-loaded, so Leaflet is only downloaded
 * when an administrator switches to the map).
 *
 * Props:
 * - params: the list filters WITHOUT page / page_size / ordering; GET /complaints/map/ accepts the same
 *   filters as the list and returns up to 3000 pins (newest first).
 */
import { MapPinned } from 'lucide-react'
import { ComplaintMap } from '@/components/maps'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ErrorState } from '@/components/ui/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { useApi } from '@/hooks/useApi'
import { complaintService } from '@/services/complaintService'
import { formatNumber } from '@/utils/format'
import { SummaryLine } from '../shared/Controls'

const MAP_LIMIT = 3000
const MAP_HEIGHT = 'h-[420px] sm:h-[560px] xl:h-[640px]'

export default function ComplaintsMapPanel({ params }) {
  const { data, loading, error, refetch } = useApi(() => complaintService.map(params), [params])
  const points = Array.isArray(data) ? data : []

  return (
    <Card>
      <CardHeader
        icon={MapPinned}
        title="Complaints on the map"
        description="Pins take the category colour; numbered clusters group nearby complaints and are ringed in their most urgent priority. Select a pin for details."
        actions={data ? <SummaryLine count={points.length} noun="pin" loading={loading} /> : null}
      />
      <CardBody>
        {error && !data ? (
          <ErrorState bordered={false} title="The map could not be loaded" error={error} onRetry={refetch} />
        ) : loading && !data ? (
          <Skeleton className={`w-full rounded-xl ${MAP_HEIGHT}`} />
        ) : (
          <ComplaintMap
            points={points}
            basePath="/admin/complaints"
            height={null}
            className={MAP_HEIGHT}
            emptyMessage="No complaints match these filters, so there is nothing to map."
          />
        )}
        {points.length >= MAP_LIMIT ? (
          <p className="mt-3 text-xs text-ink-3">
            The map shows the newest {formatNumber(MAP_LIMIT)} complaints. Narrow the filters to see older ones.
          </p>
        ) : null}
      </CardBody>
    </Card>
  )
}
