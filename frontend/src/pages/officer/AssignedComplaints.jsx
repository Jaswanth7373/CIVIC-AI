/**
 * Assigned complaints (/officer/complaints) - page 17 of the requirements.
 *
 * GET /api/complaints/ scoped by the server: "Assigned to me" (default) or "My department"
 * (`?scope=department`). Search, status / category / severity / priority / date filters and the sort order
 * live in the URL (useComplaintFilters), so the topbar search, dashboard tiles and the back button all land
 * on the exact same list. The default order is the AI priority, highest first. Rows waiting for the
 * signed-in officer's acceptance can be accepted in place, on desktop and on phones.
 *
 * The queue is the work still to do: by default the status filter holds the officer's actionable statuses
 * (assigned, accepted, in progress, reopened - the dashboard's "Open work queue"), so finished work never sorts
 * above a job that is due today. "All statuses" (the switch above the list, or clearing the status filter -
 * `?status=` in the URL) brings resolved, verified, closed and rejected work orders back.
 *
 * List or map (`?view=map`, also in the URL): the map shows the same complaints - same scope, same filters - as
 * clustered pins from GET /api/complaints/map/, which is not paged (every match, the newest 3000 at most). Only
 * the visible view is requested; switching views loads the other one fresh.
 */
import { Building2, ClipboardCheck, ClipboardX, History, List, Map as MapIcon, RefreshCw, SearchX } from 'lucide-react'
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ComplaintFilters } from '@/components/complaints/ComplaintFilters'
import { useComplaintFilters } from '@/components/complaints/useComplaintFilters'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { PageHeader } from '@/components/ui/PageHeader'
import { Pagination } from '@/components/ui/Pagination'
import { TabPanel, Tabs } from '@/components/ui/Tabs'
import { useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { categoryService } from '@/services/categoryService'
import { complaintService } from '@/services/complaintService'
import { getErrorStatus } from '@/utils/errors'
import { formatNumber } from '@/utils/format'
import { ComplaintsMapCard } from './components/ComplaintsMapCard'
import { OfficerComplaintTable } from './components/OfficerComplaintTable'
import { useAcceptComplaint } from './components/useAcceptComplaint'
import { OPEN_WORK_STATUSES } from './components/officerUtils'
import { ViewToggle } from './components/ViewToggle'

const FILTER_DEFAULTS = { ordering: '-priority_score', status: OPEN_WORK_STATUSES }
const FILTER_CONTROLS = ['search', 'status', 'category', 'severity', 'priority', 'date', 'ordering', 'flags']
/** Pins have no order, so the map view's filter bar leaves out the sort control. */
const MAP_FILTER_CONTROLS = FILTER_CONTROLS.filter((control) => control !== 'ordering')
/** List-only params the map request leaves out: the map is not paged and the server sends the newest first. */
const LIST_ONLY_PARAMS = ['page', 'page_size', 'ordering']
const VIEW_OPTIONS = [
  { value: 'list', label: 'List', icon: List },
  { value: 'map', label: 'Map', icon: MapIcon },
]
const STATUS_SCOPE_OPTIONS = [
  { value: 'open', label: 'Open work' },
  { value: 'all', label: 'All statuses' },
]

/** 'open' (the actionable statuses), 'all' (no status filter) or null (some other status choice). */
function statusScopeOf(status) {
  if (!status.length) return 'all'
  const open = [...OPEN_WORK_STATUSES].sort().join(',')
  return [...status].sort().join(',') === open ? 'open' : null
}

const SCOPE_TABS_ID = 'officer-scope'
/**
 * The shared Pagination lays its Previous / Next buttons out as `inline-grid`, which stacks the chevron above
 * the label from the sm breakpoint; `inline-flex` keeps them on one line (reported to the UI owner).
 */
const PAGINATION_FIX = "mt-4 [&_button[aria-label$='page']]:inline-flex [&_button[aria-label$='page']]:items-center"

export default function AssignedComplaints() {
  const { user } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()
  const scope = searchParams.get('scope') === 'department' ? 'department' : 'mine'
  const view = searchParams.get('view') === 'map' ? 'map' : 'list'
  const list = useComplaintFilters({ defaults: FILTER_DEFAULTS })
  const params = useMemo(() => (scope === 'department' ? { ...list.params, scope: 'department' } : list.params), [list.params, scope])
  const mapParams = useMemo(
    () => Object.fromEntries(Object.entries(params).filter(([key]) => !LIST_ONLY_PARAMS.includes(key))),
    [params],
  )

  const { data, loading, error, refetch } = useApi(() => complaintService.list(params), [params], { immediate: view === 'list' })
  const mapQuery = useApi(() => complaintService.map(mapParams), [mapParams], { immediate: view === 'map' })
  const { data: categories } = useApi(() => categoryService.list(), [])
  // The scope tabs count what the list shows for each scope under the current status choice (open work by default).
  const statusKey = list.filters.status.join(',')
  const { data: scopeTotals } = useApi(
    () => {
      const status = statusKey || undefined
      return Promise.all([
        complaintService.list({ status, page_size: 1 }),
        complaintService.list({ status, scope: 'department', page_size: 1 }),
      ]).then(([mine, department]) => ({ mine: mine.count, department: department.count }))
    },
    [statusKey],
  )
  const { accept, acceptingId } = useAcceptComplaint({ onAccepted: () => refetch() })

  const department = user?.officer_profile?.department
  const departmentName = department?.name ?? 'your department'
  const rows = data?.results ?? []
  const statusScope = statusScopeOf(list.filters.status)
  // Filters beyond the open-work / all-statuses switch (which has its own wording below).
  const filtered = list.activeCount - (statusScope === 'all' ? 1 : 0) > 0 || statusScope === null || Boolean(list.filters.search)
  const pageMissing = getErrorStatus(error) === 404 && list.page > 1
  const setStatusScope = (next) => list.setFilters({ status: next === 'open' ? [...OPEN_WORK_STATUSES] : [] })
  const finished = statusScope === 'all' ? ', finished work included' : ''

  // The visible view's request drives the Refresh button and the summary line.
  const mapPoints = Array.isArray(mapQuery.data) ? mapQuery.data : null
  const active =
    view === 'map'
      ? { data: mapPoints, loading: mapQuery.loading, refetch: mapQuery.refetch, count: mapPoints?.length ?? 0 }
      : { data, loading, refetch, count: data?.count ?? 0 }

  const setScope = (next) => {
    setSearchParams((current) => {
      const nextParams = new URLSearchParams(current)
      if (next === 'department') nextParams.set('scope', 'department')
      else nextParams.delete('scope')
      nextParams.delete('page')
      return nextParams
    })
  }

  // The page number is kept, so going back to the list returns to the same page.
  const setView = (next) => {
    setSearchParams((current) => {
      const nextParams = new URLSearchParams(current)
      if (next === 'map') nextParams.set('view', 'map')
      else nextParams.delete('view')
      return nextParams
    })
  }

  const tabs = [
    { id: 'mine', label: 'Assigned to me', count: scopeTotals?.mine },
    { id: 'department', label: 'My department', count: scopeTotals?.department },
  ]

  const emptyState = filtered ? (
    <EmptyState
      bordered={false}
      compact
      icon={SearchX}
      title="No complaints match these filters"
      description="Clear a filter, widen the date range or check the spelling of the search."
      action={
        <Button variant="outline" onClick={list.resetFilters}>
          Clear all filters
        </Button>
      }
    />
  ) : scope === 'mine' && statusScope === 'open' ? (
    <EmptyState
      bordered={false}
      compact
      icon={ClipboardCheck}
      title="Your queue is clear"
      description="No open work orders right now. New ones appear here as soon as the AI routes a complaint to you."
      action={
        <Button variant="outline" leftIcon={History} onClick={() => setStatusScope('all')}>
          Show finished work too
        </Button>
      }
    />
  ) : scope === 'mine' ? (
    <EmptyState
      bordered={false}
      compact
      icon={ClipboardX}
      title="No complaints are assigned to you"
      description="New work orders appear here as soon as the AI routes a complaint to you. Meanwhile you can follow your department's complaints."
      action={
        <Button variant="outline" leftIcon={Building2} onClick={() => setScope('department')}>
          View department complaints
        </Button>
      }
    />
  ) : statusScope === 'open' ? (
    <EmptyState
      bordered={false}
      compact
      icon={ClipboardCheck}
      title={`No open complaints in ${departmentName}`}
      description="Complaints routed to your department by the AI appear here while they are being worked on."
      action={
        <Button variant="outline" leftIcon={History} onClick={() => setStatusScope('all')}>
          Show finished work too
        </Button>
      }
    />
  ) : (
    <EmptyState
      bordered={false}
      compact
      icon={ClipboardX}
      title={`No complaints in ${departmentName} yet`}
      description="Complaints routed to your department by the AI appear here."
    />
  )

  const mapEmptyMessage = filtered
    ? 'No complaints match these filters, so there is nothing to map.'
    : statusScope === 'open'
      ? 'No open work orders, so there is nothing to map.'
      : scope === 'mine'
        ? 'No complaints are assigned to you, so there is nothing to map.'
        : `No complaints in ${departmentName} yet, so there is nothing to map.`

  const count = active.count
  const summary =
    active.loading && !active.data
      ? view === 'map'
        ? 'Loading the map'
        : 'Loading complaints'
      : !active.data
        ? null
        : filtered
          ? `${formatNumber(count)} ${count === 1 ? 'complaint matches' : 'complaints match'} your filters`
          : scope === 'mine'
            ? statusScope === 'open'
              ? `${formatNumber(count)} open ${count === 1 ? 'work order is' : 'work orders are'} assigned to you`
              : `${formatNumber(count)} ${count === 1 ? 'complaint is' : 'complaints are'} assigned to you${finished}`
            : `${formatNumber(count)} ${statusScope === 'open' ? 'open ' : ''}${count === 1 ? 'complaint' : 'complaints'} in ${departmentName}${finished}`

  return (
    <>
      <PageHeader
        title="Assigned complaints"
        description="Search, filter and sort your work orders, or see where they are on the map. The AI priority decides the default order, so critical issues come first."
        actions={
          <>
            <ViewToggle label="Show complaints as" value={view} onChange={setView} options={VIEW_OPTIONS} />
            <Button
              variant="outline"
              leftIcon={RefreshCw}
              onClick={() => active.refetch()}
              loading={active.loading && Boolean(active.data)}
              disabled={active.loading && !active.data}
            >
              Refresh
            </Button>
          </>
        }
      />

      <Tabs tabs={tabs} value={scope} onChange={setScope} idPrefix={SCOPE_TABS_ID} label="Which complaints to show" className="mb-4" />

      <TabPanel tabId={scope} value={scope} idPrefix={SCOPE_TABS_ID} className="focus-visible:outline-offset-4">
        <ComplaintFilters
          {...list.bind}
          categories={categories ?? []}
          show={view === 'map' ? MAP_FILTER_CONTROLS : FILTER_CONTROLS}
          searchPlaceholder="Search number, title or area"
          className="mb-4"
        />

        <div className="mb-3 flex min-h-10 flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink" aria-live="polite">
              {summary}
            </p>
            {scope === 'department' && department ? (
              <p className="text-xs text-ink-3">Complaints routed to your department, whoever they are assigned to.</p>
            ) : null}
          </div>
          <ViewToggle label="Which work orders to show" value={statusScope} onChange={setStatusScope} options={STATUS_SCOPE_OPTIONS} />
        </div>

        {view === 'map' ? (
          <ComplaintsMapCard
            points={mapPoints}
            loading={mapQuery.loading}
            error={mapQuery.error}
            onRetry={() => mapQuery.refetch()}
            emptyMessage={mapEmptyMessage}
          />
        ) : (
          <>
            {error && data && !pageMissing ? (
              <Alert
                tone="danger"
                title="The list could not be refreshed"
                className="mb-3"
                action={
                  <Button size="sm" variant="outline" leftIcon={RefreshCw} onClick={() => refetch()}>
                    Try again
                  </Button>
                }
              >
                Showing the last results that loaded.
              </Alert>
            ) : null}

            {pageMissing ? (
              <EmptyState
                icon={SearchX}
                title="This page of results is empty"
                description="The list got shorter since this page was opened."
                action={<Button onClick={() => list.setPage(1)}>Go to the first page</Button>}
              />
            ) : error && !data ? (
              <ErrorState title="The complaints could not be loaded" error={error} onRetry={() => refetch()} />
            ) : (
              <>
                <OfficerComplaintTable
                  complaints={rows}
                  loading={loading}
                  sort={list.filters.ordering || FILTER_DEFAULTS.ordering}
                  onSortChange={(ordering) => list.setFilters({ ordering })}
                  currentUserId={user?.id}
                  onAccept={accept}
                  acceptingId={acceptingId}
                  showOfficer={scope === 'department'}
                  caption={scope === 'mine' ? 'Complaints assigned to you' : `Complaints in ${departmentName}`}
                  empty={emptyState}
                />
                {data ? (
                  <Pagination
                    page={data.page ?? list.page}
                    totalPages={data.total_pages}
                    count={data.count}
                    pageSize={data.page_size}
                    onPageChange={list.setPage}
                    className={PAGINATION_FIX}
                  />
                ) : null}
              </>
            )}
          </>
        )}
      </TabPanel>
    </>
  )
}
