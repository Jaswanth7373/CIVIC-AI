/**
 * ManualVerificationModal - a person overrides (or replaces) the AI-assisted resolution verification.
 *
 * POST /complaints/{id}/manual-verification/ `{status, score?, explanation}` -> Verification. "Likely resolved"
 * verifies the complaint (citizen asked for feedback); "Not resolved" sends the work back to the officer.
 *
 * Props: open, onClose, complaint (ComplaintDetail), onDone(verification)
 */
import { ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { RadioGroup } from '@/components/ui/RadioGroup'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/hooks/useToast'
import { complaintService } from '@/services'
import { VERIFICATION_META } from '@/utils/constants'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'

const OUTCOMES = ['likely_resolved', 'partially_resolved', 'not_resolved', 'needs_manual_review'].map((value) => ({
  value,
  label: VERIFICATION_META[value].label,
  description: {
    likely_resolved: 'The work is done. A resolved complaint becomes verified and the citizen is asked for feedback.',
    partially_resolved: 'Part of the issue remains. The work goes back to the officer as in progress.',
    not_resolved: 'The issue is still there. The work goes back to the officer as in progress.',
    needs_manual_review: 'Keep it flagged for administrators until someone has checked the site.',
  }[value],
}))

export function ManualVerificationModal({ open, onClose, complaint, onDone }) {
  const toast = useToast()
  const latest = complaint.latest_verification
  const [status, setStatus] = useState('likely_resolved')
  const [score, setScore] = useState(latest?.score != null ? String(Math.round(latest.score)) : '')
  const [explanation, setExplanation] = useState('')
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const submit = async (event) => {
    event.preventDefault()
    const nextErrors = {}
    if (!explanation.trim()) nextErrors.explanation = 'Explain what you checked; it is shown with the verification result.'
    const scoreNumber = score === '' ? null : Number(score)
    if (scoreNumber !== null && (!Number.isInteger(scoreNumber) || scoreNumber < 0 || scoreNumber > 100)) {
      nextErrors.score = 'Enter a whole number from 0 to 100, or leave it empty.'
    }
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }
    setSaving(true)
    setErrors({})
    try {
      const payload = { status, explanation: explanation.trim() }
      if (scoreNumber !== null) payload.score = scoreNumber
      const verification = await complaintService.manualVerification(complaint.id, payload)
      toast.success('Verification recorded', `${complaint.complaint_number}: ${VERIFICATION_META[status].label.toLowerCase()}.`)
      onDone?.(verification)
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error('Could not record the verification', getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={saving ? undefined : onClose}
      size="lg"
      title="Verify manually"
      description="Your decision replaces the AI-assisted result. It is marked as a manual override."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="manual-verification-form" loading={saving} leftIcon={ShieldCheck}>
            Save verification
          </Button>
        </>
      }
    >
      <form id="manual-verification-form" onSubmit={submit} className="space-y-5" noValidate>
        {latest ? (
          <p className="text-sm text-ink-2">
            The AI-assisted check said <span className="font-semibold text-ink">{latest.status_display ?? VERIFICATION_META[latest.status]?.label}</span>{' '}
            with a score of <span className="font-semibold text-ink tabular">{Math.round(Number(latest.score) || 0)}/100</span>.
          </p>
        ) : null}
        <RadioGroup
          label="Outcome"
          required
          options={OUTCOMES}
          value={status}
          onChange={(value) => {
            setStatus(value)
            setErrors((current) => ({ ...current, status: undefined, non_field_errors: undefined }))
          }}
          error={errors.status}
        />
        <FormField label="Score" htmlFor="manual-score" optional hint="0-100. Leave empty to let the outcome decide the score." error={errors.score}>
          <Input
            id="manual-score"
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            value={score}
            onChange={(event) => {
              setScore(event.target.value)
              setErrors((current) => ({ ...current, score: undefined }))
            }}
            className="w-32 tabular"
          />
        </FormField>
        <FormField label="What you checked" htmlFor="manual-explanation" required error={errors.explanation}>
          <Textarea
            id="manual-explanation"
            value={explanation}
            onChange={(event) => {
              setExplanation(event.target.value)
              setErrors((current) => ({ ...current, explanation: undefined }))
            }}
            maxLength={2000}
            rows={3}
            placeholder="For example: site visit on 17 Oct - the drain is cleared and the cover replaced."
          />
        </FormField>
        {errors.non_field_errors ? <Alert tone="danger">{errors.non_field_errors}</Alert> : null}
      </form>
    </Modal>
  )
}

export default ManualVerificationModal
