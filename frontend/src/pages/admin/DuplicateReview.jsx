/**
 * Duplicate review (admin) - the queue of report pairs the AI thinks describe the same issue.
 *
 * Data: GET /duplicates/?status=<tab>&ordering=&page= (paginated pairs) + one `page_size=1` count per tab.
 * Tabs: Pending review / Confirmed / Not a duplicate (`?status=` in the URL, so a tab can be linked).
 * Each pair is shown side by side - photos, text, distance and dates - with the description, photo and
 * location similarity bars; "Confirm duplicate" and "Not a duplicate" open a confirmation dialog with an
 * optional note (PATCH /duplicates/{id}/).
 *
 * Motion: pairs converge as they come into view; a reviewed pair leaves the queue the way the decision reads
 * (a confirmed duplicate merges into its original, then folds away) and the cards below close the gap.
 */
import { AnimatePresence } from 'framer-motion'
import { CopyCheck, Inbox } from 'lucide-react'
import { useState } from 'react'
import { Button, EmptyState, ErrorState, PageHeader, Select, Skeleton, Tabs } from '@/components/ui'
import { useApi } from '@/hooks/useApi'
import { duplicateService } from '@/services'
import { DUPLICATE_STATUS_META } from '@/utils/constants'
import { ListPagination, SummaryLine } from './manage/shared/Controls'
import { toList } from './manage/shared/listUtils'
import { useUrlParams } from './manage/shared/useUrlParams'
import { DuplicatePairCard } from './manage/duplicates/DuplicatePairCard'
import { ReviewDialog } from './manage/duplicates/ReviewDialog'

const PAGE_SIZE = 10
const TABS = [
  { id: 'pending_review', label: 'Pending review', icon: DUPLICATE_STATUS_META.pending_review.icon },
  { id: 'confirmed_duplicate', label: 'Confirmed', icon: DUPLICATE_STATUS_META.confirmed_duplicate.icon },
  { id: 'not_duplicate', label: 'Not a duplicate', icon: DUPLICATE_STATUS_META.not_duplicate.icon },
]
const ORDERING_OPTIONS = [
  { value: '-overall_similarity', label: 'Closest match first' },
  { value: '-created_at', label: 'Newest first' },
  { value: 'created_at', label: 'Oldest first' },
]
const EMPTY_COPY = {
  pending_review: {
    title: 'No duplicates waiting for review',
    description: 'When a new report looks like one nearby, the AI links them here for a decision.',
  },
  confirmed_duplicate: {
    title: 'No confirmed duplicates yet',
    description: 'Pairs you confirm are merged into the original report and listed here.',
  },
  not_duplicate: {
    title: 'No rejected pairs yet',
    description: 'Pairs marked as separate issues are listed here for the record.',
  },
}

function PairSkeleton() {
  return (
    <li aria-hidden className="space-y-4 rounded-xl border border-line bg-surface p-5">
      <Skeleton className="h-7 w-40" />
      <div className="grid gap-5 lg:grid-cols-[1fr_14rem_1fr]">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </li>
  )
}

export default function DuplicateReview() {
  const { values, setValues, page, setPage } = useUrlParams({ status: 'pending_review', ordering: '-overall_similarity' })
  const status = TABS.some((tab) => tab.id === values.status) ? values.status : 'pending_review'
  const [review, setReview] = useState(null)
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewSession, setReviewSession] = useState(0)
  // Decisions saved in this visit (pair id -> status): the card leaves the list accordingly.
  const [decisions, setDecisions] = useState({})

  const pairs = useApi(
    () => duplicateService.list({ status, ordering: values.ordering, page, page_size: PAGE_SIZE }),
    [status, values.ordering, page],
  )
  const counts = useApi(
    () => Promise.all(TABS.map((tab) => duplicateService.list({ status: tab.id, page_size: 1 }).then((data) => data?.count ?? 0))),
    [],
  )

  const rows = toList(pairs.data)
  const tabs = TABS.map((tab, index) => ({ ...tab, count: counts.data?.[index] }))
  const empty = EMPTY_COPY[status]

  const openReview = (pair, decision) => {
    setReviewSession((value) => value + 1)
    setReview({ pair, status: decision })
    setReviewOpen(true)
  }

  const afterReview = (updated) => {
    if (updated?.id != null) setDecisions((current) => ({ ...current, [updated.id]: updated.status }))
    setReviewOpen(false)
    pairs.refetch()
    counts.refetch()
  }

  return (
    <>
      <PageHeader
        title="Duplicate review"
        description="The AI links reports that seem to describe the same issue nearby. Confirm a duplicate to merge the newer report into the original, or keep both when they are separate problems."
      />

      <Tabs
        tabs={tabs}
        value={status}
        onChange={(next) => setValues({ status: next })}
        idPrefix="duplicates"
        label="Duplicate review status"
        className="mb-4"
      />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <SummaryLine count={pairs.data?.count} noun="pair" loading={pairs.loading && Boolean(pairs.data)} />
        <Select
          aria-label="Sort pairs"
          value={values.ordering}
          onChange={(event) => setValues({ ordering: event.target.value })}
          options={ORDERING_OPTIONS}
          containerClassName="w-auto min-w-48"
        />
      </div>

      <div role="tabpanel" id={`duplicates-panel-${status}`} aria-labelledby={`duplicates-tab-${status}`}>
        {pairs.error && !pairs.data ? (
          <ErrorState title="Duplicate pairs could not be loaded" error={pairs.error} onRetry={() => pairs.refetch()} />
        ) : pairs.loading && !pairs.data ? (
          <ul className="space-y-4">
            <PairSkeleton />
            <PairSkeleton />
          </ul>
        ) : rows.length ? (
          <ul className="space-y-4" aria-busy={pairs.loading || undefined}>
            <AnimatePresence>
              {rows.map((pair) => (
                <DuplicatePairCard key={pair.id} pair={pair} onReview={openReview} decision={decisions[pair.id]} />
              ))}
            </AnimatePresence>
          </ul>
        ) : (
          <EmptyState
            icon={status === 'pending_review' ? CopyCheck : Inbox}
            title={empty.title}
            description={empty.description}
            action={
              status === 'pending_review' ? (
                <Button variant="outline" to="/admin/complaints?has_duplicates=true">
                  View complaints with duplicates
                </Button>
              ) : null
            }
          />
        )}
      </div>

      <ListPagination className="mt-5" data={pairs.data} page={page} pageSize={PAGE_SIZE} onPageChange={setPage} />

      <ReviewDialog
        key={reviewSession}
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        pair={review?.pair}
        status={review?.status}
        onDone={afterReview}
      />
    </>
  )
}
