/**
 * Resolution verification (/officer/complaints/:id/verify) - page 20 of the requirements.
 *
 * Shows the before / after photos the verification judged (BeforeAfterSlider), the latest result
 * (VerificationResult: score /100, Likely resolved / Partially resolved / Not resolved / Needs manual
 * review, explanation, metrics, "AI-assisted verification - not a guarantee"), the score bands with the live
 * thresholds of the AI configuration, and the full verification history. Actions follow `allowed_actions`:
 * - "Run AI verification" -> POST /complaints/{id}/verify/ (resolved complaints with an after photo)
 * - "Verify manually" / "Override result" -> ManualVerificationModal -> POST .../manual-verification/
 * - "Request manual verification" -> RequestReviewModal -> POST .../request-manual-verification/
 * Before a complaint is resolved the page explains what is missing and links to the resolution update.
 * On phones the primary decision (run the AI verification, or verify manually) also floats in a dock once the
 * header's own button has scrolled out of view.
 */
import {
  CircleCheck,
  ImageOff,
  ImageUp,
  Info,
  ListChecks,
  Ruler,
  ScanEye,
  Send,
  ShieldCheck,
  TriangleAlert,
  UserSearch,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { BeforeAfterSlider } from '@/components/complaints/BeforeAfterSlider'
import { MobileActionDock } from '@/components/complaints/MobileActionDock'
import { VerificationResult } from '@/components/complaints/VerificationResult'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { useApi } from '@/hooks/useApi'
import { useToast } from '@/hooks/useToast'
import { aiService } from '@/services/aiService'
import { complaintService } from '@/services/complaintService'
import { ACTION_LABELS, getVerificationMeta } from '@/utils/constants'
import { getErrorMessage } from '@/utils/errors'
import { formatDateTime } from '@/utils/format'
import { ComplaintHeader } from './components/ComplaintHeader'
import { ComplaintLoadError, ComplaintPageSkeleton } from './components/ComplaintPageState'
import { allowedSet, beforePhotoFor, complaintPath, evidenceForVerification, latestEvent } from './components/officerUtils'
import { ScoreBands } from './components/ScoreBands'
import { ManualVerificationModal, RequestReviewModal } from './components/VerificationModals'
import { VerificationHistory } from './components/VerificationHistory'
import { useOfficerComplaint } from './components/useOfficerComplaint'
import { WorkOrderSummaryCard } from './components/WorkOrderSummaryCard'

function SinglePhoto({ src, label, alt }) {
  return (
    <figure className="min-w-0">
      <div className="relative overflow-hidden rounded-xl bg-sunken" style={{ aspectRatio: '4 / 3' }}>
        {src ? (
          <img src={src} alt={`${label}: ${alt}`} className="absolute inset-0 size-full object-contain" />
        ) : (
          <span className="absolute inset-0 grid place-items-center text-xs font-medium text-ink-3">
            <span className="flex flex-col items-center gap-1.5">
              <ImageOff aria-hidden className="size-6" />
              No {label.toLowerCase()} photo yet
            </span>
          </span>
        )}
        <span className="absolute left-2 top-2 rounded-md bg-asphalt-950/75 px-2 py-0.5 text-xs font-semibold text-white">{label}</span>
      </div>
    </figure>
  )
}

/** One sentence on where the verification stands, with the way forward. */
function StateAlert({ complaint, allowed }) {
  const latest = complaint.latest_verification
  const status = complaint.status
  const resolvePath = complaintPath(complaint.id, 'resolve')

  if (status === 'verified') {
    return (
      <Alert tone="success" icon={ShieldCheck} title="Resolution verified" className="mb-5">
        {complaint.verified_at ? `Verified on ${formatDateTime(complaint.verified_at)}. ` : ''}The citizen has been asked to rate the work.
      </Alert>
    )
  }
  if (status === 'closed') {
    return (
      <Alert tone="neutral" icon={CircleCheck} title="Complaint closed" className="mb-5">
        The resolution was verified and the complaint closed{complaint.closed_at ? ` on ${formatDateTime(complaint.closed_at)}` : ''}.
      </Alert>
    )
  }
  if (status === 'resolved') {
    if (!latest) {
      return (
        <Alert tone="info" icon={Info} title="Not verified yet" className="mb-5">
          {allowed.has('verify')
            ? 'Run the AI verification to compare the before and after photos, or verify the work manually.'
            : 'There is no after photo for this resolution yet. Upload one so the AI can compare it, or verify the work manually.'}
        </Alert>
      )
    }
    if (latest.manual_review_requested) {
      return (
        <Alert tone="info" icon={UserSearch} title="Manual verification requested" className="mb-5">
          An administrator has been asked to review this resolution. You can still verify it manually.
        </Alert>
      )
    }
    if (complaint.needs_manual_review || latest.status !== 'likely_resolved') {
      const meta = getVerificationMeta(latest.status)
      return (
        <Alert tone="warning" icon={TriangleAlert} title="A manual decision is needed" className="mb-5">
          {latest.status === 'needs_manual_review'
            ? 'The photos could not be compared reliably (photo quality, or the after photo shows a different scene). Upload a clearer after photo from the same spot, or decide manually.'
            : `The AI scored the work ${latest.score}/100 (${meta.label.toLowerCase()}). If the work is complete, verify it manually; otherwise finish it, upload a new after photo and run the verification again.`}
        </Alert>
      )
    }
    return null
  }
  if (status === 'accepted' || status === 'in_progress') {
    const sentBack = latest && latest.method === 'manual' && ['not_resolved', 'partially_resolved'].includes(latest.status)
    return (
      <Alert
        tone="info"
        icon={Info}
        title={sentBack ? 'The resolution was sent back for more work' : 'Not resolved yet'}
        className="mb-5"
        action={
          allowed.has('upload_evidence') ? (
            <Button size="sm" variant="outline" leftIcon={ImageUp} to={resolvePath}>
              Go to resolution update
            </Button>
          ) : null
        }
      >
        {sentBack && latest.explanation
          ? `Reviewer's note: ${latest.explanation}`
          : 'Upload an after photo and mark the complaint as resolved. The AI verification then runs automatically.'}
      </Alert>
    )
  }
  if (status === 'assigned' || status === 'reopened') {
    return (
      <Alert tone="info" icon={Info} title="The work has not been done yet" className="mb-5">
        Accept the complaint and complete the work first. The verification compares the photos you upload when resolving it.
      </Alert>
    )
  }
  return null
}

export default function ResolutionVerification() {
  const toast = useToast()
  const { complaint, error, refetch, setData } = useOfficerComplaint()
  const { data: aiConfig } = useApi(() => aiService.getConfig(), [])
  const [running, setRunning] = useState(false)
  const [dialog, setDialog] = useState(null)
  // The header's own copies of the dock's actions: the phone dock only appears once they have scrolled away.
  const verifyActionRef = useRef(null)
  const manualActionRef = useRef(null)

  if (!complaint) {
    return error ? (
      <ComplaintLoadError error={error} onRetry={() => refetch()} title="Resolution verification" />
    ) : (
      <ComplaintPageSkeleton title="Resolution verification" />
    )
  }

  const allowed = allowedSet(complaint)
  const latest = complaint.latest_verification
  const evidence = evidenceForVerification(complaint, latest)
  const before = beforePhotoFor(complaint, evidence)
  const after = evidence?.after_image ?? null
  const resolution = latestEvent(complaint, 'resolved')
  const verifications = Array.isArray(complaint.verifications) ? complaint.verifications : []
  const alt = complaint.title || 'Complaint location'

  const runVerification = async () => {
    setRunning(true)
    try {
      const verification = await complaintService.verify(complaint.id)
      const meta = getVerificationMeta(verification.status)
      toast.success('AI verification complete', `Score ${verification.score}/100: ${meta.label}.`)
      await refetch()
    } catch (err) {
      toast.error('Could not run the AI verification', getErrorMessage(err))
    } finally {
      setRunning(false)
    }
  }

  const resultActions = (
    <>
      {allowed.has('request_manual_review') && !latest?.manual_review_requested ? (
        <Button size="sm" variant="outline" leftIcon={Send} onClick={() => setDialog('review')}>
          Request manual verification
        </Button>
      ) : null}
    </>
  )

  return (
    <>
      <ComplaintHeader
        complaint={complaint}
        page="verify"
        description={complaint.title}
        showMeta={false}
        actions={
          allowed.has('verify') || allowed.has('manual_verify') ? (
            <>
              {allowed.has('manual_verify') ? (
                <Button
                  ref={manualActionRef}
                  variant="outline"
                  leftIcon={UserSearch}
                  onClick={() => setDialog('manual')}
                  disabled={running}
                >
                  {ACTION_LABELS.manual_verify}
                </Button>
              ) : null}
              {allowed.has('verify') ? (
                <Button ref={verifyActionRef} leftIcon={ScanEye} onClick={runVerification} loading={running}>
                  {ACTION_LABELS.verify}
                </Button>
              ) : null}
            </>
          ) : null
        }
      />

      <StateAlert complaint={complaint} allowed={allowed} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,360px)]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader
              title="Before and after"
              icon={ImageUp}
              description={
                latest && evidence
                  ? 'The photos compared by the latest verification.'
                  : 'The before photo next to the latest after photo of the site.'
              }
            />
            <CardBody>
              {before?.url && after ? (
                <BeforeAfterSlider key={`${evidence?.id}-${before.url}`} before={before.url} after={after} alt={alt} />
              ) : before?.url || after ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <SinglePhoto src={before?.url} label="Before" alt={alt} />
                  <SinglePhoto src={after} label="After" alt={alt} />
                </div>
              ) : (
                <EmptyState
                  icon={ImageOff}
                  compact
                  bordered={false}
                  title="No photos to compare yet"
                  description="Upload a before and an after photo of the site from the resolution update."
                />
              )}
              <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3">
                {before?.source === 'citizen' ? <span>Before: the citizen&apos;s original photo</span> : null}
                {before?.source === 'evidence' || before?.source === 'uploaded' ? <span>Before: uploaded by the officer</span> : null}
                {evidence?.uploaded_by ? (
                  <span>
                    After: {evidence.uploaded_by.full_name},{' '}
                    <time dateTime={evidence.uploaded_at} className="tabular">
                      {formatDateTime(evidence.uploaded_at)}
                    </time>
                  </span>
                ) : null}
              </div>
              {!after && allowed.has('upload_evidence') ? (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed border-line-strong bg-surface-2 px-4 py-3">
                  <p className="text-sm text-ink-2">The AI needs an after photo of the repaired site to verify the work.</p>
                  <Button size="sm" leftIcon={ImageUp} to={complaintPath(complaint.id, 'resolve')}>
                    Upload after photo
                  </Button>
                </div>
              ) : null}
              {resolution?.remarks ? (
                <div className="mt-4">
                  <p className="mb-1 text-xs font-semibold text-ink-2">
                    Resolution remarks{resolution.actor_label ? ` from ${resolution.actor_label}` : ''}
                  </p>
                  <p className="whitespace-pre-line rounded-lg border-l-[3px] border-line-strong bg-surface-2 px-3 py-2 text-sm text-ink-2">
                    {resolution.remarks}
                  </p>
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card aria-busy={running || undefined}>
            <CardHeader
              title="AI verification result"
              icon={ScanEye}
              description="Score out of 100, the verdict and the measurements behind it."
            />
            <CardBody>
              {running ? (
                <div role="status" className="mb-4 rounded-lg border border-line bg-surface-2 px-3 py-3">
                  <div aria-hidden className="mb-2 h-1 overflow-hidden rounded-full bg-sunken">
                    <div className="lane-line-x animate-lane h-full w-full" />
                  </div>
                  <p className="text-sm text-ink-2">
                    Aligning the after photo onto the before photo and measuring the change where the issue was detected. This takes a few
                    seconds.
                  </p>
                </div>
              ) : null}
              {latest ? (
                <VerificationResult
                  verification={latest}
                  onOverride={allowed.has('manual_verify') ? () => setDialog('manual') : undefined}
                  actions={resultActions}
                />
              ) : (
                <EmptyState
                  icon={ScanEye}
                  compact
                  bordered={false}
                  title="Not verified yet"
                  description={
                    allowed.has('verify')
                      ? 'Run the AI verification to score how well the after photo shows the issue fixed.'
                      : 'The AI verification runs when the complaint is resolved with an after photo.'
                  }
                  action={
                    allowed.has('verify') || allowed.has('manual_verify') || allowed.has('request_manual_review') ? (
                      <>
                        {allowed.has('request_manual_review') ? (
                          <Button variant="outline" leftIcon={Send} onClick={() => setDialog('review')}>
                            Request manual verification
                          </Button>
                        ) : null}
                        {allowed.has('manual_verify') ? (
                          <Button variant="outline" leftIcon={UserSearch} onClick={() => setDialog('manual')} disabled={running}>
                            {ACTION_LABELS.manual_verify}
                          </Button>
                        ) : null}
                        {allowed.has('verify') ? (
                          <Button leftIcon={ScanEye} onClick={runVerification} loading={running}>
                            {ACTION_LABELS.verify}
                          </Button>
                        ) : null}
                      </>
                    ) : null
                  }
                />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Verification history"
              icon={ListChecks}
              description="Every AI run and manual decision for this complaint, newest first."
            />
            <CardBody>
              <VerificationHistory verifications={verifications} />
            </CardBody>
          </Card>
        </div>

        <aside aria-label="Work order and scoring" className="min-w-0 space-y-5">
          <WorkOrderSummaryCard complaint={complaint} />
          <Card>
            <CardHeader title="How the score reads" icon={Ruler} />
            <CardBody>
              <ScoreBands
                resolvedThreshold={aiConfig?.verification_resolved_threshold}
                partialThreshold={aiConfig?.verification_partial_threshold}
                score={latest?.score}
                status={latest?.status}
              />
            </CardBody>
          </Card>
        </aside>
      </div>

      {allowed.has('manual_verify') ? (
        <ManualVerificationModal
          open={dialog === 'manual'}
          onClose={() => setDialog(null)}
          complaint={complaint}
          onSaved={() => refetch()}
        />
      ) : null}
      {allowed.has('request_manual_review') ? (
        <RequestReviewModal open={dialog === 'review'} onClose={() => setDialog(null)} complaint={complaint} onRequested={setData} />
      ) : null}

      {allowed.has('verify') ? (
        <MobileActionDock
          label="Verification actions"
          eyebrow={complaint.complaint_number}
          title="Let the AI check the fix"
          icon={ScanEye}
          watch={verifyActionRef}
        >
          <Button leftIcon={ScanEye} onClick={runVerification} loading={running}>
            {ACTION_LABELS.verify}
          </Button>
        </MobileActionDock>
      ) : allowed.has('manual_verify') ? (
        <MobileActionDock
          label="Verification actions"
          eyebrow={complaint.complaint_number}
          title="Decide on the fix yourself"
          icon={UserSearch}
          watch={manualActionRef}
        >
          <Button leftIcon={UserSearch} onClick={() => setDialog('manual')}>
            {ACTION_LABELS.manual_verify}
          </Button>
        </MobileActionDock>
      ) : null}
    </>
  )
}
