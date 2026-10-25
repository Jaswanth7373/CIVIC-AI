/**
 * CategoriesTab - the civic categories citizens report and the AI engine predicts.
 *
 * Data: GET /categories/?include_inactive=true + GET /departments/?include_inactive=true (for the form).
 * The note at the top says what makes the platform extensible: a category added here is used by the AI
 * engine at once through its keywords and vision labels - no code change, no retraining.
 * Delete = DELETE /categories/{id}/: unused -> deleted (204); referenced by complaints or AI predictions ->
 * deactivated instead (200 + `deactivated: true`).
 */
import { Brain, MoreHorizontal, Pencil, Plus, Power, Tag, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { DepartmentBadge } from '@/components/complaints'
import { Alert } from '@/components/ui/Alert'
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
import { categoryService, departmentService } from '@/services'
import { getErrorMessage } from '@/utils/errors'
import { formatHours, formatNumber } from '@/utils/format'
import { SummaryLine } from '../shared/Controls'
import { IconPlate } from '../shared/FormControls'
import { toList } from '../shared/listUtils'
import { CategoryFormModal } from './CategoryFormModal'

function TermsCell({ category }) {
  const keywords = Array.isArray(category.keywords) ? category.keywords : []
  const labels = Array.isArray(category.vision_labels) ? category.vision_labels : []
  const preview = keywords.slice(0, 3).join(', ')
  return (
    <span className="block max-w-48 text-xs">
      <span className="font-semibold text-ink tabular">{formatNumber(keywords.length)}</span>
      <span className="text-ink-2"> keywords, </span>
      <span className="font-semibold text-ink tabular">{formatNumber(labels.length)}</span>
      <span className="text-ink-2"> vision labels</span>
      {preview ? (
        <span className="block truncate text-ink-3" title={keywords.join(', ')}>
          {preview}
          {keywords.length > 3 ? '…' : ''}
        </span>
      ) : null}
    </span>
  )
}

export function CategoriesTab() {
  const toast = useToast()
  const confirm = useConfirm()
  const categories = useApi(() => categoryService.list({ include_inactive: true }), [])
  const departments = useApi(() => departmentService.list({ include_inactive: true }), [])
  const [form, setForm] = useState({ open: false, category: null, session: 0 })
  const [pendingId, setPendingId] = useState(null)
  const rows = toList(categories.data)

  const openForm = (category = null) => setForm((current) => ({ open: true, category, session: current.session + 1 }))
  const closeForm = () => setForm((current) => ({ ...current, open: false }))

  const remove = async (category) => {
    const ok = await confirm({
      title: `Delete ${category.name}?`,
      message:
        category.complaint_count > 0
          ? `${formatNumber(category.complaint_count)} complaints use this category, so it will be deactivated instead of deleted: citizens and the AI engine stop using it, history stays.`
          : 'An unused category is deleted. If AI predictions refer to it, it is deactivated instead.',
      confirmLabel: 'Delete category',
      tone: 'danger',
    })
    if (!ok) return
    setPendingId(category.id)
    try {
      const result = await categoryService.remove(category.id)
      if (result?.deactivated) toast.warning('Category deactivated instead', result.detail)
      else toast.success('Category deleted', `${category.name} was removed.`)
      categories.refetch()
    } catch (error) {
      toast.error('Could not delete the category', getErrorMessage(error))
    } finally {
      setPendingId(null)
    }
  }

  const activate = async (category) => {
    setPendingId(category.id)
    try {
      await categoryService.update(category.id, { is_active: true })
      toast.success('Category activated', `${category.name} is offered to citizens and used by the AI engine again.`)
      categories.refetch()
    } catch (error) {
      toast.error('Could not activate the category', getErrorMessage(error))
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
        { label: 'Edit category', icon: Pencil, onClick: () => openForm(row) },
        !row.is_active ? { label: 'Activate category', icon: Power, onClick: () => activate(row) } : null,
        { divider: true },
        { label: 'Delete category', icon: Trash2, danger: true, onClick: () => remove(row) },
      ].filter(Boolean)}
    />
  )

  const columns = [
    {
      key: 'name',
      header: 'Category',
      render: (row) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <IconPlate icon={row.icon} color={row.color} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5">
              <span className="truncate font-semibold text-ink">{row.name}</span>
              {!row.is_active ? (
                <Badge tone="neutral" size="sm" dot>
                  Inactive
                </Badge>
              ) : null}
            </span>
            <span className="block text-xs text-ink-3 tabular">{row.slug}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'routing',
      header: 'Routed to',
      render: (row) => (
        <div className="flex flex-col items-start gap-1">
          <DepartmentBadge department={row.department_detail} size="sm" emptyLabel="General fallback" />
          {row.secondary_department_detail ? (
            <span className="text-xs text-ink-3">then {row.secondary_department_detail.name}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'weights',
      header: 'Severity and safety',
      hideOnMobile: true,
      render: (row) => (
        <span className="block whitespace-nowrap text-xs">
          <span className="block">
            <span className="text-sm font-semibold text-ink tabular">{formatNumber(row.base_severity)}</span>
            <span className="text-ink-3">/100 base severity</span>
          </span>
          <span className="block text-ink-3">
            safety weight <span className="font-semibold text-ink-2 tabular">{formatNumber(row.public_safety_weight, { digits: 2 })}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'sla',
      header: 'SLA',
      hideOnMobile: true,
      render: (row) => (
        <span className="whitespace-nowrap tabular">
          {formatHours(row.effective_sla_hours)}
          <span className="block text-xs text-ink-3">{row.sla_hours != null ? 'Category override' : 'Department default'}</span>
        </span>
      ),
    },
    { key: 'terms', header: 'AI terms', hideOnMobile: true, render: (row) => <TermsCell category={row} /> },
    { key: 'complaints', header: 'Complaints', align: 'right', render: (row) => <span className="font-semibold tabular">{formatNumber(row.complaint_count)}</span> },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: actionsMenu,
    },
  ]

  return (
    <div className="space-y-3">
      <Alert tone="info" icon={Brain} title="New categories work without code changes">
        The AI engine reads categories at run time: the text classifier blends in each category&apos;s keywords and the
        image model maps its vision labels, so a category added here is recognised in the very next complaint. Routing
        sends its complaints to the department you pick.
      </Alert>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SummaryLine count={categories.data ? rows.length : undefined} noun="category" plural="categories" loading={categories.loading && Boolean(categories.data)}>
          {categories.data ? <span className="text-ink-3">{formatNumber(rows.filter((row) => row.is_active).length)} active</span> : null}
        </SummaryLine>
        <Button leftIcon={Plus} onClick={() => openForm(null)}>
          Add category
        </Button>
      </div>

      {categories.error && !categories.data ? (
        <ErrorState title="Categories could not be loaded" error={categories.error} onRetry={() => categories.refetch()} />
      ) : (
        <DataTable
          caption="Categories"
          className="relative [&_td]:px-3 [&_th]:px-3"
          columns={columns}
          data={rows}
          loading={categories.loading}
          rowKey="id"
          onRowClick={(row) => openForm(row)}
          rowClassName={(row) => (row.is_active ? undefined : 'opacity-70')}
          empty={
            <EmptyState
              bordered={false}
              icon={Tag}
              title="No categories yet"
              description="Add the kinds of issues citizens can report; the AI engine starts using them immediately."
              action={
                <Button leftIcon={Plus} onClick={() => openForm(null)}>
                  Add category
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
                <p className="text-xs text-ink-3 tabular">{row.slug}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <DepartmentBadge department={row.department_detail} size="sm" emptyLabel="General fallback" />
                  <span className="text-xs text-ink-2 tabular">{formatNumber(row.complaint_count)} complaints</span>
                </div>
              </div>
              <div className="-mr-1.5 -mt-1 shrink-0">{actionsMenu(row)}</div>
            </div>
          )}
        />
      )}

      <CategoryFormModal
        key={form.session}
        open={form.open}
        onClose={closeForm}
        category={form.category}
        departments={toList(departments.data)}
        onSaved={() => {
          closeForm()
          categories.refetch()
        }}
      />
    </div>
  )
}

export default CategoriesTab
