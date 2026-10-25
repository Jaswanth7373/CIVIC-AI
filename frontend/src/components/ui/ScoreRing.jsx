import { motion } from 'framer-motion'
import { useRef } from 'react'
import { CountUp } from '@/components/motion/CountUp'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { DURATION, EASE } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { resolveTone, toneStroke } from './tones'

const PRESETS = { sm: 64, md: 96, lg: 128 }
const roundWhole = (value) => String(Math.round(value))

/**
 * Circular score gauge (e.g. "Resolution Verification Score 91/100"). The arc length is
 * `circumference x value / max`, drawn with stroke-dashoffset.
 *
 * Motion: the first time the ring is seen, the arc sweeps to its value while the number counts up with it;
 * later value changes glide from the previous value. Reduced motion: the final arc and number at once.
 * The accessible name always carries the real value ("Score: 91 out of 100").
 *
 * @param {object} props
 * @param {number} props.value
 * @param {number} [props.max=100]
 * @param {number|'sm'|'md'|'lg'} [props.size='md'] diameter in px or a preset
 * @param {'neutral'|'green'|'yellow'|'orange'|'red'|'blue'|'violet'|'teal'|'magenta'|'slate'} [props.tone='green']
 * @param {string} [props.label] small caption inside the ring (also used in the accessible name)
 */
export function ScoreRing({ value = 0, max = 100, size = 'md', tone = 'green', label, strokeWidth, className }) {
  const ref = useRef(null)
  const reduced = usePrefersReducedMotion()
  const seen = useInViewOnce(ref, { amount: 0.6, margin: '0px' })
  const diameter = typeof size === 'number' ? size : (PRESETS[size] ?? PRESETS.md)
  const stroke = strokeWidth ?? Math.max(4, Math.round(diameter * 0.09))
  const radius = (diameter - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const safeMax = Number(max) > 0 ? Number(max) : 100
  const number = Number(value) || 0
  const ratio = Math.min(1, Math.max(0, number / safeMax))
  const center = diameter / 2
  const target = circumference * (1 - ratio)

  return (
    <div
      ref={ref}
      role="img"
      aria-label={`${label ? `${label}: ` : ''}${Math.round(number)} out of ${safeMax}`}
      className={cn('relative inline-grid shrink-0 place-items-center', className)}
      style={{ width: diameter, height: diameter }}
    >
      <svg width={diameter} height={diameter} viewBox={`0 0 ${diameter} ${diameter}`} className="-rotate-90" aria-hidden>
        <circle cx={center} cy={center} r={radius} fill="none" strokeWidth={stroke} className="stroke-sunken" />
        <motion.circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          className={toneStroke[resolveTone(tone)]}
          initial={reduced ? false : { strokeDashoffset: circumference }}
          animate={reduced || seen ? { strokeDashoffset: target } : { strokeDashoffset: circumference }}
          transition={{ duration: DURATION.count, ease: EASE.count }}
        />
      </svg>
      <div aria-hidden className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <CountUp
          value={Math.round(number)}
          format={roundWhole}
          className="font-display font-extrabold leading-none text-ink tabular"
          style={{ fontSize: Math.round(diameter * 0.3) }}
        />
        {label ? (
          <span className="mt-1 max-w-[80%] truncate font-medium leading-tight text-ink-3" style={{ fontSize: Math.max(10, Math.round(diameter * 0.11)) }}>
            {label}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export default ScoreRing
