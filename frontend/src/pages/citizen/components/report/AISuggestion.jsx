/**
 * AISuggestion - the live "AI suggestion" chip of the report form (POST /api/ai/classify/ via
 * useCategorySuggestion): the category the multimodal engine would pick, its fused confidence, what the photo
 * and the description each said, the Demo AI badge, and a button that applies the category to the form.
 *
 * Props:
 * - suggestion: `{status, result, error, retry}` from useCategorySuggestion
 * - selected: the category slug currently chosen in the form ('' = let the AI decide)
 * - onApply(slug): put the suggested category into the category field
 * - categories: CategoryOut list, to name the per-modality classes
 * - idleHint: text shown while there is nothing to classify yet (omit to render nothing)
 * - stacked: narrow-column layout (category, confidence bar and a full-width button on separate rows), used
 *   next to the photo preview on wide screens
 *
 * The chip is an aria-live region, so screen-reader users hear the suggestion when it arrives. Low
 * confidence (under 50 %) or a disagreement between photo and text is said plainly instead of presenting
 * the guess as certain.
 */
import { Check, RotateCcw, Sparkles, TriangleAlert } from 'lucide-react'
import { AIModeBadge } from '@/components/ai/AIModeBadge'
import { categoryFromSlug, toRatio } from '@/components/ai/aiUtils'
import { ConfidenceBar } from '@/components/ai/ConfidenceBar'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { cn } from '@/utils/cn'
import { getErrorMessage, getErrorStatus } from '@/utils/errors'
import { formatPercent } from '@/utils/format'

function modalityLine(label, slug, confidence, categories, finalCategory) {
  const ratio = toRatio(confidence)
  if (!slug || !ratio) return null
  const name = categoryFromSlug(slug, categories, finalCategory)?.name ?? slug
  return `${label}: ${name} ${formatPercent(ratio)}`
}

export function AISuggestion({ suggestion, selected, onApply, categories, idleHint, stacked = false, className }) {
  const { status, result, error, retry } = suggestion ?? {}

  if (!status || status === 'idle') {
    return idleHint ? (
      <p className={cn('flex items-start gap-2 text-xs text-ink-3', className)}>
        <Sparkles aria-hidden className="mt-px size-3.5 shrink-0" />
        {idleHint}
      </p>
    ) : null
  }

  if (status === 'error') {
    const message =
      getErrorStatus(error) === 429
        ? 'Too many suggestions in a short time. Try again in a minute.'
        : getErrorMessage(error, 'The AI could not suggest a category right now.')
    return (
      <div
        role="status"
        className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface-2 px-3.5 py-3', className)}
      >
        <TriangleAlert aria-hidden className="size-4 shrink-0 text-hazard-600 dark:text-hazard-300" />
        <p className="min-w-0 flex-1 text-sm text-ink-2">
          <span className="font-semibold text-ink">AI suggestion unavailable.</span> {message} You can still choose the
          category yourself.
        </p>
        <Button size="sm" variant="ghost" leftIcon={RotateCcw} onClick={retry}>
          Try again
        </Button>
      </div>
    )
  }

  const waiting = status === 'waiting'
  const category = result?.category ?? null
  const fusion = result?.fusion ?? {}
  const ratio = toRatio(fusion.confidence)
  const applied = Boolean(category && selected === category.slug)
  const unsure = Boolean(category) && (ratio == null || ratio < 0.5 || fusion.needs_review)
  const lines = [
    modalityLine('Photo', fusion.image_category, fusion.image_confidence, categories, category),
    modalityLine('Description', fusion.text_category, fusion.text_confidence, categories, category),
  ].filter(Boolean)

  return (
    <div
      aria-live="polite"
      aria-busy={waiting || undefined}
      className={cn('rounded-xl border border-line bg-surface-2 px-3.5 py-3', className)}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
          <Sparkles aria-hidden className="size-3.5 text-primary-ink" />
          AI suggestion
          {waiting ? (
            <span className="inline-flex items-center gap-1 font-medium text-ink-3">
              <Spinner size="xs" decorative />
              {result ? 'Updating' : 'Analysing'}
            </span>
          ) : null}
        </p>
        {result ? <AIModeBadge isDemo={result.is_demo} mode={result.mode} size="sm" /> : null}
      </div>

      {!result ? (
        <p className="mt-2 text-sm text-ink-3">Looking at your report to suggest a category…</p>
      ) : !category ? (
        <p className="mt-2 text-sm text-ink-2">The AI could not match this to a category yet. Add a little more detail.</p>
      ) : stacked ? (
        <div className={cn('mt-3 space-y-3 transition-opacity', waiting && 'opacity-60')}>
          <CategoryBadge category={category} size="lg" />
          {ratio != null ? <ConfidenceBar value={ratio} label="Confidence" size="sm" /> : null}
          {lines.length ? <p className="text-xs text-ink-3 tabular">{lines.join('. ')}.</p> : null}
          {unsure ? (
            <p className="text-xs text-hazard-700 dark:text-hazard-300">
              The AI is not sure about this one. Add more detail, or choose the category yourself.
            </p>
          ) : null}
          {applied ? (
            <p className="flex items-center gap-1 text-sm font-semibold text-sign-700 dark:text-sign-300">
              <Check aria-hidden className="size-4" />
              Category applied
            </p>
          ) : (
            <Button size="sm" variant="secondary" fullWidth onClick={() => onApply?.(category.slug)} disabled={waiting}>
              Use this category
            </Button>
          )}
        </div>
      ) : (
        <div className={cn('mt-2 transition-opacity', waiting && 'opacity-60')}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <CategoryBadge category={category} size="lg" />
            {ratio != null ? (
              <span className="text-sm font-semibold text-ink tabular">
                {formatPercent(ratio)} <span className="font-normal text-ink-3">confident</span>
              </span>
            ) : null}
            <span className="ml-auto">
              {applied ? (
                <span className="inline-flex items-center gap-1 text-sm font-semibold text-sign-700 dark:text-sign-300">
                  <Check aria-hidden className="size-4" />
                  Category applied
                </span>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => onApply?.(category.slug)} disabled={waiting}>
                  Use this category
                </Button>
              )}
            </span>
          </div>
          {unsure ? (
            <p className="mt-2 text-xs text-hazard-700 dark:text-hazard-300">
              The AI is not sure about this one. Add more detail, or choose the category yourself.
            </p>
          ) : null}
          {lines.length ? <p className="mt-1.5 text-xs text-ink-3 tabular">{lines.join('. ')}.</p> : null}
        </div>
      )}
    </div>
  )
}

export default AISuggestion
