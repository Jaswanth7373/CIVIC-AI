/**
 * ReportedIssueCard - the citizen's own words and photo, with what the image model marked on it.
 *
 * Props: { complaint: ComplaintDetail, className }
 *
 * Detection boxes belong to the photo the AI analysed (the first original image), so they are drawn only on
 * that photo; extra photos are shown plain. Approximate regions (CLIP saliency instead of a detector) are
 * drawn dashed by ImageWithBoxes and labelled "approx.".
 */
import { ImageOff, MessageSquareText } from 'lucide-react'
import { useState } from 'react'
import { ImageWithBoxes } from '@/components/ai/ImageWithBoxes'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { cn } from '@/utils/cn'
import { formatDateTime } from '@/utils/format'

export function ReportedIssueCard({ complaint, className }) {
  const images = (Array.isArray(complaint.images) ? complaint.images : []).filter((image) => image?.url)
  const [selectedId, setSelectedId] = useState(null)
  const selectedIndex = Math.max(
    0,
    images.findIndex((image) => String(image.id) === String(selectedId)),
  )
  const image = images[selectedIndex] ?? null
  const prediction = complaint.ai_prediction
  const analysed = selectedIndex === 0
  const citizen = complaint.citizen?.full_name

  return (
    <Card className={className}>
      <CardHeader
        title="Citizen's report"
        icon={MessageSquareText}
        description={citizen ? `Reported by ${citizen} on ${formatDateTime(complaint.created_at)}` : undefined}
      />
      <CardBody className="space-y-4">
        <p className="whitespace-pre-line break-words text-[15px] leading-relaxed text-ink">{complaint.description}</p>
        {image ? (
          <ImageWithBoxes
            src={image.url}
            alt={`Photo of the reported issue: ${complaint.title || complaint.complaint_number}`}
            objects={analysed ? prediction?.detected_objects : []}
            boxes={analysed ? prediction?.bounding_boxes : []}
            maxHeight="28rem"
          />
        ) : (
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-line-strong bg-surface-2 px-4 py-5 text-sm text-ink-2">
            <ImageOff aria-hidden className="size-5 shrink-0 text-ink-3" />
            The citizen did not attach a photo. The AI classified this complaint from the description alone.
          </div>
        )}
        {images.length > 1 ? (
          <div role="group" aria-label="Photos of this complaint" className="flex flex-wrap gap-2">
            {images.map((item, index) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedId(item.id)}
                aria-pressed={index === selectedIndex}
                aria-label={`Show photo ${index + 1} of ${images.length}`}
                className={cn(
                  'overflow-hidden rounded-lg ring-2 ring-offset-2 ring-offset-surface transition-shadow',
                  index === selectedIndex ? 'ring-primary' : 'ring-transparent hover:ring-line-strong',
                )}
              >
                <img src={item.url} alt="" className="size-16 object-cover" loading="lazy" />
              </button>
            ))}
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}

export default ReportedIssueCard
