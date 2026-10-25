/**
 * ReportStepper - progress header of the report wizard: Photo, Details, Location, Review.
 *
 * Props:
 * - steps: `[{key, label}]`
 * - current: index of the open step
 * - furthest: highest step index reached so far (steps up to it can be revisited)
 * - onSelect(index): a reachable step was chosen
 *
 * Completed steps are highway-green discs with a tick, the open step wears the road-marking yellow ring, and
 * the steps are joined by the lane line (yellow dashes behind you, grey dashes ahead) - the same language as
 * the complaint LifecycleStepper, so reporting and tracking read as one road. Each stop is a real button
 * (keyboard reachable) with its state spelled out for screen readers; unreachable steps are disabled.
 *
 * Motion: moving forward paints the lane to the new step and the finished step's tick pops in; going back
 * lifts the paint again. Reduced motion: the state changes at once.
 */
import { Check } from 'lucide-react'
import { cn } from '@/utils/cn'

const MUTED_LANE_X = {
  backgroundImage: 'repeating-linear-gradient(to right, var(--c-line-strong) 0 6px, transparent 6px 11px)',
}

export function ReportStepper({ steps, current, furthest, onSelect, className }) {
  return (
    <ol aria-label="Report steps" className={cn('flex w-full items-start', className)}>
      {steps.map((step, index) => {
        const complete = index < current
        const isCurrent = index === current
        const reachable = index <= furthest && !isCurrent
        const state = complete ? 'completed' : isCurrent ? 'current step' : 'not started'
        return (
          <li key={step.key} className="relative flex min-w-0 flex-1 flex-col items-center">
            {index > 0 ? (
              <>
                <span aria-hidden className="absolute right-1/2 top-[15px] h-[3px] w-full -translate-y-1/2" style={MUTED_LANE_X} />
                <span
                  aria-hidden
                  className="lane-line-x absolute right-1/2 top-[15px] h-[3px] w-full -translate-y-1/2 transition-[clip-path] duration-500 ease-standard"
                  style={{ clipPath: index <= current ? 'inset(0% 0% 0% 0%)' : 'inset(0% 100% 0% 0%)' }}
                />
              </>
            ) : null}
            <button
              type="button"
              onClick={() => onSelect?.(index)}
              disabled={!reachable}
              aria-current={isCurrent ? 'step' : undefined}
              className="group relative z-10 flex min-w-0 flex-col items-center gap-1.5 rounded-lg px-1 disabled:cursor-default pointer-coarse:min-h-11"
            >
              <span
                className={cn(
                  'grid size-[30px] place-items-center rounded-full font-display text-sm font-bold tabular transition-[color,background-color,box-shadow] duration-300 ease-standard',
                  complete && 'bg-sign-600 text-white group-enabled:group-hover:bg-sign-700',
                  isCurrent && 'bg-surface text-ink ring-[3px] ring-marking-500',
                  !complete && !isCurrent && 'bg-surface text-ink-3 ring-1 ring-line-strong',
                  !complete && !isCurrent && reachable && 'group-hover:text-ink group-hover:ring-ink-3',
                )}
              >
                {complete ? <Check aria-hidden className="size-4 animate-pop-in motion-reduce:animate-none" strokeWidth={3} /> : <span aria-hidden>{index + 1}</span>}
              </span>
              <span
                className={cn(
                  'max-w-full truncate text-xs',
                  isCurrent ? 'font-bold text-ink' : complete ? 'font-semibold text-ink-2' : 'font-medium text-ink-3',
                )}
              >
                {step.label}
                <span className="sr-only">
                  {`, step ${index + 1} of ${steps.length}, ${state}`}
                </span>
              </span>
            </button>
          </li>
        )
      })}
    </ol>
  )
}

export default ReportStepper
