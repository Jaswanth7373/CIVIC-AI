/**
 * OverrideAIModal - an administrator corrects the AI: category, severity and/or the priority score.
 *
 * POST /complaints/{id}/override-ai/ `{category?, severity?, priority_score?, reason}`. Only changed values are
 * sent. A new category re-routes the complaint to that category's department; without a manual score the
 * priority is recalculated from the corrected inputs. The reason is required - it appears on the timeline and
 * in the audit log next to the old and new values.
 *
 * Props: open, onClose, complaint (ComplaintDetail), categories (CategoryOut[]), onDone(detail)
 */
import { SlidersHorizontal } from 'lucide-react'
import { useRef, useState } from 'react'
import { CategoryBadge, PriorityMeter, SeverityBadge } from '@/components/complaints'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/hooks/useToast'
import { complaintService } from '@/services'
import { LEVEL_META, LEVEL_OPTIONS } from '@/utils/constants'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { formatPercent } from '@/utils/format'
import { RangeField } from '../shared/FormControls'

export function OverrideAIModal({ open, onClose, complaint, categories, onDone }) {
  const toast = useToast()
  const currentCategory = complaint.category?.id != null ? String(complaint.category.id) : ''
  const [category, setCategory] = useState(currentCategory)
  const [severity, setSeverity] = useState(complaint.severity ?? '')
  const [manualPriority, setManualPriority] = useState(false)
  const [priorityScore, setPriorityScore] = useState(Math.round(Number(complaint.priority_score) || 50))
  const [reason, setReason] = useState('')
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const firstFieldRef = useRef(null)

  /** Clear a field's message (and the "change something" message) as soon as the field is edited. */
  const clearError = (key) =>
    setErrors((current) => (current[key] || current.non_field_errors ? { ...current, [key]: undefined, non_field_errors: undefined } : current))

  const prediction = complaint.ai_prediction
  const options = (Array.isArray(categories) ? categories : [])
    .filter((item) => item.is_active !== false || String(item.id) === currentCategory)
    .map((item) => ({
      value: String(item.id),
      label: String(item.id) === currentCategory ? `${item.name} (current)` : item.name,
    }))
  const categoryChanged = Boolean(category) && category !== currentCategory
  const severityChanged = Boolean(severity) && severity !== complaint.severity
  const nextCategory = (categories ?? []).find((item) => String(item.id) === category)
  const routesElsewhere = categoryChanged && nextCategory?.department_detail && nextCategory.department_detail.id !== complaint.department?.id

  const submit = async (event) => {
    event.preventDefault()
    const nextErrors = {}
    if (!categoryChanged && !severityChanged && !manualPriority) {
      nextErrors.non_field_errors = 'Change the category or the severity, or set the priority score, to override the AI.'
    }
    if (!reason.trim()) nextErrors.reason = 'Explain why the AI result is wrong. The reason is shown on the timeline and kept in the audit log.'
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }
    const payload = { reason: reason.trim() }
    if (categoryChanged) payload.category = Number(category)
    if (severityChanged) payload.severity = severity
    if (manualPriority) payload.priority_score = Number(priorityScore)

    setSaving(true)
    setErrors({})
    try {
      const detail = await complaintService.overrideAI(complaint.id, payload)
      const changed = [
        categoryChanged ? `category ${nextCategory?.name ?? ''}`.trim() : null,
        severityChanged ? `severity ${LEVEL_META[severity]?.label.toLowerCase()}` : null,
        manualPriority ? `priority ${priorityScore}` : null,
      ].filter(Boolean)
      toast.success('AI result overridden', `${complaint.complaint_number}: ${changed.join(', ')}.`)
      onDone?.(detail)
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error('Could not override the AI result', getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      initialFocusRef={firstFieldRef}
      onClose={saving ? undefined : onClose}
      size="lg"
      title="Override AI result"
      description="Correct what the AI decided. The original prediction is kept for the AI analytics."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="override-ai-form" loading={saving} leftIcon={SlidersHorizontal}>
            Override AI result
          </Button>
        </>
      }
    >
      <form id="override-ai-form" onSubmit={submit} className="space-y-5" noValidate>
        {prediction ? (
          <div className="rounded-xl border border-line bg-surface-2 p-3.5">
            <p className="mb-2 text-xs font-medium text-ink-3">The AI decided</p>
            <div className="flex flex-wrap items-center gap-2">
              <CategoryBadge category={prediction.final_category ?? prediction.final_category_slug} size="sm" />
              <span className="text-xs text-ink-3 tabular">{formatPercent(prediction.multimodal_confidence)} confidence</span>
              <SeverityBadge severity={prediction.severity} score={prediction.severity_score} size="sm" withLabel />
            </div>
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Category" htmlFor="override-category" error={errors.category} hint={routesElsewhere ? `Moves the complaint to ${nextCategory.department_detail.name}.` : undefined}>
            <Select
              id="override-category"
              ref={firstFieldRef}
              value={category}
              onChange={(event) => {
                setCategory(event.target.value)
                clearError('category')
              }}
              options={options}
            />
          </FormField>
          <FormField label="Severity" htmlFor="override-severity" error={errors.severity}>
            <Select
              id="override-severity"
              value={severity}
              onChange={(event) => {
                setSeverity(event.target.value)
                clearError('severity')
              }}
              options={LEVEL_OPTIONS.map((option) => ({
                value: option.value,
                label: option.value === complaint.severity ? `${option.label} (current)` : option.label,
              }))}
            />
          </FormField>
        </div>

        <div className="space-y-3 rounded-xl border border-line p-3.5">
          <Switch
            checked={manualPriority}
            onCheckedChange={(checked) => {
              setManualPriority(checked)
              clearError('priority_score')
            }}
            label="Set the priority score manually"
            description="Otherwise the priority engine recalculates it from the corrected category and severity."
          />
          {manualPriority ? (
            <div className="space-y-3 pt-1">
              <RangeField
                label="Priority score"
                value={priorityScore}
                onChange={setPriorityScore}
                min={0}
                max={100}
                format={(value) => `${value}/100`}
                error={errors.priority_score}
              />
              <PriorityMeter score={priorityScore} size="sm" label="New priority score" showZoneLabels />
            </div>
          ) : null}
        </div>

        <FormField label="Reason" htmlFor="override-reason" required error={errors.reason}>
          <Textarea
            id="override-reason"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value)
              clearError('reason')
            }}
            maxLength={2000}
            rows={3}
            placeholder="For example: the photo shows an open manhole, not a pothole; the cover is missing."
          />
        </FormField>

        {errors.non_field_errors ? <Alert tone="danger">{errors.non_field_errors}</Alert> : null}
      </form>
    </Modal>
  )
}

export default OverrideAIModal
