/**
 * ReassignDrawer - assign or reassign the officer of a complaint, guided by the recommendation engine.
 *
 * Data: GET /assignments/recommend/?complaint=<id>&limit=n - candidates ranked by a 0-1 score:
 * 0.40 x spare capacity + 0.25 x proximity (exp(-d / 5 km)) + 0.15 x availability + 0.20 x track record (the
 * track record weighs 0.30 for critical complaints). Officers at or over capacity are ranked last. Each
 * candidate shows the score, its workload bar, distance, availability and the engine's reasons; the top one
 * carries the "Recommended" badge. Any other active officer can be picked from the full directory.
 * Save: PATCH /assignments/{active id}/ (reassignment) or POST /assignments/ when nobody is assigned yet.
 *
 * Motion: the candidates arrive one after another in the engine's ranking order, each match score counting up
 * and its workload bar filling (more candidates loaded later simply appear). Reduced motion: all at once.
 *
 * Props: open, onClose, complaint (ComplaintDetail), onAssigned(assignment)
 */
import { Check, MapPin, Sparkles, UserCheck } from 'lucide-react'
import { useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Avatar } from '@/components/ui/Avatar'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Drawer } from '@/components/ui/Drawer'
import { ErrorState } from '@/components/ui/ErrorState'
import { FormField } from '@/components/ui/FormField'
import { Skeleton } from '@/components/ui/Skeleton'
import { Textarea } from '@/components/ui/Textarea'
import { DepartmentBadge } from '@/components/complaints'
import { CountUp } from '@/components/motion/CountUp'
import { Stagger, StaggerItem } from '@/components/motion/Stagger'
import { useApi } from '@/hooks/useApi'
import { useToast } from '@/hooks/useToast'
import { assignmentService, officerService } from '@/services'
import { cn } from '@/utils/cn'
import { ACTION_LABELS } from '@/utils/constants'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { formatDistance } from '@/utils/format'
import { OfficerSelect } from '../shared/OfficerSelect'
import { WorkloadBar } from '../shared/WorkloadBar'
import { officerName, toList } from '../shared/listUtils'

function CandidateOption({ candidate, index, selected, current, onSelect, name }) {
  const officer = candidate.officer ?? {}
  const score = Math.round((Number(candidate.score) || 0) * 100)
  const inputId = `candidate-${officer.id}`
  return (
    <StaggerItem as="li" index={index}>
      <label
        htmlFor={inputId}
        className={cn(
          'block cursor-pointer rounded-xl border bg-surface p-3.5 transition-colors',
          selected ? 'border-primary bg-primary-soft' : 'border-line hover:border-line-strong',
          current && 'cursor-default',
        )}
      >
        <div className="flex items-start gap-3">
          <input
            id={inputId}
            type="radio"
            name={name}
            value={officer.id}
            checked={selected}
            disabled={current}
            onChange={() => onSelect(String(officer.id))}
            className="mt-1 size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-default"
          />
          <Avatar src={officer.avatar} name={officer.full_name} size="sm" decorative />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-semibold text-ink">{officer.full_name}</span>
              {candidate.recommended ? (
                <Badge tone="green" size="sm" icon={Sparkles}>
                  Recommended
                </Badge>
              ) : null}
              {current ? (
                <Badge tone="blue" size="sm" icon={UserCheck}>
                  Current officer
                </Badge>
              ) : null}
            </div>
            <p className="truncate text-xs text-ink-3">
              {[officer.designation, officer.employee_id].filter(Boolean).join(', ') || 'Officer'}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <CountUp as="p" value={score} className="font-display text-xl font-extrabold leading-none text-ink tabular" />
            <p className="mt-0.5 text-[11px] font-medium text-ink-3">match score</p>
          </div>
        </div>

        <div className="mt-3 grid gap-3 pl-7 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <WorkloadBar
            active={candidate.workload}
            capacity={candidate.capacity}
            utilization={candidate.utilization}
            overloaded={candidate.overloaded}
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1 text-ink-2 tabular">
              <MapPin aria-hidden className="size-3.5 text-ink-3" />
              {candidate.distance_km == null ? 'Distance unknown' : `${formatDistance(candidate.distance_km * 1000)} away`}
            </span>
            <span
              className={cn(
                'inline-flex items-center gap-1 font-semibold',
                candidate.is_available ? 'text-sign-700 dark:text-sign-300' : 'text-hazard-700 dark:text-hazard-300',
              )}
            >
              <span aria-hidden className={cn('size-1.5 rounded-full', candidate.is_available ? 'bg-sign-500' : 'bg-hazard-500')} />
              {candidate.is_available ? 'Available' : 'Unavailable'}
            </span>
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5 pl-7">
          {officer.department ? <DepartmentBadge department={officer.department} size="sm" /> : null}
          {candidate.same_department === false ? (
            <Badge tone="yellow" size="sm">
              Other department
            </Badge>
          ) : null}
        </div>

        {Array.isArray(candidate.reasons) && candidate.reasons.length ? (
          <ul className="mt-2.5 space-y-1 pl-7 text-xs text-ink-2" aria-label={`Why ${officer.full_name} was ranked here`}>
            {candidate.reasons.map((reason) => (
              <li key={reason} className="flex gap-1.5">
                <Check aria-hidden className="mt-px size-3.5 shrink-0 text-ink-3" />
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </label>
    </StaggerItem>
  )
}

export function ReassignDrawer({ open, onClose, complaint, onAssigned }) {
  const toast = useToast()
  const [limit, setLimit] = useState(5)
  const [selected, setSelected] = useState('')
  const [notes, setNotes] = useState('')
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const recommendations = useApi(() => assignmentService.recommend(complaint.id, limit), [complaint.id, limit], { immediate: open })
  const directory = useApi(() => officerService.list({ page_size: 100, is_active: true }), [], { immediate: open })

  const currentId = complaint.assigned_officer?.id != null ? String(complaint.assigned_officer.id) : ''
  const activeAssignment = complaint.current_assignment?.is_active ? complaint.current_assignment : null
  const isReassign = Boolean(currentId)
  const candidates = Array.isArray(recommendations.data) ? recommendations.data : []
  const officers = toList(directory.data)
  const candidateIds = new Set(candidates.map((candidate) => String(candidate.officer?.id)))
  const pickedFromDirectory = selected && !candidateIds.has(selected) ? selected : ''
  const selectedName =
    candidates.find((candidate) => String(candidate.officer?.id) === selected)?.officer?.full_name ??
    officerName(officers.find((officer) => String(officer.id) === selected))

  const submit = async (event) => {
    event.preventDefault()
    if (!selected) {
      setErrors({ officer: 'Choose the officer who should handle this complaint.' })
      return
    }
    setSaving(true)
    setErrors({})
    const payload = { officer: Number(selected), notes: notes.trim() }
    try {
      const assignment = activeAssignment
        ? await assignmentService.reassign(activeAssignment.id, payload)
        : await assignmentService.assign({ complaint: complaint.id, ...payload })
      toast.success(isReassign ? 'Officer reassigned' : 'Officer assigned', `${selectedName} now handles ${complaint.complaint_number}.`)
      onAssigned?.(assignment)
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error(isReassign ? 'Could not reassign the officer' : 'Could not assign the officer', getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const title = isReassign ? ACTION_LABELS.reassign : ACTION_LABELS.assign

  return (
    <Drawer
      open={open}
      onClose={saving ? undefined : onClose}
      side="right"
      size="lg"
      title={title}
      description={`${complaint.complaint_number}: officers ranked by workload, distance, availability and track record.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="reassign-form" loading={saving} disabled={!selected} leftIcon={UserCheck}>
            {selected ? `${isReassign ? 'Reassign to' : 'Assign to'} ${selectedName}` : title}
          </Button>
        </>
      }
    >
      <form id="reassign-form" onSubmit={submit} className="space-y-5" noValidate>
        {complaint.assigned_officer ? (
          <p className="text-sm text-ink-2">
            Currently assigned to <span className="font-semibold text-ink">{complaint.assigned_officer.full_name}</span>. The
            current officer is notified about the reassignment, the new officer gets the work order.
          </p>
        ) : null}

        <fieldset className="min-w-0">
          <legend className="mb-2 text-sm font-semibold text-ink">Recommended officers</legend>
          {recommendations.error && !recommendations.data ? (
            <ErrorState
              compact
              title="Recommendations could not be loaded"
              error={recommendations.error}
              onRetry={() => recommendations.refetch()}
            />
          ) : recommendations.loading && !recommendations.data ? (
            <ul aria-hidden className="space-y-3">
              {[0, 1, 2].map((index) => (
                <li key={index} className="space-y-2 rounded-xl border border-line p-3.5">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-2 w-full" />
                  <Skeleton className="h-3 w-2/3" />
                </li>
              ))}
            </ul>
          ) : candidates.length ? (
            <Stagger as="ul" className="space-y-3">
              {candidates.map((candidate, index) => (
                <CandidateOption
                  key={candidate.officer?.id}
                  index={index}
                  candidate={candidate}
                  name="recommended-officer"
                  selected={selected === String(candidate.officer?.id)}
                  current={String(candidate.officer?.id) === currentId}
                  onSelect={(id) => {
                    setSelected(id)
                    setErrors({})
                  }}
                />
              ))}
            </Stagger>
          ) : (
            <Alert tone="info" title="No candidates found">
              No active officer works in this complaint&apos;s department or its fallbacks. Pick any officer below.
            </Alert>
          )}
          {candidates.length >= limit && limit < 20 ? (
            <Button variant="link" size="sm" className="mt-2" onClick={() => setLimit(limit + 5)} loading={recommendations.loading}>
              Show more candidates
            </Button>
          ) : null}
        </fieldset>

        <FormField
          label="Or choose any officer"
          hint="Use this to route the work to another department's officer."
          error={errors.officer}
        >
          <OfficerSelect
            officers={officers}
            value={pickedFromDirectory}
            onChange={(value) => {
              setSelected(value)
              setErrors({})
            }}
            excludeId={currentId}
            activeOnly
            placeholder={directory.loading && !directory.data ? 'Loading officers…' : 'Choose from all officers'}
          />
        </FormField>

        <FormField label="Notes for the officer" optional hint="Shown on the assignment and in the audit log." error={errors.notes}>
          <Textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="For example: citizen reports the cover is missing since Monday; bring barricades."
          />
        </FormField>

        {errors.non_field_errors || errors.complaint ? (
          <Alert tone="danger">{errors.non_field_errors || errors.complaint}</Alert>
        ) : null}
      </form>
    </Drawer>
  )
}

export default ReassignDrawer
