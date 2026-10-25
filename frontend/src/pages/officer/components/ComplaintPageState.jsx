/**
 * Loading and failure states shared by the three complaint pages of the officer workspace
 * (details, resolution update, resolution verification).
 *
 * - ComplaintPageSkeleton: the page's real shape (header, progress strip, two columns) so nothing jumps
 *   when the work order arrives.
 * - ComplaintLoadError: says what happened - a complaint outside the officer's scope answers 404, so that
 *   case gets its own copy and a way back to the list instead of a pointless "Try again".
 */
import { ClipboardList, SearchX } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { ErrorState } from '@/components/ui/ErrorState'
import { PageHeader } from '@/components/ui/PageHeader'
import { Skeleton } from '@/components/ui/Skeleton'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { getErrorStatus } from '@/utils/errors'
import { OFFICER_BASE_PATH } from './officerUtils'

function SkeletonCard({ lines = 3, media = false }) {
  return (
    <div className="space-y-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <Skeleton className="h-4 w-40" />
      {media ? <Skeleton className="aspect-[4/3] w-full rounded-lg" /> : null}
      <Skeleton lines={lines} />
    </div>
  )
}

export function ComplaintPageSkeleton({ title = 'Complaint details', side = true }) {
  useDocumentTitle(title)
  return (
    <div aria-busy="true">
      <span className="sr-only" role="status">
        Loading the complaint
      </span>
      <div aria-hidden className="mb-6 space-y-3">
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-8 w-[28rem] max-w-full" />
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-6 w-32" />
        </div>
      </div>
      <div className={side ? 'grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]' : 'grid gap-5'}>
        <div className="space-y-5">
          <SkeletonCard media lines={3} />
          <SkeletonCard lines={4} />
        </div>
        {side ? (
          <div className="space-y-5">
            <SkeletonCard media lines={2} />
            <SkeletonCard lines={3} />
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ComplaintLoadError({ error, onRetry, title = 'Complaint details' }) {
  const status = getErrorStatus(error)
  const backToList = (
    <Button variant={status === 404 ? 'primary' : 'outline'} leftIcon={ClipboardList} to={OFFICER_BASE_PATH}>
      Back to assigned complaints
    </Button>
  )
  return (
    <>
      <PageHeader title={title} back={{ to: OFFICER_BASE_PATH, label: 'Assigned complaints' }} />
      {status === 404 || status === 403 ? (
        <EmptyState
          icon={SearchX}
          title="This complaint is not in your work area"
          description="It may have been reassigned to another officer or department, or the link is wrong. Your assigned complaints are all on the list."
          action={backToList}
        />
      ) : (
        <ErrorState title="The complaint could not be loaded" error={error} onRetry={onRetry} action={backToList} />
      )}
    </>
  )
}

export default ComplaintPageSkeleton
