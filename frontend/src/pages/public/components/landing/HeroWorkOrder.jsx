/**
 * HeroWorkOrder - the landing page's characteristic element: a municipal work order filled in live by the
 * real AI engine, presented as a glass dispatch card over the 3D city.
 *
 * On load the page posts a bundled sample photo + description to the public demo endpoint
 * (POST /api/ai/demo/, nothing is stored). When the answer arrives, ONE orchestrated sequence plays:
 * the photo is already on the card, the real detection box draws in, then the category with its fused
 * confidence, the severity hint and finally the department the category is routed to (from the public
 * /categories/ routing data). Every value on the card comes from those two responses.
 *
 * Presentation: over the scene (large screens) the card is frosted glass that leans toward the pointer
 * (TiltCard: mouse / trackpad only, no transform at rest); below the scene (phones, tablets) it is a solid
 * card. The photo carries viewfinder corners; while the engine works a yellow scan line sweeps it.
 * Compact at lg only (1024-1279 px, where the copy column is narrow): a slimmer evidence column, smaller type in
 * the caption and the severity's one-line reason left out (the level and score stay), so the card is about a
 * quarter shorter and narrower and leaves the copy room. From xl on, and below lg, the full ticket.
 *
 * Props:
 * - demo: `useApi` state of the hero request `{data, loading, error}`
 * - onRetry(): run the request again (after an outage or a rate limit)
 * - categories / categoriesLoading: public CategoryOut list (department routing + SLA)
 * - onTryOwn(): open the "Try your own photo" dialog
 * - hold: while true the fields do not start filling in (the hero's entrance has not been cued yet)
 *
 * Contract: `article[aria-labelledby='hero-demo-title']` with "Analysed in N ms", the category, the severity
 * level, the department and "Demo AI Mode" as text. Reduced motion: the final work order is shown at once.
 * Screen readers get one summary announcement.
 */
import { motion } from 'framer-motion'
import { Camera, Quote, RefreshCw, RotateCcw } from 'lucide-react'
import { AIModeBadge } from '@/components/ai/AIModeBadge'
import { ConfidenceBar } from '@/components/ai/ConfidenceBar'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { DepartmentBadge } from '@/components/complaints/DepartmentBadge'
import { SeverityBadge } from '@/components/complaints/SeverityBadge'
import { TiltCard } from '@/components/motion/TiltCard'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Spinner } from '@/components/ui/Spinner'
import { cn } from '@/utils/cn'
import { getLevelMeta } from '@/utils/constants'
import { getErrorMessage } from '@/utils/errors'
import { formatHours, formatNumber } from '@/utils/format'
import { HERO_SAMPLE, findCategory, percent, retryAfterSeconds, routeFor } from './demoUtils'
import { useCountdown } from './useCountdown'
import { useRevealSequence } from './useRevealSequence'

const IMAGE_WIDTH = 640
const IMAGE_HEIGHT = 480
const EASE = [0.22, 1, 0.36, 1]

const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0))

/** The first detection the vision engine returned: `{box: [x1, y1, x2, y2] (0-1), label, confidence, approximate}`. */
function primaryDetection(vision) {
  const objects = Array.isArray(vision?.detected_objects) ? vision.detected_objects : []
  const object = objects.find((item) => Array.isArray(item?.box) && item.box.length >= 4)
  const raw = object?.box ?? (Array.isArray(vision?.bounding_boxes) ? vision.bounding_boxes[0] : null)
  if (!Array.isArray(raw) || raw.length < 4) return null
  const [x1, y1, x2, y2] = raw.slice(0, 4).map(clamp01)
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null
  return {
    box: [x1, y1, x2, y2],
    label: object?.label ?? vision?.category ?? '',
    confidence: object?.confidence ?? vision?.confidence,
    approximate: Boolean(object?.approximate),
  }
}

/** "Photo 75% and description 98% agree" - how the two models voted, in words. */
function agreementText(result, categories) {
  const fusion = result?.fusion ?? {}
  const name = (slug) => findCategory(categories, slug)?.name ?? String(slug ?? '').replace(/_/g, ' ')
  const image = fusion.image_category ? `photo ${percent(fusion.image_confidence)}` : null
  const text = fusion.text_category ? `description ${percent(fusion.text_confidence)}` : null
  if (fusion.agreement === 'agree' && image && text) return `Photo ${percent(fusion.image_confidence)} and description ${percent(fusion.text_confidence)} agree`
  if (fusion.agreement === 'disagree' && image && text) {
    return `Photo says ${name(fusion.image_category)} (${percent(fusion.image_confidence)}), description says ${name(fusion.text_category)} (${percent(fusion.text_confidence)})`
  }
  if (image || text) return `Decided from the ${image ? 'photo' : 'description'} alone`
  return 'Fused decision of the photo and description models'
}

function DetectionOverlay({ detection, visible, animated, name }) {
  if (!detection) return null
  const [x1, y1, x2, y2] = detection.box
  const rect = {
    x: x1 * IMAGE_WIDTH,
    y: y1 * IMAGE_HEIGHT,
    width: (x2 - x1) * IMAGE_WIDTH,
    height: (y2 - y1) * IMAGE_HEIGHT,
  }
  const drawn = { pathLength: 1, opacity: 1 }
  const hidden = { pathLength: 0, opacity: 0 }
  const motionProps = detection.approximate
    ? { initial: false, animate: { opacity: visible ? 1 : 0 }, transition: { duration: animated ? 0.4 : 0 } }
    : {
        initial: animated ? hidden : false,
        animate: visible ? drawn : hidden,
        transition: { duration: animated ? 0.75 : 0, ease: EASE },
      }
  // The label hangs from the side of the box nearer the photo's centre, so it stays inside even the narrow
  // evidence photo of the dispatch ticket.
  const anchorRight = (x1 + x2) / 2 > 0.5
  const labelInside = y1 < 0.09

  return (
    <>
      <svg
        aria-hidden
        viewBox={`0 0 ${IMAGE_WIDTH} ${IMAGE_HEIGHT}`}
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 size-full"
      >
        <motion.rect
          {...rect}
          rx="6"
          fill="none"
          stroke="rgb(15 22 23 / 0.65)"
          strokeWidth="9"
          strokeDasharray={detection.approximate ? '18 12' : undefined}
          {...motionProps}
        />
        <motion.rect
          {...rect}
          rx="6"
          fill="none"
          stroke="#fbc41a"
          strokeWidth="5"
          strokeDasharray={detection.approximate ? '18 12' : undefined}
          {...motionProps}
        />
      </svg>
      <motion.span
        aria-hidden
        initial={animated ? { opacity: 0 } : false}
        animate={{ opacity: visible ? 1 : 0 }}
        transition={{ delay: visible && animated ? 0.5 : 0, duration: 0.25 }}
        className="absolute whitespace-nowrap rounded-[3px] bg-marking-400 px-1.5 py-px text-[11px] font-bold leading-4 text-asphalt-950 shadow-[0_0_0_1px_rgb(15_22_23/0.55)]"
        style={{
          ...(anchorRight ? { right: `${(1 - x2) * 100}%` } : { left: `${x1 * 100}%` }),
          top: labelInside ? `calc(${y1 * 100}% + 6px)` : `calc(${y1 * 100}% - 22px)`,
        }}
      >
        {name} {percent(detection.confidence)}
        {detection.approximate ? ' approx.' : ''}
      </motion.span>
    </>
  )
}

function Field({ label, revealed, animated, waiting, reserve, children }) {
  return (
    <div className="grid grid-cols-[5.75rem_minmax(0,1fr)] items-start gap-x-3 px-4 py-3 sm:grid-cols-1 sm:gap-y-1.5 sm:px-5 sm:py-3.5 lg:gap-y-1 lg:px-4 lg:py-2.5">
      <dt className="pt-1 text-[13px] font-medium text-ink-3 sm:pt-0 sm:text-xs">{label}</dt>
      <dd className={cn('min-w-0', reserve)}>
        {revealed ? (
          <motion.div
            initial={animated ? { opacity: 0, y: 8, filter: 'blur(3px)' } : false}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
            transition={{ duration: 0.42, ease: EASE }}
          >
            {children}
          </motion.div>
        ) : (
          <span
            aria-hidden
            className={cn(
              'block h-7 w-3/4 max-w-[15rem] rounded-md border border-dashed border-line-strong',
              waiting && 'skeleton border-transparent',
            )}
          />
        )}
      </dd>
    </div>
  )
}

/** Camera viewfinder corners on the evidence photo (decorative). */
function Viewfinder({ active }) {
  const corner = 'absolute size-5 border-white/85 drop-shadow-[0_1px_1px_rgb(15_22_23/0.6)]'
  return (
    <span
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-2.5 transition-[inset,opacity] duration-500 ease-enter sm:inset-3',
        active ? 'opacity-100' : 'opacity-70',
      )}
    >
      <span className={cn(corner, 'left-0 top-0 rounded-tl-md border-l-2 border-t-2')} />
      <span className={cn(corner, 'right-0 top-0 rounded-tr-md border-r-2 border-t-2')} />
      <span className={cn(corner, 'bottom-0 left-0 rounded-bl-md border-b-2 border-l-2')} />
      <span className={cn(corner, 'bottom-0 right-0 rounded-br-md border-b-2 border-r-2')} />
    </span>
  )
}

/** Small status lamp next to the card title: amber while the engine works, green when done, red on failure. */
function StatusLamp({ state }) {
  const color = state === 'done' ? 'bg-sign-500' : state === 'failed' ? 'bg-signal-500' : 'bg-marking-500'
  return (
    <span aria-hidden className="relative grid size-2.5 shrink-0 place-items-center">
      {state === 'working' ? (
        <span className={cn('absolute inline-flex size-2.5 animate-ping rounded-full opacity-70 motion-reduce:hidden', color)} />
      ) : null}
      <span className={cn('relative inline-flex size-2 rounded-full ring-2 ring-white/40 dark:ring-black/30', color)} />
    </span>
  )
}

export function HeroWorkOrder({ demo, onRetry, categories, categoriesLoading, onTryOwn, hold = false, className }) {
  const result = demo.data
  const ready = Boolean(result) && !demo.loading
  const loading = demo.loading && !result
  const failed = !ready && !demo.loading && Boolean(demo.error)
  // The card fills in once it is on its way in: the reveal waits for the hero's entrance cue.
  const { step, replay, animated } = useRevealSequence(ready && !hold, 4)

  const waitSeconds = failed ? retryAfterSeconds(demo.error) : null
  const remaining = useCountdown(waitSeconds ?? 0, demo.error)

  const vision = result?.vision ?? null
  const fusion = result?.fusion ?? {}
  const hint = result?.severity_hint ?? null
  const category = result?.category ?? null
  const detection = primaryDetection(vision)
  const detectionName = findCategory(categories, detection?.label)?.name ?? category?.name ?? 'Detected issue'
  const route = routeFor(categories, category)
  const levelLabel = getLevelMeta(hint?.level)?.label

  const announcement = ready
    ? `AI analysis complete: ${category?.name ?? 'no category'}, ${percent(fusion.confidence)} confidence, ` +
      `${levelLabel ? `${levelLabel.toLowerCase()} severity` : 'severity not assessed'}` +
      `${route.department ? `, routed to ${route.department.name}` : ''}.`
    : loading
      ? 'Analysing the sample photo and description.'
      : ''

  return (
    <TiltCard
      as="article"
      max={4}
      aria-labelledby="hero-demo-title"
      className={cn(
        'min-w-0 overflow-hidden rounded-2xl border',
        // Wide screens: a dispatch ticket - evidence photo on the left, the work order fields on the right.
        'sm:grid sm:grid-cols-[13rem_minmax(0,1fr)] lg:grid-cols-[9rem_minmax(0,1fr)] xl:grid-cols-[11.5rem_minmax(0,1fr)]',
        // Below the scene (phones, tablets): a solid card on the page.
        'border-line bg-surface elev-raised',
        // Over the scene: frosted glass with a lit top edge, deeper in the night theme (dense enough at dawn that
        // the muted labels stay AA over the darkest facade behind the card).
        'lg:border-white/70 lg:bg-white/[0.86] lg:backdrop-blur-xl lg:backdrop-saturate-[1.35]',
        'dark:lg:border-white/[0.09] dark:lg:bg-asphalt-900/[0.78]',
        'lg:shadow-[inset_0_1px_0_rgb(255_255_255/0.7),var(--elev-floating)] dark:lg:shadow-[inset_0_1px_0_rgb(255_255_255/0.08),var(--elev-floating)]',
        className,
      )}
    >
      <header className="flex items-start justify-between gap-3 border-b border-line/80 px-4 py-3 sm:col-span-2 sm:px-5 lg:px-4 lg:py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusLamp state={ready ? 'done' : failed ? 'failed' : 'working'} />
            <h2 id="hero-demo-title" className="font-display text-base font-bold leading-snug text-ink">
              Live AI demo
            </h2>
          </div>
          <p className="mt-0.5 text-xs text-ink-3">A real request to the CivicAI engine. Nothing is stored.</p>
        </div>
        {result ? (
          <div className="shrink-0">
            <AIModeBadge isDemo={result.is_demo} mode={result.mode} size="sm" showProduction />
          </div>
        ) : null}
      </header>

      <figure className="min-w-0 sm:border-r sm:border-line/80">
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-sunken">
          <img
            src={HERO_SAMPLE.src}
            alt={HERO_SAMPLE.alt}
            width={IMAGE_WIDTH}
            height={IMAGE_HEIGHT}
            fetchPriority="high"
            className="absolute inset-0 size-full object-cover"
          />
          <Viewfinder active={loading} />
          {ready ? (
            <DetectionOverlay detection={detection} visible={step >= 1} animated={animated} name={detectionName} />
          ) : null}
          {loading ? (
            <>
              {animated ? (
                <motion.span
                  aria-hidden
                  className="absolute inset-x-0 top-0 h-full"
                  initial={{ y: '-100%' }}
                  animate={{ y: '0%' }}
                  transition={{ duration: 1.8, repeat: Infinity, ease: 'linear' }}
                >
                  <span className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-b from-marking-400/0 to-marking-400/25" />
                  <span className="absolute inset-x-0 bottom-0 h-0.5 bg-marking-400 shadow-[0_0_10px_1px_rgb(251_196_26/0.6)]" />
                </motion.span>
              ) : null}
              <span className="absolute bottom-3 left-3 inline-flex items-center gap-2 rounded-md bg-asphalt-950/80 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur-sm">
                <Spinner size="xs" decorative />
                Analysing photo and description
              </span>
            </>
          ) : null}
        </div>
        <figcaption className="flex gap-2.5 border-b border-line/80 px-4 py-3 text-sm leading-relaxed text-ink-2 sm:border-b-0 sm:px-4 sm:text-[13px] lg:gap-2 lg:px-3.5 lg:py-2.5 lg:leading-snug lg:max-xl:gap-1.5 lg:max-xl:px-3 lg:max-xl:text-xs">
          <Quote aria-hidden className="mt-1 size-3.5 shrink-0 text-ink-3" />
          <span>
            <span className="sr-only">Description sent with the photo: </span>
            {HERO_SAMPLE.description}
          </span>
        </figcaption>
      </figure>

      {failed ? (
        <div className="min-w-0 space-y-3 px-4 py-4 sm:px-5">
          {waitSeconds != null ? (
            <Alert tone="warning" title="The live demo is busy">
              {remaining > 0
                ? `It has run many times from this network in the last minute. It can run again in ${remaining}\u00a0s.`
                : 'It can run again now.'}
            </Alert>
          ) : (
            <Alert tone="danger" title="The live AI demo couldn't run">
              {getErrorMessage(demo.error)}
            </Alert>
          )}
          <Button size="sm" variant="outline" leftIcon={RefreshCw} onClick={onRetry} disabled={remaining > 0}>
            {remaining > 0 ? `Try again in ${remaining}\u00a0s` : 'Run the demo again'}
          </Button>
        </div>
      ) : (
        <dl className="min-w-0 divide-y divide-line/80">
          <Field label="Issue" revealed={ready && step >= 2} animated={animated} waiting={loading} reserve="min-h-[4.25rem]">
            <div className="flex flex-wrap items-center gap-2">
              <CategoryBadge category={category} size="lg" />
            </div>
            <ConfidenceBar size="sm" className="mt-2.5 lg:mt-2" value={fusion.confidence} label={agreementText(result, categories)} />
          </Field>
          <Field label="Severity hint" revealed={ready && step >= 3} animated={animated} waiting={loading} reserve="min-h-[3.5rem] lg:max-xl:min-h-7">
            <SeverityBadge severity={hint?.level} score={hint?.score} withLabel />
            {hint?.reason ? <p className="mt-1.5 text-sm text-ink-2 lg:mt-1 lg:text-[13px] lg:leading-snug lg:max-xl:hidden">{hint.reason}</p> : null}
          </Field>
          <Field
            label="Routed to"
            revealed={ready && step >= 4 && !(categoriesLoading && !route.department)}
            animated={animated}
            waiting={loading || categoriesLoading}
            reserve="min-h-[2.25rem]"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <DepartmentBadge department={route.department} size="lg" emptyLabel="Routing unavailable" />
              {route.slaHours ? (
                <span className="text-sm text-ink-2">
                  Response target <span className="font-semibold text-ink">{formatHours(route.slaHours)}</span>
                </span>
              ) : null}
            </div>
          </Field>
        </dl>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-line/80 bg-surface-2 px-4 py-3 sm:col-span-2 sm:px-5 lg:bg-black/[0.025] lg:px-4 lg:py-2 dark:lg:bg-white/[0.03]">
        <p className="text-xs text-ink-3">
          {ready && result.processing_time_ms != null ? (
            <>
              Analysed in {formatNumber(result.processing_time_ms)} ms
            </>
          ) : loading ? (
            'Waiting for the AI engine'
          ) : (
            'Send your own photo or description'
          )}
        </p>
        <div className="flex items-center gap-1.5">
          {ready && animated ? (
            <IconButton icon={RotateCcw} label="Replay the analysis" size="sm" onClick={replay} />
          ) : null}
          <Button size="sm" variant="secondary" leftIcon={Camera} onClick={onTryOwn}>
            Try your own photo
          </Button>
        </div>
      </footer>

      <p role="status" className="sr-only">
        {announcement}
      </p>
    </TiltCard>
  )
}

export default HeroWorkOrder
