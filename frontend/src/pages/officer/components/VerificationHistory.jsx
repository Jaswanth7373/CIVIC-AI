/**
 * VerificationHistory - every verification of a complaint, newest first: AI-assisted runs and manual
 * decisions, with score, verdict, who decided, when, and the explanation on demand.
 *
 * Props: { verifications: Verification[], className }
 *
 * A manual decision stores the result it replaced in `metrics.previous_status` / `previous_score`, so the
 * history can say what was overridden.
 */
import { Bot, ChevronDown, UserRound } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/utils/cn'
import { VERIFICATION_METHOD_LABELS, getVerificationMeta } from '@/utils/constants'
import { formatDateTime, timeAgo } from '@/utils/format'
import { sortVerifications } from './officerUtils'

export function VerificationHistory({ verifications, className }) {
  const rows = sortVerifications(verifications)
  if (!rows.length) {
    return (
      <EmptyState
        compact
        bordered={false}
        title="No verifications yet"
        description="Each AI run and every manual decision is listed here with its score."
        className={className}
      />
    )
  }
  return (
    <ol aria-label="Verification history" className={cn('divide-y divide-line', className)}>
      {rows.map((item, index) => {
        const meta = getVerificationMeta(item.status)
        const manual = item.method === 'manual'
        const ActorIcon = item.verified_by ? UserRound : Bot
        const previous = manual && item.metrics?.previous_status ? getVerificationMeta(item.metrics.previous_status) : null
        return (
          <li key={item.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="w-14 shrink-0 font-display text-lg font-extrabold leading-none text-ink tabular">
                {item.score}
                <span className="text-xs font-semibold text-ink-3">/100</span>
              </span>
              <Badge tone={meta.tone} icon={meta.icon} size="sm">
                {meta.label}
              </Badge>
              <Badge tone={manual ? 'violet' : 'neutral'} size="sm">
                {item.method_display || VERIFICATION_METHOD_LABELS[item.method] || item.method}
              </Badge>
              {index === 0 ? (
                <Badge tone="yellow" variant="outline" size="sm">
                  Current
                </Badge>
              ) : null}
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-ink-3">
                <ActorIcon aria-hidden className="size-3.5" />
                <span>
                  {item.verified_by?.full_name ?? 'CivicAI Engine'},{' '}
                  <time dateTime={item.verified_at} title={formatDateTime(item.verified_at)} className="tabular">
                    {timeAgo(item.verified_at)}
                  </time>
                </span>
              </span>
            </div>
            {previous ? (
              <p className="mt-1 text-xs text-ink-3">
                Replaced the {previous.label.toLowerCase()} result
                {item.metrics.previous_score != null ? ` (${item.metrics.previous_score}/100)` : ''}.
              </p>
            ) : null}
            {item.explanation ? (
              <details className="group mt-1.5">
                <summary className="inline-flex cursor-pointer select-none items-center gap-1 rounded-md text-xs font-semibold text-primary-ink hover:underline pointer-coarse:min-h-11">
                  <ChevronDown aria-hidden className="size-3.5 transition-transform group-open:rotate-180" />
                  Explanation
                </summary>
                <p className="mt-1.5 whitespace-pre-line rounded-lg bg-surface-2 px-3 py-2 text-sm text-ink-2">{item.explanation}</p>
              </details>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

export default VerificationHistory
