/**
 * ReportRail - the side column of the report wizard on wide screens (xl and up).
 *
 * - "Your report": a live checklist of what has been filled in (photo, description, category, location), so
 *   the citizen sees at a glance what is still missing before the review step.
 * - "After you submit": the stages the AI pipeline runs on the server, drawn on the lane-line road used for
 *   every complaint journey. The same stages are replayed with their real timings after submitting.
 */
import { Building2, Check, Copy, Gauge, ScanSearch, UserCheck } from 'lucide-react'
import { cn } from '@/utils/cn'

const PIPELINE = [
  { icon: ScanSearch, title: 'Classify', text: 'The image model and the text classifier each name the issue; their votes are fused.' },
  { icon: Gauge, title: 'Score', text: 'Severity and priority are scored from 0 to 100, with the reasons behind them.' },
  { icon: Copy, title: 'Check duplicates', text: 'Nearby reports are compared by text, photo and distance.' },
  { icon: Building2, title: 'Route', text: 'The complaint goes to the department responsible for the category.' },
  { icon: UserCheck, title: 'Assign', text: 'An available officer close to the spot is assigned, and you are notified.' },
]

function CheckRow({ done, label, value }) {
  return (
    <li className="flex items-start gap-2.5 py-2">
      <span
        aria-hidden
        className={cn(
          'mt-px grid size-5 shrink-0 place-items-center rounded-full',
          done ? 'bg-sign-600 text-white' : 'border border-dashed border-line-strong',
        )}
      >
        {done ? <Check className="size-3" strokeWidth={3} /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink">
          {label}
          <span className="sr-only">{done ? ': done' : ': not done yet'}</span>
        </span>
        <span className="block truncate text-xs text-ink-3">{value}</span>
      </span>
    </li>
  )
}

export function ReportRail({ form, categories, suggestion }) {
  const description = form.description.trim()
  const chosen = (categories ?? []).find((category) => category.slug === form.category)
  const suggested = suggestion?.result?.category
  const place = form.address.area || form.address.address || form.address.city
  return (
    <div className="sticky top-24 space-y-4">
      <section aria-labelledby="report-checklist-heading" className="rounded-xl border border-line bg-surface p-4">
        <h2 id="report-checklist-heading" className="font-display text-sm font-bold text-ink">
          Your report
        </h2>
        <ul className="mt-1 divide-y divide-line">
          <CheckRow done={Boolean(form.image)} label="Photo" value={form.image ? form.image.name : 'Optional, but it helps the AI'} />
          <CheckRow
            done={description.length >= 10}
            label="Description"
            value={description ? `${description.length} characters` : 'Required, at least 10 characters'}
          />
          <CheckRow
            done={Boolean(chosen || suggested)}
            label="Category"
            value={chosen ? chosen.name : suggested ? `AI suggests ${suggested.name}` : 'The AI decides if you skip it'}
          />
          <CheckRow
            done={Boolean(form.position)}
            label="Location"
            value={form.position ? place || 'Pinned on the map' : 'Required, place the pin'}
          />
        </ul>
      </section>

      <section aria-labelledby="report-pipeline-heading" className="rounded-xl border border-line bg-surface p-4">
        <h2 id="report-pipeline-heading" className="font-display text-sm font-bold text-ink">
          After you submit
        </h2>
        <ol className="mt-3">
          {PIPELINE.map((stage, index) => {
            const Icon = stage.icon
            const last = index === PIPELINE.length - 1
            return (
              <li key={stage.title} className="relative flex gap-3">
                {!last ? <span aria-hidden className="lane-line absolute bottom-0 left-[13px] top-7 w-[3px] rounded-full" /> : null}
                <span className="relative grid size-7 shrink-0 place-items-center rounded-lg bg-sidebar text-marking-400">
                  <Icon aria-hidden className="size-3.5" />
                </span>
                <div className={cn('min-w-0', last ? 'pb-0' : 'pb-4')}>
                  <p className="text-sm font-semibold text-ink">{stage.title}</p>
                  <p className="text-xs text-ink-3">{stage.text}</p>
                </div>
              </li>
            )
          })}
        </ol>
      </section>
    </div>
  )
}

export default ReportRail
