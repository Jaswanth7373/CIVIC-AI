/**
 * DemoResultView - the AI engine's answer to a visitor's own photo and / or description
 * (POST /api/ai/demo/ response), laid out like the AI analysis panel staff see on a complaint:
 * the photo with the detections, the fused category and confidence, how each model voted, the severity hint,
 * the department the category is routed to, the text signals and the engine's own disclaimer.
 *
 * Props: result (demo response), imageUrl (object URL of the photo that was sent, or null),
 * categories (public CategoryOut list for names, routing and response targets).
 */
import { Brain, Building2, ScanSearch, Sparkles, TriangleAlert } from 'lucide-react'
import { AIModeBadge } from '@/components/ai/AIModeBadge'
import { ConfidenceBar } from '@/components/ai/ConfidenceBar'
import { ImageWithBoxes } from '@/components/ai/ImageWithBoxes'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { DepartmentBadge } from '@/components/complaints/DepartmentBadge'
import { SeverityBadge } from '@/components/complaints/SeverityBadge'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/utils/cn'
import { formatHours, formatNumber } from '@/utils/format'
import { findCategory, routeFor } from './demoUtils'

const AGREEMENT = {
  agree: { tone: 'green', label: 'Photo and description agree' },
  disagree: { tone: 'orange', label: 'Photo and description disagree' },
  single_modality: { tone: 'blue', label: 'Decided from one source' },
  none: { tone: 'neutral', label: 'No usable evidence' },
}

/** The fusion explanation without the trailing demo disclaimer (the badge and footnote already say it). */
function plainExplanation(text) {
  return String(text ?? '')
    .split(/\s*Demo AI Mode:/)[0]
    .trim()
}

function Block({ title, icon: Icon, children, className }) {
  return (
    <section className={cn('border-t border-line pt-4', className)}>
      <h3 className="mb-2.5 flex items-center gap-2 text-sm font-bold text-ink">
        <Icon aria-hidden className="size-4 text-ink-3" />
        {title}
      </h3>
      {children}
    </section>
  )
}

export function DemoResultView({ result, imageUrl, categories }) {
  const vision = result?.vision ?? null
  const text = result?.text ?? null
  const fusion = result?.fusion ?? {}
  const hint = result?.severity_hint ?? null
  const category = result?.category ?? null
  const route = routeFor(categories, category)
  const agreement = AGREEMENT[fusion.agreement] ?? AGREEMENT.none
  const nameOf = (slug) => findCategory(categories, slug)?.name ?? (slug ? String(slug).replace(/_/g, ' ') : null)
  const keywords = (Array.isArray(text?.keywords) ? text.keywords : [])
    .map((keyword) => (typeof keyword === 'string' ? keyword : (keyword?.keyword ?? '')))
    .filter(Boolean)
  const impacts = (Array.isArray(text?.impacts) ? text.impacts : []).filter((impact) => impact?.label || impact?.type)
  const explanation = plainExplanation(fusion.explanation)
  const versions = [vision?.model_version, text?.model_version, fusion.version].filter(Boolean)

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="min-w-0">
        {imageUrl ? (
          <>
            <ImageWithBoxes
              src={imageUrl}
              alt="Your photo with the regions the AI marked"
              objects={vision?.detected_objects}
              boxes={vision?.bounding_boxes}
              categories={categories}
              maxHeight="22rem"
            />
            {vision?.explanation ? <p className="mt-3 text-xs leading-relaxed text-ink-3">{vision.explanation}</p> : null}
          </>
        ) : (
          <div className="grid aspect-[4/3] place-items-center rounded-xl border border-dashed border-line-strong bg-surface-2 p-6 text-center">
            <p className="max-w-[16rem] text-sm text-ink-2">No photo was sent, so the description alone decided the category.</p>
          </div>
        )}
      </div>

      <div className="min-w-0 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="mb-1.5 text-xs font-medium text-ink-3">AI category</p>
            <CategoryBadge category={category} size="lg" emptyLabel="No confident category" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={agreement.tone} size="sm">
              {agreement.label}
            </Badge>
            <AIModeBadge isDemo={result?.is_demo} mode={result?.mode} size="sm" showProduction />
          </div>
        </div>

        <ConfidenceBar value={fusion.confidence} label="Fused confidence" />
        {explanation ? <p className="text-sm leading-relaxed text-ink-2">{explanation}</p> : null}

        {fusion.needs_review ? (
          <Alert tone="warning" icon={TriangleAlert} title="A person would check this one">
            In a real complaint this result is flagged for manual review, so an administrator confirms the category.
          </Alert>
        ) : null}

        <Block title="How each model voted" icon={Sparkles}>
          <div className="grid gap-4 sm:grid-cols-2">
            <ConfidenceBar
              size="sm"
              label="Image model"
              detail={vision ? (nameOf(vision.category) ?? 'No category') : 'No photo sent'}
              value={vision ? vision.confidence : null}
            />
            <ConfidenceBar
              size="sm"
              label="Text classifier"
              detail={text ? (nameOf(text.category) ?? 'No category') : 'No description sent'}
              value={text ? text.confidence : null}
            />
          </div>
        </Block>

        <Block title="Severity hint" icon={ScanSearch}>
          <SeverityBadge severity={hint?.level} score={hint?.score} withLabel />
          {hint?.reason ? <p className="mt-1.5 text-sm text-ink-2">{hint.reason}</p> : null}
        </Block>

        <Block title="Routed to" icon={Building2}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <DepartmentBadge department={route.department} emptyLabel={category ? 'Routing unavailable' : 'No department without a category'} />
            {route.slaHours ? (
              <span className="text-sm text-ink-2">
                Response target <span className="font-semibold text-ink">{formatHours(route.slaHours)}</span>
              </span>
            ) : null}
          </div>
        </Block>

        {keywords.length || impacts.length ? (
          <Block title="What the description says" icon={Brain}>
            {keywords.length ? (
              <ul aria-label="Keywords" className="flex flex-wrap gap-1.5">
                {keywords.map((keyword) => (
                  <li key={keyword} className="rounded-md bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2 ring-1 ring-inset ring-line">
                    {keyword}
                  </li>
                ))}
              </ul>
            ) : null}
            {impacts.length ? (
              <p className={cn('text-sm text-ink-2', keywords.length && 'mt-2.5')}>
                Likely impact:{' '}
                <span className="font-semibold text-ink">{impacts.map((impact) => impact.label || impact.type).join(', ')}</span>
              </p>
            ) : null}
          </Block>
        ) : null}
      </div>

      <div className="space-y-1.5 border-t border-line pt-3 md:col-span-2">
        {result?.disclaimer ? <p className="text-xs leading-relaxed text-ink-3">{result.disclaimer}</p> : null}
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-ink-3">
          {versions.length ? <span className="break-all">Models: {versions.join(', ')}</span> : null}
          {result?.processing_time_ms != null ? (
            <span>
              Analysed in {formatNumber(result.processing_time_ms)} ms
            </span>
          ) : null}
        </p>
      </div>
    </div>
  )
}

export default DemoResultView
