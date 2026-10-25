/**
 * AIModeBadge - says which AI produced THIS result: "Demo AI Mode" or (optionally) "Production AI".
 *
 * Props:
 * - isDemo: the result's own `is_demo` flag (wins over `mode`)
 * - mode: the result's `mode` / `model_mode` ('demo' | 'production')
 * - modelVersion: added to the explanation tooltip (e.g. "demo-opencv-heuristic-1.0")
 * - showProduction: also render a badge for production results (default false: only demo is flagged)
 * - size: 'sm' | 'md' (default 'md')
 * - className
 *
 * The app-wide DemoModeBadge (components/ui) reflects the CURRENT system mode. A stored prediction,
 * verification or sentiment result keeps the mode it was computed in, so result panels use this badge,
 * driven by the result itself - an old demo prediction stays labelled demo after the system switches to
 * production. The badge is a button so the explanation is reachable by keyboard and touch. On touch screens the
 * button is a transparent 44 x 44 px hit area around the chip, so the chip keeps its size while the target is
 * large enough.
 */
import { Cpu, FlaskConical } from 'lucide-react'
import { Tooltip } from '@/components/ui/Tooltip'
import { cn } from '@/utils/cn'
import { DEMO_MODE_DESCRIPTION } from '@/utils/constants'

const SIZES = {
  sm: 'gap-1 px-1.5 py-0.5 text-[11px] [&_svg]:size-3',
  md: 'gap-1.5 px-2 py-1 text-xs [&_svg]:size-3.5',
}

export function AIModeBadge({ isDemo, mode, modelVersion, showProduction = false, size = 'md', className }) {
  const demo = typeof isDemo === 'boolean' ? isDemo : mode === 'demo'
  if (!demo && !(showProduction && (mode === 'production' || isDemo === false))) return null
  const version = modelVersion ? ` Model version: ${modelVersion}.` : ''
  const tip = demo
    ? `${DEMO_MODE_DESCRIPTION}${version}`
    : `This result was produced by the production AI models (trained deep-learning weights).${version}`
  const Icon = demo ? FlaskConical : Cpu

  return (
    <Tooltip content={tip}>
      <button
        type="button"
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-md pointer-coarse:min-h-11 pointer-coarse:min-w-11',
          className,
        )}
      >
        <span
          className={cn(
            'inline-flex items-center rounded-md font-semibold ring-1 ring-inset',
            demo
              ? 'bg-marking-50 text-marking-800 ring-marking-200 dark:bg-marking-500/15 dark:text-marking-300 dark:ring-marking-500/30'
              : 'bg-sign-50 text-sign-700 ring-sign-200 dark:bg-sign-500/15 dark:text-sign-300 dark:ring-sign-500/30',
            SIZES[size] ?? SIZES.md,
          )}
        >
          <Icon aria-hidden />
          {demo ? 'Demo AI Mode' : 'Production AI'}
        </span>
      </button>
    </Tooltip>
  )
}

export default AIModeBadge
