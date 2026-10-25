/**
 * Complaint details (/citizen/complaints/:id) - everything about one of the citizen's complaints.
 *
 * Data: GET /api/complaints/{id}/ (ComplaintDetail; the server only returns the citizen's own complaints
 * and only public timeline events). Layout: header (title, number, status, reported time, SLA, actions),
 * progress strip (LifecycleStepper + who / when / latest update), then the report (photo with the AI's
 * detection boxes, description), resolution evidence + AI verification, feedback, AI analysis and possible
 * duplicates in the main column; priority, location and the compact timeline in the side column.
 *
 * Actions come strictly from `allowed_actions`: edit (dialog), delete (confirmation), reopen (dialog with a
 * required reason) and feedback (inline FeedbackForm -> POST /api/feedback/, which closes the complaint;
 * `suggest_reopen` in the answer offers to reopen it). "Track progress" opens the live tracking view.
 * On phones the page's next action (give feedback once the fix is in, otherwise follow it live) also floats
 * in a dock at the bottom of the screen, once the header's own button has scrolled out of view.
 */
import { useReducedMotion } from 'framer-motion'
import { Ban, BrainCircuit, Copy, Gauge, ImageOff, Pencil, RotateCcw, Route, ShieldCheck, Star, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { AIAnalysisPanel } from '@/components/ai/AIAnalysisPanel'
import { ImageWithBoxes } from '@/components/ai/ImageWithBoxes'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { ComplaintTimeline } from '@/components/complaints/ComplaintTimeline'
import { DuplicatePanel } from '@/components/complaints/DuplicatePanel'
import { EvidencePanel } from '@/components/complaints/EvidencePanel'
import { FeedbackCard } from '@/components/complaints/FeedbackCard'
import { FeedbackForm } from '@/components/complaints/FeedbackForm'
import { LifecycleStepper } from '@/components/complaints/LifecycleStepper'
import { MobileActionDock } from '@/components/complaints/MobileActionDock'
import { PriorityBreakdown } from '@/components/complaints/PriorityBreakdown'
import { SeverityBadge } from '@/components/complaints/SeverityBadge'
import { StatusBadge } from '@/components/complaints/StatusBadge'
import { VerificationResult } from '@/components/complaints/VerificationResult'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ErrorState } from '@/components/ui/ErrorState'
import { PageHeader } from '@/components/ui/PageHeader'
import { useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { useConfirm } from '@/hooks/useConfirm'
import { useNotifications } from '@/hooks/useNotifications'
import { useToast } from '@/hooks/useToast'
import { categoryService } from '@/services/categoryService'
import { complaintService } from '@/services/complaintService'
import { feedbackService } from '@/services/feedbackService'
import { ACTION_LABELS } from '@/utils/constants'
import { getErrorMessage, getErrorStatus } from '@/utils/errors'
import { formatDateTime } from '@/utils/format'
import { EditComplaintModal, ReopenComplaintModal } from './components/ComplaintActionModals'
import { ComplaintMetaRow, LocationCard, StatusFacts } from './components/ComplaintPanels'
import { ComplaintPageSkeleton, ComplaintNotFound } from './components/ComplaintPageStates'
import { complaintPath, isOpenStatus, latestEvent, primaryPhoto, trackingPath } from './components/complaintHelpers'
import { useOwnComplaintIds } from './components/useOwnComplaintIds'

function Fact({ label, children }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-ink-3">{label}</dt>
      <dd className="mt-1 text-sm text-ink-2">{children}</dd>
    </div>
  )
}

export default function ComplaintDetails() {
  const { id } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const { refreshUser } = useAuth()
  const { refresh: refreshNotifications } = useNotifications()
  const reducedMotion = useReducedMotion()
  const { data, error, refetch, setData } = useApi(() => complaintService.get(id), [id])
  // While another complaint loads (e.g. after following a duplicate link), never show the previous one.
  const complaint = data && String(data.id) === String(id) ? data : null
  const { data: categoryData } = useApi(() => categoryService.list(), [])
  const categories = Array.isArray(categoryData) ? categoryData : []

  const [editSession, setEditSession] = useState(0)
  const [editOpen, setEditOpen] = useState(false)
  const [reopenOpen, setReopenOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [feedbackOutcome, setFeedbackOutcome] = useState(null)
  const feedbackRef = useRef(null)
  // The header's own copies of the dock's actions: the phone dock only appears once they have scrolled away.
  const feedbackActionRef = useRef(null)
  const trackActionRef = useRef(null)

  const duplicates = complaint?.duplicates ?? []
  const hasDuplicateInfo = Boolean(duplicates.length || complaint?.duplicate_of)
  const { ids: ownIds } = useOwnComplaintIds(hasDuplicateInfo)

  if (!complaint) {
    if (error) {
      return getErrorStatus(error) === 404 ? (
        <ComplaintNotFound />
      ) : (
        <ErrorState title="This complaint could not be loaded" error={error} onRetry={refetch} />
      )
    }
    return <ComplaintPageSkeleton />
  }

  const allowed = new Set(complaint.allowed_actions ?? [])
  const photo = primaryPhoto(complaint)
  const prediction = complaint.ai_prediction
  const evidence = complaint.evidence ?? []
  const verification = complaint.latest_verification
  const feedback = complaint.feedback ?? []
  const timeline = complaint.timeline ?? []
  const canFeedback = allowed.has('feedback')
  const rejection = complaint.status === 'rejected' ? latestEvent(timeline.filter((event) => event.event === 'rejected')) : null
  const allDuplicatesOwn = duplicates.every((link) => ownIds.has(link.other?.id))
  const original = complaint.duplicate_of

  const scrollToFeedback = () => {
    feedbackRef.current?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
    feedbackRef.current?.querySelector('[role="radio"]')?.focus({ preventScroll: true })
  }

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete this complaint?',
      message: `${complaint.complaint_number} will be withdrawn and removed from the department's queue. This cannot be undone.`,
      confirmLabel: ACTION_LABELS.delete,
      cancelLabel: 'Keep complaint',
      tone: 'danger',
    })
    if (!ok) return
    setDeleting(true)
    try {
      await complaintService.remove(complaint.id)
      toast.success('Complaint deleted', `${complaint.complaint_number} was withdrawn.`)
      refreshNotifications()
      navigate('/citizen/complaints', { replace: true })
    } catch (deleteError) {
      toast.error('Could not delete complaint', getErrorMessage(deleteError))
      setDeleting(false)
    }
  }

  const submitFeedback = async (values) => {
    try {
      const saved = await feedbackService.submit({ complaint: complaint.id, rating: values.rating, text: values.text })
      toast.success(
        'Feedback submitted',
        saved?.suggest_reopen
          ? 'Sorry it did not go well. You can reopen the complaint if the problem is still there.'
          : 'Thank you. The complaint is now closed.',
      )
      setFeedbackOutcome({ suggestReopen: Boolean(saved?.suggest_reopen) })
      refreshUser()
      refetch()
      return saved
    } catch (submitError) {
      toast.error('Could not submit feedback', getErrorMessage(submitError))
      throw submitError
    }
  }

  const onSaved = (updated) => {
    if (updated) setData((current) => ({ ...current, ...updated }))
    setEditOpen(false)
    setReopenOpen(false)
    setFeedbackOutcome(null)
    refetch()
  }

  const actions = (
    <>
      {canFeedback ? (
        <Button ref={feedbackActionRef} leftIcon={Star} onClick={scrollToFeedback}>
          {ACTION_LABELS.feedback}
        </Button>
      ) : null}
      <Button ref={trackActionRef} variant="outline" leftIcon={Route} to={trackingPath(complaint.id)}>
        Track progress
      </Button>
      {allowed.has('reopen') ? (
        <Button variant="outline" leftIcon={RotateCcw} onClick={() => setReopenOpen(true)}>
          {ACTION_LABELS.reopen}
        </Button>
      ) : null}
      {allowed.has('edit') ? (
        <Button
          variant="outline"
          leftIcon={Pencil}
          onClick={() => {
            setEditSession((value) => value + 1)
            setEditOpen(true)
          }}
        >
          {ACTION_LABELS.edit}
        </Button>
      ) : null}
      {allowed.has('delete') ? (
        <Button
          variant="ghost"
          leftIcon={Trash2}
          loading={deleting}
          onClick={handleDelete}
          className="text-signal-600 hover:bg-signal-50 hover:text-signal-700 dark:text-signal-300 dark:hover:bg-signal-500/15"
        >
          {ACTION_LABELS.delete}
        </Button>
      ) : null}
    </>
  )

  return (
    <>
      <PageHeader
        back={{ to: '/citizen/complaints', label: 'My complaints' }}
        title={complaint.title || complaint.complaint_number}
        actions={actions}
      >
        <ComplaintMetaRow complaint={complaint} />
      </PageHeader>

      <div className="space-y-5">
        {rejection ? (
          <Alert tone="danger" icon={Ban} title="The department could not act on this complaint">
            {rejection.remarks || 'The officer rejected the complaint.'}
            {rejection.actor_label ? <span className="text-ink-3"> ({rejection.actor_label})</span> : null}
          </Alert>
        ) : null}
        {feedbackOutcome?.suggestReopen && allowed.has('reopen') ? (
          <Alert
            tone="warning"
            title="Not happy with the fix?"
            action={
              <Button size="sm" variant="warning" leftIcon={RotateCcw} onClick={() => setReopenOpen(true)}>
                {ACTION_LABELS.reopen}
              </Button>
            }
          >
            If the problem is still there, reopen the complaint and it goes back to the officer
            {complaint.can_reopen_until ? ` (possible until ${formatDateTime(complaint.can_reopen_until)})` : ''}.
          </Alert>
        ) : null}
        {complaint.needs_manual_review ? (
          <Alert tone="info" icon={ShieldCheck} title="An administrator is double-checking this complaint">
            The AI was not fully sure about the category or the resolution, so a person reviews it. You do not need to do
            anything.
          </Alert>
        ) : null}

        <Card className="elev-raised">
          <CardBody className="space-y-5">
            <LifecycleStepper status={complaint.status} events={timeline} />
            <StatusFacts complaint={complaint} events={timeline} className="border-t border-line pt-5" />
          </CardBody>
        </Card>

        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_21rem] xl:grid-cols-[minmax(0,1fr)_24rem]">
          <div className="min-w-0 space-y-5">
            <Card>
              <CardHeader title="What you reported" />
              <CardBody className="space-y-4">
                {photo ? (
                  <ImageWithBoxes
                    src={photo}
                    alt={`Photo of ${complaint.complaint_number}`}
                    objects={prediction?.detected_objects}
                    boxes={prediction?.bounding_boxes}
                    categories={categories}
                  />
                ) : (
                  <p className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-ink-3">
                    <ImageOff aria-hidden className="size-4" />
                    No photo was attached. The AI classified this report from the description.
                  </p>
                )}
                <p className="whitespace-pre-line break-words text-[15px] leading-relaxed text-ink">{complaint.description}</p>
                <dl className="grid gap-4 border-t border-line pt-4 sm:grid-cols-3">
                  <Fact label="Your category">
                    {complaint.reported_category ? (
                      <CategoryBadge category={complaint.reported_category} size="sm" />
                    ) : (
                      'Left to the AI'
                    )}
                  </Fact>
                  <Fact label="Noticed">
                    <time dateTime={complaint.incident_at} className="tabular">
                      {formatDateTime(complaint.incident_at ?? complaint.created_at)}
                    </time>
                  </Fact>
                  <Fact label="Reported">
                    <time dateTime={complaint.created_at} className="tabular">
                      {formatDateTime(complaint.created_at)}
                    </time>
                  </Fact>
                  {complaint.reopen_count ? (
                    <Fact label="Reopened">
                      {complaint.reopen_count === 1 ? 'Once' : `${complaint.reopen_count} times`}
                    </Fact>
                  ) : null}
                </dl>
              </CardBody>
            </Card>

            {evidence.length || verification ? (
              <Card>
                <CardHeader
                  title="Resolution"
                  description="The officer's before and after photos, compared by the AI-assisted verification."
                />
                <CardBody className="space-y-6">
                  <EvidencePanel evidence={evidence} fallbackBefore={photo} alt={complaint.title || 'Complaint location'} />
                  {verification ? (
                    <div className="border-t border-line pt-5">
                      <h3 className="mb-3 font-display text-sm font-bold text-ink">AI verification</h3>
                      <VerificationResult verification={verification} />
                    </div>
                  ) : null}
                </CardBody>
              </Card>
            ) : null}

            {canFeedback || feedback.length ? (
              <Card ref={feedbackRef} id="feedback" className="scroll-mt-20">
                <CardHeader
                  icon={Star}
                  title={canFeedback ? 'Rate the resolution' : 'Your feedback'}
                  description={
                    canFeedback
                      ? 'Your rating closes the complaint. Comments are analysed for sentiment and shared with the department.'
                      : 'Thank you for rating how this complaint was handled.'
                  }
                />
                <CardBody className="space-y-3">
                  {canFeedback ? <FeedbackForm onSubmit={submitFeedback} /> : null}
                  {feedback.map((item) => (
                    <FeedbackCard key={item.id} feedback={item} showCitizen={false} showComplaint={false} />
                  ))}
                </CardBody>
              </Card>
            ) : null}

            <Card>
              <CardHeader
                icon={BrainCircuit}
                title="AI analysis"
                description="How the AI classified this complaint and scored its severity."
              />
              <CardBody>
                <AIAnalysisPanel prediction={prediction} categories={categories} />
              </CardBody>
            </Card>

            {hasDuplicateInfo ? (
              <Card>
                <CardHeader
                  icon={Copy}
                  title="Possible duplicates"
                  description="Reports the AI linked to this one because they look like the same problem nearby."
                />
                <CardBody className="space-y-4">
                  {original ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2.5 text-sm text-ink-2">
                      <span>Merged into the earlier report</span>
                      {ownIds.has(original.id) ? (
                        <Link to={complaintPath(original.id)} className="font-semibold text-primary-ink tabular hover:underline">
                          {original.complaint_number}
                        </Link>
                      ) : (
                        <span className="font-semibold text-ink tabular">{original.complaint_number}</span>
                      )}
                      <StatusBadge status={original.status} label={original.status_display} size="sm" />
                      <span className="text-ink-3">Updates continue on the original report.</span>
                    </div>
                  ) : null}
                  {duplicates.length ? (
                    <DuplicatePanel
                      duplicates={duplicates}
                      basePath={allDuplicatesOwn ? '/citizen/complaints' : undefined}
                    />
                  ) : null}
                </CardBody>
              </Card>
            ) : null}
          </div>

          <div className="min-w-0 space-y-5">
            <Card>
              <CardHeader icon={Gauge} title="Severity and priority" />
              <CardBody className="space-y-4">
                <div>
                  <SeverityBadge severity={complaint.severity} score={complaint.severity_score} withLabel />
                  {prediction?.severity_reason ? <p className="mt-2 text-sm text-ink-2">{prediction.severity_reason}</p> : null}
                </div>
                <div className="border-t border-line pt-4">
                  <PriorityBreakdown priority={complaint.priority} compact />
                </div>
              </CardBody>
            </Card>

            <LocationCard complaint={complaint} />

            <Card>
              <CardHeader
                title="Updates"
                actions={
                  <Button variant="link" size="sm" to={trackingPath(complaint.id)}>
                    Live tracking
                  </Button>
                }
              />
              <CardBody>
                <ComplaintTimeline events={timeline} status={complaint.status} compact maxEvents={5} />
              </CardBody>
            </Card>
          </div>
        </div>
      </div>

      {allowed.has('edit') ? (
        <EditComplaintModal
          key={editSession}
          complaint={complaint}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSaved={onSaved}
        />
      ) : null}
      {allowed.has('reopen') ? (
        <ReopenComplaintModal complaint={complaint} open={reopenOpen} onClose={() => setReopenOpen(false)} onSaved={onSaved} />
      ) : null}

      {canFeedback ? (
        <MobileActionDock
          label="Complaint actions"
          eyebrow={complaint.complaint_number}
          title="The fix is in. How did it go?"
          icon={Star}
          watch={feedbackActionRef}
        >
          <Button leftIcon={Star} onClick={scrollToFeedback}>
            {ACTION_LABELS.feedback}
          </Button>
        </MobileActionDock>
      ) : isOpenStatus(complaint.status) ? (
        <MobileActionDock
          label="Complaint actions"
          eyebrow={complaint.complaint_number}
          title="Follow every update live"
          icon={Route}
          watch={trackActionRef}
        >
          <Button leftIcon={Route} to={trackingPath(complaint.id)}>
            Track progress
          </Button>
        </MobileActionDock>
      ) : null}
    </>
  )
}
