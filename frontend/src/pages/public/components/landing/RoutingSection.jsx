/**
 * "Automatic Department Routing" - the live routing table: which department receives each civic category,
 * the backup department when there is one, and the response target (SLA). Read from the public
 * GET /api/categories/ list (`department_detail`, `secondary_department_detail`, `effective_sla_hours`), so it
 * changes the moment an administrator re-routes a category.
 *
 * The full-bleed moment of act 2 ("Decide"): the section is a night band in both themes under a lane line,
 * and the table is a dispatch board on it - the response targets in road-marking yellow, like the digits of a
 * departures board.
 *
 * Choreography: the first time the table is on screen, a routing arc in the department's own colour hops from
 * each category to its department, row after row (the same arcs that fly to the department headquarters in the
 * 3D city), and the department lands when its arc arrives. Reduced motion: the finished table.
 */
import { motion } from 'framer-motion'
import { CornerDownRight } from 'lucide-react'
import { useRef } from 'react'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { DepartmentBadge } from '@/components/complaints/DepartmentBadge'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE } from '@/components/motion/tokens'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { formatHours } from '@/utils/format'
import { LandingHeading, LandingSection } from './LandingSection'

/** Seconds between two rows' arcs, and how long one arc takes to fly. */
const ROW_STEP = 0.09
const FLIGHT = 0.62
const ARC = 'M 3 21 C 22 -3, 58 -3, 77 21'
const NEUTRAL = '#8C9A96'

const isHex = (value) => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim())

/** The hop from the category to its department: lane-line launch, the arc, a landing dot. */
function RouteArc({ color, delay, play, animated }) {
  const stroke = isHex(color) ? color : NEUTRAL
  return (
    <svg aria-hidden viewBox="0 0 80 26" className="h-7 w-full overflow-visible">
      <path d={ARC} fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 4" className="text-line-strong" />
      <motion.path
        d={ARC}
        fill="none"
        stroke={stroke}
        strokeWidth="2.5"
        strokeLinecap="round"
        initial={animated ? { pathLength: 0, opacity: 0 } : false}
        animate={!animated || play ? { pathLength: 1, opacity: 1 } : undefined}
        transition={{ pathLength: { duration: FLIGHT, delay, ease: EASE.inOut }, opacity: { duration: 0.01, delay } }}
      />
      <motion.circle
        cx="77"
        cy="21"
        r="3.5"
        fill={stroke}
        initial={animated ? { scale: 0 } : false}
        animate={!animated || play ? { scale: [0, 1.6, 1] } : undefined}
        transition={{ duration: 0.4, delay: delay + FLIGHT * 0.92, ease: EASE.standard }}
      />
    </svg>
  )
}

export function RoutingSection({ categories, loading, error, onRetry }) {
  const list = Array.isArray(categories) ? categories : []
  const departmentCount = new Set(list.map((category) => category.department_detail?.id).filter(Boolean)).size
  const reduced = usePrefersReducedMotion()
  const animated = !reduced
  const tableRef = useRef(null)
  const seen = useInViewOnce(tableRef, { margin: '0px 0px -20% 0px' })
  const play = seen && list.length > 0

  return (
    <LandingSection id="department-routing" labelledBy="routing-title" tone="night">
      <LandingHeading
        id="routing-title"
        title="Automatic Department Routing"
        lead="Once the AI knows what the issue is, the routing table decides who fixes it: no forwarding between desks, no complaint lost on the wrong one."
        actions={
          <Button variant="link" to="/how-it-works#officer-assignment">
            How the officer is chosen
          </Button>
        }
      />

      <div ref={tableRef} className="landing-board mt-12 min-w-0 overflow-hidden rounded-2xl border border-white/[0.08]">
        <div className="hidden grid-cols-[minmax(0,16rem)_5rem_minmax(0,1fr)_9rem] items-center gap-x-4 border-b border-line bg-black/20 px-5 py-3 font-display text-[11px] font-bold uppercase tracking-[0.14em] text-ink-3 md:grid">
          <span>Category</span>
          <span />
          <span>Department</span>
          <span className="text-right">Response target</span>
        </div>

        {loading && !list.length ? (
          <div aria-hidden className="space-y-4 px-5 py-5">
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="flex items-center gap-6">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-6 w-40" />
              </div>
            ))}
          </div>
        ) : error && !list.length ? (
          <ErrorState compact bordered={false} title="The routing table could not load" error={error} onRetry={onRetry} />
        ) : (
          <ul className="divide-y divide-line">
            {list.map((category, index) => {
              const delay = index * ROW_STEP
              const landing = delay + FLIGHT * 0.85
              return (
                <li
                  key={category.id}
                  className="grid gap-x-4 gap-y-2 px-4 py-3.5 sm:px-5 md:grid-cols-[minmax(0,16rem)_5rem_minmax(0,1fr)_9rem] md:items-center"
                >
                  <div className="min-w-0">
                    <CategoryBadge category={category} />
                  </div>
                  <span aria-hidden className="hidden md:block">
                    <RouteArc color={category.department_detail?.color} delay={delay} play={play} animated={animated} />
                  </span>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                    <CornerDownRight aria-hidden className="size-4 text-ink-3 md:hidden" />
                    <span className="sr-only">is routed to</span>
                    <motion.span
                      className="inline-flex"
                      initial={animated ? { opacity: 0, x: -8, scale: 0.94 } : false}
                      animate={!animated || play ? { opacity: 1, x: 0, scale: 1 } : undefined}
                      transition={{ duration: 0.38, delay: animated ? landing : 0, ease: EASE.enter }}
                    >
                      <DepartmentBadge department={category.department_detail} />
                    </motion.span>
                    {category.secondary_department_detail ? (
                      <span className="text-xs text-ink-3">
                        backup: <span className="font-semibold text-ink-2">{category.secondary_department_detail.name}</span>
                      </span>
                    ) : null}
                  </div>
                  <p className="text-sm text-ink-2 md:text-right">
                    <span className="md:sr-only">Response target </span>
                    <span className="font-display text-base font-extrabold text-marking-400 tabular sm:text-lg">
                      {formatHours(category.effective_sla_hours)}
                    </span>
                  </p>
                </li>
              )
            })}
          </ul>
        )}

        {list.length ? (
          <p className="border-t border-line bg-black/20 px-4 py-3 text-xs text-ink-3 sm:px-5">
            Live routing table: {list.length} categories go to {departmentCount} departments. When an administrator
            re-routes a category, new complaints follow the new route immediately.
          </p>
        ) : null}
      </div>
    </LandingSection>
  )
}

export default RoutingSection
