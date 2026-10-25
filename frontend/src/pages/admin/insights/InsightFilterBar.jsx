/**
 * InsightFilterBar - the one filter row above everything an insight page shows (date range, department,
 * category, and optionally severity and status). Every widget below re-renders against the same slice, so
 * the numbers always agree.
 *
 * Props:
 * - filters: the filter object from useInsightFilters (`{date_from, date_to, department, category, severity,
 *   status: []}`)
 * - onChange(patch): merge a partial filter object (useInsightFilters().setFilters)
 * - onReset(): clear every filter of this bar
 * - activeCount: number of active filters (shows "Clear filters")
 * - departments / categories: option lists (GET /departments/, GET /categories/)
 * - show: controls to render, any of 'date', 'department', 'category', 'severity', 'status'
 * - presets: date presets (default RANGE_PRESETS: all time, 7 / 30 / 90 days, 12 months, custom); the preset
 *   with the empty value is what "no date filter" means on that page
 * - layout: 'row' (default, one wrapping row of self-describing controls) | 'stacked' (a visible label above
 *   each full-width control, for a builder side panel)
 * - trailing: content at the end of the row (e.g. "Updated 6:20 PM" + refresh button)
 * - className
 *
 * Layout: one wrapping row from the sm breakpoint; on phones a two-column grid (the date range spans both
 * columns) so the controls stay thumb-sized without a drawer. Native selects give the best mobile pickers.
 */
import { X } from 'lucide-react'
import { useId, useState } from 'react'
import { StatusMultiSelect } from '@/components/complaints'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { cn } from '@/utils/cn'
import { LEVEL_OPTIONS } from '@/utils/constants'
import { formatDateInput } from '@/utils/format'
import {
  RANGE_PRESETS,
  categoryOptions,
  categorySelectValue,
  departmentOptions,
  detectRange,
  rangeFromPreset,
} from './insightUtils'

const DEFAULT_SHOW = ['date', 'department', 'category']

/** Stacked layout: a visible label above each control; the row layout relies on self-describing options. */
function Field({ stacked, label, htmlFor, children }) {
  if (!stacked) return children
  return (
    <FormField label={label} htmlFor={htmlFor}>
      {children}
    </FormField>
  )
}

export function InsightFilterBar({
  filters,
  onChange,
  onReset,
  activeCount = 0,
  departments = [],
  categories = [],
  show = DEFAULT_SHOW,
  presets = RANGE_PRESETS,
  layout = 'row',
  trailing,
  className,
}) {
  const [customOpen, setCustomOpen] = useState(false)
  const idPrefix = useId()
  const stacked = layout === 'stacked'
  const visible = new Set(show)
  const detected = detectRange(filters, new Date(), presets)
  const showCustom = detected === 'custom' || customOpen
  const today = formatDateInput(new Date())
  const label = (text) => (stacked ? undefined : text)

  const choosePreset = (value) => {
    if (value === 'custom') {
      setCustomOpen(true)
      return
    }
    setCustomOpen(false)
    onChange?.(rangeFromPreset(value, new Date(), presets))
  }

  const clear = () => {
    setCustomOpen(false)
    onReset?.()
  }

  const controls = (
    <>
      {visible.has('date') ? (
        <Field stacked={stacked} label="Date range" htmlFor={`${idPrefix}-range`}>
          <Select
            id={stacked ? `${idPrefix}-range` : undefined}
            aria-label={label('Date range')}
            options={presets.map(({ value, label: text }) => ({ value, label: text }))}
            value={showCustom ? 'custom' : detected}
            onChange={(event) => choosePreset(event.target.value)}
            containerClassName={stacked ? undefined : 'col-span-2 sm:w-auto sm:min-w-40'}
          />
        </Field>
      ) : null}
      {visible.has('date') && showCustom ? (
        <div className={cn(stacked ? 'grid grid-cols-2 gap-3' : 'contents')}>
          <Field stacked={stacked} label="From" htmlFor={`${idPrefix}-from`}>
            <Input
              id={stacked ? `${idPrefix}-from` : undefined}
              type="date"
              aria-label={label('From date')}
              value={filters?.date_from ?? ''}
              max={filters?.date_to || today}
              onChange={(event) => onChange?.({ date_from: event.target.value })}
              className={stacked ? undefined : 'sm:w-40'}
            />
          </Field>
          <Field stacked={stacked} label="To" htmlFor={`${idPrefix}-to`}>
            <Input
              id={stacked ? `${idPrefix}-to` : undefined}
              type="date"
              aria-label={label('To date')}
              value={filters?.date_to ?? ''}
              min={filters?.date_from || undefined}
              max={today}
              onChange={(event) => onChange?.({ date_to: event.target.value })}
              className={stacked ? undefined : 'sm:w-40'}
            />
          </Field>
        </div>
      ) : null}
      {visible.has('department') ? (
        <Field stacked={stacked} label="Department" htmlFor={`${idPrefix}-department`}>
          <Select
            id={stacked ? `${idPrefix}-department` : undefined}
            aria-label={label('Department')}
            placeholder="All departments"
            options={departmentOptions(departments)}
            value={filters?.department ?? ''}
            onChange={(event) => onChange?.({ department: event.target.value })}
            containerClassName={stacked ? undefined : 'sm:w-auto sm:min-w-44 sm:max-w-60'}
          />
        </Field>
      ) : null}
      {visible.has('category') ? (
        <Field stacked={stacked} label="Category" htmlFor={`${idPrefix}-category`}>
          <Select
            id={stacked ? `${idPrefix}-category` : undefined}
            aria-label={label('Category')}
            placeholder="All categories"
            options={categoryOptions(categories)}
            value={categorySelectValue(filters?.category, categories)}
            onChange={(event) => onChange?.({ category: event.target.value })}
            containerClassName={stacked ? undefined : 'sm:w-auto sm:min-w-44 sm:max-w-60'}
          />
        </Field>
      ) : null}
      {visible.has('severity') ? (
        <Field stacked={stacked} label="Severity" htmlFor={`${idPrefix}-severity`}>
          <Select
            id={stacked ? `${idPrefix}-severity` : undefined}
            aria-label={label('Severity')}
            placeholder="Any severity"
            options={LEVEL_OPTIONS}
            value={filters?.severity ?? ''}
            onChange={(event) => onChange?.({ severity: event.target.value })}
            containerClassName={stacked ? undefined : 'sm:w-auto sm:min-w-36'}
          />
        </Field>
      ) : null}
      {visible.has('status') ? (
        stacked ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-semibold text-ink">Status</p>
            <StatusMultiSelect
              value={filters?.status ?? []}
              onChange={(status) => onChange?.({ status })}
              className="w-full [&_button]:w-full"
            />
          </div>
        ) : (
          <StatusMultiSelect value={filters?.status ?? []} onChange={(status) => onChange?.({ status })} className="min-w-0" />
        )
      ) : null}
      {activeCount > 0 ? (
        <Button
          variant="ghost"
          size="sm"
          leftIcon={X}
          onClick={clear}
          className={stacked ? 'self-start' : 'col-span-2 justify-self-start sm:col-span-1'}
        >
          Clear filters
        </Button>
      ) : null}
    </>
  )

  if (stacked) {
    return (
      <div role="group" aria-label="Filters" className={cn('flex flex-col gap-4', className)}>
        {controls}
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3', className)}>
      <div role="group" aria-label="Filters" className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
        {controls}
      </div>
      {trailing ? <div className="flex min-w-0 items-center gap-2 sm:ml-auto">{trailing}</div> : null}
    </div>
  )
}

export default InsightFilterBar
