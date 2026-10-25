/**
 * Dialogs for the citizen's complaint actions (driven by ComplaintDetail.allowed_actions):
 * - EditComplaintModal ("edit"): PATCH /api/complaints/{id}/ with only the fields that changed - title,
 *   description and the address fields. A changed description is re-analysed by the AI on the server (the
 *   response then carries `analysis`). Allowed only until an officer accepts the complaint.
 * - ReopenComplaintModal ("reopen"): POST /api/complaints/{id}/reopen/ `{reason}` - the reason is required
 *   and the reopen window (`can_reopen_until`) is shown.
 * Both show field errors under the fields (getFieldErrors), announce the outcome with a toast and hand the
 * updated ComplaintDetail back through `onSaved`. The footer buttons submit the dialog's <form> through the
 * HTML `form` attribute, so Enter in a field and the Save button take the same path.
 *
 * Mount EditComplaintModal with a new `key` per opening (the details page does) so every edit starts from
 * the complaint's current values.
 */
import { RotateCcw, Save } from 'lucide-react'
import { useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/hooks/useToast'
import { complaintService } from '@/services/complaintService'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { formatDateTime } from '@/utils/format'
import { ADDRESS_FIELDS, DESCRIPTION_MAX, DESCRIPTION_MIN, TITLE_MAX } from './report/reportForm'

const REASON_MAX = 2000
const EDIT_FIELDS = ['title', 'description', ...ADDRESS_FIELDS.map((field) => field.key)]

function editableValues(complaint) {
  const location = complaint?.location ?? {}
  return {
    title: complaint?.title ?? '',
    description: complaint?.description ?? '',
    address: location.address ?? '',
    landmark: location.landmark ?? '',
    area: location.area ?? '',
    city: location.city ?? '',
    pincode: location.pincode ?? '',
  }
}

export function EditComplaintModal({ complaint, open, onClose, onSaved }) {
  const toast = useToast()
  const [initial] = useState(() => editableValues(complaint))
  const [values, setValues] = useState(initial)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState('')

  const changed = EDIT_FIELDS.filter((key) => values[key].trim() !== initial[key].trim())
  const descriptionChanged = changed.includes('description')

  const update = (key, value) => {
    setValues((current) => ({ ...current, [key]: value }))
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (saving || !changed.length) return
    if (values.description.trim().length < DESCRIPTION_MIN) {
      setErrors({ description: `The description needs at least ${DESCRIPTION_MIN} characters.` })
      return
    }
    const payload = Object.fromEntries(changed.map((key) => [key, values[key].trim()]))
    setSaving(true)
    setFailure('')
    try {
      const updated = await complaintService.update(complaint.id, payload)
      toast.success(
        'Complaint updated',
        updated?.analysis ? 'The new description was analysed again by the AI.' : 'Your changes are saved.',
      )
      onSaved(updated)
    } catch (error) {
      const fieldErrors = getFieldErrors(error)
      setErrors(fieldErrors)
      if (!EDIT_FIELDS.some((key) => fieldErrors[key])) setFailure(getErrorMessage(error))
      toast.error('Could not update complaint', getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      size="lg"
      title="Edit complaint"
      description={`${complaint.complaint_number}. You can edit it until an officer accepts the work.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="edit-complaint-form" leftIcon={Save} loading={saving} disabled={!changed.length}>
            Save changes
          </Button>
        </>
      }
    >
      <form id="edit-complaint-form" noValidate onSubmit={handleSubmit} className="space-y-4">
        {failure ? (
          <Alert tone="danger" title="Changes not saved">
            {failure}
          </Alert>
        ) : null}
        <FormField label="Title" htmlFor="edit-title" optional error={errors.title}>
          <Input id="edit-title" maxLength={TITLE_MAX} value={values.title} onChange={(event) => update('title', event.target.value)} />
        </FormField>
        <FormField
          label="Description"
          htmlFor="edit-description"
          required
          error={errors.description}
          hint={
            descriptionChanged
              ? 'Saving a new description runs the AI analysis again (category, severity and priority).'
              : `At least ${DESCRIPTION_MIN} characters.`
          }
        >
          <Textarea
            id="edit-description"
            rows={5}
            maxLength={DESCRIPTION_MAX}
            value={values.description}
            onChange={(event) => update('description', event.target.value)}
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          {ADDRESS_FIELDS.map((field) => (
            <FormField
              key={field.key}
              label={field.label}
              htmlFor={`edit-${field.key}`}
              optional
              error={errors[field.key]}
              className={field.key === 'address' ? 'sm:col-span-2' : undefined}
            >
              <Input
                id={`edit-${field.key}`}
                maxLength={field.maxLength}
                value={values[field.key]}
                autoComplete={field.autoComplete}
                onChange={(event) => update(field.key, event.target.value)}
              />
            </FormField>
          ))}
        </div>
        <p className="text-xs text-ink-3">
          The map pin cannot be moved after submitting. If the spot is wrong, delete this complaint and report it again.
        </p>
      </form>
    </Modal>
  )
}

export function ReopenComplaintModal({ complaint, open, onClose, onSaved }) {
  const toast = useToast()
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const close = () => {
    if (saving) return
    setReason('')
    setError('')
    onClose()
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (saving) return
    const text = reason.trim()
    if (!text) {
      setError('Tell the department what is still wrong, so the officer knows what to fix.')
      return
    }
    setSaving(true)
    setError('')
    try {
      const updated = await complaintService.reopen(complaint.id, { reason: text })
      toast.success('Complaint reopened', 'The officer has been told that the issue is not fixed.')
      setReason('')
      onSaved(updated)
    } catch (caught) {
      const fieldErrors = getFieldErrors(caught)
      setError(fieldErrors.reason || getErrorMessage(caught))
      toast.error('Could not reopen complaint', getErrorMessage(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Reopen complaint"
      description={`${complaint.complaint_number}: ${complaint.title}`}
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="reopen-complaint-form" variant="warning" leftIcon={RotateCcw} loading={saving}>
            Reopen complaint
          </Button>
        </>
      }
    >
      <form id="reopen-complaint-form" noValidate onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-ink-2">
          Reopen the complaint if the problem is still there or has come back. It goes back to the officer with your reason,
          and its priority is recalculated.
        </p>
        {complaint.can_reopen_until ? (
          <p className="text-xs text-ink-3">
            You can reopen it until{' '}
            <time dateTime={complaint.can_reopen_until} className="tabular">
              {formatDateTime(complaint.can_reopen_until)}
            </time>
            .
          </p>
        ) : null}
        <FormField label="What is still wrong?" htmlFor="reopen-reason" required error={error}>
          <Textarea
            id="reopen-reason"
            rows={4}
            maxLength={REASON_MAX}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value)
              if (error) setError('')
            }}
            placeholder="For example: the pothole was filled with loose gravel and opened up again after the rain."
          />
        </FormField>
      </form>
    </Modal>
  )
}
