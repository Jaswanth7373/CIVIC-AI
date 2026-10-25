/**
 * PriorityBreakdown - why a complaint got its priority score.
 *
 * Props:
 * - priority: PriorityBreakdown from the API `{final_score, priority_level, components: [{key, label, score,
 *   max, raw}], explanation, trigger, is_override, created_at, ...}` | null
 * - showMeter: show the PriorityMeter above the components (default true)
 * - compact: tighter spacing, no timestamp (for side panels)
 * - className
 *
 * The priority engine computes `final = sum(weight_i x factor_i)` over five components (severity 40,
 * public impact 25, location risk 15, frequency 10, duplicates 10 by default, normalised to 100). Each row
 * shows that component's points out of its weight ("35/40") and a bar filled to `raw = score / max`, so the
 * reader sees both how much a factor contributed and how close it was to its maximum. All bars share one
 * informational colour: their length already carries the value, so colour is not spent re-encoding it.
 */
import { Gauge, SlidersHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { cn } from '@/utils/cn'
import { formatDateTime, formatNumber } from '@/utils/format'
import { PriorityMeter } from './PriorityMeter'

/** PriorityScore.trigger values written by apps/complaints/services (priority.py, overrides.py, ...). */
const TRIGGER_LABELS = {
  initial: 'Calculated after the initial AI analysis',
  duplicate_update: 'Recalculated after linked duplicate reports changed',
  reopened: 'Recalculated after the complaint was reopened',
  reanalysis: 'Recalculated after an AI re-analysis',
  ai_override: "Recalculated after an administrator corrected the AI prediction",
  override: 'Set by an administrator',
  config_change: 'Recalculated with new AI settings',
  recalculated: 'Recalculated',
}

function triggerLabel(trigger) {
  if (!trigger) return null
  if (TRIGGER_LABELS[trigger]) return TRIGGER_LABELS[trigger]
  const text = String(trigger).replace(/_/g, ' ')
  return `Trigger: ${text}`
}

/** Points with one decimal only when needed: 35 -> "35", 12.5 -> "12.5". */
function points(value) {
  const number = Number(value) || 0
  return formatNumber(number, { digits: Number.isInteger(number) ? 0 : 1 })
}

export function PriorityBreakdown({ priority, showMeter = true, compact = false, className }) {
  if (!priority) {
    return (
      <EmptyState
        icon={Gauge}
        compact
        bordered={false}
        title="No priority score yet"
        description="The priority is calculated right after the AI analysis finishes."
        className={className}
      />
    )
  }

  const components = Array.isArray(priority.components) ? priority.components : []
  const trigger = triggerLabel(priority.trigger)

  return (
    <div className={cn('min-w-0', className)}>
      {showMeter ? <PriorityMeter score={priority.final_score} level={priority.priority_level} className="mb-4" /> : null}

      <ul className={cn(compact ? 'space-y-2.5' : 'space-y-3')} aria-label="Priority components">
        {components.map((component) => {
          const max = Number(component.max) || 0
          const score = Number(component.score) || 0
          return (
            <li key={component.key}>
              <ProgressBar
                value={score}
                max={max > 0 ? max : 1}
                tone="blue"
                size="sm"
                label={component.label}
                showValue
                valueLabel={`${points(score)}/${points(max)}`}
              />
            </li>
          )
        })}
      </ul>

      {priority.explanation ? (
        <p className={cn('text-sm text-ink-2', compact ? 'mt-3' : 'mt-4')}>{priority.explanation}</p>
      ) : null}

      {trigger || priority.is_override || (!compact && priority.created_at) ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-3">
          {priority.is_override ? (
            <Badge tone="violet" size="sm" icon={SlidersHorizontal}>
              Manual override
            </Badge>
          ) : null}
          {trigger && !priority.is_override ? <span>{trigger}</span> : null}
          {!compact && priority.created_at ? (
            <time dateTime={priority.created_at} className="tabular">
              {formatDateTime(priority.created_at)}
            </time>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default PriorityBreakdown
