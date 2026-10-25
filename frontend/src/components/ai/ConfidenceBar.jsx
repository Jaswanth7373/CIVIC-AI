/**
 * ConfidenceBar - a model confidence (0-1) as a labelled bar with its percentage.
 *
 * Props:
 * - value: confidence 0..1 (values above 1 are read as percentages, e.g. 91 -> 0.91); null -> "Not available"
 * - label: what the confidence belongs to ("Image model", "Fused decision") - also the bar's accessible name
 * - detail: secondary text under the label (e.g. the class the model chose: "Pothole")
 * - tone: force a tone; by default the tone reflects how far the number can be trusted: >= 75% green,
 *   >= 50% yellow, below 50% orange (the fusion engine sends results under 30% to manual review)
 * - size: 'sm' | 'md' (default 'md')
 * - delay: seconds before the fill starts growing (to cascade several bars)
 * - className
 *
 * Motion: the first time the bar is seen, the fill grows from empty to the real value with a small lit tip
 * travelling at its edge (the AI "reading" the value), and the percentage counts up with it; later value
 * changes glide. The ARIA value is always the real one. Reduced motion: the final bar and number at once.
 */
import { useRef } from 'react'
import { CountUp } from '@/components/motion/CountUp'
import { useInViewOnce } from '@/components/motion/hooks'
import { resolveTone, toneBar } from '@/components/ui/tones'
import { cn } from '@/utils/cn'
import { formatPercent } from '@/utils/format'
import { confidenceTone, toRatio } from './aiUtils'
import '@/styles/app.css'

const percentText = (value) => formatPercent(value / 100)

export function ConfidenceBar({ value, label, detail, tone, size = 'md', delay = 0, className }) {
  const trackRef = useRef(null)
  const seen = useInViewOnce(trackRef, { amount: 0.6, margin: '0px' })
  const ratio = toRatio(value)
  const text = ratio == null ? 'Not available' : formatPercent(ratio)
  const percent = ratio == null ? 0 : Math.round(ratio * 1000) / 10
  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          {label ? <p className={cn('font-medium text-ink-2', size === 'sm' ? 'text-xs' : 'text-sm')}>{label}</p> : null}
          {detail ? <p className="truncate text-xs text-ink-3">{detail}</p> : null}
        </div>
        {ratio == null ? (
          <span className={cn('shrink-0 font-semibold text-ink tabular', size === 'sm' ? 'text-xs' : 'text-sm')}>{text}</span>
        ) : (
          <CountUp
            value={Math.round(ratio * 100)}
            format={percentText}
            duration={0.9}
            delay={delay}
            className={cn('shrink-0 font-semibold text-ink tabular', size === 'sm' ? 'text-xs' : 'text-sm')}
          />
        )}
      </div>
      <div
        ref={trackRef}
        role="progressbar"
        aria-label={typeof label === 'string' ? label : 'Confidence'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={ratio == null ? undefined : Math.round(ratio * 100)}
        aria-valuetext={text}
        className={cn('w-full overflow-hidden rounded-full bg-sunken', size === 'sm' ? 'h-1.5' : 'h-2')}
      >
        <div
          data-seen={seen && ratio != null ? '' : undefined}
          className={cn('app-bar-fill h-full rounded-full', toneBar[resolveTone(tone ?? confidenceTone(ratio))])}
          style={{ width: `${seen ? percent : 0}%`, transitionDelay: `${delay}s`, animationDelay: `${delay}s` }}
        />
      </div>
    </div>
  )
}

export default ConfidenceBar
