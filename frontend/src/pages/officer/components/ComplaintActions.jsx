/**
 * ComplaintActions - the officer's buttons for one complaint, driven entirely by `allowed_actions`.
 *
 * Props:
 * - complaint: ComplaintDetail
 * - onUpdated(detail): a lifecycle action answered with the updated ComplaintDetail (accept / start / reject)
 * - onRemarkAdded(timelineEvent): a remark was added
 * - only: 'primary' renders the primary action alone (the phone action dock), without the dialogs
 * - className
 *
 * Exactly one button is primary - the next step of the lifecycle, in this precedence: accept, start work,
 * mark as resolved, run AI verification, verify manually. Accept and start work run in place (they are
 * reversible and quick on site); reject and add remark open dialogs; resolving and verifying open their own
 * pages, where the evidence is handled. Labels come from ACTION_LABELS so every screen names an action the
 * same way.
 */
import { Ban, CircleCheck, ClipboardCheck, Construction, ImageUp, MessageSquarePlus, ScanEye, ShieldCheck, UserSearch } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/hooks/useToast'
import { complaintService } from '@/services/complaintService'
import { cn } from '@/utils/cn'
import { ACTION_LABELS, STATUS_GROUPS } from '@/utils/constants'
import { getErrorMessage } from '@/utils/errors'
import { AddRemarkModal, RejectComplaintModal } from './ActionModals'
import { allowedSet, complaintPath, primaryActionKey } from './officerUtils'

/** Button key of each primary action (the lifecycle order lives in officerUtils.primaryActionKey). */
const BUTTON_KEYS = { accept: 'accept', start_work: 'start', resolve: 'resolve', verify: 'verify', manual_verify: 'manual' }

export function ComplaintActions({ complaint, onUpdated, onRemarkAdded, only, className }) {
  const toast = useToast()
  const [pending, setPending] = useState(null)
  const [dialog, setDialog] = useState(null)
  const allowed = allowedSet(complaint)
  const primaryKey = primaryActionKey(complaint)
  const variantFor = (key) => (key === primaryKey ? 'primary' : 'outline')
  const busy = pending !== null

  const run = async (key, call, success, failure) => {
    setPending(key)
    try {
      const detail = await call()
      toast.success(success.title, success.description)
      onUpdated?.(detail)
    } catch (err) {
      toast.error(failure, getErrorMessage(err))
    } finally {
      setPending(null)
    }
  }

  const accept = () =>
    run(
      'accept',
      () => complaintService.accept(complaint.id, {}),
      {
        title: 'Complaint accepted',
        description: `${complaint.complaint_number} is in your accepted work. Start work when the crew is on site.`,
      },
      'Could not accept complaint',
    )

  const startWork = () =>
    run(
      'start_work',
      () => complaintService.start(complaint.id, {}),
      { title: 'Work started', description: 'The citizen can see that work is under way.' },
      'Could not start work',
    )

  const hasVerifications = Array.isArray(complaint.verifications) && complaint.verifications.length > 0
  const showVerificationLink =
    !allowed.has('verify') && !allowed.has('manual_verify') && (hasVerifications || STATUS_GROUPS.resolved.includes(complaint.status))

  const buttons = []
  if (allowed.has('reject')) {
    buttons.push(
      <Button
        key="reject"
        variant="outline"
        leftIcon={Ban}
        onClick={() => setDialog('reject')}
        disabled={busy}
        className="text-signal-600 hover:text-signal-700 dark:text-signal-300 dark:hover:text-signal-200"
      >
        {ACTION_LABELS.reject}
      </Button>,
    )
  }
  if (allowed.has('add_remark')) {
    buttons.push(
      <Button key="remark" variant="outline" leftIcon={MessageSquarePlus} onClick={() => setDialog('remark')} disabled={busy}>
        {ACTION_LABELS.add_remark}
      </Button>,
    )
  }
  if (allowed.has('upload_evidence') && !allowed.has('resolve')) {
    buttons.push(
      <Button key="evidence" variant="outline" leftIcon={ImageUp} to={complaintPath(complaint.id, 'resolve')}>
        {ACTION_LABELS.upload_evidence}
      </Button>,
    )
  }
  if (allowed.has('resolve')) {
    buttons.push(
      <Button key="resolve" variant={variantFor('resolve')} leftIcon={CircleCheck} to={complaintPath(complaint.id, 'resolve')}>
        {ACTION_LABELS.resolve}
      </Button>,
    )
  }
  if (allowed.has('verify')) {
    buttons.push(
      <Button key="verify" variant={variantFor('verify')} leftIcon={ScanEye} to={complaintPath(complaint.id, 'verify')}>
        {ACTION_LABELS.verify}
      </Button>,
    )
  } else if (allowed.has('manual_verify')) {
    buttons.push(
      <Button key="manual" variant={variantFor('manual_verify')} leftIcon={UserSearch} to={complaintPath(complaint.id, 'verify')}>
        {ACTION_LABELS.manual_verify}
      </Button>,
    )
  } else if (showVerificationLink) {
    buttons.push(
      <Button key="verification" variant="outline" leftIcon={ShieldCheck} to={complaintPath(complaint.id, 'verify')}>
        View verification
      </Button>,
    )
  }
  if (allowed.has('start_work')) {
    buttons.push(
      <Button
        key="start"
        variant={variantFor('start_work')}
        leftIcon={Construction}
        onClick={startWork}
        loading={pending === 'start_work'}
        disabled={busy && pending !== 'start_work'}
      >
        {ACTION_LABELS.start_work}
      </Button>,
    )
  }
  if (allowed.has('accept')) {
    buttons.push(
      <Button
        key="accept"
        variant={variantFor('accept')}
        leftIcon={ClipboardCheck}
        onClick={accept}
        loading={pending === 'accept'}
        disabled={busy && pending !== 'accept'}
      >
        {ACTION_LABELS.accept}
      </Button>,
    )
  }

  if (!buttons.length) return null

  if (only === 'primary') {
    return buttons.find((button) => button.key === BUTTON_KEYS[primaryKey]) ?? null
  }

  return (
    <>
      <div className={cn('flex flex-wrap items-center gap-2 [&>*]:flex-1 sm:[&>*]:flex-none', className)}>
        {buttons.map((button) =>
          button.props.variant === 'primary' ? (
            <span key={button.key} className="order-first basis-full sm:order-none sm:basis-auto [&>*]:w-full sm:[&>*]:w-auto">
              {button}
            </span>
          ) : (
            button
          ),
        )}
      </div>
      {allowed.has('reject') ? (
        <RejectComplaintModal open={dialog === 'reject'} onClose={() => setDialog(null)} complaint={complaint} onRejected={onUpdated} />
      ) : null}
      {allowed.has('add_remark') ? (
        <AddRemarkModal open={dialog === 'remark'} onClose={() => setDialog(null)} complaint={complaint} onAdded={onRemarkAdded} />
      ) : null}
    </>
  )
}

export default ComplaintActions
