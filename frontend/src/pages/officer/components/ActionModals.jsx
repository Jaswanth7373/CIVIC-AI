/**
 * Dialogs behind the officer's complaint actions.
 *
 * - RejectComplaintModal: rejecting needs a reason (the API requires `remarks`); the citizen and the
 *   administrators read it, so the dialog asks for it in plain words. The dialog itself is the confirmation
 *   step of this destructive action.
 * - AddRemarkModal: a timeline remark, either visible to the citizen or kept as an internal note
 *   (`is_public`), POST /complaints/{id}/remarks/.
 *
 * Both validate in the browser first (empty text), then show the server's field message under the field and
 * its summary in a toast when the request fails.
 */
import { Ban, MessageSquarePlus } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { Modal } from '@/components/ui/Modal'
import { Switch } from '@/components/ui/Switch'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/hooks/useToast'
import { complaintService } from '@/services/complaintService'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { REMARKS_MAX } from './officerUtils'

export function RejectComplaintModal({ open, onClose, complaint, onRejected }) {
  const toast = useToast()
  const formId = useId()
  const fieldRef = useRef(null)
  const [remarks, setRemarks] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const close = () => {
    if (saving) return
    setError('')
    onClose?.()
  }

  const submit = async (event) => {
    event.preventDefault()
    const text = remarks.trim()
    if (!text) {
      setError('Explain why the complaint cannot be handled, so the citizen knows what to do next.')
      fieldRef.current?.focus()
      return
    }
    setSaving(true)
    setError('')
    try {
      const detail = await complaintService.reject(complaint.id, { remarks: text })
      toast.success('Complaint rejected', `${complaint.complaint_number} is closed as rejected. The citizen can read your reason.`)
      setRemarks('')
      onRejected?.(detail)
      onClose?.()
    } catch (err) {
      setError(getFieldErrors(err).remarks ?? '')
      toast.error('Could not reject complaint', getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Reject complaint"
      description={`${complaint.complaint_number} will be closed as rejected and leave your queue. Use this only when the issue cannot or should not be handled.`}
      initialFocusRef={fieldRef}
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button variant="danger" type="submit" form={formId} leftIcon={Ban} loading={saving}>
            Reject complaint
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <FormField
          label="Reason for rejecting"
          required
          error={error}
          hint="For example: outside the department's jurisdiction, private property, or already fixed before the visit."
        >
          <Textarea
            ref={fieldRef}
            value={remarks}
            onChange={(event) => setRemarks(event.target.value)}
            maxLength={REMARKS_MAX}
            rows={5}
            placeholder="Why can this complaint not be handled?"
          />
        </FormField>
      </form>
    </Modal>
  )
}

export function AddRemarkModal({ open, onClose, complaint, onAdded }) {
  const toast = useToast()
  const formId = useId()
  const fieldRef = useRef(null)
  const [remarks, setRemarks] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const close = () => {
    if (saving) return
    setError('')
    onClose?.()
  }

  const submit = async (event) => {
    event.preventDefault()
    const text = remarks.trim()
    if (!text) {
      setError('Write the remark first.')
      fieldRef.current?.focus()
      return
    }
    setSaving(true)
    setError('')
    try {
      const timelineEvent = await complaintService.addRemark(complaint.id, { remarks: text, is_public: isPublic })
      toast.success(
        'Remark added',
        isPublic ? 'The citizen can read it on the complaint timeline.' : 'Saved as an internal note for officers and administrators.',
      )
      setRemarks('')
      onAdded?.(timelineEvent)
      onClose?.()
    } catch (err) {
      setError(getFieldErrors(err).remarks ?? '')
      toast.error('Could not add remark', getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add remark"
      description={`A note on the timeline of ${complaint.complaint_number}, for example a site visit or a material delay.`}
      initialFocusRef={fieldRef}
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={formId} leftIcon={MessageSquarePlus} loading={saving}>
            Add remark
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-4">
        <FormField label="Remark" required error={error}>
          <Textarea
            ref={fieldRef}
            value={remarks}
            onChange={(event) => setRemarks(event.target.value)}
            maxLength={REMARKS_MAX}
            rows={5}
            placeholder="Crew visited the site; material is ordered and the work starts tomorrow."
          />
        </FormField>
        <Switch
          checked={isPublic}
          onCheckedChange={setIsPublic}
          label="Visible to citizen"
          description={
            isPublic ? 'The citizen sees this remark on the complaint timeline.' : 'Internal note: only officers and administrators see it.'
          }
        />
      </form>
    </Modal>
  )
}

export default RejectComplaintModal
