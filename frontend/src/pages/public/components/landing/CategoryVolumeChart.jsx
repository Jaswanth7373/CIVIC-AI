/**
 * CategoryVolumeChart - "Complaints by category" on the landing page: one bar per civic category, longest first,
 * drawn in the civic signage system instead of a chart library's defaults.
 *
 * - One measure, one colour: every bar is sign green (complaint volume). The category's own colour appears only
 *   as its identity swatch beside the name, as on the category badges everywhere else in CivicAI, so colour never
 *   doubles as rank.
 * - Recessive frame: dashed vertical grid lines at round steps, a solid baseline at zero and small tabular tick
 *   labels under the plot; each value is written at the end of its bar in ink.
 * - Hover (mouse and pen): the row lights up and a tooltip in the system's floating style gives the count and
 *   its share of all complaints. The same numbers are in the table itself, so nothing depends on hovering.
 * - Entrance: the bars grow from the baseline, one after another, the first time the chart is on screen
 *   (clip-path, so the rounded data end keeps its shape). Reduced motion: the finished chart.
 *
 * It is a real table (category, complaints) styled as a chart, so screen readers and keyboard users read the
 * data directly; every figure comes from GET /api/categories/ (`complaint_count`).
 *
 * Props: rows ([{ id, name, color, complaint_count }]).
 */
import { motion } from 'framer-motion'
import { useRef, useState } from 'react'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { formatNumber } from '@/utils/format'

/** Seconds between two bars, and how long one bar takes to grow. */
const BAR_STEP = 0.05
const BAR_GROW = 0.7

const isHex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())

/** A round axis maximum and its step (1, 2 or 5 times a power of ten), for about four intervals. */
function niceScale(max) {
  if (!(max > 0)) return { top: 1, step: 1 }
  const raw = max / 4
  const power = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * power).find((candidate) => candidate >= raw) ?? 10 * power
  return { top: Math.ceil(max / step) * step, step }
}

export function CategoryVolumeChart({ rows }) {
  const ref = useRef(null)
  const reduced = usePrefersReducedMotion()
  const seen = useInViewOnce(ref, { margin: '0px 0px -15% 0px' })
  const [active, setActive] = useState(null)

  const data = [...(Array.isArray(rows) ? rows : [])].sort((a, b) => b.complaint_count - a.complaint_count)
  const total = data.reduce((sum, row) => sum + (Number(row.complaint_count) || 0), 0)
  const { top, step } = niceScale(data[0]?.complaint_count ?? 0)
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step)
  const share = (count) => (total > 0 ? `${formatNumber((count / total) * 100, { digits: 1 })}%` : '0%')

  return (
    <div ref={ref} className="min-w-0" onPointerLeave={() => setActive(null)}>
      <table className="w-full table-fixed border-separate border-spacing-0 text-left">
        <caption className="sr-only">Complaints by category, most reported first</caption>
        <colgroup>
          <col className="w-[38%] sm:w-[30%]" />
          <col />
        </colgroup>
        <thead className="sr-only">
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Complaints</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row, index) => {
            const count = Number(row.complaint_count) || 0
            const width = top > 0 ? (count / top) * 100 : 0
            const lit = active === row.id
            const dimmed = active != null && !lit
            return (
              <tr
                key={row.id}
                className="group/row"
                onPointerEnter={(event) => event.pointerType !== 'touch' && setActive(row.id)}
              >
                <th
                  scope="row"
                  className={cn(
                    'py-1.5 pr-3 align-middle text-[13px] font-medium leading-tight transition-colors duration-200 sm:w-[30%] sm:text-sm',
                    lit ? 'text-ink' : 'text-ink-2',
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      aria-hidden
                      className="size-2.5 shrink-0 rounded-[3px] ring-1 ring-inset ring-black/10"
                      style={{ backgroundColor: isHex(row.color) ? row.color : '#8C9A96' }}
                    />
                    <span className="truncate" title={row.name}>
                      {row.name}
                    </span>
                  </span>
                </th>
                <td className="relative py-1.5 align-middle">
                  {/* The plot: grid lines, the row's hover light, the bar and its value. The right margin keeps
                      room for the value after the longest bar, so the scale stays true. */}
                  <div className="relative mr-9 h-7">
                    <div aria-hidden className="absolute inset-y-[-6px] inset-x-0">
                      {ticks.map((tick) => (
                        <span
                          key={tick}
                          className={cn('absolute inset-y-0 w-px', tick === 0 ? 'bg-line-strong' : 'cv-grid')}
                          style={{ left: `${(tick / top) * 100}%` }}
                        />
                      ))}
                    </div>
                    <div
                      aria-hidden
                      className={cn(
                        'absolute inset-y-0 -right-9 left-0 rounded-r-md transition-colors duration-200',
                        lit ? 'bg-sunken' : 'bg-transparent',
                      )}
                    />
                    <div className="absolute inset-y-[5px] left-0 w-full">
                      <motion.span
                        aria-hidden
                        className={cn(
                          'absolute inset-y-0 left-0 rounded-r-[4px] transition-[background-color,opacity] duration-200',
                          lit ? 'bg-primary-hover dark:bg-primary-ink' : 'bg-primary',
                          dimmed && 'opacity-55',
                        )}
                        style={{ width: `${Math.max(width, count > 0 ? 0.8 : 0)}%` }}
                        initial={reduced ? false : { clipPath: 'inset(0 100% 0 0)' }}
                        animate={reduced || seen ? { clipPath: 'inset(0 0% 0 0)' } : undefined}
                        transition={{ duration: BAR_GROW, delay: index * BAR_STEP, ease: EASE.enter }}
                      />
                      <span
                        className="absolute top-1/2 ml-2 -translate-y-1/2 text-[13px] font-bold text-ink tabular"
                        style={{ left: `${width}%` }}
                      >
                        {formatNumber(count)}
                        <span className="sr-only">, {share(count)} of all complaints</span>
                      </span>
                    </div>
                    {lit ? (
                      <span
                        aria-hidden
                        className={cn(
                          'pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-ink-2 shadow-[var(--shadow-overlay)]',
                          // The first row's tip opens below it, so it stays inside the card.
                          index === 0 ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
                        )}
                        style={{ left: `${Math.min(Math.max(width, 18), 82)}%` }}
                      >
                        <span className="font-semibold text-ink">{row.name}</span>
                        <span className="mx-1.5 text-ink-3">·</span>
                        <span className="font-semibold text-ink tabular">{formatNumber(count)}</span> complaints,{' '}
                        <span className="tabular">{share(count)}</span> of all
                      </span>
                    ) : null}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot aria-hidden>
          <tr>
            <td />
            <td className="pt-2">
              <div className="relative mr-9 h-4 text-[11px] text-ink-3 tabular">
                {ticks.map((tick, index) => (
                  <span
                    key={tick}
                    className={cn(
                      'absolute top-0',
                      index === 0 ? 'translate-x-0' : index === ticks.length - 1 ? '-translate-x-full' : '-translate-x-1/2',
                    )}
                    style={{ left: `${(tick / top) * 100}%` }}
                  >
                    {formatNumber(tick)}
                  </span>
                ))}
              </div>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

export default CategoryVolumeChart
