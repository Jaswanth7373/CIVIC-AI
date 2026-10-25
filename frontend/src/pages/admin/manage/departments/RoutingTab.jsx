/**
 * RoutingTab - the category -> department routing table as an editable matrix.
 *
 * Data: GET /departments/routing/ (active categories with their primary and secondary department) +
 * GET /departments/?include_inactive=true. Edits stay local (changed rows are marked) until "Save routing",
 * which sends only the changed rows: PUT /departments/routing/ `{mappings: [{category, department,
 * secondary_department}]}` - applied atomically and audit-logged, answered with the full table.
 * How routing works (apps/complaints/services/routing.py): primary department if active, else the secondary
 * one, else the General Civic Department (GEN). New complaints use the new table right away.
 */
import { GitBranch, RotateCcw, Save } from 'lucide-react'
import { useState } from 'react'
import { CategoryBadge } from '@/components/complaints'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { DataTable } from '@/components/ui/DataTable'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { Select } from '@/components/ui/Select'
import { useApi } from '@/hooks/useApi'
import { useToast } from '@/hooks/useToast'
import { departmentService } from '@/services'
import { cn } from '@/utils/cn'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { SummaryLine } from '../shared/Controls'
import { rowErrors, toList } from '../shared/listUtils'

const idOf = (department) => (department?.id != null ? String(department.id) : '')

export function RoutingTab() {
  const toast = useToast()
  const routing = useApi(() => departmentService.routing(), [])
  const departments = useApi(() => departmentService.list({ include_inactive: true }), [])
  const [draft, setDraft] = useState({})
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const rows = toList(routing.data)
  const departmentRows = toList(departments.data)
  const valueOf = (row, key) => draft[row.category.id]?.[key] ?? idOf(row[key])
  const isChanged = (row) => valueOf(row, 'department') !== idOf(row.department) || valueOf(row, 'secondary_department') !== idOf(row.secondary_department)
  const changedRows = rows.filter(isChanged)

  const optionsFor = (current) =>
    departmentRows
      .filter((department) => department.is_active !== false || String(department.id) === current)
      .map((department) => ({
        value: String(department.id),
        label: department.is_active === false ? `${department.name} (inactive)` : department.name,
      }))

  const update = (row, key, value) => {
    setDraft((current) => ({
      ...current,
      [row.category.id]: {
        department: valueOf(row, 'department'),
        secondary_department: valueOf(row, 'secondary_department'),
        ...current[row.category.id],
        [key]: value,
      },
    }))
    setErrors((current) => {
      const next = { ...current }
      delete next[row.category.id]
      return next
    })
  }

  const save = async () => {
    const localErrors = {}
    changedRows.forEach((row) => {
      const primary = valueOf(row, 'department')
      const secondary = valueOf(row, 'secondary_department')
      if (primary && primary === secondary) {
        localErrors[row.category.id] = { secondary_department: 'Pick a different fallback than the primary department.' }
      }
    })
    if (Object.keys(localErrors).length) {
      setErrors(localErrors)
      toast.error('Routing not saved', 'A category uses the same department as primary and fallback.')
      return
    }
    const mappings = changedRows.map((row) => ({
      category: row.category.id,
      department: valueOf(row, 'department') ? Number(valueOf(row, 'department')) : null,
      secondary_department: valueOf(row, 'secondary_department') ? Number(valueOf(row, 'secondary_department')) : null,
    }))
    setSaving(true)
    setErrors({})
    try {
      const table = await departmentService.updateRouting(mappings)
      routing.setData(table)
      setDraft({})
      toast.success('Routing saved', `${mappings.length} ${mappings.length === 1 ? 'category routes' : 'categories route'} to the new departments from now on.`)
    } catch (error) {
      const byIndex = rowErrors(getFieldErrors(error), 'mappings')
      const byCategory = {}
      Object.entries(byIndex).forEach(([index, messages]) => {
        const categoryId = mappings[Number(index)]?.category
        if (categoryId != null) byCategory[categoryId] = messages
      })
      setErrors(byCategory)
      toast.error('Could not save the routing', getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const columns = [
    {
      key: 'category',
      header: 'Category',
      render: (row) => (
        <div className="flex flex-col items-start gap-1">
          <CategoryBadge category={row.category} />
          {isChanged(row) ? (
            <Badge tone="yellow" size="sm">
              Changed
            </Badge>
          ) : null}
        </div>
      ),
    },
    {
      key: 'department',
      header: 'Primary department',
      render: (row) => (
        <div className="min-w-52">
          <Select
            aria-label={`Primary department for ${row.category.name}`}
            placeholder="General fallback"
            value={valueOf(row, 'department')}
            onChange={(event) => update(row, 'department', event.target.value)}
            options={optionsFor(valueOf(row, 'department'))}
            invalid={Boolean(errors[row.category.id]?.department)}
            className={cn(valueOf(row, 'department') !== idOf(row.department) && 'border-marking-500')}
          />
          {errors[row.category.id]?.department ? (
            <p className="mt-1 text-xs font-medium text-signal-600 dark:text-signal-300">{errors[row.category.id].department}</p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'secondary_department',
      header: 'Fallback department',
      render: (row) => (
        <div className="min-w-52">
          <Select
            aria-label={`Fallback department for ${row.category.name}`}
            placeholder="None"
            value={valueOf(row, 'secondary_department')}
            onChange={(event) => update(row, 'secondary_department', event.target.value)}
            options={optionsFor(valueOf(row, 'secondary_department'))}
            invalid={Boolean(errors[row.category.id]?.secondary_department)}
            className={cn(valueOf(row, 'secondary_department') !== idOf(row.secondary_department) && 'border-marking-500')}
          />
          {errors[row.category.id]?.secondary_department ? (
            <p className="mt-1 text-xs font-medium text-signal-600 dark:text-signal-300">{errors[row.category.id].secondary_department}</p>
          ) : null}
        </div>
      ),
    },
  ]

  const loadError = (routing.error && !routing.data) || (departments.error && !departments.data)

  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-sm text-ink-2">
        Each category goes to its primary department. When that department is inactive, the fallback takes over; without
        either, complaints go to the General Civic Department. Changes apply to new complaints; existing ones keep their
        department.
      </p>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <SummaryLine count={routing.data ? rows.length : undefined} noun="category" plural="categories">
          {changedRows.length ? <span className="font-semibold text-marking-800 dark:text-marking-300">{changedRows.length} unsaved</span> : null}
        </SummaryLine>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" leftIcon={RotateCcw} disabled={!changedRows.length || saving} onClick={() => { setDraft({}); setErrors({}) }}>
            Discard changes
          </Button>
          <Button leftIcon={Save} loading={saving} disabled={!changedRows.length} onClick={save}>
            {changedRows.length ? `Save routing (${changedRows.length})` : 'Save routing'}
          </Button>
        </div>
      </div>

      {loadError ? (
        <ErrorState
          title="The routing table could not be loaded"
          error={routing.error ?? departments.error}
          onRetry={() => {
            routing.refetch()
            departments.refetch()
          }}
        />
      ) : (
        <DataTable
          caption="Category routing"
          className="relative"
          columns={columns}
          data={rows}
          loading={routing.loading || departments.loading}
          rowKey={(row) => row.category.id}
          empty={<EmptyState bordered={false} icon={GitBranch} title="No active categories" description="Add a category first; it appears here to be routed." />}
          mobileCard={(row) => (
            <div className="space-y-3 p-4">
              {columns[0].render(row)}
              <div className="grid gap-3">
                <div>
                  <p className="mb-1 text-xs font-medium text-ink-3">Primary department</p>
                  {columns[1].render(row)}
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-ink-3">Fallback department</p>
                  {columns[2].render(row)}
                </div>
              </div>
            </div>
          )}
        />
      )}

      {Object.keys(errors).length ? <Alert tone="danger">Some rows could not be saved. Fix the highlighted departments and save again.</Alert> : null}
    </div>
  )
}

export default RoutingTab
