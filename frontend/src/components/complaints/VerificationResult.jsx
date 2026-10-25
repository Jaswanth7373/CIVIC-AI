/**
 * VerificationResult - outcome of the before / after resolution verification.
 *
 * Props:
 * - verification: Verification `{id, evidence_id, score, status, status_display, explanation, metrics,
 *   method, method_display, is_manual_override, manual_review_requested, verified_by, verified_at,
 *   model_version, is_demo}` - or the engine output of POST /ai/verify-resolution/ with files
 *   (`{score, status, status_label, explanation, metrics, model_version, mode, is_demo, disclaimer,
 *   processing_time_ms}`); null shows an empty state
 * - onOverride(verification): shows an "Override result" button (officer / admin manual verification)
 * - actions: extra nodes in the footer next to the override button (the "override slot")
 * - compact: smaller ring, key metrics only
 * - className
 *
 * What the numbers mean (ai/verification): the after photo is aligned onto the before photo (ORB features +
 * RANSAC homography), then compared with SSIM, colour-histogram similarity and pixel change - globally and
 * inside the box where the issue was originally detected - and the vision model checks whether the issue is
 * still visible. The score (0-100) and status follow from those metrics. The result is advisory: the
 * disclaimer is always shown and a person can override it.
 */
import { ScanEye, ShieldAlert, SlidersHorizontal, UserRound, UserSearch } from 'lucide-react'
import { AIModeBadge } from '@/components/ai/AIModeBadge'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ScoreRing } from '@/components/ui/ScoreRing'
import { cn } from '@/utils/cn'
import { VERIFICATION_DISCLAIMER, VERIFICATION_METHOD_LABELS, VERIFICATION_META, getVerificationMeta } from '@/utils/constants'
import { formatDateTime, formatNumber, formatPercent } from '@/utils/format'

/** Known metrics, in reading order: label + how to format the value. */
const METRICS = [
  { key: 'region_change', label: 'Change where the issue was detected', format: 'percent', primary: true },
  { key: 'issue_still_detected', label: 'Issue still detected in the after photo', format: 'boolean', primary: true },
  { key: 'scene_consistency', label: 'Same place (scene consistency)', format: 'percent', primary: true },
  { key: 'ssim', label: 'Structural similarity (SSIM)', format: 'ratio', primary: true },
  { key: 'change_ratio', label: 'Share of the photo that changed', format: 'percent' },
  { key: 'histogram_similarity', label: 'Colour histogram similarity', format: 'ratio' },
  { key: 'after_issue_confidence', label: 'Issue confidence in the after photo', format: 'percent' },
  { key: 'clip_similarity', label: 'CLIP scene similarity', format: 'ratio' },
  { key: 'edge_density_change', label: 'Edge density change', format: 'ratio' },
  { key: 'colour_shift', label: 'Colour shift', format: 'ratio' },
  { key: 'mean_abs_diff', label: 'Mean absolute pixel difference', format: 'ratio' },
  { key: 'quality_ok', label: 'Photo quality good enough', format: 'boolean' },
  { key: 'before_issue_confidence', label: 'Issue confidence in the before photo', format: 'percent' },
  { key: 'aligned', label: 'Photos aligned (ORB + RANSAC homography)', format: 'boolean' },
  { key: 'alignment_inlier_ratio', label: 'Feature matches consistent with the alignment', format: 'percent' },
  { key: 'alignment_matches', label: 'Feature matches found', format: 'number' },
  { key: 'alignment_inliers', label: 'Feature matches kept (inliers)', format: 'number' },
  { key: 'region_source', label: 'Region compared', format: 'region' },
  { key: 'after_category', label: 'Class seen in the after photo', format: 'text' },
  { key: 'after_category_confidence', label: 'Confidence of that class', format: 'percent' },
  // A manual decision records the result it replaced (services/verification.manual_verification).
  { key: 'previous_status', label: 'Result it replaces', format: 'verification', hideEmpty: true },
  { key: 'previous_score', label: 'Score it replaces', format: 'score', hideEmpty: true },
  { key: 'previous_method', label: 'Method of that result', format: 'method', hideEmpty: true },
]

/** `region_source` values written by ai/verification/metrics.region_change. */
const REGION_SOURCES = {
  prior_boxes: 'The box where the issue was originally detected',
  most_changed_region: 'The area that changed the most (no detection box)',
}
const KNOWN_KEYS = new Set(METRICS.map((metric) => metric.key))

function formatMetric(value, format) {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean' || format === 'boolean') return value === true || value === 'true' ? 'Yes' : 'No'
  if (format === 'region') return REGION_SOURCES[value] ?? humanizeKey(value)
  if (format === 'text') return humanizeKey(value)
  if (format === 'verification') return VERIFICATION_META[value]?.label ?? humanizeKey(value)
  if (format === 'method') return VERIFICATION_METHOD_LABELS[value] ?? humanizeKey(value)
  const number = Number(value)
  if (!Number.isFinite(number)) return String(value)
  // One decimal = the full precision the engine stores (3 decimals). The explanation text quotes whole percents
  // computed from the unrounded values, so it always lies within 0.5 of the metric (99% next to 99.5%) instead
  // of contradicting it after a second rounding (99% next to 100%).
  if (format === 'percent') return formatPercent(number, { digits: 1 })
  if (format === 'score') return `${Math.round(number)}/100`
  if (format === 'ratio') return formatNumber(number, { digits: 2 })
  return formatNumber(number, { digits: Math.abs(number) < 10 ? 2 : 0 })
}

function isEmpty(value) {
  return value === null || value === undefined || value === ''
}

function humanizeKey(key) {
  const text = String(key).replace(/_/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function MetricRows({ rows }) {
  return (
    <dl className="grid gap-x-6 text-sm @xl:grid-cols-2">
      {rows.map((row) => (
        <div key={row.key} className="flex items-baseline justify-between gap-3 border-b border-line py-1.5">
          <dt className={cn('min-w-0', row.known ? 'text-ink-2' : 'text-ink-3')}>{row.label}</dt>
          <dd className="max-w-[55%] shrink-0 break-words text-right font-semibold text-ink tabular">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * The four metrics that decide the status are always visible; every other metric the engine reported sits in
 * an "All metrics" disclosure (compact mode shows the key four only).
 */
function MetricList({ metrics, compact }) {
  const reported = METRICS.filter((metric) => metrics[metric.key] !== undefined && !(metric.hideEmpty && isEmpty(metrics[metric.key])))
  const rows = [
    ...reported.map((metric) => ({
      key: metric.key,
      label: metric.label,
      value: formatMetric(metrics[metric.key], metric.format),
      primary: Boolean(metric.primary),
      known: true,
    })),
    ...Object.entries(metrics)
      .filter(([key, value]) => !KNOWN_KEYS.has(key) && value !== null && typeof value !== 'object' && value !== '')
      .map(([key, value]) => ({ key, label: humanizeKey(key), value: formatMetric(value), primary: false, known: false })),
  ]
  const primary = rows.filter((row) => row.primary)
  const rest = rows.filter((row) => !row.primary)
  if (!rows.length) return null
  // Without engine metrics (a manual decision) the remaining rows are all there is: show them directly.
  if (!primary.length) return <MetricRows rows={rest} />
  return (
    <div className="space-y-2">
      <MetricRows rows={primary} />
      {!compact && rest.length ? (
        <details className="group">
          <summary className="cursor-pointer select-none rounded-md py-1 text-xs font-semibold text-primary-ink hover:underline pointer-coarse:min-h-11">
            All metrics ({rest.length})
          </summary>
          <div className="mt-1">
            <MetricRows rows={rest} />
          </div>
        </details>
      ) : null}
    </div>
  )
}

export function VerificationResult({ verification, onOverride, actions, compact = false, className }) {
  if (!verification) {
    return (
      <EmptyState
        icon={ScanEye}
        compact
        bordered={false}
        title="Not verified yet"
        description="AI verification runs when the officer uploads an after photo of the resolved issue."
        className={className}
      />
    )
  }

  const known = VERIFICATION_META[verification.status]
  const meta = known ?? getVerificationMeta(verification.status)
  const statusLabel = known ? meta.label : (verification.status_display ?? verification.status_label ?? meta.label)
  const score = Number(verification.score) || 0
  const metrics = verification.metrics && typeof verification.metrics === 'object' ? verification.metrics : {}
  const method = verification.method_display ?? VERIFICATION_METHOD_LABELS[verification.method] ?? null
  // A manual decision is a person's call: it carries the "Manual override" badge only, and none of the AI
  // details (engine mode, model version, the "AI-assisted verification" disclaimer).
  const manual = verification.method === 'manual' || Boolean(verification.is_manual_override)
  const showFooter = typeof onOverride === 'function' || actions

  return (
    <div className={cn('@container min-w-0', className)}>
      <div className="flex flex-col gap-4 @md:flex-row @md:items-start">
        <ScoreRing value={score} max={100} size={compact ? 'sm' : 'md'} tone={meta.tone} label="score" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={meta.tone} icon={meta.icon} size={compact ? 'sm' : 'md'}>
              {statusLabel}
            </Badge>
            {method && !verification.is_manual_override ? (
              <Badge tone="neutral" size="sm">
                {method}
              </Badge>
            ) : null}
            {verification.is_manual_override ? (
              <Badge tone="violet" size="sm" icon={SlidersHorizontal}>
                Manual override
              </Badge>
            ) : null}
            {verification.manual_review_requested ? (
              <Badge tone="blue" size="sm" icon={UserSearch}>
                Manual review requested
              </Badge>
            ) : null}
            {manual ? null : (
              <AIModeBadge isDemo={verification.is_demo} mode={verification.mode} modelVersion={verification.model_version} size="sm" />
            )}
          </div>
          <p className="mt-2 font-display text-base font-bold text-ink">
            Resolution verification score <span className="tabular">{Math.round(score)}/100</span>
          </p>
          {verification.explanation ? <p className="mt-1 text-sm text-ink-2">{verification.explanation}</p> : null}
          {!compact && !verification.explanation && meta.description ? (
            <p className="mt-1 text-sm text-ink-2">{meta.description}</p>
          ) : null}
        </div>
      </div>

      {Object.keys(metrics).length ? (
        <div className="mt-4">
          <MetricList metrics={metrics} compact={compact} />
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
        {verification.verified_by ? (
          <span className="inline-flex items-center gap-1">
            <UserRound aria-hidden className="size-3.5" />
            Verified by {verification.verified_by.full_name}
          </span>
        ) : null}
        {verification.verified_at ? (
          <time dateTime={verification.verified_at} className="tabular">
            {formatDateTime(verification.verified_at)}
          </time>
        ) : null}
        {verification.model_version && !manual ? <span className="break-all">Model {verification.model_version}</span> : null}
        {verification.processing_time_ms != null ? (
          <span className="tabular">{formatNumber(verification.processing_time_ms)} ms</span>
        ) : null}
      </div>

      {manual ? null : (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">
          <ShieldAlert aria-hidden className="mt-px size-4 shrink-0 text-ink-3" />
          <span>{verification.disclaimer || VERIFICATION_DISCLAIMER}</span>
        </p>
      )}

      {showFooter ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {actions}
          {typeof onOverride === 'function' ? (
            <Button variant="outline" size="sm" leftIcon={SlidersHorizontal} onClick={() => onOverride(verification)}>
              Override result
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default VerificationResult
