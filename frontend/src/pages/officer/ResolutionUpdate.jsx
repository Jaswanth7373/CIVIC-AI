/**
 * Resolution update (/officer/complaints/:id/resolve) - page 19 of the requirements.
 *
 * The officer records the repair: a before photo (the citizen's photo stands in when none is uploaded), an
 * after photo (camera capture on phones) and the resolution remarks.
 * - "Save evidence" -> POST /complaints/{id}/evidence/ (multipart before_image / after_image), e.g. the
 *   before photo at the start of the work and the after photo later.
 * - "Mark as resolved" -> uploads a newly chosen before photo as evidence first, then POST
 *   /complaints/{id}/resolve/ (multipart remarks + after_image). With an after photo the backend runs the
 *   AI-assisted verification immediately and may verify the complaint; the outcome is shown right here.
 * Accepted complaints offer "Start work"; assigned ones must be accepted first. Everything the page offers
 * follows `allowed_actions`.
 *
 * Once a new after photo is chosen, the form previews the comparison the AI will make - the before photo
 * (the officer's, else the citizen's) against the new after photo - with the before / after wipe.
 *
 * Phones: the form's action row (Save evidence / Mark as resolved) sticks to the bottom of the screen while
 * the form is taller than the screen, so resolving never needs a scroll back down.
 */
import { CircleCheck, ClipboardCheck, Construction, ImageUp, Info, ScanEye, ShieldCheck } from 'lucide-react'
import { useRef, useState } from 'react'
import { BeforeAfterSlider } from '@/components/complaints/BeforeAfterSlider'
import { EvidencePanel } from '@/components/complaints/EvidencePanel'
import { VerificationResult } from '@/components/complaints/VerificationResult'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { FileDropzone } from '@/components/ui/FileDropzone'
import { FormField } from '@/components/ui/FormField'
import { Textarea } from '@/components/ui/Textarea'
import { useAuth } from '@/hooks/useAuth'
import { useConfig } from '@/hooks/useConfig'
import { useConfirm } from '@/hooks/useConfirm'
import { useToast } from '@/hooks/useToast'
import '@/styles/app.css'
import { complaintService } from '@/services/complaintService'
import { ACTION_LABELS, getVerificationMeta } from '@/utils/constants'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { formatDateTime } from '@/utils/format'
import { ComplaintHeader } from './components/ComplaintHeader'
import { ComplaintLoadError, ComplaintPageSkeleton } from './components/ComplaintPageState'
import {
  REMARKS_MAX,
  allowedSet,
  citizenPhoto,
  complaintPath,
  currentAfterEvidence,
  cycleEvidence,
  isAssignedTo,
  latestEvent,
} from './components/officerUtils'
import { PhotoTipsCard } from './components/PhotoTipsCard'
import { useObjectUrl } from './components/useObjectUrl'
import { useOfficerComplaint } from './components/useOfficerComplaint'
import { WorkOrderSummaryCard } from './components/WorkOrderSummaryCard'

const ACCEPT = 'image/jpeg,image/png,image/webp'

/** Summary of a recorded resolution: when, the remarks, and the latest verification. */
function ResolutionSummary({ complaint }) {
  const allowed = allowedSet(complaint)
  const resolution = latestEvent(complaint, 'resolved')
  const verifyLabel = allowed.has('verify')
    ? ACTION_LABELS.verify
    : allowed.has('manual_verify')
      ? ACTION_LABELS.manual_verify
      : 'Open verification'
  return (
    <Card>
      <CardHeader
        title="Resolution recorded"
        icon={CircleCheck}
        description={
          complaint.resolved_at
            ? `Marked as resolved on ${formatDateTime(complaint.resolved_at)}${resolution?.actor_label ? ` by ${resolution.actor_label}` : ''}.`
            : 'The work on this complaint is complete.'
        }
      />
      <CardBody className="space-y-4">
        {resolution?.remarks ? (
          <div>
            <p className="mb-1 text-xs font-semibold text-ink-2">Resolution remarks</p>
            <p className="whitespace-pre-line rounded-lg border-l-[3px] border-line-strong bg-surface-2 px-3 py-2 text-sm text-ink-2">
              {resolution.remarks}
            </p>
          </div>
        ) : null}
        <VerificationResult
          verification={complaint.latest_verification}
          compact
          actions={
            <Button
              size="sm"
              variant={allowed.has('verify') || allowed.has('manual_verify') ? 'primary' : 'outline'}
              leftIcon={ScanEye}
              to={complaintPath(complaint.id, 'verify')}
            >
              {verifyLabel}
            </Button>
          }
        />
        {!complaint.latest_verification ? (
          <Button variant="outline" leftIcon={ScanEye} to={complaintPath(complaint.id, 'verify')}>
            {verifyLabel}
          </Button>
        ) : null}
      </CardBody>
    </Card>
  )
}

export default function ResolutionUpdate() {
  const { user } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const { maxImageMB } = useConfig()
  const { complaint, error, refetch, setData } = useOfficerComplaint()
  const [beforeFile, setBeforeFile] = useState(null)
  const [afterFile, setAfterFile] = useState(null)
  const [remarks, setRemarks] = useState('')
  const [errors, setErrors] = useState({})
  const [busy, setBusy] = useState(null)
  const [outcome, setOutcome] = useState(null)
  const remarksRef = useRef(null)
  const beforeFileUrl = useObjectUrl(beforeFile)
  const afterFileUrl = useObjectUrl(afterFile)

  if (!complaint) {
    return error ? (
      <ComplaintLoadError error={error} onRetry={() => refetch()} title="Resolution update" />
    ) : (
      <ComplaintPageSkeleton title="Resolution update" />
    )
  }

  const allowed = allowedSet(complaint)
  const canUpload = allowed.has('upload_evidence')
  const canResolve = allowed.has('resolve')
  const mine = isAssignedTo(complaint, user?.id)
  const cycle = cycleEvidence(complaint)
  const savedAfter = currentAfterEvidence(complaint)
  const savedBefore = cycle.find((item) => item.before_image)?.before_image ?? null
  const originalPhoto = citizenPhoto(complaint)
  const resolvedGroup = ['resolved', 'verified', 'closed'].includes(complaint.status)
  const hasEvidence = Array.isArray(complaint.evidence) && complaint.evidence.length > 0
  // The comparison the AI will make, shown as soon as a new after photo is chosen.
  const comparisonBefore = beforeFileUrl ?? savedBefore ?? originalPhoto

  const lifecycle = async (key, call, success, failure) => {
    setBusy(key)
    try {
      const detail = await call()
      setData(detail)
      toast.success(success.title, success.description)
    } catch (err) {
      toast.error(failure, getErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const acceptComplaint = () =>
    lifecycle(
      'accept',
      () => complaintService.accept(complaint.id, {}),
      { title: 'Complaint accepted', description: 'You can now upload evidence and resolve it.' },
      'Could not accept complaint',
    )

  const startWork = () =>
    lifecycle(
      'start',
      () => complaintService.start(complaint.id, {}),
      { title: 'Work started', description: 'The citizen can see that work is under way.' },
      'Could not start work',
    )

  const clearFiles = () => {
    setBeforeFile(null)
    setAfterFile(null)
  }

  const saveEvidence = async () => {
    if (!beforeFile && !afterFile) {
      setErrors({ photos: 'Choose a before or an after photo to save.' })
      return
    }
    setErrors({})
    setBusy('evidence')
    try {
      await complaintService.uploadEvidence(complaint.id, {
        before_image: beforeFile ?? undefined,
        after_image: afterFile ?? undefined,
      })
      const saved = beforeFile && afterFile ? 'before and after photos are' : beforeFile ? 'before photo is' : 'after photo is'
      toast.success('Evidence saved', `The ${saved} stored with ${complaint.complaint_number}.`)
      clearFiles()
      await refetch()
    } catch (err) {
      setErrors(getFieldErrors(err))
      toast.error('Could not save evidence', getErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const resolve = async () => {
    const text = remarks.trim()
    if (!text) {
      setErrors({ remarks: 'Describe the work done. Remarks are required to mark a complaint as resolved.' })
      remarksRef.current?.focus()
      return
    }
    setErrors({})
    const withAfterPhoto = Boolean(afterFile || savedAfter)
    const ok = await confirm(
      withAfterPhoto
        ? {
            title: `Mark ${complaint.complaint_number} as resolved?`,
            message: 'The citizen is notified, and the AI compares the before and after photos to verify the work right away.',
            confirmLabel: ACTION_LABELS.resolve,
            tone: 'primary',
          }
        : {
            title: 'Resolve without an after photo?',
            message:
              'The AI can only verify the work with an after photo. Without one, the resolution waits for a manual check. Add an after photo if you can.',
            confirmLabel: 'Resolve without photo',
            tone: 'warning',
          },
    )
    if (!ok) return

    const previousVerificationId = complaint.latest_verification?.id ?? null
    setBusy('resolve')
    try {
      if (beforeFile) await complaintService.uploadEvidence(complaint.id, { before_image: beforeFile })
      const detail = await complaintService.resolve(complaint.id, { remarks: text, after_image: afterFile ?? undefined })
      const verification =
        detail.latest_verification && detail.latest_verification.id !== previousVerificationId ? detail.latest_verification : null
      setData(detail)
      setOutcome({ status: detail.status, verification, withAfterPhoto })
      clearFiles()
      setRemarks('')
      if (verification) {
        const meta = getVerificationMeta(verification.status)
        toast.success('Complaint resolved', `AI verification: ${meta.label}, ${verification.score}/100.`)
      } else {
        toast.success('Complaint resolved', 'No AI verification ran yet. Open the verification page to run it or to verify manually.')
      }
    } catch (err) {
      setErrors(getFieldErrors(err))
      toast.error('Could not mark the complaint as resolved', getErrorMessage(err))
      refetch()
    } finally {
      setBusy(null)
    }
  }

  const statusPanel = (() => {
    if (!mine && !resolvedGroup) {
      return (
        <EmptyState
          icon={Info}
          title="Only the assigned officer can record the resolution"
          description={
            complaint.assigned_officer
              ? `${complaint.assigned_officer.full_name} is handling this complaint. You can follow it and add remarks from the work order.`
              : 'No officer is assigned to this complaint yet.'
          }
          action={
            <Button variant="outline" to={complaintPath(complaint.id)}>
              Open work order
            </Button>
          }
        />
      )
    }
    if (complaint.status === 'rejected') {
      return (
        <EmptyState
          icon={Info}
          title="This complaint was rejected"
          description="A rejected complaint cannot be resolved. The rejection reason is on the work order."
          action={
            <Button variant="outline" to={complaintPath(complaint.id)}>
              Open work order
            </Button>
          }
        />
      )
    }
    if (['assigned', 'reopened'].includes(complaint.status)) {
      return (
        <EmptyState
          icon={ClipboardCheck}
          title={complaint.status === 'reopened' ? 'Accept the reopened complaint first' : 'Accept the complaint first'}
          description="Evidence can be uploaded once you have accepted the work order. Accepting tells the citizen the work is planned."
          action={
            allowed.has('accept') ? (
              <Button leftIcon={ClipboardCheck} onClick={acceptComplaint} loading={busy === 'accept'}>
                {ACTION_LABELS.accept}
              </Button>
            ) : (
              <Button variant="outline" to={complaintPath(complaint.id)}>
                Open work order
              </Button>
            )
          }
        />
      )
    }
    return null
  })()

  const showForm = canUpload && !statusPanel
  const formDescription = canResolve
    ? 'Upload the before and after photos, describe the work, then mark the complaint as resolved.'
    : 'Upload a clearer or newer photo, then run the AI verification again from the verification page.'

  return (
    <>
      <ComplaintHeader complaint={complaint} page="resolve" description={complaint.title} showMeta={false} />

      {outcome ? (
        <Alert
          tone={outcome.verification && outcome.verification.status !== 'likely_resolved' ? 'warning' : 'success'}
          title={outcome.status === 'verified' ? 'Resolved and verified' : 'Resolution recorded'}
          className="mb-5"
          onDismiss={() => setOutcome(null)}
        >
          {outcome.verification
            ? `The AI-assisted verification scored the work ${outcome.verification.score}/100: ${getVerificationMeta(outcome.verification.status).label.toLowerCase()}.${
                outcome.status === 'verified'
                  ? ' The complaint is verified and the citizen has been asked for feedback.'
                  : ' A manual decision is needed - see the verification page.'
              }`
            : outcome.withAfterPhoto
              ? 'The AI verification did not run automatically. Open the verification page to run it, or verify the work manually.'
              : 'No after photo was available, so no AI verification ran. Upload an after photo and run it, or verify the work manually.'}
        </Alert>
      ) : null}

      {complaint.status === 'accepted' && allowed.has('start_work') ? (
        <Alert
          tone="info"
          icon={Construction}
          title="Work has not started yet"
          className="mb-5"
          action={
            <Button
              size="sm"
              leftIcon={Construction}
              onClick={startWork}
              loading={busy === 'start'}
              disabled={busy !== null && busy !== 'start'}
            >
              {ACTION_LABELS.start_work}
            </Button>
          }
        >
          Start work when the crew is on site, so the citizen sees that the repair is under way. You can also resolve directly.
        </Alert>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(320px,360px)]">
        <div className="min-w-0 space-y-5">
          {statusPanel}

          {resolvedGroup ? <ResolutionSummary complaint={complaint} /> : null}

          {showForm ? (
            <Card>
              <CardHeader
                title={canResolve ? 'Evidence and remarks' : 'Upload new evidence'}
                icon={ImageUp}
                description={formDescription}
              />
              <CardBody className="space-y-5">
                <div className="grid gap-5 md:grid-cols-2">
                  <FileDropzone
                    label="Before photo"
                    value={beforeFile}
                    onChange={(file) => {
                      setBeforeFile(file)
                      setErrors((current) => ({ ...current, before_image: undefined, photos: undefined }))
                    }}
                    previewUrl={savedBefore ?? originalPhoto ?? undefined}
                    accept={ACCEPT}
                    maxSizeMB={maxImageMB}
                    capture="environment"
                    error={errors.before_image}
                    disabled={busy !== null}
                    hint={
                      beforeFile
                        ? 'New before photo, saved with the evidence.'
                        : savedBefore
                          ? 'Your uploaded before photo. Replace it if the site looked different.'
                          : originalPhoto
                            ? "The citizen's photo is used as the before photo unless you upload your own."
                            : 'No before photo yet. Take one before the work starts.'
                    }
                  />
                  <FileDropzone
                    label="After photo"
                    value={afterFile}
                    onChange={(file) => {
                      setAfterFile(file)
                      setErrors((current) => ({ ...current, after_image: undefined, photos: undefined }))
                    }}
                    previewUrl={savedAfter?.after_image ?? undefined}
                    accept={ACCEPT}
                    maxSizeMB={maxImageMB}
                    capture="environment"
                    error={errors.after_image}
                    disabled={busy !== null}
                    hint={
                      afterFile
                        ? 'New after photo. The AI compares it with the before photo.'
                        : savedAfter
                          ? `After photo saved ${formatDateTime(savedAfter.uploaded_at)}. Replace it if needed.`
                          : 'Take it from the same spot and angle as the before photo.'
                    }
                  />
                </div>

                {afterFileUrl && comparisonBefore ? (
                  <section aria-labelledby="comparison-preview-heading" className="rounded-xl border border-line bg-surface-2 p-3 sm:p-4">
                    <h3 id="comparison-preview-heading" className="mb-2.5 flex items-center gap-1.5 text-sm font-semibold text-ink">
                      <ScanEye aria-hidden className="size-4 text-ink-3" />
                      What the AI will compare
                    </h3>
                    <BeforeAfterSlider
                      key={afterFileUrl}
                      before={comparisonBefore}
                      after={afterFileUrl}
                      alt={complaint.title || 'Complaint location'}
                      aspect="16 / 9"
                    />
                  </section>
                ) : null}

                {canResolve ? (
                  <FormField
                    label="Resolution remarks"
                    htmlFor="resolution-remarks"
                    required
                    error={errors.remarks}
                    hint="What was done, materials used, anything the citizen should know. The citizen sees these remarks."
                  >
                    <Textarea
                      ref={remarksRef}
                      value={remarks}
                      onChange={(event) => {
                        setRemarks(event.target.value)
                        if (errors.remarks) setErrors((current) => ({ ...current, remarks: undefined }))
                      }}
                      maxLength={REMARKS_MAX}
                      rows={4}
                      disabled={busy !== null}
                      placeholder="What was repaired and how, the materials used, and when the site was safe again."
                    />
                  </FormField>
                ) : null}

                {errors.photos || errors.non_field_errors ? <Alert tone="danger">{errors.photos || errors.non_field_errors}</Alert> : null}

                {busy === 'resolve' ? (
                  <div role="status" className="rounded-lg border border-line bg-surface-2 px-3 py-2.5">
                    <div aria-hidden className="mb-2 h-1 overflow-hidden rounded-full bg-sunken">
                      <div className="lane-line-x animate-lane h-full w-full" />
                    </div>
                    <p className="text-sm text-ink-2">
                      {afterFile || savedAfter
                        ? 'Saving the resolution and running the AI verification on the photos. This takes a few seconds.'
                        : 'Saving the resolution.'}
                    </p>
                  </div>
                ) : null}

                <div className="app-sticky-actions flex items-center gap-2 border-t border-line pt-4 sm:justify-end">
                  <Button
                    variant="outline"
                    leftIcon={ImageUp}
                    onClick={saveEvidence}
                    loading={busy === 'evidence'}
                    disabled={busy !== null && busy !== 'evidence'}
                    className={canResolve ? 'px-3 sm:px-4' : 'flex-1 sm:flex-none'}
                  >
                    {/* phones: the icon alone next to the primary action (the name stays for screen readers) */}
                    <span className={canResolve ? 'sr-only sm:not-sr-only' : undefined}>Save evidence</span>
                  </Button>
                  {canResolve ? (
                    <Button
                      leftIcon={CircleCheck}
                      onClick={resolve}
                      loading={busy === 'resolve'}
                      disabled={busy !== null && busy !== 'resolve'}
                      className="flex-1 sm:flex-none"
                    >
                      {ACTION_LABELS.resolve}
                    </Button>
                  ) : null}
                </div>
              </CardBody>
            </Card>
          ) : null}

          {!showForm && resolvedGroup && hasEvidence ? (
            <Card>
              <CardHeader title="Evidence" icon={ShieldCheck} description="Photos recorded for this resolution." />
              <CardBody>
                <EvidencePanel evidence={complaint.evidence} fallbackBefore={originalPhoto} alt={complaint.title || 'Complaint location'} />
              </CardBody>
            </Card>
          ) : null}
        </div>

        <aside aria-label="Work order" className="min-w-0 space-y-5">
          <WorkOrderSummaryCard complaint={complaint} />
          {showForm && hasEvidence ? (
            <Card>
              <CardHeader title="Saved evidence" icon={ShieldCheck} />
              <CardBody>
                <EvidencePanel evidence={complaint.evidence} fallbackBefore={originalPhoto} alt={complaint.title || 'Complaint location'} />
              </CardBody>
            </Card>
          ) : null}
          {showForm ? <PhotoTipsCard maxImageMB={maxImageMB} /> : null}
        </aside>
      </div>
    </>
  )
}
