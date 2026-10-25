/**
 * Status dialogs of the admin complaint page.
 *
 * - StatusChangeModal: POST /complaints/{id}/update-status/ `{status, remarks}`. Administrators may take any
 *   lifecycle transition (the state machine in apps/complaints/services/status.py still validates it and
 *   requires remarks for rejected / resolved / reopened); the dialog always asks for remarks because they are
 *   what the citizen and the officer read on the timeline.
 * - CloseComplaintModal: POST /complaints/{id}/close/ `{remarks?}` (offered only when `close` is allowed,
 *   i.e. after the resolution).
 * - ReopenComplaintModal: POST /complaints/{id}/reopen/ `{reason}` (offered when `reopen` is allowed: resolved,
 *   verified, closed or rejected complaints). Reopening counts the reopen, clears the resolution timestamps,
 *   recalculates the priority and notifies the officer.
 *
 * Props (both): open, onClose, complaint (ComplaintDetail), onDone(detail)
 */
import { Archive, RefreshCw, RotateCcw } from 'lucide-react'
import { useRef, useState } from 'react'
import { StatusBadge } from '@/components/complaints'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/hooks/useToast'
import { complaintService } from '@/services'
import { STATUS_META, STATUS_OPTIONS } from '@/utils/constants'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'

/** Consequence of moving to a status, in the words the admin needs before confirming. */
const CONSEQUENCES = {
  rejected: 'The citizen is told the complaint was rejected and reads your remarks as the reason.',
  resolved: 'The complaint counts as resolved; AI verification needs an after photo from the officer.',
  verified: 'The resolution is treated as verified and the citizen is asked for feedback.',
  closed: 'The complaint leaves every open queue. Use this when the work is finished.',
  reopened: 'Work starts again: the priority is recalculated and the officer is notified.',
  assigned: 'The complaint goes back to the assigned officer’s queue as a new assignment.',
  in_progress: 'The complaint shows as work in progress for the citizen and the officer.',
}

export function StatusChangeModal({ open, onClose, complaint, onDone }) {
  const toast = useToast()
  const [status, setStatus] = useState('')
  const [remarks, setRemarks] = useState('')
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const statusFieldRef = useRef(null)
  const options = STATUS_OPTIONS.filter((option) => option.value !== complaint.status)
  const meta = STATUS_META[status]

  const submit = async (event) => {
    event.preventDefault()
    const nextErrors = {}
    if (!status) nextErrors.status = 'Choose the new status.'
    if (!remarks.trim()) nextErrors.remarks = 'Add remarks: the citizen and the officer see them on the timeline.'
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }
    setSaving(true)
    setErrors({})
    try {
      const detail = await complaintService.updateStatus(complaint.id, { status, remarks: remarks.trim() })
      toast.success(`Status changed to ${(meta?.label ?? status).toLowerCase()}`, `${complaint.complaint_number} was updated.`)
      onDone?.(detail)
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error('Could not change the status', getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      initialFocusRef={statusFieldRef}
      onClose={saving ? undefined : onClose}
      title="Change status"
      description={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          {complaint.complaint_number} is currently <StatusBadge status={complaint.status} label={complaint.status_display} size="sm" />
        </span>
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="status-change-form" loading={saving} leftIcon={RefreshCw}>
            {meta ? `Move to ${meta.label.toLowerCase()}` : 'Change status'}
          </Button>
        </>
      }
    >
      <form id="status-change-form" onSubmit={submit} className="space-y-4" noValidate>
        <FormField label="New status" htmlFor="status-new" required error={errors.status} hint={meta?.description}>
          <Select
            id="status-new"
            ref={statusFieldRef}
            placeholder="Choose a status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value)
              setErrors((current) => ({ ...current, status: undefined }))
            }}
            options={options}
          />
        </FormField>
        {status && CONSEQUENCES[status] ? <Alert tone="info">{CONSEQUENCES[status]}</Alert> : null}
        <FormField label="Remarks" htmlFor="status-remarks" required error={errors.remarks}>
          <Textarea
            id="status-remarks"
            value={remarks}
            onChange={(event) => {
              setRemarks(event.target.value)
              setErrors((current) => ({ ...current, remarks: undefined, non_field_errors: undefined }))
            }}
            maxLength={2000}
            rows={3}
            placeholder="What changed and why. Shown on the complaint timeline."
          />
        </FormField>
        {errors.non_field_errors ? <Alert tone="danger">{errors.non_field_errors}</Alert> : null}
      </form>
    </Modal>
  )
}

export function CloseComplaintModal({ open, onClose, complaint, onDone }) {
  const toast = useToast()
  const [remarks, setRemarks] = useState('')
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const remarksFieldRef = useRef(null)

  const submit = async (event) => {
    event.preventDefault()
    setSaving(true)
    setErrors({})
    try {
      const detail = await complaintService.close(complaint.id, { remarks: remarks.trim() })
      toast.success('Complaint closed', `${complaint.complaint_number} left the open queues.`)
      onDone?.(detail)
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error('Could not close the complaint', getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      initialFocusRef={remarksFieldRef}
      onClose={saving ? undefined : onClose}
      size="sm"
      title="Close complaint"
      description={`${complaint.complaint_number} is resolved. Closing it ends the lifecycle; the citizen can still reopen it within the reopen window.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="close-complaint-form" loading={saving} leftIcon={Archive}>
            Close complaint
          </Button>
        </>
      }
    >
      <form id="close-complaint-form" onSubmit={submit} noValidate>
        <FormField label="Remarks" htmlFor="close-remarks" optional error={errors.remarks}>
          <Textarea
            id="close-remarks"
            ref={remarksFieldRef}
            value={remarks}
            onChange={(event) => setRemarks(event.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="For example: verified on site, closing without citizen feedback."
          />
        </FormField>
        {errors.non_field_errors ? <Alert tone="danger" className="mt-3">{errors.non_field_errors}</Alert> : null}
      </form>
    </Modal>
  )
}

export function ReopenComplaintModal({ open, onClose, complaint, onDone }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const reasonFieldRef = useRef(null)

  const submit = async (event) => {
    event.preventDefault()
    if (!reason.trim()) {
      setErrors({ reason: 'Say why the work must start again; the officer reads it on the timeline.' })
      return
    }
    setSaving(true)
    setErrors({})
    try {
      const detail = await complaintService.reopen(complaint.id, { reason: reason.trim() })
      toast.success('Complaint reopened', `${complaint.complaint_number} is back in the officer's queue.`)
      onDone?.(detail)
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error('Could not reopen the complaint', getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      initialFocusRef={reasonFieldRef}
      onClose={saving ? undefined : onClose}
      title="Reopen complaint"
      description={`${complaint.complaint_number} goes back to work: the priority is recalculated and the officer is notified.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="reopen-complaint-form" variant="warning" loading={saving} leftIcon={RotateCcw}>
            Reopen complaint
          </Button>
        </>
      }
    >
      <form id="reopen-complaint-form" onSubmit={submit} noValidate>
        <FormField label="Reason" htmlFor="reopen-reason" required error={errors.reason}>
          <Textarea
            id="reopen-reason"
            ref={reasonFieldRef}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value)
              setErrors({})
            }}
            maxLength={2000}
            rows={3}
            placeholder="For example: the citizen sent new photos; the drain is blocked again."
          />
        </FormField>
        {errors.non_field_errors ? <Alert tone="danger" className="mt-3">{errors.non_field_errors}</Alert> : null}
      </form>
    </Modal>
  )
}
