/**
 * DepartmentsTab - the departments that receive complaints, with their deadline, contacts and live counts.
 *
 * Data: GET /departments/?include_inactive=true (non-paginated; officer / category / open / total counts are
 * SQL annotations). Delete = DELETE /departments/{id}/: an unused department is deleted (204); one that still
 * has complaints, officers or categories is deactivated instead (200 + `deactivated: true`), which the toast
 * explains. Inactive departments can be activated again.
 */
import { Building2, Mail, MoreHorizontal, Pencil, Phone, Plus, Power, Trash2, UserRound } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { DataTable } from '@/components/ui/DataTable'
import { DropdownMenu } from '@/components/ui/DropdownMenu'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { IconButton } from '@/components/ui/IconButton'
import { useApi } from '@/hooks/useApi'
import { useConfirm } from '@/hooks/useConfirm'
import { useToast } from '@/hooks/useToast'
import { departmentService } from '@/services'
import { getErrorMessage } from '@/utils/errors'
import { formatHours, formatNumber } from '@/utils/format'
import { SummaryLine } from '../shared/Controls'
import { IconPlate } from '../shared/FormControls'
import { toList } from '../shared/listUtils'
import { DepartmentFormModal } from './DepartmentFormModal'

function Contacts({ department }) {
  const items = [
    department.head_name ? { icon: UserRound, text: department.head_name } : null,
    department.email ? { icon: Mail, text: department.email, href: `mailto:${department.email}` } : null,
    department.phone ? { icon: Phone, text: department.phone, href: `tel:${department.phone}` } : null,
  ].filter(Boolean)
  if (!items.length) return <span className="text-xs text-ink-3">No contact set</span>
  return (
    <ul className="space-y-0.5 text-xs">
      {items.map((item) => (
        <li key={item.text} className="flex min-w-0 items-center gap-1.5 text-ink-2">
          <item.icon aria-hidden className="size-3.5 shrink-0 text-ink-3" />
          {item.href ? (
            <a href={item.href} className="truncate hover:text-ink hover:underline">
              {item.text}
            </a>
          ) : (
            <span className="truncate">{item.text}</span>
          )}
        </li>
      ))}
    </ul>
  )
}

export function DepartmentsTab() {
  const toast = useToast()
  const confirm = useConfirm()
  const departments = useApi(() => departmentService.list({ include_inactive: true }), [])
  const [form, setForm] = useState({ open: false, department: null, session: 0 })
  const [pendingId, setPendingId] = useState(null)
  const rows = toList(departments.data)

  const openForm = (department = null) => setForm((current) => ({ open: true, department, session: current.session + 1 }))
  const closeForm = () => setForm((current) => ({ ...current, open: false }))

  const remove = async (department) => {
    const ok = await confirm({
      title: `Delete ${department.name}?`,
      message:
        'A department that still has complaints, officers or categories is deactivated instead, so its history and routing stay intact. An unused department is deleted.',
      confirmLabel: 'Delete department',
      tone: 'danger',
    })
    if (!ok) return
    setPendingId(department.id)
    try {
      const result = await departmentService.remove(department.id)
      if (result?.deactivated) toast.warning('Department deactivated instead', result.detail)
      else toast.success('Department deleted', `${department.name} was removed.`)
      departments.refetch()
    } catch (error) {
      toast.error('Could not delete the department', getErrorMessage(error))
    } finally {
      setPendingId(null)
    }
  }

  const activate = async (department) => {
    setPendingId(department.id)
    try {
      await departmentService.update(department.id, { is_active: true })
      toast.success('Department activated', `${department.name} receives complaints again.`)
      departments.refetch()
    } catch (error) {
      toast.error('Could not activate the department', getErrorMessage(error))
    } finally {
      setPendingId(null)
    }
  }

  // Shared by the table's last column and the phone cards (below md the table renders as cards only).
  const actionsMenu = (row) => (
    <DropdownMenu
      label={`Actions for ${row.name}`}
      trigger={<IconButton icon={MoreHorizontal} label={`Actions for ${row.name}`} size="sm" loading={pendingId === row.id} />}
      items={[
        { label: 'Edit department', icon: Pencil, onClick: () => openForm(row) },
        !row.is_active ? { label: 'Activate department', icon: Power, onClick: () => activate(row) } : null,
        { divider: true },
        { label: 'Delete department', icon: Trash2, danger: true, onClick: () => remove(row) },
      ].filter(Boolean)}
    />
  )

  const columns = [
    {
      key: 'name',
      header: 'Department',
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <IconPlate icon={row.icon} color={row.color} />
          <span className="min-w-0">
            <span className="block truncate font-semibold text-ink">{row.name}</span>
            <span className="block text-xs text-ink-3 tabular">{row.code}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'sla',
      header: 'SLA',
      render: (row) => (
        <span className="whitespace-nowrap tabular">
          {formatHours(row.sla_hours)}
          <span className="block text-xs text-ink-3">{formatNumber(row.sla_hours)} h</span>
        </span>
      ),
    },
    { key: 'contacts', header: 'Contacts', hideOnMobile: true, className: 'max-w-56', render: (row) => <Contacts department={row} /> },
    { key: 'officers', header: 'Officers', align: 'right', render: (row) => <span className="font-semibold tabular">{formatNumber(row.officer_count)}</span> },
    {
      key: 'categories',
      header: 'Categories',
      align: 'right',
      hideOnMobile: true,
      render: (row) => <span className="font-semibold tabular">{formatNumber(row.category_count)}</span>,
    },
    {
      key: 'complaints',
      header: 'Open / total',
      align: 'right',
      render: (row) => (
        <span className="whitespace-nowrap tabular">
          <span className="font-semibold text-ink">{formatNumber(row.open_complaints)}</span>
          <span className="text-ink-3"> / {formatNumber(row.total_complaints)}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge tone={row.is_active ? 'green' : 'neutral'} size="sm" dot>
          {row.is_active ? 'Active' : 'Inactive'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: actionsMenu,
    },
  ]

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SummaryLine count={departments.data ? rows.length : undefined} noun="department" loading={departments.loading && Boolean(departments.data)}>
          {departments.data ? (
            <span className="text-ink-3">{formatNumber(rows.filter((row) => row.is_active).length)} active</span>
          ) : null}
        </SummaryLine>
        <Button leftIcon={Plus} onClick={() => openForm(null)}>
          Add department
        </Button>
      </div>

      {departments.error && !departments.data ? (
        <ErrorState title="Departments could not be loaded" error={departments.error} onRetry={() => departments.refetch()} />
      ) : (
        <DataTable
          caption="Departments"
          className="relative"
          columns={columns}
          data={rows}
          loading={departments.loading}
          rowKey="id"
          onRowClick={(row) => openForm(row)}
          rowClassName={(row) => (row.is_active ? undefined : 'opacity-70')}
          empty={
            <EmptyState
              bordered={false}
              icon={Building2}
              title="No departments yet"
              description="Add the departments that resolve complaints, then route categories to them."
              action={
                <Button leftIcon={Plus} onClick={() => openForm(null)}>
                  Add department
                </Button>
              }
            />
          }
          mobileCard={(row) => (
            <div className="flex items-start gap-3 p-4">
              <IconPlate icon={row.icon} color={row.color} />
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-semibold text-ink">{row.name}</p>
                  <Badge tone={row.is_active ? 'green' : 'neutral'} size="sm" dot>
                    {row.is_active ? 'Active' : 'Inactive'}
                  </Badge>
                </div>
                <p className="text-xs text-ink-3 tabular">
                  {row.code}, SLA {formatHours(row.sla_hours)}
                </p>
                <p className="mt-1.5 text-xs text-ink-2 tabular">
                  {formatNumber(row.officer_count)} officers, {formatNumber(row.open_complaints)} open of {formatNumber(row.total_complaints)} complaints
                </p>
              </div>
              <div className="-mr-1.5 -mt-1 shrink-0">{actionsMenu(row)}</div>
            </div>
          )}
        />
      )}

      <DepartmentFormModal
        key={form.session}
        open={form.open}
        onClose={closeForm}
        department={form.department}
        onSaved={() => {
          closeForm()
          departments.refetch()
        }}
      />
    </div>
  )
}

export default DepartmentsTab
