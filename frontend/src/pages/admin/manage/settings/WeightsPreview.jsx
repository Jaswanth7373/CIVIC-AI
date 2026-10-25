/**
 * WeightsPreview - the five priority weights as one 100-point bar (part of a whole).
 *
 * Every factor is drawn in the same informational blue that the complaint pages' PriorityBreakdown uses for these
 * five factors, so the factors look the same everywhere and the bar never borrows the level colours of the
 * "Priority levels" scale right below it (yellow = medium, orange = high, red = critical). Identity comes from
 * direct labels instead: each segment names its factor and points as far as its own width allows (a container
 * query per segment: "Public impact 25", then "Impact 25", then "25"), 2 px surface gaps separate the segments, a
 * tooltip gives the exact points, and the inputs underneath list the factors in the same order. When the weights
 * do not add up to 100, the unassigned points are an empty dashed segment (or the overflow is called out under
 * the bar), so the reason for the validation error is visible. The whole bar has a text alternative.
 *
 * Motion: segments glide to their new widths as the weights are typed (the bar answers the input), on the
 * house curve; with reduced motion they jump.
 *
 * Props: values (form values with weight_* keys), fields (WEIGHT_FIELDS)
 */
import { toneBar } from '@/components/ui/tones'
import { cn } from '@/utils/cn'
import { formatNumber } from '@/utils/format'

const points = (value) => formatNumber(value, { digits: 1 })

export function WeightsPreview({ values, fields }) {
  const segments = fields.map((field) => ({ ...field, value: Math.max(0, Number(values[field.key]) || 0) }))
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  const scale = Math.max(100, total)
  const missing = Math.max(0, 100 - total)
  const over = total > 100.01
  const complete = Math.abs(total - 100) <= 0.01

  return (
    <div>
      <div
        role="img"
        aria-label={`Priority weights: ${segments.map((segment) => `${segment.label} ${points(segment.value)}`).join(', ')}; total ${points(total)} of 100.`}
        className="flex h-9 w-full gap-0.5 overflow-hidden rounded-lg"
      >
        {segments
          .filter((segment) => segment.value > 0)
          .map((segment) => (
            <span
              key={segment.key}
              title={`${segment.label}: ${points(segment.value)} points`}
              className={cn(
                '@container flex h-full min-w-0 items-center justify-center gap-1 overflow-hidden px-1.5 text-xs font-bold text-white tabular transition-[flex-basis] duration-300 ease-standard first:rounded-l-lg last:rounded-r-lg',
                toneBar.blue,
              )}
              style={{ flexBasis: `${(segment.value / scale) * 100}%` }}
            >
              {/* Widths measured for 12 px bold labels: "Public impact 100" needs 104 px, "Duplicates 100" 87 px;
                  a value may use the segment's padding too, so "12.5" still shows in a 26 px segment. */}
              <span className="hidden min-w-0 truncate @min-[6.5rem]:inline">{segment.label}</span>
              <span className="hidden min-w-0 truncate @min-[5.5rem]:@max-[6.5rem]:inline">{segment.short ?? segment.label}</span>
              <span className="hidden shrink-0 @min-[0.875rem]:inline">{points(segment.value)}</span>
            </span>
          ))}
        {missing > 0.01 ? (
          <span
            title={`${points(missing)} points not assigned`}
            className="h-full rounded-r-lg border border-dashed border-line-strong bg-sunken transition-[flex-basis] duration-300 ease-standard"
            style={{ flexBasis: `${missing}%` }}
          />
        ) : null}
      </div>
      <p className={cn('mt-2 text-xs font-semibold tabular', complete ? 'text-sign-700 dark:text-sign-300' : 'text-signal-600 dark:text-signal-300')}>
        {complete
          ? 'Total 100 of 100 points'
          : over
            ? `Total ${points(total)}: ${points(total - 100)} points too many`
            : `Total ${points(total)}: ${points(missing)} points still to assign`}
      </p>
    </div>
  )
}

export default WeightsPreview
