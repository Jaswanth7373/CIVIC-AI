/**
 * AIAnalysisPanel - everything the multimodal AI engine concluded about a complaint, and why.
 *
 * Props:
 * - prediction: AIPrediction `{image_category, image_confidence, text_category, text_confidence,
 *   final_category: CategoryMini, final_category_slug, multimodal_confidence, severity, severity_score,
 *   severity_reason, severity_factors, detected_objects, bounding_boxes, keywords, impacts,
 *   probabilities: {image, text, fused}, modality_weights, location_risk, explanation, needs_review,
 *   model_mode, is_demo, model_version, processing_time_ms, created_at}` | null
 * - imageUrl: the complaint photo; with it the detections are drawn on the image (ImageWithBoxes)
 * - categories: optional CategoryMini list, to name the image / text classes by their category names
 * - compact: decision + severity only (side panels)
 * - className
 *
 * Reading order mirrors the pipeline: the final decision and its explanation; how each modality voted
 * (image model, text classifier, fused result, and whether they agreed); how much weight each evidence
 * source got in the late fusion; the top fused class probabilities; severity and the factors behind it;
 * location risk; the text signals (keywords, impacts); the detections on the photo; then the model version.
 * Layout adapts to the panel's own width (CSS container queries), so it works in a side column too.
 * Results are labelled demo when `is_demo` is true, and low-confidence / disagreeing results are flagged
 * for manual review instead of being presented as certain.
 *
 * Motion: every number is drawn from zero to its real value the first time it is seen - the three model
 * votes one after another, the evidence-weight strip segment by segment, the class probabilities and the
 * severity factors in a short cascade - each bar with a lit tip on its growing edge. Reduced motion: the
 * final values at once.
 */
import { Brain, MapPinned, ScanSearch, Sparkles, TriangleAlert } from 'lucide-react'
import { useRef } from 'react'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { useInViewOnce } from '@/components/motion/hooks'
import { SeverityBadge } from '@/components/complaints/SeverityBadge'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/utils/cn'
import { getLevelMeta } from '@/utils/constants'
import { formatDateTime, formatNumber, formatPercent } from '@/utils/format'
import { AIModeBadge } from './AIModeBadge'
import { categoryFromSlug, humanize, modalityAgreement, toRatio } from './aiUtils'
import { ConfidenceBar } from './ConfidenceBar'
import { ImageWithBoxes } from './ImageWithBoxes'
import '@/styles/app.css'

const AGREEMENT = {
  agree: { tone: 'green', label: 'Image and text agree' },
  disagree: { tone: 'orange', label: 'Image and text disagree' },
  single_modality: { tone: 'blue', label: 'Decided from one source' },
  none: { tone: 'neutral', label: 'No model evidence' },
}

/**
 * Evidence sources of the late fusion, in a fixed order with fixed colours. None of them reuses a
 * severity/priority level hue (the yellow, orange and red of LEVEL_META), so the strip never reads as a level.
 */
const WEIGHT_SOURCES = [
  { key: 'image', label: 'Photo', className: 'bg-guide-500' },
  { key: 'text', label: 'Description', className: 'bg-teal-600' },
  { key: 'reported', label: "Citizen's category", className: 'bg-asphalt-500' },
  { key: 'location', label: 'Nearby reports', className: 'bg-fuchsia-600' },
]

function Section({ title, icon: Icon, children, className }) {
  return (
    <section className={cn('border-t border-line pt-4', className)}>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
        {Icon ? <Icon aria-hidden className="size-4 text-ink-3" /> : null}
        {title}
      </h3>
      {children}
    </section>
  )
}

/** A bar that grows to `ratio` (0..1) the first time it is seen, after `delay` seconds. Decorative. */
function GrowBar({ ratio, delay = 0, className, fillClassName }) {
  const ref = useRef(null)
  const seen = useInViewOnce(ref, { amount: 0.6, margin: '0px' })
  const width = `${Math.min(1, Math.max(0, ratio)) * 100}%`
  return (
    <span ref={ref} aria-hidden className={cn('block overflow-hidden rounded-full bg-sunken', className)}>
      <span
        data-seen={seen ? '' : undefined}
        className={cn('app-bar-fill block h-full rounded-full', fillClassName)}
        style={{ width: seen ? width : '0%', transitionDelay: `${delay}s`, animationDelay: `${delay}s` }}
      />
    </span>
  )
}

function WeightStrip({ weights }) {
  const ref = useRef(null)
  const seen = useInViewOnce(ref, { amount: 0.6, margin: '0px' })
  const entries = WEIGHT_SOURCES.map((source) => ({ ...source, value: Math.max(0, Number(weights?.[source.key]) || 0) })).filter(
    (entry) => entry.value > 0,
  )
  const total = entries.reduce((sum, entry) => sum + entry.value, 0)
  if (!total) return null
  return (
    <div>
      {/* Segments grow in turn from the left, like evidence being added to the decision. */}
      <div ref={ref} className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full" aria-hidden>
        {entries.map((entry, index) => (
          <span
            key={entry.key}
            className={cn('h-full transition-[flex-basis] duration-700 ease-enter', entry.className)}
            style={{ flexBasis: seen ? `${(entry.value / total) * 100}%` : '0%', transitionDelay: `${index * 0.14}s` }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
        {entries.map((entry) => (
          <li key={entry.key} className="flex items-center gap-1.5">
            <span aria-hidden className={cn('size-2.5 rounded-[2px]', entry.className)} />
            <span className="font-semibold text-ink tabular">{formatPercent(entry.value / total)}</span>
            {entry.label}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ProbabilityList({ probabilities, categories, finalCategory }) {
  const rows = Object.entries(probabilities ?? {})
    .map(([slug, value]) => ({ slug, ratio: toRatio(value) }))
    .filter((row) => row.ratio != null)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 4)
  if (!rows.length) return null
  return (
    <ul className="space-y-2">
      {rows.map((row, index) => (
        <li key={row.slug} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-xs">
          <span className="truncate font-medium text-ink-2">{categoryFromSlug(row.slug, categories, finalCategory)?.name}</span>
          <GrowBar ratio={row.ratio} delay={index * 0.1} className="h-1.5" fillClassName={index === 0 ? 'bg-guide-500' : 'bg-guide-400 dark:bg-guide-450'} />
          <span className="font-semibold text-ink tabular">{formatPercent(row.ratio)}</span>
        </li>
      ))}
    </ul>
  )
}

function SeverityFactors({ factors }) {
  const rows = Object.entries(factors ?? {})
    .map(([key, factor]) => ({ key, ...(factor && typeof factor === 'object' ? factor : {}) }))
    .filter((factor) => factor.available !== false && Number.isFinite(Number(factor.contribution)))
    .sort((a, b) => Number(b.contribution) - Number(a.contribution))
  if (!rows.length) return null
  return (
    <ul className="space-y-2.5">
      {rows.map((factor, index) => {
        const max = (Number(factor.weight) || 0) * 100
        const contribution = Number(factor.contribution) || 0
        const share = max > 0 ? Math.min(1, contribution / max) : 0
        return (
          <li key={factor.key}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
              <span className="font-medium text-ink-2">{factor.label || humanize(factor.key)}</span>
              <span className="font-semibold text-ink tabular">
                {formatNumber(contribution, { digits: 1 })}
                <span className="font-normal text-ink-3">/{formatNumber(max, { digits: 0 })} pts</span>
              </span>
            </div>
            <GrowBar ratio={share} delay={Math.min(index, 6) * 0.08} className="h-1.5" fillClassName="bg-guide-500 dark:bg-guide-450" />
            {factor.detail ? <p className="mt-0.5 text-[11px] text-ink-3">{factor.detail}</p> : null}
          </li>
        )
      })}
    </ul>
  )
}

function ImpactList({ impacts }) {
  const rows = (Array.isArray(impacts) ? impacts : []).filter((impact) => impact && (impact.label || impact.type))
  if (!rows.length) return <p className="text-xs text-ink-3">No public impact cues were found in the description.</p>
  return (
    <ul className="space-y-2">
      {rows.map((impact) => {
        const ratio = toRatio(impact.score)
        const evidence = Array.isArray(impact.evidence) ? impact.evidence.join(', ') : impact.evidence
        return (
          <li key={impact.type ?? impact.label} className="text-xs">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-semibold text-ink">{impact.label || humanize(impact.type)}</span>
              {ratio != null ? <span className="font-semibold text-ink tabular">{formatPercent(ratio)}</span> : null}
            </div>
            {evidence ? <p className="text-ink-3">Because of: {evidence}</p> : null}
          </li>
        )
      })}
    </ul>
  )
}

function LocationRisk({ risk }) {
  if (!risk || typeof risk !== 'object' || (risk.score == null && !risk.level)) {
    return <p className="text-xs text-ink-3">Location risk was not assessed for this complaint.</p>
  }
  const ratio = toRatio(risk.score)
  const meta = getLevelMeta(risk.level)
  const factors = Array.isArray(risk.factors) ? risk.factors.filter((factor) => typeof factor === 'string') : []
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {meta ? (
          <Badge tone={meta.tone} icon={meta.icon} size="sm">
            {meta.label} location risk
          </Badge>
        ) : null}
        {ratio != null ? <span className="text-xs font-semibold text-ink tabular">Score {formatPercent(ratio)}</span> : null}
        {risk.is_high_traffic ? (
          <Badge tone="orange" size="sm">
            High-traffic area
          </Badge>
        ) : null}
      </div>
      {factors.length ? (
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-ink-2">
          {factors.map((factor) => (
            <li key={factor}>{factor}</li>
          ))}
        </ul>
      ) : risk.explanation ? (
        <p className="text-xs text-ink-2">{risk.explanation}</p>
      ) : null}
    </div>
  )
}

export function AIAnalysisPanel({ prediction, imageUrl, categories, compact = false, className }) {
  if (!prediction) {
    return (
      <EmptyState
        icon={Brain}
        compact
        bordered={false}
        title="No AI analysis yet"
        description="The analysis runs automatically when a complaint is submitted. Administrators can re-run it."
        className={className}
      />
    )
  }

  const finalCategory = prediction.final_category ?? (prediction.final_category_slug ? categoryFromSlug(prediction.final_category_slug, categories) : null)
  const imageCategory = categoryFromSlug(prediction.image_category, categories, finalCategory)
  const textCategory = categoryFromSlug(prediction.text_category, categories, finalCategory)
  const agreement = AGREEMENT[modalityAgreement(prediction)]
  const probabilities = prediction.probabilities ?? {}
  const keywords = (Array.isArray(prediction.keywords) ? prediction.keywords : [])
    .map((keyword) => (typeof keyword === 'string' ? keyword : (keyword?.keyword ?? keyword?.text ?? '')))
    .filter(Boolean)

  return (
    <div className={cn('@container min-w-0 space-y-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="mb-1.5 text-xs font-medium text-ink-3">AI category</p>
          <CategoryBadge category={finalCategory} size="lg" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={agreement.tone} size="sm">
            {agreement.label}
          </Badge>
          <AIModeBadge isDemo={prediction.is_demo} mode={prediction.model_mode} modelVersion={prediction.model_version} size="sm" />
        </div>
      </div>

      <ConfidenceBar value={prediction.multimodal_confidence} label="Fused confidence" />

      {prediction.explanation ? <p className="text-sm text-ink-2">{prediction.explanation}</p> : null}

      {prediction.needs_review ? (
        <Alert tone="warning" icon={TriangleAlert} title="Flagged for manual review">
          The photo and the description disagree, or the confidence is low, so a person should confirm the category.
        </Alert>
      ) : null}

      <Section title="How each model voted" icon={Sparkles}>
        <div className="grid gap-4 @lg:grid-cols-3">
          <ConfidenceBar
            size="sm"
            label="Image model"
            detail={imageCategory?.name ?? 'No photo'}
            value={prediction.image_category ? prediction.image_confidence : null}
          />
          <ConfidenceBar
            size="sm"
            label="Text classifier"
            detail={textCategory?.name ?? 'No description'}
            value={prediction.text_category ? prediction.text_confidence : null}
            delay={0.12}
          />
          <ConfidenceBar
            size="sm"
            label="Fused decision"
            detail={finalCategory?.name ?? 'Undecided'}
            value={prediction.multimodal_confidence}
            delay={0.24}
          />
        </div>
        {!compact ? (
          <div className="mt-4 grid gap-4 @2xl:grid-cols-2">
            {prediction.modality_weights && Object.keys(prediction.modality_weights).length ? (
              <div>
                <p className="mb-2 text-xs font-medium text-ink-3">Weight of each evidence source</p>
                <WeightStrip weights={prediction.modality_weights} />
              </div>
            ) : null}
            {probabilities.fused && Object.keys(probabilities.fused).length ? (
              <div>
                <p className="mb-2 text-xs font-medium text-ink-3">Most likely categories</p>
                <ProbabilityList probabilities={probabilities.fused} categories={categories} finalCategory={finalCategory} />
              </div>
            ) : null}
          </div>
        ) : null}
      </Section>

      <Section title="Severity" icon={TriangleAlert}>
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={prediction.severity} score={prediction.severity_score} withLabel />
        </div>
        {prediction.severity_reason ? <p className="mt-2 text-sm text-ink-2">{prediction.severity_reason}</p> : null}
        {!compact ? (
          <div className="mt-3">
            <SeverityFactors factors={prediction.severity_factors} />
          </div>
        ) : null}
      </Section>

      {!compact ? (
        <>
          <Section title="Location risk" icon={MapPinned}>
            <LocationRisk risk={prediction.location_risk} />
          </Section>

          <Section title="What the description says" icon={Brain}>
            <div className="grid gap-4 @lg:grid-cols-2">
              <div>
                <p className="mb-2 text-xs font-medium text-ink-3">Keywords</p>
                {keywords.length ? (
                  <ul className="flex flex-wrap gap-1.5">
                    {keywords.map((keyword) => (
                      <li key={keyword} className="rounded-md bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2 ring-1 ring-inset ring-line">
                        {keyword}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-ink-3">No keywords extracted.</p>
                )}
              </div>
              <div>
                <p className="mb-2 text-xs font-medium text-ink-3">Public impact</p>
                <ImpactList impacts={prediction.impacts} />
              </div>
            </div>
          </Section>

          {imageUrl ? (
            <Section title="What the image model saw" icon={ScanSearch}>
              <ImageWithBoxes
                src={imageUrl}
                alt="Complaint photo with AI detections"
                objects={prediction.detected_objects}
                boxes={prediction.bounding_boxes}
                categories={categories}
              />
            </Section>
          ) : null}
        </>
      ) : null}

      <p className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-3 text-[11px] text-ink-3">
        {prediction.model_version ? <span className="break-all">Model {prediction.model_version}</span> : null}
        {prediction.processing_time_ms != null ? (
          <span className="tabular">Analysed in {formatNumber(prediction.processing_time_ms)} ms</span>
        ) : null}
        {prediction.created_at ? (
          <time dateTime={prediction.created_at} className="tabular">
            {formatDateTime(prediction.created_at)}
          </time>
        ) : null}
      </p>
    </div>
  )
}

export default AIAnalysisPanel
