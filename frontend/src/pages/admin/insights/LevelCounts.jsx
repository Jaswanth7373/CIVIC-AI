/**
 * LevelCounts - the four severity / priority levels with their counts in one compact row
 * ("Low 3, Medium 107, High 47, Critical 3"), each keyed by its level icon and colour from LEVEL_META.
 * Used above a histogram so the level split and the score shape read together.
 *
 * Props:
 * - data: `[{level, label, count}]` (overview.priority_distribution / severity_distribution)
 * - label: accessible name of the list (e.g. "Complaints by priority level")
 * - className
 *
 * Motion: the four counts count up, low to critical, the first time the row is seen (final values at once
 * with reduced motion; the text is always the real count).
 */
import { CountUp } from '@/components/motion/CountUp'
import { STAGGER } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { LEVEL_META, LEVEL_ORDER } from '@/utils/constants'

export function LevelCounts({ data, label = 'Complaints by level', className }) {
  const counts = new Map((Array.isArray(data) ? data : []).map((row) => [row?.level, Number(row?.count) || 0]))
  return (
    <div className={cn('@container', className)}>
      <ul aria-label={label} className="grid grid-cols-2 gap-x-4 gap-y-2 @xs:grid-cols-4">
        {LEVEL_ORDER.map((level, index) => {
          const meta = LEVEL_META[level]
          return (
            <li key={level} className="min-w-0 border-l-2 pl-2.5" style={{ borderColor: meta.color }}>
              <p className="truncate text-xs font-medium text-ink-2">{meta.label}</p>
              <CountUp
                as="p"
                value={counts.get(level) ?? 0}
                delay={index * STAGGER.step}
                className="font-display text-lg font-extrabold leading-tight text-ink tabular"
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export default LevelCounts
