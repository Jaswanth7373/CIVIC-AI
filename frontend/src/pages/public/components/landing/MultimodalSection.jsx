/**
 * "Multimodal AI" - image + text + location fusion drawn as lanes merging into one road. The numbers come
 * from the live demo the hero just ran (POST /api/ai/demo/): what the photo model and the text model each
 * decided, the weight the fusion engine gave each lane (lane width = weight) and the fused decision. The
 * location lane is shown closed, because the public demo sends no GPS position.
 *
 * Choreography: the first time the diagram is on screen the lanes are laid down from the three sources towards
 * the merge point, their lane markings start to flow into the fused decision, and the fused confidence counts up
 * as the lanes arrive. Reduced motion: the finished diagram, still markings.
 *
 * Props: demo (`useApi` state of the hero request), categories (public CategoryOut list, for names).
 */
import { motion } from 'framer-motion'
import { Camera, MapPin, MessageSquareText, MoveDown } from 'lucide-react'
import { useId, useRef } from 'react'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { CountUp } from '@/components/motion/CountUp'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE } from '@/components/motion/tokens'
import { Badge } from '@/components/ui/Badge'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/utils/cn'
import { findCategory, percent } from './demoUtils'
import { LandingHeading, LandingSection } from './LandingSection'

const LANE_Y = [100 / 6, 50, 500 / 6]
/** Seconds the lanes take to reach the merge point. */
const LAY_SECONDS = 1.1

const AGREEMENT_LABELS = {
  agree: { tone: 'green', label: 'Photo and description agree' },
  disagree: { tone: 'orange', label: 'Photo and description disagree' },
  single_modality: { tone: 'blue', label: 'Decided from one source' },
}

const asPercent = (value) => percent(value)

function laneWidth(weight) {
  return 6 + Math.max(0, Math.min(1, Number(weight) || 0)) * 30
}

function MergeLines({ lanes, laid, animated }) {
  const clipId = `merge-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  return (
    <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="size-full overflow-visible">
      <defs>
        <clipPath id={clipId}>
          <motion.rect
            x="-5"
            y="-20"
            height="140"
            initial={animated ? { width: 0 } : false}
            animate={{ width: !animated || laid ? 110 : 0 }}
            transition={{ duration: LAY_SECONDS, ease: EASE.inOut }}
          />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {lanes.map((lane, index) => {
          const y = LANE_Y[index]
          const d = `M 0 ${y} C 55 ${y}, 45 50, 100 50`
          if (lane.closed) {
            return (
              <path
                key={lane.key}
                d={d}
                fill="none"
                strokeWidth={2}
                strokeDasharray="5 5"
                vectorEffect="non-scaling-stroke"
                className="stroke-line-strong"
              />
            )
          }
          return (
            <g key={lane.key}>
              <path
                d={d}
                fill="none"
                strokeWidth={laneWidth(lane.weight)}
                vectorEffect="non-scaling-stroke"
                className="stroke-asphalt-800 dark:stroke-asphalt-600"
              />
              <path
                d={d}
                fill="none"
                strokeWidth={2}
                strokeDasharray="7 6"
                vectorEffect="non-scaling-stroke"
                className="lane-flow stroke-marking-500"
                data-paused={!laid || undefined}
              />
            </g>
          )
        })}
      </g>
    </svg>
  )
}

function Lane({ lane, loading, index, laid, animated }) {
  return (
    <motion.div
      className={cn(
        'flex h-full items-center gap-3 rounded-xl border px-3.5 py-3',
        lane.closed ? 'border-dashed border-line-strong bg-transparent' : 'border-line bg-surface elev-raised',
      )}
      initial={animated ? { opacity: 0, x: -14 } : false}
      animate={!animated || laid ? { opacity: 1, x: 0 } : undefined}
      transition={{ duration: 0.5, delay: index * 0.09, ease: EASE.enter }}
    >
      <span
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-xl',
          lane.closed ? 'bg-sunken text-ink-3' : 'bg-asphalt-900 text-marking-400 ring-1 ring-inset ring-white/10 dark:bg-asphalt-800',
        )}
      >
        <lane.icon aria-hidden className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-display text-[15px] font-bold text-ink">{lane.title}</p>
          {loading ? (
            <Skeleton className="h-3.5 w-16" />
          ) : lane.weight != null ? (
            <p className="shrink-0 text-xs text-ink-3">
              weight <span className="font-semibold text-ink">{percent(lane.weight)}</span>
            </p>
          ) : null}
        </div>
        <div className="mt-1 min-w-0 text-sm text-ink-2">{loading ? <Skeleton className="h-5 w-40" /> : lane.body}</div>
      </div>
    </motion.div>
  )
}

export function MultimodalSection({ demo, categories }) {
  const result = demo.data
  const loading = demo.loading && !result
  const fusion = result?.fusion ?? {}
  const weights = fusion.weights ?? {}
  const nameOf = (slug) => findCategory(categories, slug) ?? (slug ? { slug, name: String(slug).replace(/_/g, ' ') } : null)
  const agreement = AGREEMENT_LABELS[fusion.agreement]
  const reduced = usePrefersReducedMotion()
  const animated = !reduced
  const diagramRef = useRef(null)
  const laid = useInViewOnce(diagramRef, { margin: '0px 0px -20% 0px' })
  const confidence = Number(fusion.confidence)

  const lanes = [
    {
      key: 'image',
      title: 'Photo',
      icon: Camera,
      weight: result ? weights.image : null,
      closed: Boolean(result) && !(Number(weights.image) > 0),
      body: result?.vision ? (
        <span className="flex flex-wrap items-center gap-2">
          <CategoryBadge category={nameOf(result.vision.category)} size="sm" />
          <span>{percent(result.vision.confidence)} sure</span>
        </span>
      ) : result ? (
        'No photo in this example'
      ) : (
        'Live result unavailable'
      ),
    },
    {
      key: 'text',
      title: 'Description',
      icon: MessageSquareText,
      weight: result ? weights.text : null,
      closed: Boolean(result) && !(Number(weights.text) > 0),
      body: result?.text ? (
        <span className="flex flex-wrap items-center gap-2">
          <CategoryBadge category={nameOf(result.text.category)} size="sm" />
          <span>{percent(result.text.confidence)} sure</span>
        </span>
      ) : result ? (
        'No description in this example'
      ) : (
        'Live result unavailable'
      ),
    },
    {
      key: 'location',
      title: 'Location',
      icon: MapPin,
      weight: result ? weights.location : null,
      closed: !(Number(weights.location) > 0),
      body:
        Number(weights.location) > 0
          ? 'Nearby reports nudged the decision.'
          : 'Closed in this demo: no GPS position was sent. In a real report, nearby complaints add a small nudge.',
    },
  ]

  return (
    <LandingSection id="multimodal-ai" labelledBy="multimodal-title" tone="surface" joined>
      <LandingHeading
        layout="spread"
        id="multimodal-title"
        title="Multimodal AI"
        lead="A photo can be blurry and a description can be vague. CivicAI lets both models vote, weighs each vote by how sure the model is, and merges them into one decision."
      />

      <div
        ref={diagramRef}
        className="mt-12 grid gap-4 md:grid-cols-[minmax(0,1fr)_7rem_minmax(0,0.85fr)] md:items-stretch md:gap-0 lg:grid-cols-[minmax(0,1fr)_11rem_minmax(0,0.8fr)]"
      >
        <div className="grid gap-3 md:grid-rows-3 md:gap-0">
          {lanes.map((lane, index) => (
            <div key={lane.key} className="md:py-1.5">
              <Lane lane={lane} loading={loading && lane.key !== 'location'} index={index} laid={laid} animated={animated} />
            </div>
          ))}
        </div>

        <div aria-hidden className="hidden md:block">
          <MergeLines
            lanes={lanes.map((lane) => ({ ...lane, weight: loading ? 0.4 : lane.weight }))}
            laid={laid}
            animated={animated}
          />
        </div>
        <div aria-hidden className="flex justify-center text-ink-3 md:hidden">
          <MoveDown className="size-6" />
        </div>

        <div className="flex items-center">
          <motion.div
            className="w-full rounded-2xl border-2 border-asphalt-800 bg-surface p-4 elev-raised dark:border-asphalt-600 sm:p-6"
            initial={animated ? { opacity: 0.4, scale: 0.97 } : false}
            animate={!animated || laid ? { opacity: 1, scale: 1 } : undefined}
            transition={{ duration: 0.6, delay: animated ? LAY_SECONDS * 0.85 : 0, ease: EASE.enter }}
          >
            <p className="text-xs font-medium text-ink-3">Fused decision</p>
            {loading ? (
              <div className="mt-2 space-y-2">
                <Skeleton className="h-7 w-44" />
                <Skeleton className="h-4 w-32" />
              </div>
            ) : result ? (
              <>
                <div className="mt-1.5 flex flex-wrap items-center gap-2">
                  <CategoryBadge category={result.category ?? nameOf(fusion.category)} size="lg" />
                </div>
                <p className="mt-3 font-display text-4xl font-extrabold leading-none tracking-tight text-ink tabular">
                  {Number.isFinite(confidence) ? (
                    <CountUp value={confidence} format={asPercent} delay={LAY_SECONDS * 0.7} />
                  ) : (
                    percent(fusion.confidence)
                  )}
                  <span className="ml-2 font-sans text-sm font-medium tracking-normal text-ink-2">confidence</span>
                </p>
                {agreement ? (
                  <Badge tone={agreement.tone} size="sm" className="mt-4">
                    {agreement.label}
                  </Badge>
                ) : null}
                {fusion.method ? <p className="mt-3 text-xs text-ink-3">{fusion.method}</p> : null}
              </>
            ) : (
              <p className="mt-2 text-sm text-ink-2">
                The live demo above couldn't run, so this diagram has no numbers right now.
              </p>
            )}
          </motion.div>
        </div>
      </div>

      <ul className="mt-12 grid gap-8 border-t border-line pt-10 text-[15px] leading-relaxed text-ink-2 md:grid-cols-3">
        <li>
          <strong className="block font-display text-base text-ink sm:text-[17px]">Confidence-weighted votes</strong>
          <span className="mt-1.5 block">
            Each model votes with its confidence. A blurry or dark photo counts for less, so a clear description can still
            carry the decision.
          </span>
        </li>
        <li>
          <strong className="block font-display text-base text-ink sm:text-[17px]">Small nudges, never the driver</strong>
          <span className="mt-1.5 block">
            The category the citizen picked and the categories of nearby reports only nudge the result, by roughly 10 to
            15% and 5 to 10%.
          </span>
        </li>
        <li>
          <strong className="block font-display text-base text-ink sm:text-[17px]">Unsure means a person checks</strong>
          <span className="mt-1.5 block">
            When both models are confident but disagree, or the fused result is under 30% sure, the complaint is flagged for
            manual review.
          </span>
        </li>
      </ul>
    </LandingSection>
  )
}

export default MultimodalSection
