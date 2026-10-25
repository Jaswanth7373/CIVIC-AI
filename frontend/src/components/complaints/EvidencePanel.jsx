/**
 * EvidencePanel - the officer's resolution evidence: before / after photos with a comparison slider.
 *
 * Props:
 * - evidence: Evidence[] `{id, before_image, after_image, uploaded_by, remarks, uploaded_at}` (or a single
 *   Evidence object). The newest upload is shown first; older uploads are reachable from the tabs.
 * - fallbackBefore: URL of the complaint's original photo, used as "before" when an upload has only an
 *   after photo (the usual case: the citizen's report already shows the problem)
 * - alt: scene description for the images (default "Complaint location")
 * - action: node shown in the empty state (e.g. an "Upload after photo" button on the officer page)
 * - emptyTitle / emptyDescription: empty-state copy. By default the description speaks about "the officer"
 *   (citizen and admin pages); with an `action` - the viewer can upload the photo - it speaks to the viewer.
 * - className
 */
import { ImageUp, UserRound } from 'lucide-react'
import { useState } from 'react'
import { EmptyState } from '@/components/ui/EmptyState'
import { Tabs } from '@/components/ui/Tabs'
import { cn } from '@/utils/cn'
import { formatDate, formatDateTime, toDate } from '@/utils/format'
import { BeforeAfterSlider } from './BeforeAfterSlider'

function SinglePhoto({ src, label, alt }) {
  return (
    <figure className="min-w-0">
      <div className="relative overflow-hidden rounded-xl bg-sunken" style={{ aspectRatio: '4 / 3' }}>
        <img src={src} alt={`${label}: ${alt}`} loading="lazy" className="absolute inset-0 size-full object-contain" />
        <span className="absolute left-2 top-2 rounded-md bg-asphalt-950/75 px-2 py-0.5 text-xs font-semibold text-white">{label}</span>
      </div>
    </figure>
  )
}

const EMPTY_DESCRIPTION = 'The officer uploads an after photo when the work is done; it appears here next to the original.'
const EMPTY_DESCRIPTION_OWN = 'Upload an after photo when the work is done; it appears here next to the original.'

export function EvidencePanel({
  evidence,
  fallbackBefore,
  alt = 'Complaint location',
  action,
  emptyTitle = 'No resolution evidence yet',
  emptyDescription,
  className,
}) {
  const items = (Array.isArray(evidence) ? evidence : evidence ? [evidence] : [])
    .filter((item) => item && (item.before_image || item.after_image))
    .sort((a, b) => (toDate(b.uploaded_at)?.getTime() ?? 0) - (toDate(a.uploaded_at)?.getTime() ?? 0))
  const [selectedId, setSelectedId] = useState(null)

  if (!items.length) {
    return (
      <EmptyState
        icon={ImageUp}
        compact
        bordered={false}
        title={emptyTitle}
        description={emptyDescription ?? (action ? EMPTY_DESCRIPTION_OWN : EMPTY_DESCRIPTION)}
        action={action}
        className={className}
      />
    )
  }

  const current = items.find((item) => String(item.id) === String(selectedId)) ?? items[0]
  const before = current.before_image || fallbackBefore
  const after = current.after_image

  return (
    <div className={cn('@container min-w-0', className)}>
      {items.length > 1 ? (
        <Tabs
          className="mb-3"
          label="Evidence uploads"
          value={String(current.id)}
          onChange={setSelectedId}
          tabs={items.map((item, index) => ({
            id: String(item.id),
            label: index === 0 ? `Latest (${formatDate(item.uploaded_at)})` : formatDate(item.uploaded_at),
          }))}
        />
      ) : null}

      {before && after ? (
        <BeforeAfterSlider key={current.id} before={before} after={after} alt={alt} />
      ) : (
        <div className="grid gap-3 @md:grid-cols-2">
          {before ? <SinglePhoto src={before} label="Before" alt={alt} /> : null}
          {after ? <SinglePhoto src={after} label="After" alt={alt} /> : null}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
        {current.uploaded_by ? (
          <span className="inline-flex items-center gap-1">
            <UserRound aria-hidden className="size-3.5" />
            Uploaded by {current.uploaded_by.full_name}
          </span>
        ) : null}
        {current.uploaded_at ? (
          <time dateTime={current.uploaded_at} className="tabular">
            {formatDateTime(current.uploaded_at)}
          </time>
        ) : null}
        {!current.before_image && fallbackBefore && after ? <span>Before photo: the citizen&apos;s original report</span> : null}
      </div>
      {current.remarks ? (
        <p className="mt-2 whitespace-pre-line rounded-lg border-l-[3px] border-line-strong bg-surface-2 px-3 py-2 text-sm text-ink-2">
          {current.remarks}
        </p>
      ) : null}
    </div>
  )
}

export default EvidencePanel
