/**
 * PriorityBadge - priority level with the 0-100 priority score ("Critical 80").
 *
 * Props:
 * - level: 'low' | 'medium' | 'high' | 'critical' (alias: `priority`). When missing but `score` is given, the
 *   level is derived from the score with the default thresholds (26 / 51 / 76).
 * - score: 0-100 priority score (`priority_score`); omit to show only the level
 * - withLabel: show "priority" after the level ("High priority")
 * - size: 'sm' | 'md' | 'lg' (default 'md')
 * - className
 *
 * Priority and severity often sit side by side, so they never look alike: priority is the tinted chip, led by a
 * small gauge filled to the score (where the work order stands in the queue); severity (SeverityBadge) is a
 * plain word with a level dot. The level is always in words too, and the score digits use the chip's full text
 * colour (AA contrast).
 */
import { CircleDashed } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/utils/cn'
import { getLevelMeta, scoreToLevel } from '@/utils/constants'

/** Where the gauge sits when only the level is known: the middle of the level's band. */
const LEVEL_FILL = { low: 13, medium: 38, high: 63, critical: 88 }
const GAUGE_SIZES = { sm: 'h-1 w-3.5', md: 'h-1.5 w-4', lg: 'h-1.5 w-5' }

function ScoreGauge({ value, size }) {
  return (
    <span aria-hidden className={cn('relative shrink-0 overflow-hidden rounded-full bg-current/25', GAUGE_SIZES[size] ?? GAUGE_SIZES.md)}>
      <span className="absolute inset-y-0 left-0 rounded-full bg-current" style={{ width: `${Math.max(12, value)}%` }} />
    </span>
  )
}

export function PriorityBadge({ level, priority, score, withLabel = false, size = 'md', className }) {
  const hasScore = score !== null && score !== undefined && score !== '' && Number.isFinite(Number(score))
  const meta = getLevelMeta(level ?? priority) ?? (hasScore ? getLevelMeta(scoreToLevel(score)) : null)
  if (!meta) {
    return (
      <Badge tone="neutral" size={size} icon={CircleDashed} className={className}>
        <span className="sr-only">Priority: </span>
        Not scored
      </Badge>
    )
  }
  const value = hasScore ? Math.min(100, Math.max(0, Number(score))) : (LEVEL_FILL[meta.value] ?? 50)
  return (
    <Badge tone={meta.tone} size={size} icon={<ScoreGauge value={value} size={size} />} title={meta.description} className={className}>
      <span className="sr-only">Priority: </span>
      {withLabel ? `${meta.label} priority` : meta.label}
      {hasScore ? (
        <>
          <span className="sr-only">, score</span>
          <span className="ml-1 font-bold tabular">{Math.round(Number(score))}</span>
        </>
      ) : null}
    </Badge>
  )
}

export default PriorityBadge
