/**
 * PriorityMeter - horizontal 0-100 gauge with Low / Medium / High / Critical zones and a marker at the score.
 *
 * Props:
 * - score: 0-100 priority score (alias: `value`)
 * - level: level key; derived from `score` and `thresholds` when omitted (so the zone and the label agree)
 * - thresholds: `{medium, high, critical}` lower bounds (default 26 / 51 / 76, the AIConfiguration defaults)
 * - label: accessible name and caption (default "Priority score")
 * - size: 'sm' (compact: no caption row, no zone labels) | 'md' (default)
 * - showZoneLabels: default true for 'md'
 * - className
 *
 * How it reads: the track is split into four zones whose widths are proportional to the configured
 * thresholds (low 0-25 is 26% of the track ...). The zone that contains the score is drawn in its full level
 * colour, the others are tinted, and a needle marks the exact score - the same "where am I on the scale"
 * reading as a fuel gauge. Zones are separated by 2px gaps of the surface colour instead of borders.
 * Semantics: `role="meter"` with aria-valuenow / aria-valuetext ("87 out of 100, Critical") - always the
 * real value.
 *
 * Motion: the first time the meter is seen, the needle sweeps up from zero to the score while the number
 * counts with it, and the score's zone lights up in its full colour when the needle lands. Later changes
 * glide from the previous score. Reduced motion: the final reading at once.
 */
import { motion } from 'framer-motion'
import { useRef, useState } from 'react'
import { withAlpha } from '@/components/charts/palette'
import { CountUp } from '@/components/motion/CountUp'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { DURATION, EASE } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { DEFAULT_LEVEL_THRESHOLDS, LEVEL_META, LEVEL_ORDER, scoreToLevel } from '@/utils/constants'

const roundWhole = (value) => String(Math.round(value))

function clampScore(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(100, Math.max(0, number))
}

/** Zone boundaries in score units, from the (validated, ordered) thresholds. */
function buildZones(thresholds) {
  const t = { ...DEFAULT_LEVEL_THRESHOLDS, ...(thresholds ?? {}) }
  const medium = Math.min(Math.max(Number(t.medium) || DEFAULT_LEVEL_THRESHOLDS.medium, 1), 98)
  const high = Math.min(Math.max(Number(t.high) || DEFAULT_LEVEL_THRESHOLDS.high, medium + 1), 99)
  const critical = Math.min(Math.max(Number(t.critical) || DEFAULT_LEVEL_THRESHOLDS.critical, high + 1), 100)
  const bounds = [0, medium, high, critical, 100]
  return LEVEL_ORDER.map((key, index) => ({ key, start: bounds[index], end: bounds[index + 1], meta: LEVEL_META[key] }))
}

export function PriorityMeter({
  score,
  value,
  level,
  thresholds,
  label = 'Priority score',
  size = 'md',
  showZoneLabels,
  className,
}) {
  const meterRef = useRef(null)
  const reduced = usePrefersReducedMotion()
  const seen = useInViewOnce(meterRef, { amount: 0.6, margin: '0px' })
  const raw = score ?? value
  const hasScore = raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw))
  const current = clampScore(raw)
  const zones = buildZones(thresholds)
  const levelKey = LEVEL_META[level] ? level : scoreToLevel(current, { ...DEFAULT_LEVEL_THRESHOLDS, ...(thresholds ?? {}) })
  const meta = LEVEL_META[levelKey]
  const compact = size === 'sm'
  const zoneLabels = showZoneLabels ?? !compact
  // The score's zone lights up once the needle has arrived (at once with reduced motion).
  const [landed, setLanded] = useState(false)
  const lit = reduced || landed

  return (
    <div className={cn('w-full min-w-0', className)}>
      {!compact ? (
        <div className="mb-2 flex items-end justify-between gap-3">
          <div className="flex items-baseline gap-1">
            {hasScore ? (
              <CountUp
                value={Math.round(current)}
                format={roundWhole}
                duration={DURATION.count}
                className="font-display text-3xl font-extrabold leading-none text-ink tabular"
              />
            ) : (
              <span className="font-display text-3xl font-extrabold leading-none text-ink tabular">—</span>
            )}
            <span className="text-sm font-semibold text-ink-3 tabular">/100</span>
          </div>
          <div className="text-right">
            <p className="text-xs font-medium text-ink-3">{label}</p>
            <p className="font-display text-sm font-bold text-ink">{hasScore ? `${meta.label} priority` : 'Not scored yet'}</p>
          </div>
        </div>
      ) : null}

      <div
        ref={meterRef}
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={hasScore ? Math.round(current) : undefined}
        aria-valuetext={hasScore ? `${Math.round(current)} out of 100, ${meta.label}` : 'Not scored yet'}
        className={cn('relative', compact ? 'pt-2' : 'pt-3')}
      >
        <div className={cn('flex w-full gap-0.5', compact ? 'h-1.5' : 'h-2.5')}>
          {zones.map((zone, index) => {
            const active = hasScore && zone.key === levelKey
            return (
              <span
                key={zone.key}
                aria-hidden
                className={cn(
                  'block h-full transition-[background-color,box-shadow] duration-300 ease-standard',
                  index === 0 && 'rounded-l-full',
                  index === zones.length - 1 && 'rounded-r-full',
                )}
                style={{
                  flexBasis: `${zone.end - zone.start}%`,
                  backgroundColor: active && lit ? zone.meta.color : withAlpha(zone.meta.color, 0.26),
                  boxShadow: active && lit && !compact ? `0 0 0 0 ${zone.meta.color}, 0 0 14px -2px ${withAlpha(zone.meta.color, 0.55)}` : undefined,
                }}
              />
            )
          })}
        </div>
        {hasScore ? (
          // The needle's `left` is animated (one small absolutely positioned element), so it never reaches
          // outside the meter the way a translated full-width rail would.
          <motion.span
            aria-hidden
            className="pointer-events-none absolute top-0 flex -translate-x-1/2 flex-col items-center"
            initial={reduced ? false : { left: '0%' }}
            animate={reduced || seen ? { left: `${current}%` } : { left: '0%' }}
            transition={{ duration: DURATION.count, ease: EASE.count }}
            onAnimationComplete={() => {
              if (seen) setLanded(true)
            }}
          >
            <span
              className={cn(
                'block border-x-transparent border-t-ink',
                compact ? 'border-x-[4px] border-t-[5px]' : 'border-x-[5px] border-t-[7px]',
              )}
            />
            <span className={cn('block w-0.5 rounded-full bg-ink ring-2 ring-surface', compact ? 'h-2.5' : 'h-4')} />
          </motion.span>
        ) : null}
      </div>

      {zoneLabels ? (
        <div className="mt-1.5 flex w-full gap-0.5 text-[11px] leading-tight">
          {zones.map((zone) => (
            <span
              key={zone.key}
              className={cn(
                'block truncate text-center transition-colors duration-300',
                hasScore && zone.key === levelKey && lit ? 'font-bold text-ink' : 'text-ink-3',
              )}
              style={{ flexBasis: `${zone.end - zone.start}%` }}
            >
              {zone.meta.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export default PriorityMeter
