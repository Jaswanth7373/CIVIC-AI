/**
 * Feedback (/citizen/feedback) - rate resolved complaints and see the feedback already given.
 *
 * - "Waiting for your rating": GET /api/feedback/pending/ (plain array of `{complaint: ComplaintMini,
 *   resolved_at}`), each with an inline FeedbackForm -> POST /api/feedback/. A rating closes the complaint,
 *   its comment is sentiment-analysed on the server, and an answer with `suggest_reopen: true` (rating 1-2
 *   inside the reopen window) offers to reopen it. `?complaint=<id>` (from the dashboard's "Rate the fix")
 *   scrolls to that request and highlights it.
 * - "Your feedback": GET /api/feedback/ (paginated, own feedback only) as FeedbackCards with the AI
 *   sentiment badge, score and confidence.
 *
 * Motion: a rated request folds away and the remaining ones slide into its place (exit + layout animation);
 * the history arrives in a short cascade on first load. Reduced motion: changes happen at once.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { ClipboardList, MessageSquareText, RotateCcw, Star } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { FeedbackCard } from '@/components/complaints/FeedbackCard'
import { FeedbackForm } from '@/components/complaints/FeedbackForm'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { Stagger, StaggerItem } from '@/components/motion/Stagger'
import { EASE } from '@/components/motion/tokens'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { PageHeader } from '@/components/ui/PageHeader'
import { PaginationBar } from '@/pages/shared/components/PaginationBar'
import { Skeleton } from '@/components/ui/Skeleton'
import { useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import { feedbackService } from '@/services/feedbackService'
import { cn } from '@/utils/cn'
import { getErrorMessage } from '@/utils/errors'
import { formatDateTime, formatNumber, timeAgo } from '@/utils/format'
import { ComplaintThumb } from './components/DashboardPanels'
import { complaintPath } from './components/complaintHelpers'

const HISTORY_PAGE_SIZE = 12

function SectionHeading({ id, title, count, description }) {
  return (
    <div className="mb-3">
      <h2 id={id} className="flex items-center gap-2 font-display text-lg font-bold text-ink">
        {title}
        {typeof count === 'number' ? (
          <span className="rounded-full bg-sunken px-2 py-0.5 font-sans text-xs font-semibold text-ink-2 tabular">{count}</span>
        ) : null}
      </h2>
      {description ? <p className="mt-0.5 text-sm text-ink-2">{description}</p> : null}
    </div>
  )
}

function RequestCard({ request, highlighted, onSubmit }) {
  const { complaint, resolved_at: resolvedAt } = request
  return (
    <article
      id={`feedback-request-${complaint.id}`}
      aria-labelledby={`feedback-request-title-${complaint.id}`}
      className={cn(
        'scroll-mt-24 overflow-hidden rounded-xl border bg-surface elev-raised transition-shadow',
        highlighted ? 'border-marking-500 ring-2 ring-marking-500/40' : 'border-line',
      )}
    >
      {/* waiting for the citizen: the road marking runs along the top of every open request */}
      <div aria-hidden className="lane-line-x h-[3px]" />
      <div className="flex gap-3 border-b border-line px-4 py-3.5 sm:px-5">
        <ComplaintThumb complaint={complaint} size="sm" className="size-14" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-ink-3 tabular">{complaint.complaint_number}</p>
          <h3 id={`feedback-request-title-${complaint.id}`} className="line-clamp-2 font-display text-[15px] font-bold leading-snug text-ink">
            <Link to={complaintPath(complaint.id)} className="hover:underline">
              {complaint.title}
            </Link>
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
            <CategoryBadge category={complaint.category} size="sm" />
            {resolvedAt ? (
              <span>
                Resolved{' '}
                <time dateTime={resolvedAt} title={formatDateTime(resolvedAt)}>
                  {timeAgo(resolvedAt)}
                </time>
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <div className="px-4 py-4 sm:px-5">
        <FeedbackForm onSubmit={(values) => onSubmit(request, values)} />
      </div>
    </article>
  )
}

function RequestSkeleton() {
  return (
    <div aria-hidden className="rounded-xl border border-line bg-surface">
      <div className="flex gap-3 border-b border-line px-5 py-3.5">
        <Skeleton className="size-14 rounded-lg" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
      <div className="space-y-3 px-5 py-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  )
}

export default function FeedbackPage() {
  const reduced = usePrefersReducedMotion()
  const toast = useToast()
  const { refreshUser } = useAuth()
  const [searchParams] = useSearchParams()
  const focusId = searchParams.get('complaint')
  const [historyPage, setHistoryPage] = useState(1)
  const [reopenHint, setReopenHint] = useState(null)

  const pending = useApi(() => feedbackService.pending(), [])
  const history = useApi(() => feedbackService.list({ page: historyPage, page_size: HISTORY_PAGE_SIZE }), [historyPage])
  const requests = Array.isArray(pending.data) ? pending.data.filter((item) => item?.complaint) : []
  const historyRows = history.data?.results ?? []
  const historyCount = history.data?.count ?? 0

  // Coming from "Rate the fix": bring that request into view once the list is loaded.
  const pendingLoaded = Boolean(pending.data)
  useEffect(() => {
    if (!focusId || !pendingLoaded) return
    const card = document.getElementById(`feedback-request-${focusId}`)
    if (!card) return
    card.scrollIntoView({ block: 'start' })
    card.querySelector('[role="radio"]')?.focus({ preventScroll: true })
  }, [focusId, pendingLoaded])

  const submit = async (request, values) => {
    const { complaint } = request
    try {
      const saved = await feedbackService.submit({ complaint: complaint.id, rating: values.rating, text: values.text })
      toast.success(
        'Feedback submitted',
        saved?.suggest_reopen
          ? `${complaint.complaint_number} is closed. You can still reopen it if the problem is not fixed.`
          : `Thank you. ${complaint.complaint_number} is now closed.`,
      )
      pending.setData((current) => (Array.isArray(current) ? current.filter((item) => item?.complaint?.id !== complaint.id) : current))
      setReopenHint(saved?.suggest_reopen ? complaint : null)
      if (historyPage === 1) history.refetch()
      else setHistoryPage(1)
      refreshUser()
      return saved
    } catch (error) {
      toast.error('Could not submit feedback', getErrorMessage(error))
      throw error
    }
  }

  return (
    <>
      <PageHeader
        title="Feedback"
        description="Rate how your resolved complaints were handled. Each rating closes the complaint, helps the department improve and earns you 5 civic points."
      />

      <div className="space-y-8">
        {reopenHint ? (
          <Alert
            tone="warning"
            title="Sorry the fix did not work out"
            onDismiss={() => setReopenHint(null)}
            action={
              <Button size="sm" variant="warning" leftIcon={RotateCcw} to={complaintPath(reopenHint.id)}>
                Open {reopenHint.complaint_number} to reopen it
              </Button>
            }
          >
            If the problem is still there, reopen the complaint and it goes back to the officer with your reason.
          </Alert>
        ) : null}

        <section aria-labelledby="pending-feedback-heading">
          <SectionHeading
            id="pending-feedback-heading"
            title="Waiting for your rating"
            count={pending.data ? requests.length : undefined}
            description="Complaints an officer has resolved. Tell us whether the problem is really fixed."
          />
          {pending.error && !pending.data ? (
            <ErrorState title="Feedback requests could not be loaded" error={pending.error} onRetry={pending.refetch} />
          ) : !pending.data ? (
            <div className="grid gap-4 xl:grid-cols-2">
              <RequestSkeleton />
              <RequestSkeleton />
            </div>
          ) : requests.length ? (
            <div className="relative grid items-start gap-4 xl:grid-cols-2">
              <AnimatePresence initial={false} mode="popLayout">
                {requests.map((request) => (
                  <motion.div
                    key={request.complaint.id}
                    layout="position"
                    className="min-w-0"
                    exit={{ opacity: 0, scale: 0.96, transition: { duration: reduced ? 0 : 0.24, ease: EASE.exit } }}
                    transition={{ layout: { duration: 0.36, ease: EASE.standard } }}
                  >
                    <RequestCard
                      request={request}
                      highlighted={String(request.complaint.id) === String(focusId)}
                      onSubmit={submit}
                    />
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          ) : (
            <EmptyState
              icon={Star}
              title="No ratings waiting"
              description="When an officer resolves one of your complaints, you can rate the fix here."
              action={
                <Button variant="outline" leftIcon={ClipboardList} to="/citizen/complaints">
                  View my complaints
                </Button>
              }
            />
          )}
        </section>

        <section aria-labelledby="feedback-history-heading">
          <SectionHeading
            id="feedback-history-heading"
            title="Your feedback"
            count={history.data ? historyCount : undefined}
            description="Ratings you have given, with the sentiment the AI read in your comments."
          />
          {history.error && !history.data ? (
            <ErrorState title="Your feedback could not be loaded" error={history.error} onRetry={history.refetch} />
          ) : !history.data ? (
            <div aria-hidden className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {[0, 1, 2].map((index) => (
                <div key={index} className="space-y-3 rounded-xl border border-line bg-surface p-4">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton lines={3} />
                </div>
              ))}
            </div>
          ) : historyRows.length ? (
            <div className="space-y-4">
              <Stagger className={cn('grid gap-3 md:grid-cols-2 xl:grid-cols-3', history.loading && 'opacity-60 transition-opacity')}>
                {historyRows.map((item, index) => (
                  <StaggerItem key={item.id} index={index} className="min-w-0">
                    <FeedbackCard feedback={item} showCitizen={false} basePath="/citizen/complaints" className="h-full" />
                  </StaggerItem>
                ))}
              </Stagger>
              <PaginationBar
                page={history.data.page ?? historyPage}
                totalPages={history.data.total_pages ?? 1}
                count={historyCount}
                pageSize={history.data.page_size ?? HISTORY_PAGE_SIZE}
                onPageChange={setHistoryPage}
              />
            </div>
          ) : (
            <EmptyState
              icon={MessageSquareText}
              title="You have not rated a fix yet"
              description={
                requests.length
                  ? `Start with the ${formatNumber(requests.length)} complaint${requests.length === 1 ? '' : 's'} waiting above.`
                  : 'Your ratings and comments will be listed here.'
              }
            />
          )}
        </section>
      </div>
    </>
  )
}
