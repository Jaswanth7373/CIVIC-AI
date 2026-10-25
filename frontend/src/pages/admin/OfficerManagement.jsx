/**
 * Officer management (admin) - the field officers of every department, their workload and track record.
 *
 * Data: GET /officers/ (filters `department`, `is_available`, `is_active`, `search`; `ordering` by name,
 * stat_active_workload, stat_resolved_count, stat_avg_rating; paginated) + GET /departments/.
 * - Workload bar = active_workload / max_active_complaints ("Over capacity" once active > capacity).
 * - The availability switch saves immediately (PATCH {is_available}) and is undone if the API refuses.
 * - Create / edit in a modal with the base location on a map (lazy-loaded); the workload drawer shows the
 *   officer's open queue (GET /officers/{id}/workload/); deactivate = DELETE (account kept, history kept).
 * - `?search=` (from User management) and `?new=1` (from "Add an officer instead") are honoured on arrival.
 */
import { BarChart3, HardHat, MoreHorizontal, Pencil, Power, PowerOff, SearchX, UserPlus } from 'lucide-react'
import { Suspense, lazy, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DepartmentBadge } from '@/components/complaints'
import {
  Badge,
  Button,
  DataTable,
  DropdownMenu,
  EmptyState,
  ErrorState,
  IconButton,
  PageHeader,
  SearchInput,
  Select,
  StarRating,
  Switch,
} from '@/components/ui'
import { useApi } from '@/hooks/useApi'
import { useConfirm } from '@/hooks/useConfirm'
import { useToast } from '@/hooks/useToast'
import { departmentService, officerService } from '@/services'
import { getErrorMessage } from '@/utils/errors'
import { formatHours, formatNumber } from '@/utils/format'
import { ListPagination, PersonCell, SummaryLine } from './manage/shared/Controls'
import { WorkloadBar } from './manage/shared/WorkloadBar'
import { compactParams, officerName, toList } from './manage/shared/listUtils'
import { useUrlParams } from './manage/shared/useUrlParams'
import { WorkloadDrawer } from './manage/officers/WorkloadDrawer'

const OfficerFormModal = lazy(() => import('./manage/officers/OfficerFormModal'))

const PAGE_SIZE = 20
const DEFAULTS = { search: '', department: '', is_available: '', is_active: '', ordering: 'user__first_name' }
const AVAILABILITY_FILTER = [
  { value: '', label: 'Any availability' },
  { value: 'true', label: 'Available' },
  { value: 'false', label: 'Unavailable' },
]
const ACCOUNT_FILTER = [
  { value: '', label: 'Any account' },
  { value: 'true', label: 'Active accounts' },
  { value: 'false', label: 'Deactivated' },
]

function RatingCell({ value }) {
  if (value === null || value === undefined) return <span className="text-xs text-ink-3">No ratings</span>
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <StarRating value={value} readOnly size="sm" label="Average rating" />
      <span className="font-semibold tabular">{formatNumber(value, { digits: 1 })}</span>
    </span>
  )
}

export default function OfficerManagement() {
  const toast = useToast()
  const confirm = useConfirm()
  const [searchParams, setSearchParams] = useSearchParams()
  const { values, setValues, page, setPage, reset } = useUrlParams(DEFAULTS)
  const [form, setForm] = useState({ open: searchParams.get('new') === '1', officer: null, session: 0 })
  const [formLoaded, setFormLoaded] = useState(searchParams.get('new') === '1')
  const [workloadState, setWorkloadState] = useState({ open: false, officer: null })
  const [pendingId, setPendingId] = useState(null)

  const officers = useApi(() => officerService.list(compactParams({ ...values, page, page_size: PAGE_SIZE })), [values, page])
  const departments = useApi(() => departmentService.list({ include_inactive: true }), [])
  const rows = toList(officers.data)
  const departmentRows = toList(departments.data)
  const filtered = Boolean(values.search || values.department || values.is_available || values.is_active)

  const openForm = (officer = null) => {
    setFormLoaded(true)
    setForm((current) => ({ open: true, officer, session: current.session + 1 }))
  }
  const closeForm = () => {
    setForm((current) => ({ ...current, open: false }))
    if (searchParams.get('new')) {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current)
          next.delete('new')
          return next
        },
        { replace: true },
      )
    }
  }

  const replaceRow = (updated) => {
    officers.setData((current) =>
      current && Array.isArray(current.results)
        ? { ...current, results: current.results.map((row) => (row.id === updated.id ? { ...row, ...updated } : row)) }
        : current,
    )
  }

  const toggleAvailability = async (row, available) => {
    const name = officerName(row)
    replaceRow({ id: row.id, is_available: available })
    setPendingId(row.id)
    try {
      const saved = await officerService.update(row.id, { is_available: available })
      replaceRow(saved)
      toast.success(available ? `${name} is available` : `${name} is unavailable`, available ? 'New complaints can be assigned to them.' : 'They are ranked last for new assignments.')
    } catch (error) {
      replaceRow({ id: row.id, is_available: row.is_available })
      toast.error('Could not change the availability', getErrorMessage(error))
    } finally {
      setPendingId(null)
    }
  }

  const deactivate = async (row) => {
    const name = officerName(row)
    const ok = await confirm({
      title: `Deactivate ${name}?`,
      message: `${name} can no longer sign in and gets no new work. Assignments and history are kept${
        row.active_workload ? `; ${row.active_workload} open complaint(s) must be reassigned` : ''
      }.`,
      confirmLabel: 'Deactivate officer',
      tone: 'danger',
    })
    if (!ok) return
    setPendingId(row.id)
    try {
      const result = await officerService.remove(row.id)
      if (result?.open_complaints) toast.warning('Officer deactivated', result.detail)
      else toast.success('Officer deactivated', result?.detail ?? `${name} can no longer sign in.`)
      officers.refetch()
    } catch (error) {
      toast.error('Could not deactivate the officer', getErrorMessage(error))
    } finally {
      setPendingId(null)
    }
  }

  const reactivate = async (row) => {
    const name = officerName(row)
    const ok = await confirm({
      title: `Reactivate ${name}?`,
      message: 'They can sign in again. Switch on availability when they should receive new assignments.',
      confirmLabel: 'Reactivate officer',
      tone: 'primary',
    })
    if (!ok) return
    setPendingId(row.id)
    try {
      const saved = await officerService.update(row.id, { is_active: true })
      replaceRow(saved)
      toast.success('Officer reactivated', `${name} can sign in again.`)
    } catch (error) {
      toast.error('Could not reactivate the officer', getErrorMessage(error))
    } finally {
      setPendingId(null)
    }
  }

  // Shared by the table's last column and the phone cards (below md the table renders as cards only).
  const actionsMenu = (row) => (
    <DropdownMenu
      label={`Actions for ${officerName(row)}`}
      trigger={<IconButton icon={MoreHorizontal} label={`Actions for ${officerName(row)}`} size="sm" loading={pendingId === row.id} />}
      items={[
        { label: 'View workload', icon: BarChart3, onClick: () => setWorkloadState({ open: true, officer: row }) },
        { label: 'Edit officer', icon: Pencil, onClick: () => openForm(row) },
        { divider: true },
        row.user?.is_active === false
          ? { label: 'Reactivate officer', icon: Power, onClick: () => reactivate(row) }
          : { label: 'Deactivate officer', icon: PowerOff, danger: true, onClick: () => deactivate(row) },
      ]}
    />
  )

  const columns = [
    {
      key: 'officer',
      header: 'Officer',
      sortable: true,
      sortKey: 'user__first_name',
      className: 'max-w-64',
      render: (row) => (
        <PersonCell
          name={officerName(row)}
          avatar={row.user?.avatar}
          secondary={[row.employee_id, row.designation].filter(Boolean).join(', ') || row.user?.email}
        />
      ),
    },
    {
      key: 'department',
      header: 'Department',
      render: (row) => (
        <div className="flex flex-col items-start gap-1">
          <DepartmentBadge department={row.department} size="sm" emptyLabel="No department" />
          {row.zone ? <span className="max-w-48 truncate text-xs text-ink-3" title={row.zone}>{row.zone}</span> : null}
        </div>
      ),
    },
    {
      key: 'workload',
      header: 'Workload',
      sortable: true,
      sortKey: 'stat_active_workload',
      render: (row) => (
        <WorkloadBar active={row.active_workload} capacity={row.max_active_complaints} compact className="w-32" />
      ),
    },
    {
      key: 'resolved',
      header: 'Resolved',
      align: 'right',
      sortable: true,
      sortKey: 'stat_resolved_count',
      render: (row) => <span className="font-semibold tabular">{formatNumber(row.resolved_count ?? 0)}</span>,
    },
    {
      key: 'time',
      header: 'Avg. time',
      align: 'right',
      hideOnMobile: true,
      render: (row) => <span className="whitespace-nowrap tabular">{formatHours(row.avg_resolution_hours)}</span>,
    },
    {
      key: 'rating',
      header: 'Rating',
      sortable: true,
      sortKey: 'stat_avg_rating',
      hideOnMobile: true,
      render: (row) => <RatingCell value={row.avg_rating} />,
    },
    {
      key: 'available',
      header: 'Available',
      render: (row) =>
        row.user?.is_active === false ? (
          <Badge tone="neutral" size="sm" dot>
            Deactivated
          </Badge>
        ) : (
          <Switch
            checked={Boolean(row.is_available)}
            disabled={pendingId === row.id}
            onCheckedChange={(checked) => toggleAvailability(row, checked)}
            aria-label={`${officerName(row)} available for new assignments`}
          />
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: actionsMenu,
    },
  ]

  const departmentOptions = [
    { value: '', label: 'All departments' },
    ...departmentRows.map((department) => ({ value: String(department.id), label: department.name })),
  ]

  return (
    <>
      <PageHeader
        title="Officers"
        description="Field officers by department, with their live workload, resolutions and citizen ratings. Availability decides who the AI recommends for new complaints."
        actions={
          <Button leftIcon={UserPlus} onClick={() => openForm(null)}>
            Add officer
          </Button>
        }
      />

      <div className="mb-3 flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
        <SearchInput
          value={values.search}
          onSearch={(search) => setValues({ search })}
          placeholder="Search name, email, employee id or zone"
          label="Search officers"
          className="lg:max-w-sm lg:flex-1"
        />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex">
          <Select
            aria-label="Department"
            value={values.department}
            onChange={(event) => setValues({ department: event.target.value })}
            options={departmentOptions}
            containerClassName="col-span-2 sm:col-span-1 lg:w-52"
            className={values.department ? 'border-primary' : undefined}
          />
          <Select
            aria-label="Availability"
            value={values.is_available}
            onChange={(event) => setValues({ is_available: event.target.value })}
            options={AVAILABILITY_FILTER}
            containerClassName="lg:w-44"
            className={values.is_available ? 'border-primary' : undefined}
          />
          <Select
            aria-label="Account"
            value={values.is_active}
            onChange={(event) => setValues({ is_active: event.target.value })}
            options={ACCOUNT_FILTER}
            containerClassName="lg:w-44"
            className={values.is_active ? 'border-primary' : undefined}
          />
        </div>
        {filtered ? (
          <Button variant="ghost" size="sm" onClick={reset}>
            Clear filters
          </Button>
        ) : null}
      </div>

      <SummaryLine className="mb-2" count={officers.data?.count} noun="officer" loading={officers.loading && Boolean(officers.data)} />

      {officers.error && !officers.data ? (
        <ErrorState title="Officers could not be loaded" error={officers.error} onRetry={() => officers.refetch()} />
      ) : (
        <DataTable
          caption="Officers"
          className="relative [&_td]:px-3 [&_th]:px-3"
          columns={columns}
          data={rows}
          loading={officers.loading}
          rowKey="id"
          sort={values.ordering}
          onSortChange={(ordering) => setValues({ ordering })}
          onRowClick={(row) => setWorkloadState({ open: true, officer: row })}
          empty={
            filtered ? (
              <EmptyState
                bordered={false}
                icon={SearchX}
                title="No officers match"
                description="Try another name, or clear the department and availability filters."
                action={
                  <Button variant="outline" onClick={reset}>
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <EmptyState
                bordered={false}
                icon={HardHat}
                title="No officers yet"
                description="Add the first field officer so complaints can be assigned automatically."
                action={
                  <Button leftIcon={UserPlus} onClick={() => openForm(null)}>
                    Add officer
                  </Button>
                }
              />
            )
          }
          mobileCard={(row) => (
            <div className="space-y-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <PersonCell name={officerName(row)} avatar={row.user?.avatar} secondary={row.employee_id || row.user?.email} size="md" />
                <div className="-mr-1.5 flex shrink-0 items-center gap-2">
                  {row.user?.is_active === false ? (
                    <Badge tone="neutral" size="sm" dot>
                      Deactivated
                    </Badge>
                  ) : (
                    <Switch
                      checked={Boolean(row.is_available)}
                      disabled={pendingId === row.id}
                      onCheckedChange={(checked) => toggleAvailability(row, checked)}
                      aria-label={`${officerName(row)} available for new assignments`}
                    />
                  )}
                  {actionsMenu(row)}
                </div>
              </div>
              <DepartmentBadge department={row.department} size="sm" emptyLabel="No department" />
              <WorkloadBar active={row.active_workload} capacity={row.max_active_complaints} />
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-2">
                <span>
                  <span className="font-semibold text-ink tabular">{formatNumber(row.resolved_count ?? 0)}</span> resolved, avg.{' '}
                  {formatHours(row.avg_resolution_hours)}
                </span>
                <RatingCell value={row.avg_rating} />
              </div>
            </div>
          )}
        />
      )}

      <ListPagination data={officers.data} page={page} pageSize={PAGE_SIZE} onPageChange={setPage} />

      <WorkloadDrawer
        open={workloadState.open}
        onClose={() => setWorkloadState((current) => ({ ...current, open: false }))}
        officer={workloadState.officer}
        onEdit={(officer) => {
          setWorkloadState((current) => ({ ...current, open: false }))
          openForm(officer)
        }}
      />

      {formLoaded ? (
        <Suspense fallback={null}>
          <OfficerFormModal
            key={form.session}
            open={form.open}
            onClose={closeForm}
            officer={form.officer}
            departments={departmentRows}
            onSaved={() => {
              closeForm()
              officers.refetch()
            }}
          />
        </Suspense>
      ) : null}
    </>
  )
}
