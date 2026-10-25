/**
 * ReviewDialog - confirm a duplicate decision, with an optional note for the record.
 *
 * PATCH /duplicates/{id}/ `{status: 'confirmed_duplicate' | 'not_duplicate', notes?}`. Confirming merges the
 * newer report into the original and closes it (its citizen is notified); "Not a duplicate" keeps both
 * complaints and records the decision. The note (max 255 characters) is stored on the pair, shown on both
 * timelines and kept in the audit log.
 *
 * Props: open, onClose, pair, status, onDone(updatedPair)
 */
import { CopyCheck, CopyX } from 'lucide-react'
import { useRef, useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { Modal } from '@/components/ui/Modal'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/hooks/useToast'
import { duplicateService } from '@/services'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'

export function ReviewDialog({ open, onClose, pair, status, onDone }) {
  const toast = useToast()
  const [notes, setNotes] = useState('')
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const firstFieldRef = useRef(null)
  const confirmed = status === 'confirmed_duplicate'
  const newer = pair?.complaint?.complaint_number ?? 'The newer report'
  const original = pair?.similar_complaint?.complaint_number ?? 'the original'

  const submit = async (event) => {
    event.preventDefault()
    if (!pair) return
    setSaving(true)
    setErrors({})
    try {
      const updated = await duplicateService.review(pair.id, { status, notes: notes.trim() })
      toast.success(confirmed ? 'Duplicate confirmed' : 'Marked as not a duplicate', confirmed ? `${newer} was merged into ${original}.` : `${newer} and ${original} stay separate.`)
      onDone?.(updated)
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error('Could not save the review', getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      initialFocusRef={firstFieldRef}
      onClose={saving ? undefined : onClose}
      title={confirmed ? 'Confirm duplicate?' : 'Mark as not a duplicate?'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="duplicate-review-form"
            variant={confirmed ? 'warning' : 'primary'}
            leftIcon={confirmed ? CopyCheck : CopyX}
            loading={saving}
          >
            {confirmed ? 'Confirm duplicate' : 'Not a duplicate'}
          </Button>
        </>
      }
    >
      <form id="duplicate-review-form" onSubmit={submit} className="space-y-4" noValidate>
        {confirmed ? (
          <Alert tone="warning" title={`${newer} will be merged into ${original}`}>
            The newer report is closed and its citizen is told the issue is handled as part of {original}. The original keeps
            its officer and gets a priority update.
          </Alert>
        ) : (
          <p className="text-sm text-ink-2">
            {newer} and {original} stay separate complaints and are worked on independently. The pair leaves the review queue.
          </p>
        )}
        <FormField label="Note for the record" htmlFor="duplicate-review-notes" optional error={errors.notes}>
          <Textarea
            id="duplicate-review-notes"
            ref={firstFieldRef}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={255}
            rows={2}
            placeholder={confirmed ? 'For example: same pole, reported twice.' : 'For example: different spot 200 m further along the road.'}
          />
        </FormField>
        {errors.non_field_errors || errors.status ? <Alert tone="danger">{errors.non_field_errors || errors.status}</Alert> : null}
      </form>
    </Modal>
  )
}

export default ReviewDialog
