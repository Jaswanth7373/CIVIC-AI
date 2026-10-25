/**
 * All complaints (admin) - every complaint across departments, as a sortable table or a map.
 *
 * Data: GET /complaints/ (admin scope = all) with the filters of BUILD_SPEC 4.2. Every filter lives in the URL
 * (useComplaintFilters + `assigned_officer` + `view`), so a filtered list can be bookmarked, shared and
 * restored with the back button; the topbar search lands here with `?search=`.
 * - Filter bar: search, statuses (multi), category, severity, priority, department, reported date range and
 *   sort order (ComplaintFilters), plus the assigned officer.
 * - Quick chips: Critical / Unassigned / Overdue / Duplicates / Needs review, each with the live number of
 *   complaints it would show together with the other active filters (one `page_size=1` count per chip).
 * - Table: number + title, category + department, officer, priority gauge, severity, status + SLA, reported
 *   (ten fields in seven columns so a row fits a 1440 px screen); priority, severity and date sort on the
 *   server (`ordering`); rows open /admin/complaints/:id. Phones get complaint cards.
 * - Map: the same filters on GET /complaints/map/ (lazy-loaded Leaflet panel).
 */
import { ClipboardList, List, Map as MapIcon, SearchX } from 'lucide-react'
import { Suspense, lazy, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  CategoryBadge,
  ComplaintFilters,
  ComplaintTable,
  DepartmentBadge,
  PriorityMeter,
  SLAIndicator,
  StatusBadge,
  useComplaintFilters,
} from '@/components/complaints'
import { Alert, Button, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui'
import { useApi } from '@/hooks/useApi'
import { categoryService, complaintService, departmentService, officerService, userService } from '@/services'
import { COMPLAINT_ORDERING_OPTIONS, LEVEL_META } from '@/utils/constants'
import { FilterChip, ListPagination, SegmentedControl, SummaryLine } from './manage/shared/Controls'
import { OfficerSelect } from './manage/shared/OfficerSelect'
import { compactParams, omitKeys, toList } from './manage/shared/listUtils'
import { QUICK_FILTERS } from './manage/complaints/quickFilters'

const ComplaintsMapPanel = lazy(() => import('./manage/complaints/ComplaintsMapPanel'))

const PAGE_SIZE = 20
const DEFAULT_ORDERING = COMPLAINT_ORDERING_OPTIONS[0].value
const FILTER_CONTROLS = ['search', 'status', 'category', 'severity', 'priority', 'department', 'date', 'ordering']
const VIEW_OPTIONS = [
  { value: 'list', label: 'List', icon: List },
  { value: 'map', label: 'Map', icon: MapIcon },
]

/** Priority column: the segmented 0-100 gauge plus the score and level in words. */
function PriorityCell({ complaint }) {
  const meta = LEVEL_META[complaint.priority_level]
  const hasScore = complaint.priority_score !== null && complaint.priority_score !== undefined
  return (
    <div className="w-24">
      <PriorityMeter size="sm" score={complaint.priority_score} level={complaint.priority_level} />
      <p className="mt-1 flex items-baseline gap-1.5 text-xs">
        <span className="font-bold text-ink tabular">{hasScore ? Math.round(complaint.priority_score) : '—'}</span>
        <span className="text-ink-3">{meta?.label ?? 'Not scored'}</span>
      </p>
    </div>
  )
}

/*
 * Ten fields in seven columns, so the whole row fits a 1440 px screen next to the sidebar: the department sits
 * under the category, the SLA countdown under the status (narrower screens scroll inside the table).
 */
const TABLE_COLUMNS = [
  {
    key: 'complaint',
    header: 'Complaint',
    // The width cap sits on the inner block: browsers ignore max-width on table cells in automatic layout.
    render: (row) => (
      <div className="min-w-0 max-w-60">
        <p className="text-xs font-semibold text-ink-3 tabular">{row.complaint_number}</p>
        <p className="line-clamp-2 font-semibold leading-snug text-ink" title={row.title}>
          {row.title || row.description}
        </p>
      </div>
    ),
  },
  {
    key: 'category',
    header: 'Category and department',
    render: (row) => (
      <div className="flex flex-col items-start gap-1">
        <CategoryBadge category={row.category} size="sm" />
        <DepartmentBadge department={row.department} size="sm" />
      </div>
    ),
  },
  'officer',
  {
    key: 'priority',
    header: 'Priority',
    sortable: true,
    sortKey: 'priority_score',
    render: (row) => <PriorityCell complaint={row} />,
  },
  'severity',
  {
    key: 'status',
    header: 'Status and SLA',
    render: (row) => (
      <div className="flex flex-col items-start gap-1">
        <StatusBadge status={row.status} label={row.status_display} size="sm" />
        <SLAIndicator
          compact
          dueAt={row.sla_due_at}
          status={row.status}
          resolvedAt={row.resolved_at}
          isOverdue={row.is_overdue}
          createdAt={row.created_at}
        />
      </div>
    ),
  },
  'date',
]

function MapFallback() {
  return <Skeleton className="h-[420px] w-full rounded-xl sm:h-[560px] xl:h-[640px]" />
}

export default function AllComplaints() {
  const list = useComplaintFilters({ pageSize: PAGE_SIZE })
  const [searchParams, setSearchParams] = useSearchParams()
  const officerId = searchParams.get('assigned_officer') ?? ''
  const citizenId = /^\d+$/.test(searchParams.get('citizen') ?? '') ? searchParams.get('citizen') : ''
  const view = searchParams.get('view') === 'map' ? 'map' : 'list'

  const setUrlParam = (key, value, { resetPage = true } = {}) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (value) next.set(key, value)
        else next.delete(key)
        if (resetPage) next.delete('page')
        return next
      },
      { replace: true },
    )
  }

  const categories = useApi(() => categoryService.list(), [])
  const departments = useApi(() => departmentService.list(), [])
  const officers = useApi(() => officerService.list({ page_size: 100 }), [])
  const citizen = useApi(() => userService.get(citizenId), [citizenId], { immediate: Boolean(citizenId) })

  const apiParams = useMemo(
    () => compactParams({ ...list.params, assigned_officer: officerId, citizen: citizenId }),
    [list.params, officerId, citizenId],
  )
  const baseParams = useMemo(() => omitKeys(apiParams, ['page', 'page_size', 'ordering']), [apiParams])

  const complaints = useApi(() => complaintService.list(apiParams), [apiParams], { immediate: view === 'list' })

  // Live count behind every quick chip: the current filters with that chip applied (cheap page_size=1 calls).
  const chipCounts = useApi(
    () =>
      Promise.all(
        QUICK_FILTERS.map((chip) => complaintService.list({ ...baseParams, ...chip.params, page_size: 1 }).then((page) => page?.count ?? 0)),
      ),
    [baseParams],
  )

  const rows = toList(complaints.data)
  const count = complaints.data?.count
  const officerRows = toList(officers.data)
  const hasFilters = list.activeCount > 0 || Boolean(list.filters.search) || Boolean(officerId) || Boolean(citizenId)
  const selectedOfficer = officerRows.find((officer) => String(officer.id) === officerId)

  const clearEverything = () => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        ;[...Object.keys(list.filters), 'assigned_officer', 'citizen', 'page'].forEach((key) => next.delete(key))
        return next
      },
      { replace: true },
    )
  }

  const emptyState = hasFilters ? (
    <EmptyState
      bordered={false}
      icon={SearchX}
      title="No complaints match these filters"
      description="Remove a filter, widen the date range or search for a different number, title or area."
      action={
        <Button variant="outline" onClick={clearEverything}>
          Clear all filters
        </Button>
      }
    />
  ) : (
    <EmptyState
      bordered={false}
      icon={ClipboardList}
      title="No complaints have been reported yet"
      description="Complaints appear here the moment a citizen reports an issue and the AI engine has analysed it."
    />
  )

  return (
    <>
      <PageHeader
        title="All complaints"
        description="Every complaint across departments. Filter the queue, then open a complaint to assign an officer, correct the AI or move it along its lifecycle."
        actions={
          <SegmentedControl
            label="Show complaints as"
            value={view}
            onChange={(next) => setUrlParam('view', next === 'map' ? 'map' : '', { resetPage: false })}
            options={VIEW_OPTIONS}
          />
        }
      />

      <section aria-label="Filters" className="mb-4 space-y-3">
        <ComplaintFilters
          {...list.bind}
          show={FILTER_CONTROLS}
          categories={toList(categories.data)}
          departments={toList(departments.data)}
          searchPlaceholder="Search number, title, description or area"
        />
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          {/* py-1.5 / -my-1.5: room for the 6 px focus ring inside the phone scroller; from md the chips wrap, nothing clips */}
          <div
            role="group"
            aria-label="Quick filters"
            className="scrollbar-none relative -mx-4 -my-1.5 flex gap-2 overflow-x-auto px-4 py-1.5 md:mx-0 md:flex-wrap md:overflow-visible md:px-0"
          >
            {QUICK_FILTERS.map((chip, index) => {
              const active = chip.isActive(list.filters)
              return (
                <FilterChip
                  key={chip.key}
                  active={active}
                  label={chip.label}
                  icon={chip.icon}
                  iconTone={chip.iconTone}
                  description={chip.description}
                  count={chipCounts.data?.[index] ?? null}
                  countLoading={chipCounts.loading && !chipCounts.data}
                  onClick={() => list.setFilters(chip.toggle(active))}
                />
              )
            })}
          </div>
          <OfficerSelect
            officers={officerRows}
            value={officerId}
            onChange={(value) => setUrlParam('assigned_officer', value)}
            placeholder={officers.loading && !officers.data ? 'Loading officers…' : 'Any assigned officer'}
            aria-label="Assigned officer"
            containerClassName="md:w-64 md:shrink-0"
            className={officerId ? 'border-primary' : undefined}
          />
        </div>
        {selectedOfficer ? (
          <p className="text-xs text-ink-3">
            Showing complaints assigned to <span className="font-semibold text-ink-2">{selectedOfficer.user?.full_name}</span>.{' '}
            <button type="button" onClick={() => setUrlParam('assigned_officer', '')} className="font-semibold text-primary-ink hover:underline">
              Show every officer
            </button>
          </p>
        ) : null}
        {citizenId ? (
          <p className="text-xs text-ink-3">
            Showing complaints reported by{' '}
            <span className="font-semibold text-ink-2">{citizen.data?.full_name ?? citizen.data?.email ?? 'one citizen'}</span>.{' '}
            <button type="button" onClick={() => setUrlParam('citizen', '')} className="font-semibold text-primary-ink hover:underline">
              Show every citizen
            </button>
          </p>
        ) : null}
      </section>

      {view === 'map' ? (
        <Suspense fallback={<MapFallback />}>
          <ComplaintsMapPanel params={baseParams} />
        </Suspense>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <SummaryLine count={count} noun="complaint" loading={complaints.loading && Boolean(complaints.data)}>
              {typeof count === 'number' ? (
                <span className="text-ink-3">
                  sorted by{' '}
                  {(COMPLAINT_ORDERING_OPTIONS.find((option) => option.value === (list.filters.ordering || DEFAULT_ORDERING))?.label ?? 'newest first').toLowerCase()}
                </span>
              ) : null}
            </SummaryLine>
          </div>

          {complaints.error && complaints.data ? (
            <Alert
              tone="danger"
              title="The list could not be refreshed"
              className="mb-3"
              action={
                <Button size="sm" variant="outline" onClick={() => complaints.refetch()}>
                  Try again
                </Button>
              }
            >
              Showing the last loaded results.
            </Alert>
          ) : null}

          {complaints.error && !complaints.data ? (
            <ErrorState title="Complaints could not be loaded" error={complaints.error} onRetry={() => complaints.refetch()} />
          ) : (
            <ComplaintTable
              complaints={rows}
              basePath="/admin/complaints"
              columns={TABLE_COLUMNS}
              loading={complaints.loading}
              sort={list.filters.ordering || DEFAULT_ORDERING}
              onSortChange={(ordering) => list.setFilters({ ordering })}
              caption="All complaints"
              empty={emptyState}
              className="relative [&_td]:px-3 [&_th]:px-3"
            />
          )}

          <ListPagination data={complaints.data} page={list.page} pageSize={PAGE_SIZE} onPageChange={list.setPage} />
        </>
      )}
    </>
  )
}
