/**
 * FeedbackForm - the citizen rates how the complaint was resolved (1-5 stars) and may add a comment.
 *
 * Props:
 * - onSubmit({rating, text}): called on submit; may return a promise. While it is pending the button shows
 *   a spinner; if it rejects, the API's field errors (rating / text) and message are shown in the form.
 *   Typical use: `onSubmit={(values) => feedbackService.submit({ complaint: id, ...values })}`
 * - complaint: optional ComplaintMini, shown as context above the form
 * - submitting: external pending flag (in addition to the promise)
 * - error: external error (any thrown value) to display
 * - initialRating / initialText
 * - onCancel: shows a "Cancel" button
 * - submitLabel: default "Submit feedback"
 * - maxLength: comment length limit (default 1000)
 * - className
 *
 * The comment is sentiment-analysed on the server. A rating of 1-2 stars shows a hint that the complaint
 * can be reopened afterwards (the API answers `suggest_reopen: true` in that case).
 */
import { MessageSquareText, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { StarRating } from '@/components/ui/StarRating'
import { Textarea } from '@/components/ui/Textarea'
import { cn } from '@/utils/cn'
import { RATING_LABELS } from '@/utils/constants'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'

export function FeedbackForm({
  onSubmit,
  complaint,
  submitting = false,
  error,
  initialRating = 0,
  initialText = '',
  onCancel,
  submitLabel = 'Submit feedback',
  maxLength = 1000,
  className,
}) {
  const [rating, setRating] = useState(Number(initialRating) || 0)
  const [text, setText] = useState(initialText ?? '')
  const [pending, setPending] = useState(false)
  const [submitError, setSubmitError] = useState(null)
  const [ratingMissing, setRatingMissing] = useState(false)

  const shownError = submitError ?? error ?? null
  const fieldErrors = shownError ? getFieldErrors(shownError) : {}
  const busy = submitting || pending

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (busy) return
    if (rating < 1) {
      setRatingMissing(true)
      return
    }
    setSubmitError(null)
    setPending(true)
    try {
      await onSubmit?.({ rating, text: text.trim() })
    } catch (caught) {
      setSubmitError(caught)
    } finally {
      setPending(false)
    }
  }

  const ratingError = ratingMissing && rating < 1 ? 'Choose a rating from 1 to 5 stars.' : fieldErrors.rating
  const generalError =
    shownError && !fieldErrors.rating && !fieldErrors.text ? getErrorMessage(shownError, 'Your feedback could not be sent. Try again.') : null

  return (
    <form onSubmit={handleSubmit} noValidate className={cn('min-w-0 space-y-4', className)}>
      {complaint ? (
        <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
          <p className="text-xs font-semibold text-ink-3 tabular">{complaint.complaint_number}</p>
          <p className="font-semibold text-ink">{complaint.title}</p>
        </div>
      ) : null}

      <div>
        <p aria-hidden className="text-sm font-semibold text-ink">
          How well was the issue resolved?
          <span aria-hidden className="text-signal-600 dark:text-signal-300">
            {' '}
            *
          </span>
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          <StarRating
            value={rating}
            onChange={(value) => {
              setRating(value)
              setRatingMissing(false)
            }}
            label="How well was the issue resolved? Required"
          />
          <span className="text-sm font-semibold text-ink-2" aria-live="polite">
            {rating ? RATING_LABELS[rating] : 'Not rated yet'}
          </span>
        </div>
        {ratingError ? (
          <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-signal-600 dark:text-signal-300">
            <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            {ratingError}
          </p>
        ) : null}
        {rating > 0 && rating <= 2 ? (
          <p className="mt-2 text-xs text-ink-2">
            Sorry it did not go well. After you submit, you can reopen the complaint if the issue is not fixed.
          </p>
        ) : null}
      </div>

      <FormField
        label="Tell us more"
        optional
        hint="What went well, or what is still wrong? Your words help the department improve."
        error={fieldErrors.text}
      >
        <Textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={maxLength} rows={4} />
      </FormField>

      {generalError ? (
        <Alert tone="danger" title="Feedback not sent">
          {generalError}
        </Alert>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" leftIcon={MessageSquareText} loading={busy}>
          {submitLabel}
        </Button>
      </div>
    </form>
  )
}

export default FeedbackForm
