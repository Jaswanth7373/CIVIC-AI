/**
 * Complaint management (admin) - one complaint as a work order with the administrator's controls.
 *
 * Data: GET /complaints/{id}/ (ComplaintDetail: AI prediction, priority breakdown, assignments, evidence,
 * verifications, feedback, duplicates, timeline and `allowed_actions`) + GET /categories/ (names for the AI
 * panels and the override form).
 *
 * Layout: lifecycle stepper on top; the record (citizen report with the photo and detections, AI analysis,
 * priority breakdown, resolution evidence + verification, feedback, possible duplicates) on the left; the
 * admin control panel (assignment, status and SLA, AI decision, remarks) and the timeline on the right. On
 * phones the controls come right after the stepper, the timeline last.
 *
 * Mutations (each refreshes the record and toasts the result): assign / reassign with the recommendation
 * engine, override the AI, re-run the AI analysis, change the status, close, reopen, review duplicates, manual
 * verification override, AI verification and remarks. Only actions in `allowed_actions` are offered.
 */
import { ArrowLeft, Copy, FileQuestion, Gauge, MessageSquareText, ScanEye, ScanSearch, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AIAnalysisPanel } from '@/components/ai'
import {
  ComplaintTimeline,
  DuplicatePanel,
  EvidencePanel,
  FeedbackCard,
  LifecycleStepper,
  PriorityBadge,
  PriorityBreakdown,
  SLAIndicator,
  StatusBadge,
  VerificationResult,
} from '@/components/complaints'
import { Badge, Button, Card, CardBody, CardHeader, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui'
import { useApi } from '@/hooks/useApi'
import { useConfirm } from '@/hooks/useConfirm'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { useToast } from '@/hooks/useToast'
import { categoryService, complaintService, duplicateService } from '@/services'
import { ACTION_LABELS, STATUS_GROUPS } from '@/utils/constants'
import { getErrorMessage, getErrorStatus } from '@/utils/errors'
import { formatDateTime, timeAgo } from '@/utils/format'
import { AdminControls } from './manage/complaint/AdminControls'
import { ManualVerificationModal } from './manage/complaint/ManualVerificationModal'
import { OverrideAIModal } from './manage/complaint/OverrideAIModal'
import { ReanalyzeModal } from './manage/complaint/ReanalyzeModal'
import { ReassignDrawer } from './manage/complaint/ReassignDrawer'
import { ReportCard } from './manage/complaint/ReportCard'
import { CloseComplaintModal, ReopenComplaintModal, StatusChangeModal } from './manage/complaint/StatusModals'
import { toList } from './manage/shared/listUtils'

const BASE_PATH = '/admin/complaints'

function DetailSkeleton() {
  return (
    <div aria-hidden className="space-y-5">
      <div className="space-y-3">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-5 w-1/2" />
      </div>
      <Skeleton className="h-20 w-full rounded-xl" />
      <div className="grid gap-5 lg:grid-cols-12">
        <div className="space-y-5 lg:col-span-8">
          <Skeleton className="h-96 w-full rounded-xl" />
          <Skeleton className="h-72 w-full rounded-xl" />
        </div>
        <div className="space-y-5 lg:col-span-4">
          <Skeleton className="h-[28rem] w-full rounded-xl" />
        </div>
      </div>
    </div>
  )
}

function ResolutionCard({ complaint, allowed, onVerifyManually, onVerified }) {
  const toast = useToast()
  const [verifying, setVerifying] = useState(false)
  const primaryImage = (complaint.images ?? []).find((image) => image.kind === 'original') ?? complaint.images?.[0]
  const hasEvidence = (complaint.evidence?.length ?? 0) > 0
  const resolvedStage = STATUS_GROUPS.resolved.includes(complaint.status)
  const canVerify = allowed.has('verify')
  const canVerifyManually = allowed.has('manual_verify')

  const runVerification = async () => {
    setVerifying(true)
    try {
      const verification = await complaintService.verify(complaint.id)
      toast.success('AI verification completed', `Score ${Math.round(Number(verification?.score) || 0)}/100: ${verification?.status_display ?? ''}`.trim())
      onVerified?.()
    } catch (error) {
      toast.error('Could not run the AI verification', getErrorMessage(error))
    } finally {
      setVerifying(false)
    }
  }

  const verifyButton = canVerify ? (
    <Button variant="outline" size="sm" leftIcon={ScanEye} loading={verifying} onClick={runVerification}>
      {ACTION_LABELS.verify}
    </Button>
  ) : null

  // Before the work is resolved there is nothing to compare yet: one short note instead of two empty panels.
  if (!hasEvidence && !complaint.latest_verification && !resolvedStage && !canVerify && !canVerifyManually) {
    const officer = complaint.assigned_officer?.full_name
    return (
      <Card>
        <CardHeader icon={ShieldCheck} title="Resolution" />
        <CardBody>
          <p className="text-sm text-ink-2">
            Nothing to verify yet. When {officer ?? 'the assigned officer'} marks the work resolved with an after photo, the before
            and after comparison and the AI-assisted verification appear here, and the citizen is asked to rate the work.
          </p>
        </CardBody>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader icon={ShieldCheck} title="Resolution" description="The officer's before and after photos and the AI-assisted verification." />
      <CardBody className="space-y-6">
        <EvidencePanel evidence={complaint.evidence} fallbackBefore={primaryImage?.url} alt={complaint.title} />
        {complaint.latest_verification ? (
          <div className="border-t border-line pt-5">
            <h3 className="mb-3 text-sm font-bold text-ink">Verification</h3>
            <VerificationResult
              verification={complaint.latest_verification}
              onOverride={canVerifyManually ? onVerifyManually : undefined}
              actions={verifyButton}
            />
          </div>
        ) : canVerifyManually || verifyButton ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-sm text-ink-2">No verification has run for this resolution yet.</p>
            <div className="flex flex-wrap gap-2">
              {verifyButton}
              {canVerifyManually ? (
                <Button variant="outline" size="sm" leftIcon={ShieldCheck} onClick={onVerifyManually}>
                  {ACTION_LABELS.manual_verify}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}

export default function ComplaintManagement() {
  const { id } = useParams()
  const toast = useToast()
  const confirm = useConfirm()
  const complaintQuery = useApi(() => complaintService.get(id), [id])
  const categoriesQuery = useApi(() => categoryService.list({ include_inactive: true }), [])
  const [dialog, setDialog] = useState(null)
  const [sessions, setSessions] = useState({})

  // While another complaint loads (e.g. after following a duplicate link) never show the previous one.
  const complaint = complaintQuery.data && String(complaintQuery.data.id) === String(id) ? complaintQuery.data : null
  const categories = toList(categoriesQuery.data)
  const notFound = getErrorStatus(complaintQuery.error) === 404
  // One title for the tab, given to PageHeader as well: PageHeader always writes a document title (even with
  // documentTitle={false}), so both must agree or React's effect order decides which one wins.
  const pageTitle = complaint
    ? `${complaint.complaint_number}: ${complaint.title || 'Complaint'}`
    : notFound
      ? 'Complaint not found'
      : 'Complaint management'
  useDocumentTitle(pageTitle)

  const openDialog = (name) => {
    setSessions((current) => ({ ...current, [name]: (current[name] ?? 0) + 1 }))
    setDialog(name)
  }
  const closeDialog = () => setDialog(null)
  const refresh = () => complaintQuery.refetch()
  /** Endpoints that answer with the full ComplaintDetail update the page in place. */
  const applyDetail = (detail) => {
    if (detail && detail.id != null && Array.isArray(detail.timeline)) complaintQuery.setData(detail)
    else refresh()
  }

  const reviewDuplicate = async (linkId, status, link) => {
    const confirmed = status === 'confirmed_duplicate'
    const isOriginal = link?.direction === 'original'
    const newer = isOriginal ? complaint.complaint_number : link?.other?.complaint_number
    const original = isOriginal ? link?.other?.complaint_number : complaint.complaint_number
    const ok = await confirm({
      title: confirmed ? 'Confirm duplicate?' : 'Mark as not a duplicate?',
      message: confirmed
        ? `${newer} will be merged into ${original} and closed. Its citizen is notified that the issue is handled as part of ${original}.`
        : `${newer} and ${original} stay separate complaints and are worked on independently.`,
      confirmLabel: confirmed ? 'Confirm duplicate' : 'Not a duplicate',
      tone: confirmed ? 'warning' : 'primary',
    })
    if (!ok) return
    try {
      await duplicateService.review(linkId, { status })
      toast.success(confirmed ? 'Duplicate confirmed' : 'Marked as not a duplicate', `${newer} and ${original} were reviewed.`)
      refresh()
    } catch (error) {
      toast.error('Could not save the review', getErrorMessage(error))
      throw error
    }
  }

  if (!complaint) {
    if (complaintQuery.error && !complaintQuery.loading) {
      return (
        <>
          <PageHeader
            back={{ to: BASE_PATH, label: 'All complaints' }}
            title={notFound ? 'Complaint not found' : 'Complaint management'}
            documentTitle={pageTitle}
          />
          {notFound ? (
            <EmptyState
              icon={FileQuestion}
              title="This complaint does not exist"
              description="It may have been deleted, or the link has a typo. Find it in the complaint list instead."
              action={
                <Button to={BASE_PATH} leftIcon={ArrowLeft}>
                  Back to all complaints
                </Button>
              }
            />
          ) : (
            <ErrorState title="The complaint could not be loaded" error={complaintQuery.error} onRetry={refresh} />
          )}
        </>
      )
    }
    return <DetailSkeleton />
  }

  const allowed = new Set(complaint.allowed_actions ?? [])
  const prediction = complaint.ai_prediction

  return (
    <>
      <PageHeader
        back={{ to: BASE_PATH, label: 'All complaints' }}
        title={complaint.title || complaint.complaint_number}
        documentTitle={pageTitle}
      >
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-ink-2 tabular">{complaint.complaint_number}</span>
          <StatusBadge status={complaint.status} label={complaint.status_display} />
          <PriorityBadge level={complaint.priority_level} score={complaint.priority_score} withLabel />
          <SLAIndicator
            dueAt={complaint.sla_due_at}
            status={complaint.status}
            resolvedAt={complaint.resolved_at}
            isOverdue={complaint.is_overdue}
            createdAt={complaint.created_at}
          />
          {complaint.duplicate_of ? (
            <Link to={`${BASE_PATH}/${complaint.duplicate_of.id}`} className="rounded-md hover:opacity-90">
              <Badge tone="orange" icon={Copy}>
                Merged into {complaint.duplicate_of.complaint_number}
              </Badge>
            </Link>
          ) : null}
        </div>
        <p className="mt-2 text-sm text-ink-3">
          Reported{' '}
          <time dateTime={complaint.created_at} title={formatDateTime(complaint.created_at)}>
            {timeAgo(complaint.created_at)}
          </time>{' '}
          by {complaint.citizen?.full_name ?? 'a citizen'}
          {complaint.location?.area ? ` in ${complaint.location.area}` : ''}. Last updated{' '}
          <time dateTime={complaint.updated_at} title={formatDateTime(complaint.updated_at)}>
            {timeAgo(complaint.updated_at)}
          </time>
          .
        </p>
      </PageHeader>

      {complaintQuery.error ? (
        <ErrorState compact className="mb-5" title="The latest changes could not be loaded" error={complaintQuery.error} onRetry={refresh} />
      ) : null}

      <Card className="mb-5">
        <CardBody>
          <LifecycleStepper status={complaint.status} events={complaint.timeline} />
        </CardBody>
      </Card>

      <div className="grid items-start gap-5 lg:grid-cols-12 lg:grid-rows-[auto_1fr]">
        <aside aria-label="Administrator controls" className="min-w-0 lg:col-span-4 lg:col-start-9 lg:row-start-1">
          <AdminControls complaint={complaint} onOpen={openDialog} onRemarkAdded={refresh} />
        </aside>

        <div className="min-w-0 space-y-5 lg:col-span-8 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <ReportCard complaint={complaint} categories={categories} />

          <Card>
            <CardHeader
              icon={ScanSearch}
              title="AI analysis"
              description="How the multimodal engine classified the issue and scored its severity."
              actions={
                complaint.is_ai_overridden ? (
                  <Badge tone="violet" size="sm" icon={SlidersHorizontal}>
                    Corrected by an administrator
                  </Badge>
                ) : null
              }
            />
            <CardBody>
              <AIAnalysisPanel prediction={prediction} categories={categories} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader icon={Gauge} title="Priority" description="Each of the five factors and how many points it added to the score." />
            <CardBody>
              <PriorityBreakdown priority={complaint.priority} />
            </CardBody>
          </Card>

          <ResolutionCard
            complaint={complaint}
            allowed={allowed}
            onVerifyManually={() => openDialog('verify')}
            onVerified={refresh}
          />

          {complaint.feedback?.length || STATUS_GROUPS.resolved.includes(complaint.status) ? (
            <Card>
              <CardHeader icon={MessageSquareText} title="Citizen feedback" />
              <CardBody>
                {complaint.feedback?.length ? (
                  <div className="space-y-3">
                    {complaint.feedback.map((item) => (
                      <FeedbackCard key={item.id} feedback={item} showComplaint={false} />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-ink-2">
                    No feedback yet. {complaint.citizen?.full_name ?? 'The citizen'} is asked to rate the work once the resolution is
                    verified; the rating and the analysed sentiment appear here.
                  </p>
                )}
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              icon={Copy}
              title="Possible duplicates"
              description="Reports the AI linked to this one by description, photo and distance."
            />
            <CardBody>
              {complaint.duplicates?.length ? (
                <DuplicatePanel
                  duplicates={complaint.duplicates}
                  canReview={allowed.has('review_duplicates')}
                  onReview={reviewDuplicate}
                  basePath={BASE_PATH}
                />
              ) : (
                <p className="text-sm text-ink-2">
                  No possible duplicates. The AI compared this report with nearby complaints of the last weeks and found no close
                  match.
                </p>
              )}
            </CardBody>
          </Card>
        </div>

        <section aria-label="Timeline" className="min-w-0 lg:col-span-4 lg:col-start-9 lg:row-start-2">
          <Card>
            <CardHeader title="Timeline" description="Every step, including internal notes the citizen does not see." />
            <CardBody>
              <ComplaintTimeline events={complaint.timeline} status={complaint.status} />
            </CardBody>
          </Card>
        </section>
      </div>

      <ReassignDrawer
        key={`reassign-${sessions.reassign ?? 0}`}
        open={dialog === 'reassign'}
        onClose={closeDialog}
        complaint={complaint}
        onAssigned={() => {
          closeDialog()
          refresh()
        }}
      />
      <OverrideAIModal
        key={`override-${sessions.override ?? 0}`}
        open={dialog === 'override'}
        onClose={closeDialog}
        complaint={complaint}
        categories={categories}
        onDone={(detail) => {
          closeDialog()
          applyDetail(detail)
        }}
      />
      <ReanalyzeModal
        key={`reanalyze-${sessions.reanalyze ?? 0}`}
        open={dialog === 'reanalyze'}
        onClose={closeDialog}
        complaint={complaint}
        onDone={applyDetail}
      />
      <StatusChangeModal
        key={`status-${sessions.status ?? 0}`}
        open={dialog === 'status'}
        onClose={closeDialog}
        complaint={complaint}
        onDone={(detail) => {
          closeDialog()
          applyDetail(detail)
        }}
      />
      <CloseComplaintModal
        key={`close-${sessions.close ?? 0}`}
        open={dialog === 'close'}
        onClose={closeDialog}
        complaint={complaint}
        onDone={(detail) => {
          closeDialog()
          applyDetail(detail)
        }}
      />
      <ReopenComplaintModal
        key={`reopen-${sessions.reopen ?? 0}`}
        open={dialog === 'reopen'}
        onClose={closeDialog}
        complaint={complaint}
        onDone={(detail) => {
          closeDialog()
          applyDetail(detail)
        }}
      />
      <ManualVerificationModal
        key={`verify-${sessions.verify ?? 0}`}
        open={dialog === 'verify'}
        onClose={closeDialog}
        complaint={complaint}
        onDone={() => {
          closeDialog()
          refresh()
        }}
      />
    </>
  )
}
