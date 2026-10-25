/**
 * StatusMultiSelect - pick several complaint statuses (the API's comma-list `status` filter).
 *
 * Props:
 * - value: string[] of status values
 * - onChange(next: string[]): called with the statuses in canonical lifecycle order
 * - options: `[{value, label}]` (default STATUS_OPTIONS)
 * - inline: render the checklist directly instead of behind a popover button (mobile filter drawer)
 * - label: accessible name / button text prefix (default "Status")
 * - className
 *
 * Quick-select chips apply the status groups the dashboards count by (Pending = submitted, analyzed,
 * assigned, reopened; In progress = accepted, in progress; Resolved = resolved, verified, closed), mirroring
 * Complaint.PENDING_STATUSES etc. on the backend, so "Pending" here matches the "Pending" tile.
 */
import { ChevronDown } from 'lucide-react'
import { useId } from 'react'
import { Checkbox } from '@/components/ui/Checkbox'
import { FIELD_BASE } from '@/components/ui/fieldStyles'
import { Popover } from '@/components/ui/Popover'
import { cn } from '@/utils/cn'
import { STATUS_GROUPS, STATUS_META, STATUS_OPTIONS } from '@/utils/constants'

const QUICK_GROUPS = [
  { key: 'pending', label: 'Pending' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'resolved', label: 'Resolved' },
]

function sameSet(a, b) {
  return a.length === b.length && a.every((item) => b.includes(item))
}

function StatusChecklist({ value, onChange, options }) {
  const groupId = useId()
  const selected = new Set(value)
  const ordered = (set) => options.map((option) => option.value).filter((status) => set.has(status))

  const toggle = (status, checked) => {
    const next = new Set(selected)
    if (checked) next.add(status)
    else next.delete(status)
    onChange(ordered(next))
  }

  return (
    <div>
      <p id={`${groupId}-quick`} className="mb-1.5 text-xs font-semibold text-ink-3">
        Quick select
      </p>
      <div role="group" aria-labelledby={`${groupId}-quick`} className="mb-3 flex flex-wrap gap-1.5">
        {QUICK_GROUPS.map((group) => {
          const statuses = STATUS_GROUPS[group.key]
          const active = sameSet(value, statuses)
          return (
            <button
              key={group.key}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(active ? [] : ordered(new Set(statuses)))}
              className={cn(
                'rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset transition-colors pointer-coarse:min-h-9',
                active ? 'bg-ink text-surface ring-ink' : 'bg-surface text-ink-2 ring-line-strong hover:bg-surface-2',
              )}
            >
              {group.label}
            </button>
          )
        })}
      </div>
      <fieldset>
        <legend className="sr-only">Statuses</legend>
        <div className="grid gap-0.5">
          {options.map((option) => (
            <Checkbox
              key={option.value}
              checked={selected.has(option.value)}
              onCheckedChange={(checked) => toggle(option.value, checked)}
              className="rounded-md px-1.5 py-1 hover:bg-surface-2"
              label={
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: STATUS_META[option.value]?.color ?? '#8C9A96' }}
                  />
                  {option.label}
                </span>
              }
            />
          ))}
        </div>
      </fieldset>
    </div>
  )
}

export function StatusMultiSelect({ value = [], onChange, options = STATUS_OPTIONS, inline = false, label = 'Status', className }) {
  const list = Array.isArray(value) ? value : []
  if (inline) {
    return (
      <div className={className}>
        <StatusChecklist value={list} onChange={onChange} options={options} />
      </div>
    )
  }

  const summary =
    list.length === 0
      ? 'All statuses'
      : list.length === 1
        ? (options.find((option) => option.value === list[0])?.label ?? list[0])
        : `${label} (${list.length})`

  return (
    <Popover
      label={`Filter by ${label.toLowerCase()}`}
      placement="bottom-start"
      className={className}
      panelClassName="w-72 p-3"
      trigger={
        <button
          type="button"
          aria-label={`${label}: ${summary}`}
          className={cn(
            FIELD_BASE,
            'inline-flex h-10 w-auto min-w-36 items-center justify-between gap-2 px-3 text-left pointer-coarse:h-11',
            list.length > 0 && 'border-primary',
          )}
        >
          <span className="truncate">{summary}</span>
          <ChevronDown aria-hidden className="size-4 shrink-0 text-ink-3" />
        </button>
      }
    >
      {({ close }) => (
        <>
          <StatusChecklist value={list} onChange={onChange} options={options} />
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-2.5">
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={!list.length}
              className="rounded-md px-2 py-1 text-xs font-semibold text-ink-2 hover:bg-sunken disabled:opacity-50"
            >
              Clear
            </button>
            <button
              type="button"
              onClick={close}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-white hover:bg-primary-hover"
            >
              Done
            </button>
          </div>
        </>
      )}
    </Popover>
  )
}

export default StatusMultiSelect
