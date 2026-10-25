/**
 * ReportCard - what the citizen reported: the photo with the vision model's detections, the description,
 * when and where it happened, and a static map of the spot.
 *
 * Props:
 * - complaint: ComplaintDetail
 * - categories: CategoryMini list (names the detection labels)
 */
import { CalendarClock, ImageOff, Mail, MapPin, Phone, Tag, UserRound } from 'lucide-react'
import { ImageWithBoxes } from '@/components/ai'
import { CategoryBadge } from '@/components/complaints'
import { MiniMap } from '@/components/maps'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { KeyValueList } from '@/components/ui/KeyValueList'
import { formatDateTime } from '@/utils/format'

function primaryImage(images) {
  const list = Array.isArray(images) ? images : []
  return list.find((image) => image.kind === 'original') ?? list[0] ?? null
}

export function ReportCard({ complaint, categories }) {
  const image = primaryImage(complaint.images)
  const prediction = complaint.ai_prediction
  const location = complaint.location ?? {}
  const citizen = complaint.citizen
  const addressLines = [location.address, [location.area, location.city, location.pincode].filter(Boolean).join(', ')].filter(Boolean)

  return (
    <Card>
      <CardHeader title="Citizen report" description="The photo with what the image model detected, the citizen's words and the exact spot." />
      <CardBody className="@container space-y-5">
        <div className="grid gap-5 @2xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            {image ? (
              <ImageWithBoxes
                src={image.url}
                alt={`Photo reported with ${complaint.complaint_number}`}
                objects={prediction?.detected_objects}
                boxes={prediction?.bounding_boxes}
                categories={categories}
                maxHeight="22rem"
              />
            ) : (
              <div className="grid aspect-[4/3] place-items-center rounded-xl border border-dashed border-line-strong bg-surface-2 px-6 text-center">
                <div>
                  <ImageOff aria-hidden className="mx-auto mb-2 size-6 text-ink-3" />
                  <p className="text-sm font-semibold text-ink">No photo attached</p>
                  <p className="mt-1 text-xs text-ink-3">The AI decided from the description and location only.</p>
                </div>
              </div>
            )}
          </div>
          <div className="min-w-0 space-y-4">
            <div>
              <h3 className="mb-1 text-xs font-medium text-ink-3">Description</h3>
              <p className="whitespace-pre-line text-[15px] leading-relaxed text-ink">{complaint.description}</p>
            </div>
            <KeyValueList
              items={[
                {
                  label: 'Incident time',
                  icon: CalendarClock,
                  value: complaint.incident_at ? (
                    <time dateTime={complaint.incident_at} className="tabular">
                      {formatDateTime(complaint.incident_at)}
                    </time>
                  ) : (
                    'Not given'
                  ),
                },
                {
                  label: "Citizen's category",
                  icon: Tag,
                  value: complaint.reported_category ? (
                    <CategoryBadge category={complaint.reported_category} size="sm" />
                  ) : (
                    'Left to the AI'
                  ),
                },
                {
                  label: 'Reported by',
                  icon: UserRound,
                  fullWidth: true,
                  value: citizen ? (
                    <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                      <span className="font-medium">{citizen.full_name}</span>
                      {citizen.phone ? (
                        <a
                          href={`tel:${citizen.phone}`}
                          className="inline-flex items-center gap-1 text-primary-ink hover:underline tabular pointer-coarse:min-h-11"
                        >
                          <Phone aria-hidden className="size-3.5" />
                          {citizen.phone}
                        </a>
                      ) : null}
                      {citizen.email ? (
                        <a
                          href={`mailto:${citizen.email}`}
                          className="inline-flex min-w-0 items-center gap-1 break-all text-primary-ink hover:underline pointer-coarse:min-h-11"
                        >
                          <Mail aria-hidden className="size-3.5 shrink-0" />
                          {citizen.email}
                        </a>
                      ) : null}
                    </span>
                  ) : null,
                },
              ]}
              columns={2}
            />
          </div>
        </div>

        <div className="grid gap-4 border-t border-line pt-4 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] @2xl:items-start">
          <div className="min-w-0">
            <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-ink-3">
              <MapPin aria-hidden className="size-3.5" />
              Location
            </h3>
            {addressLines.length ? (
              addressLines.map((line) => (
                <p key={line} className="text-sm text-ink">
                  {line}
                </p>
              ))
            ) : (
              <p className="text-sm text-ink-3">No address was recorded.</p>
            )}
            {location.landmark ? <p className="mt-1 text-sm text-ink-2">Near {location.landmark}</p> : null}
            <p className="mt-1 text-xs text-ink-3 tabular">
              {Number(location.latitude).toFixed(6)}, {Number(location.longitude).toFixed(6)}
            </p>
          </div>
          <MiniMap
            lat={location.latitude}
            lng={location.longitude}
            color={complaint.category?.color}
            height={190}
            label={`Map of ${complaint.complaint_number}`}
          />
        </div>
      </CardBody>
    </Card>
  )
}

export default ReportCard
