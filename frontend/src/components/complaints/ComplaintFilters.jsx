/**
 * ComplaintFilters - search + status / category / severity / priority / department / date range / sort
 * controls for complaint lists. Pair it with useComplaintFilters so the filters live in the URL:
 *
 *   const list = useComplaintFilters()
 *   <ComplaintFilters {...list.bind} categories={categories} departments={departments} />
 *
 * Props:
 * - value: filter object (see filterParams.EMPTY_FILTERS); onChange(nextFilters) gets the full object
 * - defaults: filter defaults (used by "Clear all" and to decide what counts as an active filter)
 * - categories: `[{id, name, slug}]` (GET /categories/) - the category select is disabled while the list is empty
 * - departments: `[{id, name}]` (GET /departments/) - the department select is disabled while the list is empty
 * - show: which controls to render, any of 'search', 'status', 'category', 'severity', 'priority',
 *   'department', 'date', 'ordering', 'flags' (default: all except 'flags')
 * - statusOptions: `[{value, label}]` (default every status)
 * - searchPlaceholder
 * - className
 *
 * Layout: from the lg breakpoint every control sits in one wrapping row above the list, with removable
 * chips for the active filters below it. On smaller screens only the search box and a "Filters" button
 * (with the active count) are shown; the button opens a bottom drawer with the same controls, labelled and
 * stacked for thumbs. Changes apply immediately, so the list behind the drawer is always current. The category
 * and department selects render at once at a fixed width (disabled until their options arrive), so the row wraps
 * the same way before and after the lists load and nothing below it shifts.
 */
import { ListFilter, X } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { Drawer } from '@/components/ui/Drawer'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { SearchInput } from '@/components/ui/SearchInput'
import { Select } from '@/components/ui/Select'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/utils/cn'
import { COMPLAINT_ORDERING_OPTIONS, LEVEL_META, LEVEL_OPTIONS, STATUS_META, STATUS_OPTIONS } from '@/utils/constants'
import { formatDate, formatDateInput } from '@/utils/format'
import { DATE_PRESETS, countActiveFilters, detectPreset, normalizeFilters, presetRange } from './filterParams'
import { StatusMultiSelect } from './StatusMultiSelect'

const DEFAULT_SHOW = ['search', 'status', 'category', 'severity', 'priority', 'department', 'date', 'ordering']

const FLAG_OPTIONS = [
  { key: 'is_overdue', label: 'Overdue only', chip: 'Overdue' },
  { key: 'has_duplicates', label: 'Has possible duplicates', chip: 'Has duplicates' },
  { key: 'needs_review', label: 'Needs manual review', chip: 'Needs review' },
  { key: 'unassigned', label: 'No officer assigned', chip: 'Unassigned' },
]

/** Visible label + wiring in the stacked (drawer) layout; a bare control in the desktop row. */
function Field({ stacked, label, children }) {
  if (!stacked) return children
  return <FormField label={label}>{children}</FormField>
}

function dateChipLabel(filters, preset) {
  const option = DATE_PRESETS.find((item) => item.value === preset)
  if (preset && preset !== 'custom' && option) return `Reported: ${option.label}`
  if (filters.date_from && filters.date_to) return `Reported ${formatDate(filters.date_from)} to ${formatDate(filters.date_to)}`
  if (filters.date_from) return `Reported from ${formatDate(filters.date_from)}`
  return `Reported until ${formatDate(filters.date_to)}`
}

export function ComplaintFilters({
  value,
  onChange,
  defaults = {},
  categories = [],
  departments = [],
  show = DEFAULT_SHOW,
  statusOptions = STATUS_OPTIONS,
  searchPlaceholder = 'Search number, title or address',
  className,
}) {
  const filters = normalizeFilters(value, {})
  const isDesktop = useMediaQuery(BREAKPOINTS.lg)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [customRange, setCustomRange] = useState(false)

  // Every change builds on the LATEST filters - including a change made a moment ago that the list has not
  // rendered yet (react-router applies navigations in a transition). Without this, two quick changes (a select,
  // then another select or the debounced search box) would both start from the same old filters and the second
  // would bring back what the first one cleared. The filters from props take over again whenever they change
  // (the URL was rendered, or Back / a link changed it).
  const latestRef = useRef(filters)
  const filtersKey = JSON.stringify(filters)
  const renderedKeyRef = useRef(filtersKey)
  useLayoutEffect(() => {
    if (renderedKeyRef.current === filtersKey) return
    renderedKeyRef.current = filtersKey
    latestRef.current = filters
  })
  const update = (patch) => {
    const next = { ...latestRef.current, ...patch }
    latestRef.current = next
    onChange?.(next)
  }

  const visible = new Set(show)
  const categoryOptions = (categories ?? []).map((category) => ({
    value: String(category.slug ?? category.id),
    label: category.name,
  }))
  const departmentOptions = (departments ?? []).map((department) => ({ value: String(department.id), label: department.name }))
  const preset = detectPreset(filters)
  const showCustom = preset === 'custom' || customRange
  const today = formatDateInput(new Date())
  const activeCount = countActiveFilters(filters, defaults)

  const chooseDatePreset = (next) => {
    if (next === 'custom') {
      setCustomRange(true)
      return
    }
    setCustomRange(false)
    update(presetRange(next))
  }

  const renderControls = (stacked) => (
    <>
      {visible.has('status') ? (
        stacked ? (
          <div>
            <p aria-hidden className="mb-2 text-sm font-semibold text-ink">
              Status
            </p>
            <StatusMultiSelect inline value={filters.status} onChange={(status) => update({ status })} options={statusOptions} />
          </div>
        ) : (
          <StatusMultiSelect value={filters.status} onChange={(status) => update({ status })} options={statusOptions} />
        )
      ) : null}
      {visible.has('category') ? (
        <Field stacked={stacked} label="Category">
          <Select
            aria-label={stacked ? undefined : 'Category'}
            placeholder="All categories"
            options={categoryOptions}
            value={filters.category}
            onChange={(event) => update({ category: event.target.value })}
            disabled={!categoryOptions.length}
            containerClassName={stacked ? undefined : 'w-52'}
          />
        </Field>
      ) : null}
      {visible.has('severity') ? (
        <Field stacked={stacked} label="Severity">
          <Select
            aria-label={stacked ? undefined : 'Severity'}
            placeholder="Any severity"
            options={LEVEL_OPTIONS}
            value={filters.severity}
            onChange={(event) => update({ severity: event.target.value })}
            containerClassName={stacked ? undefined : 'w-auto min-w-36'}
          />
        </Field>
      ) : null}
      {visible.has('priority') ? (
        <Field stacked={stacked} label="Priority">
          <Select
            aria-label={stacked ? undefined : 'Priority'}
            placeholder="Any priority"
            options={LEVEL_OPTIONS}
            value={filters.priority_level}
            onChange={(event) => update({ priority_level: event.target.value })}
            containerClassName={stacked ? undefined : 'w-auto min-w-36'}
          />
        </Field>
      ) : null}
      {visible.has('department') ? (
        <Field stacked={stacked} label="Department">
          <Select
            aria-label={stacked ? undefined : 'Department'}
            placeholder="All departments"
            options={departmentOptions}
            value={filters.department}
            onChange={(event) => update({ department: event.target.value })}
            disabled={!departmentOptions.length}
            containerClassName={stacked ? undefined : 'w-56'}
          />
        </Field>
      ) : null}
      {visible.has('date') ? (
        <Field stacked={stacked} label="Reported">
          <Select
            aria-label={stacked ? undefined : 'Reported date range'}
            options={DATE_PRESETS.map(({ value: optionValue, label }) => ({ value: optionValue, label }))}
            value={showCustom ? 'custom' : preset}
            onChange={(event) => chooseDatePreset(event.target.value)}
            containerClassName={stacked ? undefined : 'w-auto min-w-36'}
          />
        </Field>
      ) : null}
      {visible.has('date') && showCustom ? (
        <div className={cn(stacked ? 'grid grid-cols-2 gap-3' : 'flex w-auto items-center gap-2')}>
          <Field stacked={stacked} label="From">
            <Input
              type="date"
              aria-label={stacked ? undefined : 'Reported from'}
              value={filters.date_from}
              max={filters.date_to || today}
              onChange={(event) => update({ date_from: event.target.value })}
              className={stacked ? undefined : 'w-40'}
            />
          </Field>
          <Field stacked={stacked} label="To">
            <Input
              type="date"
              aria-label={stacked ? undefined : 'Reported until'}
              value={filters.date_to}
              min={filters.date_from || undefined}
              max={today}
              onChange={(event) => update({ date_to: event.target.value })}
              className={stacked ? undefined : 'w-40'}
            />
          </Field>
        </div>
      ) : null}
      {visible.has('ordering') ? (
        <Field stacked={stacked} label="Sort by">
          <Select
            aria-label={stacked ? undefined : 'Sort complaints'}
            options={COMPLAINT_ORDERING_OPTIONS}
            value={filters.ordering || COMPLAINT_ORDERING_OPTIONS[0].value}
            onChange={(event) => update({ ordering: event.target.value })}
            containerClassName={stacked ? undefined : 'w-auto min-w-40'}
          />
        </Field>
      ) : null}
      {visible.has('flags') ? (
        <fieldset className={cn('flex gap-x-4 gap-y-1', stacked ? 'flex-col' : 'flex-wrap items-center')}>
          <legend className={cn(stacked ? 'mb-1 text-sm font-semibold text-ink' : 'sr-only')}>Only show</legend>
          {FLAG_OPTIONS.map((flag) => (
            <Checkbox
              key={flag.key}
              label={flag.label}
              checked={filters[flag.key] === 'true'}
              onCheckedChange={(checked) => update({ [flag.key]: checked ? 'true' : '' })}
            />
          ))}
        </fieldset>
      ) : null}
    </>
  )

  /* ---- active filter chips -------------------------------------------------------------------------- */
  const chips = []
  if (filters.search) chips.push({ key: 'search', label: `Search: "${filters.search}"`, patch: { search: '' } })
  // The status chip shows a status choice that differs from the page's default (the officer queue defaults to the
  // open work); removing it goes back to that default.
  const defaultStatus = normalizeFilters({}, defaults).status
  if ([...filters.status].sort().join(',') !== [...defaultStatus].sort().join(',')) {
    chips.push({
      key: 'status',
      label: filters.status.length
        ? `Status: ${filters.status.map((status) => STATUS_META[status]?.label ?? status).join(', ')}`
        : 'Status: all statuses',
      patch: { status: defaultStatus },
    })
  }
  if (filters.category) {
    const option = categoryOptions.find((item) => item.value === filters.category)
    chips.push({ key: 'category', label: `Category: ${option?.label ?? filters.category}`, patch: { category: '' } })
  }
  if (filters.severity) {
    chips.push({ key: 'severity', label: `Severity: ${LEVEL_META[filters.severity]?.label ?? filters.severity}`, patch: { severity: '' } })
  }
  if (filters.priority_level) {
    chips.push({
      key: 'priority',
      label: `Priority: ${LEVEL_META[filters.priority_level]?.label ?? filters.priority_level}`,
      patch: { priority_level: '' },
    })
  }
  if (filters.department) {
    const option = departmentOptions.find((item) => item.value === filters.department)
    chips.push({ key: 'department', label: `Department: ${option?.label ?? filters.department}`, patch: { department: '' } })
  }
  if (filters.date_from || filters.date_to) {
    chips.push({ key: 'date', label: dateChipLabel(filters, preset), patch: { date_from: '', date_to: '' } })
  }
  FLAG_OPTIONS.forEach((flag) => {
    if (filters[flag.key] === 'true') chips.push({ key: flag.key, label: flag.chip, patch: { [flag.key]: '' } })
  })

  const clearAll = () => {
    setCustomRange(false)
    const next = normalizeFilters({}, defaults)
    latestRef.current = next
    onChange?.(next)
  }

  const removeChip = (chip) => {
    if (chip.key === 'date') setCustomRange(false)
    update(chip.patch)
  }

  const search = visible.has('search') ? (
    <SearchInput
      value={filters.search}
      onSearch={(term) => update({ search: term })}
      placeholder={searchPlaceholder}
      label="Search complaints"
      className={isDesktop ? 'min-w-56 flex-1 basis-64' : 'min-w-0 flex-1'}
    />
  ) : null

  return (
    <div className={cn('min-w-0', className)}>
      {isDesktop ? (
        <div className="flex flex-wrap items-center gap-2">
          {search}
          {renderControls(false)}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {search}
          <Button variant="outline" leftIcon={ListFilter} onClick={() => setDrawerOpen(true)} aria-haspopup="dialog">
            Filters
            {activeCount ? (
              <span className="grid min-w-5 place-items-center rounded-full bg-ink px-1 text-[11px] font-bold text-surface tabular">
                <span className="sr-only">, </span>
                {activeCount}
                <span className="sr-only"> active</span>
              </span>
            ) : null}
          </Button>
        </div>
      )}

      {chips.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5" aria-label="Active filters" role="group">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-2.5 pr-0.5 text-xs font-medium text-ink-2 ring-1 ring-inset ring-line"
            >
              <span className="truncate">{chip.label}</span>
              <button
                type="button"
                onClick={() => removeChip(chip)}
                aria-label={`Remove filter ${chip.label}`}
                className="grid size-6 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-sunken hover:text-ink pointer-coarse:size-8"
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={clearAll}
            className="rounded-md px-2 py-1 text-xs font-semibold text-primary-ink hover:underline pointer-coarse:min-h-9"
          >
            Clear all
          </button>
        </div>
      ) : null}

      {!isDesktop ? (
        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          side="bottom"
          title="Filter complaints"
          description="Changes apply right away."
          footer={
            <>
              <Button variant="ghost" onClick={clearAll} disabled={!activeCount && !filters.search}>
                Clear all
              </Button>
              <Button onClick={() => setDrawerOpen(false)}>
                Show results
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4 pb-2">{renderControls(true)}</div>
        </Drawer>
      ) : null}
    </div>
  )
}

export default ComplaintFilters
