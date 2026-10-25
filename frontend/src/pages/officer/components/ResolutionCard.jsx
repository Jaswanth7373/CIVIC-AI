/**
 * ResolutionCard - resolution evidence and the latest verification of a complaint, with the way to the
 * resolution update and verification pages.
 *
 * Props: { complaint: ComplaintDetail, className }
 *
 * Before / after photos come from EvidencePanel (the citizen's photo stands in as "before" when the officer
 * uploaded only an after photo). The verification is shown compact - score, verdict and the four deciding
 * metrics - because the full metrics, history and manual override live on the verification page.
 */
import { ImageUp, ScanEye, ShieldCheck } from 'lucide-react'
import { EvidencePanel } from '@/components/complaints/EvidencePanel'
import { VerificationResult } from '@/components/complaints/VerificationResult'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ACTION_LABELS, STATUS_GROUPS } from '@/utils/constants'
import { allowedSet, citizenPhoto, complaintPath } from './officerUtils'

export function ResolutionCard({ complaint, className }) {
  const allowed = allowedSet(complaint)
  const verification = complaint.latest_verification
  const resolvePath = complaintPath(complaint.id, 'resolve')
  const verifyPath = complaintPath(complaint.id, 'verify')
  const canUpload = allowed.has('upload_evidence')
  const showVerification = Boolean(verification) || STATUS_GROUPS.resolved.includes(complaint.status)

  const headerAction = canUpload ? (
    <Button size="sm" variant="ghost" leftIcon={ImageUp} to={resolvePath}>
      {allowed.has('resolve') ? 'Update resolution' : ACTION_LABELS.upload_evidence}
    </Button>
  ) : null

  return (
    <Card className={className}>
      <CardHeader
        title="Resolution evidence"
        icon={ImageUp}
        description="Before and after photos of the site. The AI compares them to verify the work."
        actions={headerAction}
      />
      <CardBody>
        <EvidencePanel
          evidence={complaint.evidence}
          fallbackBefore={citizenPhoto(complaint)}
          alt={complaint.title || 'Complaint location'}
          action={
            canUpload ? (
              <Button size="sm" leftIcon={ImageUp} to={resolvePath}>
                Upload after photo
              </Button>
            ) : null
          }
        />
      </CardBody>
      {showVerification ? (
        <div className="border-t border-line px-4 py-4 sm:px-5">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
            <ShieldCheck aria-hidden className="size-4 text-ink-3" />
            Latest verification
          </h3>
          <VerificationResult
            verification={verification}
            compact
            actions={
              <Button
                size="sm"
                variant={allowed.has('verify') || allowed.has('manual_verify') ? 'primary' : 'outline'}
                leftIcon={ScanEye}
                to={verifyPath}
              >
                {allowed.has('verify')
                  ? ACTION_LABELS.verify
                  : allowed.has('manual_verify')
                    ? ACTION_LABELS.manual_verify
                    : 'Open verification'}
              </Button>
            }
          />
        </div>
      ) : null}
    </Card>
  )
}

export default ResolutionCard
