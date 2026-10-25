/**
 * Human decisions on a resolution (BUILD_SPEC 3.2 / requirement 25: "allow admin/officer manual override").
 *
 * - ManualVerificationModal: POST /complaints/{id}/manual-verification/ `{status, score?, explanation}`.
 *   Each outcome states its consequence up front, because the backend applies it immediately: likely
 *   resolved -> verified; partially / not resolved -> back to in progress; needs manual review -> escalated
 *   to the administrators.
 * - RequestReviewModal: POST /complaints/{id}/request-manual-verification/ `{remarks?}` - the officer
 *   disputes the AI result and asks an administrator to look at the evidence.
 */
import { Send, UserSearch } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { RadioGroup } from '@/components/ui/RadioGroup'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/hooks/useToast'
import { complaintService } from '@/services/complaintService'
import { VERIFICATION_OPTIONS, getVerificationMeta } from '@/utils/constants'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { REMARKS_MAX } from './officerUtils'

const CONSEQUENCES = {
  likely_resolved: 'The work is done. The complaint becomes verified and the citizen is asked for feedback.',
  partially_resolved: 'Part of the issue remains. The complaint goes back to in progress with your explanation.',
  not_resolved: 'The issue is still there. The complaint goes back to in progress with your explanation.',
  needs_manual_review: 'The photos do not settle it. An administrator is asked to decide.',
}

const OUTCOME_OPTIONS = VERIFICATION_OPTIONS.map((option) => ({ ...option, description: CONSEQUENCES[option.value] }))

export function ManualVerificationModal({ open, onClose, complaint, defaultStatus = 'likely_resolved', onSaved }) {
  const toast = useToast()
  const formId = useId()
  const explanationRef = useRef(null)
  const [status, setStatus] = useState(defaultStatus)
  const [score, setScore] = useState('')
  const [explanation, setExplanation] = useState('')
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const close = () => {
    if (saving) return
    setErrors({})
    onClose?.()
  }

  const submit = async (event) => {
    event.preventDefault()
    const text = explanation.trim()
    const nextErrors = {}
    if (!text) nextErrors.explanation = 'Explain your decision. It is stored with the verification and shown on the timeline.'
    if (score !== '') {
      const number = Number(score)
      if (!Number.isInteger(number) || number < 0 || number > 100)
        nextErrors.score = 'Enter a whole number from 0 to 100, or leave it empty.'
    }
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      if (nextErrors.explanation) explanationRef.current?.focus()
      return
    }
    setSaving(true)
    setErrors({})
    try {
      const body = { status, explanation: text }
      if (score !== '') body.score = Number(score)
      const verification = await complaintService.manualVerification(complaint.id, body)
      const meta = getVerificationMeta(verification.status)
      toast.success('Manual verification saved', `${meta.label}, ${verification.score}/100.`)
      setScore('')
      setExplanation('')
      onSaved?.(verification)
      onClose?.()
    } catch (err) {
      setErrors(getFieldErrors(err))
      toast.error('Could not save the manual verification', getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      size="lg"
      title="Verify manually"
      description={`Your decision on ${complaint.complaint_number} replaces the AI result. Look at the before and after photos first.`}
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={formId} leftIcon={UserSearch} loading={saving}>
            Save manual verification
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="space-y-5">
        <RadioGroup label="Outcome" required options={OUTCOME_OPTIONS} value={status} onChange={setStatus} error={errors.status} />
        <FormField
          label="Score out of 100"
          htmlFor="manual-verification-score"
          optional
          error={errors.score}
          hint="Leave empty to use a typical score for the outcome you chose."
        >
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            value={score}
            onChange={(event) => setScore(event.target.value)}
            className="max-w-40"
          />
        </FormField>
        <FormField label="Explanation" htmlFor="manual-verification-explanation" required error={errors.explanation}>
          <Textarea
            ref={explanationRef}
            value={explanation}
            onChange={(event) => setExplanation(event.target.value)}
            maxLength={REMARKS_MAX}
            rows={4}
            placeholder="Checked on site: the issue is fixed and the area is safe. The AI score is low because the after photo was taken from another angle."
          />
        </FormField>
      </form>
    </Modal>
  )
}

export function RequestReviewModal({ open, onClose, complaint, onRequested }) {
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
    setSaving(true)
    setError('')
    try {
      const detail = await complaintService.requestManualVerification(complaint.id, { remarks: remarks.trim() })
      toast.success('Manual verification requested', 'The administrators have been notified and will review the evidence.')
      setRemarks('')
      onRequested?.(detail)
      onClose?.()
    } catch (err) {
      setError(getFieldErrors(err).remarks ?? '')
      toast.error('Could not request a manual verification', getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="Request manual verification"
      description="Ask an administrator to check the before and after photos, for example when you think the AI result is wrong."
      initialFocusRef={fieldRef}
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={formId} leftIcon={Send} loading={saving}>
            Request manual verification
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate>
        <FormField label="Note for the administrator" optional error={error} hint="What should the reviewer look at?">
          <Textarea
            ref={fieldRef}
            value={remarks}
            onChange={(event) => setRemarks(event.target.value)}
            maxLength={REMARKS_MAX}
            rows={4}
            placeholder="The repair is complete; the after photo was taken in poor light."
          />
        </FormField>
      </form>
    </Modal>
  )
}

export default ManualVerificationModal
