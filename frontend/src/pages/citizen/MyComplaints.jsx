/**
 * My complaints (/citizen/complaints) - every complaint the citizen has filed.
 *
 * Filters (search, status, category, severity, priority, reported date range and the sort order) live in the
 * URL through useComplaintFilters, so a filtered list survives a reload, can be shared, and the back button
 * restores it; the dashboard tiles link straight into filtered views (e.g. ?status=accepted,in_progress).
 * Data: GET /api/complaints/ (scoped to the citizen by the server) with the same params; the table becomes
 * cards on phones. Sorting is done by the server: through the priority and date headers on wide screens, and
 * through the "Sort by" select in the filter drawer on phones and tablets.
 */
import { FilterX, MapPin, MapPinPlus } from 'lucide-react'
import { useEffect } from 'react'
import { ComplaintFilters } from '@/components/complaints/ComplaintFilters'
import { ComplaintTable } from '@/components/complaints/ComplaintTable'
import { useComplaintFilters } from '@/components/complaints/useComplaintFilters'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { PageHeader } from '@/components/ui/PageHeader'
import { PaginationBar } from '@/pages/shared/components/PaginationBar'
import { useApi } from '@/hooks/useApi'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { categoryService } from '@/services/categoryService'
import { complaintService } from '@/services/complaintService'
import { DEFAULT_PAGE_SIZE } from '@/utils/constants'
import { getErrorStatus } from '@/utils/errors'
import { formatNumber } from '@/utils/format'
import { LINKED_NUMBER_COLUMN } from './components/complaintColumns'

// On wide screens the table headers sort (priority, severity, date), so the sort select is only offered in the
// phone / tablet filter drawer, where the list is shown as cards without headers.
const FILTER_CONTROLS_WIDE = ['search', 'status', 'category', 'severity', 'priority', 'date']
const FILTER_CONTROLS_NARROW = [...FILTER_CONTROLS_WIDE, 'ordering']
const COLUMNS = [LINKED_NUMBER_COLUMN, 'category', 'priority', 'status', 'date']

export default function MyComplaints() {
  const list = useComplaintFilters({ pageSize: DEFAULT_PAGE_SIZE })
  const { data, loading, error, refetch } = useApi(() => complaintService.list(list.params), [list.params])
  const { data: categories } = useApi(() => categoryService.list(), [])
  const { page, setPage } = list
  const isDesktop = useMediaQuery(BREAKPOINTS.lg)

  // A page number from an old link can be past the end once complaints change: go back to the first page.
  const pageGone = getErrorStatus(error) === 404 && page > 1
  useEffect(() => {
    if (pageGone) setPage(1)
  }, [pageGone, setPage])

  const rows = data?.results ?? []
  const count = data?.count ?? 0
  const filtered = list.activeCount > 0 || Boolean(list.filters.search)
  const firstLoad = loading && !data

  const empty = filtered ? (
    <EmptyState
      bordered={false}
      compact
      icon={FilterX}
      title="No complaints match these filters"
      description="Try another status or category, or widen the date range."
      action={
        <Button variant="outline" leftIcon={FilterX} onClick={list.resetFilters}>
          Clear filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      bordered={false}
      icon={MapPin}
      title="You have not reported anything yet"
      description="Spotted a pothole, an overflowing bin or a broken streetlight? Report it with a photo and follow every step here."
      action={
        <Button variant="warning" leftIcon={MapPinPlus} to="/citizen/report">
          Report an issue
        </Button>
      }
    />
  )

  return (
    <>
      <PageHeader
        title="My complaints"
        description={
          data && !filtered && count > 0
            ? `${formatNumber(count)} ${count === 1 ? 'complaint' : 'complaints'} reported. Open one to see its photo, AI analysis and every update.`
            : 'Every issue you have reported, with its live status. Open one to see its photo, AI analysis and every update.'
        }
        actions={
          <Button variant="warning" leftIcon={MapPinPlus} to="/citizen/report" className="w-full sm:w-auto">
            Report an issue
          </Button>
        }
      />

      <div className="space-y-4">
        <ComplaintFilters
          {...list.bind}
          categories={Array.isArray(categories) ? categories : []}
          show={isDesktop ? FILTER_CONTROLS_WIDE : FILTER_CONTROLS_NARROW}
        />

        {error && !data && !pageGone ? (
          <ErrorState title="Your complaints could not be loaded" error={error} onRetry={refetch} />
        ) : (
          <>
            {data && filtered ? (
              <p className="text-sm text-ink-2 tabular" aria-live="polite">
                {count === 1 ? '1 complaint matches' : `${formatNumber(count)} complaints match`}
              </p>
            ) : null}
            <ComplaintTable
              complaints={rows}
              loading={loading}
              basePath="/citizen/complaints"
              columns={COLUMNS}
              sort={list.filters.ordering || '-created_at'}
              onSortChange={(ordering) => list.setFilters({ ordering })}
              caption="Your complaints"
              empty={firstLoad ? undefined : empty}
              // Clips the sr-only labels of cells scrolled out of view instead of widening the page.
              className="relative"
            />
            {data ? (
              <PaginationBar
                page={data.page ?? list.page}
                totalPages={data.total_pages ?? 1}
                count={count}
                pageSize={data.page_size ?? DEFAULT_PAGE_SIZE}
                onPageChange={list.setPage}
              />
            ) : null}
          </>
        )}
      </div>
    </>
  )
}
