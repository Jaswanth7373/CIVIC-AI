/**
 * ChangesDiff - an audit entry's `changes` JSON as a readable list.
 *
 * The backend writes two shapes (apps/audit and the apps' views): a diff `{field: [old, new]}` for updates and a
 * snapshot `{field: value}` for creations / single events; nested objects group per item (e.g. routing
 * changes per category slug). Diffs show the old value struck through on a red tint and the new one on a
 * green tint with an arrow between them; a pair whose two sides are equal (the routing log records both
 * departments of a category even when only one moved) reads "unchanged". Snapshots show the value. null / ''
 * read as "empty". Field names become labels: `sla_alert_hours` -> "SLA alert (hours)", `is_active` -> "Active".
 *
 * Props: changes (object), snapshot (the entry records a creation / deletion, so a two-item list such as
 * `keywords: ["pothole", "crack"]` is a value, never old -> new), className
 */
import { ArrowRight } from 'lucide-react'
import { cn } from '@/utils/cn'

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isDiff = (value) => Array.isArray(value) && value.length === 2 && value.every((item) => !isPlainObject(item))
const isEmpty = (value) => value === null || value === undefined || value === ''
const sameValue = (a, b) => (isEmpty(a) && isEmpty(b)) || JSON.stringify(a) === JSON.stringify(b)

const ACRONYMS = { ai: 'AI', dbscan: 'DBSCAN', id: 'ID', ip: 'IP', sla: 'SLA', url: 'URL' }
const UNITS = { m: 'm', km: 'km', hours: 'hours', days: 'days' }

/** `sla_alert_hours` -> "SLA alert (hours)", `radius_m` -> "Radius (m)", `is_active` -> "Active". */
function fieldLabel(key) {
  const words = String(key ?? '').split(/[_\s-]+/).filter(Boolean)
  if (words.length > 1 && words[0].toLowerCase() === 'is') words.shift()
  const unit = words.length > 1 && UNITS[words.at(-1).toLowerCase()] ? UNITS[words.pop().toLowerCase()] : null
  const text = words
    .map((word, index) => ACRONYMS[word.toLowerCase()] ?? (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word.toLowerCase()))
    .join(' ')
  return unit ? `${text} (${unit})` : text
}

function Value({ value, tone }) {
  if (isEmpty(value)) {
    return <span className={cn('rounded px-1.5 py-0.5 italic text-ink-3', tone && 'bg-sunken')}>empty</span>
  }
  let text
  if (typeof value === 'boolean') text = value ? 'Yes' : 'No'
  else if (Array.isArray(value)) text = value.length ? value.map((item) => (isPlainObject(item) ? JSON.stringify(item) : String(item))).join(', ') : 'none'
  else if (isPlainObject(value)) text = JSON.stringify(value)
  else text = String(value)
  return (
    <span
      className={cn(
        'break-words rounded px-1.5 py-0.5',
        tone === 'old' && 'bg-signal-50 text-signal-800 line-through decoration-signal-400 dark:bg-signal-500/15 dark:text-signal-200',
        tone === 'new' && 'bg-sign-50 text-sign-800 dark:bg-sign-500/15 dark:text-sign-200',
        !tone && 'text-ink',
      )}
    >
      {text}
    </span>
  )
}

function Rows({ changes, snapshot = false, depth = 0 }) {
  const pair = (value) => !snapshot && isDiff(value)
  return (
    <dl className={cn('grid gap-y-1.5', depth > 0 && 'border-l-2 border-line pl-3')}>
      {Object.entries(changes).map(([key, value]) => (
        <div key={key} className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[12rem_minmax(0,1fr)]">
          <dt className="pt-0.5 text-xs font-semibold text-ink-2">{fieldLabel(key)}</dt>
          <dd className="min-w-0 text-xs">
            {pair(value) && sameValue(value[0], value[1]) ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <Value value={value[1]} />
                <span className="text-ink-3">unchanged</span>
              </span>
            ) : pair(value) ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <Value value={value[0]} tone="old" />
                <ArrowRight aria-label="changed to" className="size-3.5 shrink-0 text-ink-3" />
                <Value value={value[1]} tone="new" />
              </span>
            ) : isPlainObject(value) ? (
              <Rows changes={value} snapshot={snapshot} depth={depth + 1} />
            ) : (
              <Value value={value} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function ChangesDiff({ changes, snapshot = false, className }) {
  if (!isPlainObject(changes) || !Object.keys(changes).length) {
    return <p className={cn('text-xs text-ink-3', className)}>No field changes were recorded for this entry.</p>
  }
  return (
    <div className={cn('min-w-0', className)}>
      <Rows changes={changes} snapshot={snapshot} />
    </div>
  )
}

export default ChangesDiff
