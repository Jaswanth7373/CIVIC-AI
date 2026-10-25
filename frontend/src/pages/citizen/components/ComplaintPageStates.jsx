/**
 * Loading and not-found states for the single-complaint pages (details and tracking).
 * - ComplaintPageSkeleton: the page's own shape (header, progress strip or the tracking page's live status card,
 *   two columns) while GET /api/complaints/{id}/ is pending, so nothing jumps when the data arrives.
 * - ComplaintNotFound: the API answers 404 both for a deleted complaint and for one that belongs to another
 *   account; the message covers both and leads back to the citizen's list.
 */
import { ClipboardList, SearchX } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'

function CardSkeleton({ lines = 3, media = false }) {
  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="border-b border-line px-5 py-4">
        <Skeleton className="h-4 w-40" />
      </div>
      <div className="space-y-3 px-5 py-4">
        {media ? <Skeleton className="aspect-[4/3] w-full rounded-xl" /> : null}
        <Skeleton lines={lines} />
      </div>
    </div>
  )
}

export function ComplaintPageSkeleton({ variant = 'details' }) {
  useDocumentTitle(variant === 'tracking' ? 'Track complaint' : 'Complaint')
  return (
    <div aria-busy="true" aria-label="Loading complaint">
      {variant === 'tracking' ? (
        // "Live tracking", the number + title context line and the live indicator (no chips row).
        <div className="mb-6 space-y-3">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-full max-w-md" />
          <Skeleton className="h-3 w-64 max-w-full" />
        </div>
      ) : (
        <div className="mb-6 space-y-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-full max-w-xl" />
          <div className="flex flex-wrap gap-2">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-6 w-36" />
          </div>
        </div>
      )}
      <div className="space-y-5">
        {variant === 'tracking' ? (
          // The live status card: status plate and road progress | the latest update.
          <div className="grid gap-6 rounded-xl border border-line bg-surface p-5 sm:p-6 md:grid-cols-2 md:gap-8">
            <div className="space-y-5">
              <div className="flex items-start gap-4">
                <Skeleton className="size-14 shrink-0 rounded-xl" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="h-6 w-40" />
                  <Skeleton className="h-3.5 w-3/4" />
                </div>
              </div>
              <Skeleton className="h-1.5 w-full rounded-full" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-6 w-48" />
              <Skeleton lines={2} />
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-line bg-surface p-5">
            <div className="flex justify-between gap-3">
              {Array.from({ length: 8 }, (_, index) => (
                <Skeleton key={index} circle className="size-[26px]" />
              ))}
            </div>
            <div className="mt-6 grid gap-5 md:grid-cols-3">
              <Skeleton lines={3} />
              <Skeleton lines={2} />
              <Skeleton lines={3} />
            </div>
          </div>
        )}
        {variant === 'tracking' ? (
          // Phones: what happens next and the work zone first, then the timeline; lg: timeline left, side right.
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="space-y-5 lg:col-start-2 lg:row-start-1">
              <CardSkeleton lines={3} />
              <CardSkeleton media lines={2} />
            </div>
            <div className="lg:col-start-1 lg:row-start-1">
              <CardSkeleton lines={8} />
            </div>
          </div>
        ) : (
          <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
            <div className="space-y-5">
              <CardSkeleton media lines={4} />
              <CardSkeleton lines={6} />
            </div>
            <div className="space-y-5">
              <CardSkeleton lines={5} />
              <CardSkeleton media lines={2} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export function ComplaintNotFound() {
  useDocumentTitle('Complaint not found')
  return (
    <EmptyState
      icon={SearchX}
      title="Complaint not found"
      description="It may have been deleted, or it was filed from another account. Your own complaints are all listed on My complaints."
      action={
        <Button leftIcon={ClipboardList} to="/citizen/complaints">
          Go to my complaints
        </Button>
      }
    />
  )
}
