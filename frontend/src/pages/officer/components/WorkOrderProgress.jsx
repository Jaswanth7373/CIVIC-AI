/**
 * WorkOrderProgress - where the complaint stands and what to do now.
 *
 * Props:
 * - complaint: ComplaintDetail
 * - currentUserId: the signed-in officer (decides "your work" vs "a colleague's complaint")
 * - onUpdated(detail), onRemarkAdded(event): passed to ComplaintActions
 * - actionsRef: ref to the next-step strip (the phone dock watches it and only appears once it is out of view)
 *
 * The lifecycle stepper shows the road travelled so far; the strip under it names the next step in one
 * sentence next to the buttons that take it, marked with a small road-marking yellow plate - the
 * wayfinding accent of the design system.
 *
 * WorkOrderDock (same file) is the phone version of that strip: a floating dock with the next step in a few
 * words and the primary action, so the officer can act from anywhere on the long work order. It watches the
 * strip (`watch` = the same ref as `actionsRef`), so the action is never on screen twice.
 */
import { Ban, CircleCheck, ClipboardCheck, Construction, Eye, Hourglass, ImageUp, ScanEye, ShieldCheck, UserSearch } from 'lucide-react'
import { LifecycleStepper } from '@/components/complaints/LifecycleStepper'
import { MobileActionDock } from '@/components/complaints/MobileActionDock'
import { Card } from '@/components/ui/Card'
import { ComplaintActions } from './ComplaintActions'
import { nextStep, primaryActionKey } from './officerUtils'

const STEP_ICONS = {
  accept: ClipboardCheck,
  start: Construction,
  resolve: CircleCheck,
  verify: ScanEye,
  review: UserSearch,
  evidence: ImageUp,
  done: ShieldCheck,
  stopped: Ban,
  watch: Eye,
  wait: Hourglass,
}

/** The next step in a few words, for the phone dock (the full sentence is in the progress strip). */
const STEP_SHORT = {
  accept: 'Confirm you will handle it',
  start: 'Crew on site? Start the work',
  resolve: 'Record the fix with photos',
  verify: 'Let the AI check the fix',
  review: 'The check needs a person',
  evidence: 'The AI needs an after photo',
}

export function WorkOrderProgress({ complaint, currentUserId, onUpdated, onRemarkAdded, actionsRef }) {
  const step = nextStep(complaint, currentUserId)
  const Icon = STEP_ICONS[step.key] ?? Hourglass

  return (
    <Card className="mb-5 overflow-hidden elev-raised">
      <div className="px-4 pb-4 pt-4 sm:px-5">
        <h2 className="sr-only">Progress and next step</h2>
        <LifecycleStepper status={complaint.status} events={complaint.timeline} />
      </div>
      <div
        ref={actionsRef}
        className="flex flex-col gap-3 border-t border-line bg-surface-2 px-4 py-3 sm:px-5 xl:flex-row xl:items-center xl:justify-between"
      >
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-md bg-marking-400 text-asphalt-950">
            <Icon className="size-4" strokeWidth={2.4} />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-ink-3">Next step</p>
            <p className="text-sm font-medium text-ink">{step.text}</p>
          </div>
        </div>
        <ComplaintActions
          complaint={complaint}
          onUpdated={onUpdated}
          onRemarkAdded={onRemarkAdded}
          className="xl:shrink-0 xl:justify-end"
        />
      </div>
    </Card>
  )
}

/**
 * Phone dock with the primary action of the work order (nothing when no lifecycle action is open); `watch` is the
 * next-step strip's ref.
 */
export function WorkOrderDock({ complaint, currentUserId, onUpdated, watch }) {
  const step = nextStep(complaint, currentUserId)
  if (!primaryActionKey(complaint)) return null
  return (
    <MobileActionDock
      label="Work order actions"
      eyebrow={complaint.complaint_number}
      title={STEP_SHORT[step.key] ?? step.text}
      icon={STEP_ICONS[step.key] ?? Hourglass}
      watch={watch}
    >
      <ComplaintActions complaint={complaint} onUpdated={onUpdated} only="primary" />
    </MobileActionDock>
  )
}

export default WorkOrderProgress
