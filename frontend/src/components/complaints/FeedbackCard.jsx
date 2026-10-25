/**
 * FeedbackCard - one citizen feedback with its AI sentiment analysis.
 *
 * Props:
 * - feedback: Feedback `{id, complaint, complaint_number, complaint_title, citizen, rating, text, sentiment,
 *   sentiment_display, sentiment_score (-1..1), sentiment_confidence (0..1), sentiment_model, is_demo,
 *   department, category, created_at}`
 * - basePath: e.g. "/admin/complaints" -> the complaint number links to `${basePath}/${complaint}`
 * - showComplaint: show the complaint reference and its category / department (default true)
 * - showCitizen: show who wrote it (default true)
 * - className
 *
 * The sentiment comes from ai.nlp.sentiment (demo: a civic-phrase lexicon with negation and intensifier
 * handling; production: a RoBERTa sentiment model). The score runs from -1 (negative) to +1 (positive);
 * the label, icon and colour come from SENTIMENT_META so the meaning never rests on colour alone.
 */
import { Quote } from 'lucide-react'
import { Link } from 'react-router-dom'
import { AIModeBadge } from '@/components/ai/AIModeBadge'
import { Avatar } from '@/components/ui/Avatar'
import { Badge } from '@/components/ui/Badge'
import { StarRating } from '@/components/ui/StarRating'
import { cn } from '@/utils/cn'
import { RATING_LABELS, getSentimentMeta } from '@/utils/constants'
import { formatDateTime, formatNumber, formatPercent, timeAgo } from '@/utils/format'
import { CategoryBadge } from './CategoryBadge'
import { DepartmentBadge } from './DepartmentBadge'

function signed(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return `${number > 0 ? '+' : ''}${formatNumber(number, { digits: 2 })}`
}

export function FeedbackCard({ feedback, basePath, showComplaint = true, showCitizen = true, className }) {
  if (!feedback) return null
  const sentiment = getSentimentMeta(feedback.sentiment)
  const score = signed(feedback.sentiment_score)
  const rating = Number(feedback.rating) || 0
  const href = basePath && feedback.complaint != null ? `${basePath.replace(/\/+$/, '')}/${feedback.complaint}` : null

  return (
    <article className={cn('min-w-0 rounded-xl border border-line bg-surface p-4', className)}>
      <div className="flex items-start gap-3">
        {showCitizen && feedback.citizen ? <Avatar src={feedback.citizen.avatar} name={feedback.citizen.full_name} size="sm" decorative /> : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            {showCitizen && feedback.citizen ? (
              <p className="truncate text-sm font-semibold text-ink">{feedback.citizen.full_name}</p>
            ) : (
              <span />
            )}
            {feedback.created_at ? (
              <time dateTime={feedback.created_at} title={formatDateTime(feedback.created_at)} className="text-xs text-ink-3 tabular">
                {timeAgo(feedback.created_at)}
              </time>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StarRating value={rating} readOnly size="sm" label="Rating" />
            <span className="text-xs font-semibold text-ink-2">{RATING_LABELS[Math.round(rating)] ?? ''}</span>
          </div>
        </div>
      </div>

      {feedback.text ? (
        <blockquote className="mt-3 flex gap-2 text-sm text-ink">
          <Quote aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
          <p className="whitespace-pre-line break-words">{feedback.text}</p>
        </blockquote>
      ) : (
        <p className="mt-3 text-sm text-ink-3">Rating only, no written comment.</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {sentiment ? (
          <Badge tone={sentiment.tone} icon={sentiment.icon} size="sm">
            <span className="sr-only">Sentiment: </span>
            {sentiment.label}
            {score ? <span className="ml-1 font-bold tabular">{score}</span> : null}
          </Badge>
        ) : (
          <Badge tone="neutral" size="sm">
            Sentiment not analysed
          </Badge>
        )}
        {feedback.sentiment_confidence != null ? (
          <span className="text-xs text-ink-3 tabular">{formatPercent(feedback.sentiment_confidence)} confidence</span>
        ) : null}
        <AIModeBadge isDemo={feedback.is_demo} modelVersion={feedback.sentiment_model} size="sm" />
        {feedback.sentiment_model ? <span className="break-all text-[11px] text-ink-3">{feedback.sentiment_model}</span> : null}
      </div>

      {showComplaint && (feedback.complaint_number || feedback.category || feedback.department) ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs">
          {feedback.complaint_number ? (
            href ? (
              <Link to={href} className="font-semibold text-primary-ink tabular hover:underline">
                {feedback.complaint_number}
              </Link>
            ) : (
              <span className="font-semibold text-ink-2 tabular">{feedback.complaint_number}</span>
            )
          ) : null}
          {feedback.complaint_title ? <span className="min-w-0 truncate text-ink-2">{feedback.complaint_title}</span> : null}
          {feedback.category ? <CategoryBadge category={feedback.category} size="sm" /> : null}
          {feedback.department ? <DepartmentBadge department={feedback.department} size="sm" /> : null}
        </div>
      ) : null}
    </article>
  )
}

export default FeedbackCard
