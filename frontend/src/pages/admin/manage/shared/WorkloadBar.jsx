/**
 * WorkloadBar - an officer's open workload against their capacity ("5 of 14 active").
 *
 * Props:
 * - active: open complaints assigned to the officer (assigned / accepted / in progress / reopened)
 * - capacity: `max_active_complaints`
 * - utilization: 0..1 from the API (clamped server side); derived from active / capacity when missing
 * - overloaded: the API's `overloaded` flag (active > capacity) - wins over the local maths
 * - compact: one-line label for dense tables
 * - className
 *
 * Reading: the bar is a meter on the shared workload scale (./workload.js - the same thresholds and colours as
 * the officer's own dashboard): green while there is room, yellow "Near capacity" from 80 % and red "Over
 * capacity" once the officer has more open complaints than capacity. The state is spelled out in words with an
 * icon too, never colour alone.
 *
 * Motion: the fill grows to the officer's load the first time the meter is seen (the same entrance as the
 * app's progress bars) and glides when the load changes; with reduced motion it is drawn at once. The ARIA
 * value is always the real one.
 */
import { Siren, TriangleAlert } from 'lucide-react'
import { useRef } from 'react'
import { useInViewOnce } from '@/components/motion/hooks'
import { toneBar } from '@/components/ui/tones'
import { cn } from '@/utils/cn'
import { formatNumber } from '@/utils/format'
import { readWorkload } from './workload'

/** Text colour and icon of the states that are spelled out ("Has capacity" shows the percentage instead). */
const STATE_STYLE = {
  near: { text: 'text-marking-800 dark:text-marking-300', icon: TriangleAlert },
  over: { text: 'text-signal-700 dark:text-signal-300', icon: Siren },
}

export function WorkloadBar({ active, capacity, utilization, overloaded, compact = false, className }) {
  const meterRef = useRef(null)
  const seen = useInViewOnce(meterRef, { margin: '0px' })
  const workload = readWorkload({ active, capacity, utilization, overloaded })
  const { level } = workload
  const percent = Math.round(workload.ratio * 100)
  const style = STATE_STYLE[level.key]
  const StateIcon = style?.icon
  const valueText = `${formatNumber(workload.active)} of ${formatNumber(workload.capacity)} active, ${percent}%${
    style ? `, ${level.label.toLowerCase()}` : ''
  }`

  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
        <span className="font-semibold text-ink tabular">
          {formatNumber(workload.active)}
          <span className="font-normal text-ink-3">/{formatNumber(workload.capacity)}</span>
          {compact ? null : <span className="font-normal text-ink-3"> active</span>}
        </span>
        {style ? (
          <span className={cn('inline-flex items-center gap-1 whitespace-nowrap font-semibold', style.text)}>
            <StateIcon aria-hidden className="size-3.5 shrink-0" />
            {level.label}
          </span>
        ) : (
          <span className="text-ink-3 tabular">{percent}%</span>
        )}
      </div>
      <div
        ref={meterRef}
        role="meter"
        aria-label="Workload"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={valueText}
        className="h-1.5 w-full overflow-hidden rounded-full bg-sunken"
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-700 ease-enter', toneBar[level.tone])}
          style={{ width: `${seen ? workload.ratio * 100 : 0}%` }}
        />
      </div>
    </div>
  )
}

export default WorkloadBar
