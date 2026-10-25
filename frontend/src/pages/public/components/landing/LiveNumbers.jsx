/**
 * LiveNumbers - three headline figures under the hero call to action, read live from the public statistics
 * endpoint (GET /api/analytics/public/). Nothing is hard-coded: while loading the figures are skeletons, and
 * when the endpoint is unavailable the strip is not shown at all.
 *
 * Each figure counts up once from zero when it first appears (CountUp: one text node, the real value is always
 * what React renders; the average time counts through real durations, "12 h" ... "1 d 14 h"). The figures are
 * separated by short lane-marking dashes, like a road readout. Reduced motion: the final values at once.
 *
 * Props: stats (public stats payload | null), loading, error, delay (seconds before the count starts).
 */
import { CountUp } from '@/components/motion/CountUp'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/utils/cn'
import { formatHours, formatNumber } from '@/utils/format'

const whole = (value) => formatNumber(value)

function Figure({ value, format, label, delay, first }) {
  return (
    // column-reverse keeps the <dt> before the <dd> in the DOM; justify-end packs from the top so values align.
    // The lane-marking separator is a pseudo-element (a <dl> group may only contain <dt> and <dd>).
    <div
      className={cn(
        'relative flex min-w-0 flex-col-reverse justify-end',
        !first &&
          "pl-4 before:absolute before:inset-y-1 before:left-0 before:w-[3px] before:rounded-full before:opacity-80 before:content-[''] before:lane-line sm:pl-6",
      )}
    >
      <dt className="mt-2 text-[13px] leading-snug text-ink-2">{label}</dt>
      {/* One line per figure ("1 d 14 h" never breaks between its parts). */}
      <dd className="whitespace-nowrap font-display text-[1.625rem] font-extrabold leading-none tracking-tight text-ink tabular sm:text-[2rem]">
        {typeof value === 'number' && Number.isFinite(value) ? (
          <CountUp value={value} format={format} delay={delay} />
        ) : (
          (format?.(value) ?? '—')
        )}
      </dd>
    </div>
  )
}

export function LiveNumbers({ stats, loading, error, delay = 0 }) {
  if (error || (!loading && !stats)) return null

  if (loading && !stats) {
    return (
      <div aria-hidden className="grid max-w-lg grid-cols-3 gap-4">
        {[0, 1, 2].map((key) => (
          <div key={key} className="space-y-2.5">
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-3.5 w-24" />
          </div>
        ))}
      </div>
    )
  }

  const rate = Number(stats.resolution_rate)
  const hours = Number(stats.avg_resolution_hours)
  return (
    <div className="max-w-lg">
      {/* Phones: the duration is the widest figure, so its column gets the extra room. */}
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.25fr)] sm:grid-cols-3">
        <Figure first value={Number(stats.total_complaints)} format={whole} label="complaints reported" delay={delay} />
        <Figure
          value={Number(stats.resolved_complaints)}
          format={whole}
          label={Number.isFinite(rate) ? `resolved (${formatNumber(rate, { digits: 1 })}%)` : 'resolved'}
          delay={delay + 0.08}
        />
        <Figure
          value={stats.avg_resolution_hours == null || !Number.isFinite(hours) ? null : hours}
          format={formatHours}
          label="average time to resolve"
          delay={delay + 0.16}
        />
      </dl>
      <p className="mt-4 flex items-center gap-2 text-xs text-ink-2">
        <span aria-hidden className="relative grid size-2 place-items-center">
          <span className="absolute inline-flex size-2 animate-[ping_2.6s_cubic-bezier(0,0,0.2,1)_infinite] rounded-full bg-sign-400 opacity-60 motion-reduce:hidden" />
          <span className="relative inline-flex size-2 rounded-full bg-sign-500" />
        </span>
        Live figures from the CivicAI database
      </p>
    </div>
  )
}

export default LiveNumbers
