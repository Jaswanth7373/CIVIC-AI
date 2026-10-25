/**
 * AdminControls - the administrator's control panel next to a complaint: who works on it, where it stands
 * against its SLA, what the AI decided, and a remark box. Every button maps to an `allowed_actions` key of the
 * ComplaintDetail (copy from ACTION_LABELS), so the panel never offers an action the API would refuse;
 * "Change status" is always available because administrators may take any lifecycle transition.
 *
 * Props:
 * - complaint: ComplaintDetail
 * - onOpen(dialog): 'reassign' | 'status' | 'close' | 'reopen' | 'override' | 'reanalyze'
 * - onRemarkAdded(event): a TimelineEvent was created
 */
import { Archive, History, MessageSquarePlus, RefreshCw, RotateCcw, ScanSearch, SlidersHorizontal, UserCheck, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { CategoryBadge, DepartmentBadge, SeverityBadge, SLAIndicator, StatusBadge } from '@/components/complaints'
import { Avatar } from '@/components/ui/Avatar'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Switch } from '@/components/ui/Switch'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/hooks/useToast'
import { complaintService } from '@/services'
import { cn } from '@/utils/cn'
import { ACTION_LABELS, ASSIGNMENT_STATUS_META, ASSIGNMENT_TYPE_LABELS, LEVEL_META } from '@/utils/constants'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { formatDateTime, timeAgo } from '@/utils/format'

function Section({ title, children, className }) {
  return (
    <section className={cn('border-t border-line px-4 py-4 sm:px-5', className)}>
      <h3 className="mb-3 text-sm font-bold text-ink">{title}</h3>
      {children}
    </section>
  )
}

function assignedByText(assignment) {
  if (!assignment) return ''
  if (assignment.assignment_type === 'auto' || !assignment.assigned_by) return ASSIGNMENT_TYPE_LABELS.auto
  const type = assignment.assignment_type === 'reassignment' ? 'Reassigned' : 'Assigned'
  return `${type} by ${assignment.assigned_by.full_name}`
}

function AssignmentSection({ complaint, allowed, onOpen }) {
  const assignment = complaint.current_assignment
  // A completed assignment is no longer "current"; its OfficerMini still has the designation and department.
  const latest = (Array.isArray(complaint.assignments) ? complaint.assignments : []).find(
    (item) => item.officer?.id != null && item.officer.id === complaint.assigned_officer?.id,
  )
  const officer = assignment?.officer ?? latest?.officer ?? complaint.assigned_officer
  const history = (Array.isArray(complaint.assignments) ? complaint.assignments : []).filter((item) => item.id !== assignment?.id)
  const canReassign = allowed.has('reassign')
  const canAssign = allowed.has('assign')

  return (
    <Section title="Assigned officer">
      {officer ? (
        <div className="flex items-start gap-3">
          <Avatar src={officer.avatar} name={officer.full_name} size="md" decorative />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-ink">{officer.full_name}</p>
            <p className="text-xs text-ink-3">{[officer.designation, officer.employee_id].filter(Boolean).join(', ') || 'Officer'}</p>
            {(officer.department ?? complaint.department) ? (
              <DepartmentBadge department={officer.department ?? complaint.department} size="sm" className="mt-1.5" />
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-sm text-ink-2">No officer is assigned yet. Assign one so the work can start.</p>
      )}

      {assignment ? (
        <dl className="mt-3 grid gap-1.5 text-xs">
          <div className="flex justify-between gap-3">
            <dt className="text-ink-3">How</dt>
            <dd className="text-right font-medium text-ink">{assignedByText(assignment)}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-ink-3">When</dt>
            <dd className="text-right font-medium text-ink">
              <time dateTime={assignment.assigned_at} title={formatDateTime(assignment.assigned_at)}>
                {timeAgo(assignment.assigned_at)}
              </time>
            </dd>
          </div>
          {assignment.recommendation_score != null ? (
            <div className="flex justify-between gap-3">
              <dt className="text-ink-3">Match score</dt>
              <dd className="text-right font-medium text-ink tabular">{Math.round(Number(assignment.recommendation_score) * 100)}/100</dd>
            </div>
          ) : null}
          {officer?.phone ? (
            <div className="flex items-center justify-between gap-3">
              <dt className="text-ink-3">Phone</dt>
              <dd className="text-right">
                <a
                  href={`tel:${officer.phone}`}
                  className="inline-flex items-center font-medium text-primary-ink hover:underline tabular pointer-coarse:min-h-11"
                >
                  {officer.phone}
                </a>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {assignment?.notes ? (
        <p className="mt-2 rounded-lg border-l-[3px] border-line-strong bg-surface-2 px-3 py-2 text-xs text-ink-2">{assignment.notes}</p>
      ) : null}

      {canReassign || canAssign ? (
        <Button
          variant={canAssign ? 'primary' : 'outline'}
          fullWidth
          className="mt-3"
          leftIcon={canAssign ? UserPlus : UserCheck}
          onClick={() => onOpen('reassign')}
        >
          {canAssign ? ACTION_LABELS.assign : ACTION_LABELS.reassign}
        </Button>
      ) : officer ? (
        <p className="mt-3 text-xs text-ink-3">
          {complaint.status === 'rejected'
            ? 'A rejected complaint keeps its last officer. Reopen it to assign the work again.'
            : 'The assignment is locked once the complaint is resolved. Reopen it to assign the work again.'}
        </p>
      ) : null}

      {history.length ? (
        <details className="group mt-3">
          <summary className="inline-flex cursor-pointer items-center gap-1.5 rounded-md text-xs font-semibold text-primary-ink hover:underline pointer-coarse:min-h-11">
            <History aria-hidden className="size-3.5" />
            {assignment ? 'Earlier assignments' : 'Assignment history'} ({history.length})
          </summary>
          <ol className="mt-2 space-y-2">
            {history.map((item) => {
              const meta = ASSIGNMENT_STATUS_META[item.status] ?? { label: item.status_display ?? item.status, tone: 'neutral' }
              return (
                <li key={item.id} className="rounded-lg bg-surface-2 px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-ink">{item.officer?.full_name}</span>
                    <Badge tone={meta.tone} size="sm">
                      {meta.label}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-ink-3">
                    {assignedByText(item)},{' '}
                    <time dateTime={item.assigned_at} className="tabular">
                      {formatDateTime(item.assigned_at)}
                    </time>
                  </p>
                  {item.notes ? <p className="mt-1 text-ink-2">{item.notes}</p> : null}
                </li>
              )
            })}
          </ol>
        </details>
      ) : null}
    </Section>
  )
}

function StatusSection({ complaint, allowed, onOpen }) {
  return (
    <Section title="Status and SLA">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={complaint.status} label={complaint.status_display} />
        <SLAIndicator
          dueAt={complaint.sla_due_at}
          status={complaint.status}
          resolvedAt={complaint.resolved_at}
          isOverdue={complaint.is_overdue}
          createdAt={complaint.created_at}
        />
      </div>
      {complaint.sla_due_at ? (
        <p className="mt-2 text-xs text-ink-3">
          Deadline{' '}
          <time dateTime={complaint.sla_due_at} className="font-medium text-ink-2 tabular">
            {formatDateTime(complaint.sla_due_at)}
          </time>
          {complaint.reopen_count ? `, reopened ${complaint.reopen_count} ${complaint.reopen_count === 1 ? 'time' : 'times'}` : ''}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" leftIcon={RefreshCw} onClick={() => onOpen('status')} className="flex-1">
          Change status
        </Button>
        {allowed.has('close') ? (
          <Button variant="outline" leftIcon={Archive} onClick={() => onOpen('close')} className="flex-1">
            {ACTION_LABELS.close}
          </Button>
        ) : null}
        {allowed.has('reopen') ? (
          <Button variant="outline" leftIcon={RotateCcw} onClick={() => onOpen('reopen')} className="flex-1">
            {ACTION_LABELS.reopen}
          </Button>
        ) : null}
      </div>
    </Section>
  )
}

function AIDecisionSection({ complaint, allowed, onOpen }) {
  const level = LEVEL_META[complaint.priority_level]
  return (
    <Section title="AI decision">
      <dl className="grid gap-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-xs text-ink-3">Category</dt>
          <dd className="min-w-0">
            <CategoryBadge category={complaint.category} size="sm" />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-xs text-ink-3">Severity</dt>
          <dd>
            <SeverityBadge severity={complaint.severity} score={complaint.severity_score} size="sm" />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-xs text-ink-3">Priority</dt>
          <dd className="text-sm font-semibold text-ink tabular">
            {complaint.priority_score ?? '—'}/100 <span className="font-normal text-ink-3">{level?.label}</span>
          </dd>
        </div>
      </dl>
      {complaint.is_ai_overridden ? (
        <Badge tone="violet" size="sm" icon={SlidersHorizontal} className="mt-2.5">
          Corrected by an administrator
        </Badge>
      ) : null}
      {complaint.needs_manual_review ? (
        <Badge tone="blue" size="sm" className="mt-2.5 ml-1">
          Needs manual review
        </Badge>
      ) : null}
      {allowed.has('override_ai') || allowed.has('reanalyze') ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {allowed.has('override_ai') ? (
            <Button variant="outline" leftIcon={SlidersHorizontal} onClick={() => onOpen('override')} className="flex-1">
              {ACTION_LABELS.override_ai}
            </Button>
          ) : null}
          {allowed.has('reanalyze') ? (
            <Button variant="ghost" leftIcon={ScanSearch} onClick={() => onOpen('reanalyze')} className="flex-1">
              {ACTION_LABELS.reanalyze}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Section>
  )
}

function RemarkSection({ complaint, onRemarkAdded }) {
  const toast = useToast()
  const [remarks, setRemarks] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    if (!remarks.trim()) {
      setError('Write the remark first.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const timelineEvent = await complaintService.addRemark(complaint.id, { remarks: remarks.trim(), is_public: isPublic })
      toast.success('Remark added', isPublic ? 'The citizen can see it on the timeline.' : 'Saved as an internal note.')
      setRemarks('')
      onRemarkAdded?.(timelineEvent)
    } catch (err) {
      setError(getFieldErrors(err).remarks ?? '')
      toast.error('Could not add the remark', getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section title="Add a remark">
      <form onSubmit={submit} noValidate className="space-y-3">
        <label htmlFor="admin-remark" className="sr-only">
          Remark
        </label>
        <Textarea
          id="admin-remark"
          value={remarks}
          onChange={(event) => {
            setRemarks(event.target.value)
            if (error) setError('')
          }}
          maxLength={2000}
          rows={3}
          invalid={Boolean(error)}
          aria-describedby={error ? 'admin-remark-error' : undefined}
          placeholder="Instructions for the officer or an update for the citizen"
        />
        {error ? (
          <p id="admin-remark-error" className="text-xs font-medium text-signal-600 dark:text-signal-300">
            {error}
          </p>
        ) : null}
        <Switch
          checked={isPublic}
          onCheckedChange={setIsPublic}
          label="Show to the citizen"
          description={isPublic ? 'Appears on the public timeline.' : 'Internal note: only officers and administrators see it.'}
        />
        <Button type="submit" variant="secondary" fullWidth loading={saving} leftIcon={MessageSquarePlus}>
          {ACTION_LABELS.add_remark}
        </Button>
      </form>
    </Section>
  )
}

export function AdminControls({ complaint, onOpen, onRemarkAdded }) {
  const allowed = new Set(complaint.allowed_actions ?? [])
  return (
    <Card aria-label="Administrator controls">
      <div className="flex items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
        <h2 className="font-display text-base font-bold text-ink">Admin controls</h2>
        <span className="text-xs font-semibold text-ink-3 tabular">{complaint.complaint_number}</span>
      </div>
      <AssignmentSection complaint={complaint} allowed={allowed} onOpen={onOpen} />
      <StatusSection complaint={complaint} allowed={allowed} onOpen={onOpen} />
      <AIDecisionSection complaint={complaint} allowed={allowed} onOpen={onOpen} />
      {allowed.has('add_remark') ? <RemarkSection complaint={complaint} onRemarkAdded={onRemarkAdded} /> : null}
    </Card>
  )
}

export default AdminControls
