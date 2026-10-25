/**
 * DepartmentFormModal - create or edit a department (POST /departments/, PATCH /departments/{id}/).
 *
 * Fields: name, code (2-20 upper-case letters / digits / underscores starting with a letter, e.g. ROADS),
 * description, icon (curated civic icons), colour (#RRGGBB - the department's colour on badges, pins and
 * charts), SLA in hours (1-8760, the default deadline for its categories), head, email, phone and active.
 *
 * Props: open, onClose, department (DepartmentOut | null), onSaved(department)
 */
import { Building2, Save } from 'lucide-react'
import { useRef, useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Switch } from '@/components/ui/Switch'
import { Textarea } from '@/components/ui/Textarea'
import { useToast } from '@/hooks/useToast'
import { departmentService } from '@/services'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { formatHours } from '@/utils/format'
import { ColorField, IconPicker } from '../shared/FormControls'

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,19}$/
const HEX = /^#[0-9A-F]{6}$/i

function initialForm(department) {
  return {
    name: department?.name ?? '',
    code: department?.code ?? '',
    description: department?.description ?? '',
    icon: department?.icon ?? 'building-2',
    color: department?.color ?? '#6B7C85',
    sla_hours: String(department?.sla_hours ?? 72),
    head_name: department?.head_name ?? '',
    email: department?.email ?? '',
    phone: department?.phone ?? '',
    is_active: department?.is_active ?? true,
  }
}

export function DepartmentFormModal({ open, onClose, department, onSaved }) {
  const toast = useToast()
  const editing = Boolean(department)
  const [form, setForm] = useState(() => initialForm(department))
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const firstFieldRef = useRef(null)

  const set = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }))
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }))
  }
  const bind = (key) => ({ value: form[key], onChange: (event) => set(key, event.target.value) })
  const sla = Number(form.sla_hours)

  const submit = async (event) => {
    event.preventDefault()
    const nextErrors = {}
    if (!form.name.trim()) nextErrors.name = 'Enter the department name.'
    if (!CODE_PATTERN.test(form.code.trim().toUpperCase())) nextErrors.code = 'Use 2-20 upper-case letters, digits or underscores, starting with a letter (e.g. ROADS).'
    if (!HEX.test(form.color.trim())) nextErrors.color = 'Enter a colour as #RRGGBB, e.g. #D9480F.'
    if (!Number.isInteger(sla) || sla < 1 || sla > 8760) nextErrors.sla_hours = 'Enter whole hours from 1 to 8760.'
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }
    const payload = {
      ...form,
      name: form.name.trim(),
      code: form.code.trim().toUpperCase(),
      description: form.description.trim(),
      color: form.color.trim().toUpperCase(),
      sla_hours: sla,
      head_name: form.head_name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
    }
    setSaving(true)
    setErrors({})
    try {
      const saved = editing ? await departmentService.update(department.id, payload) : await departmentService.create(payload)
      toast.success(editing ? 'Department updated' : 'Department created', `${saved?.name ?? payload.name} (${saved?.code ?? payload.code}) was saved.`)
      onSaved?.(saved)
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error(editing ? 'Could not update the department' : 'Could not create the department', getErrorMessage(error))
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
      title={editing ? `Edit ${department.name}` : 'Add department'}
      description="Departments receive complaints through the category routing table."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="department-form" loading={saving} leftIcon={editing ? Save : Building2}>
            {editing ? 'Save changes' : 'Add department'}
          </Button>
        </>
      }
    >
      <form id="department-form" onSubmit={submit} className="space-y-5" noValidate>
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
          <FormField label="Name" htmlFor="department-name" required error={errors.name}>
            <Input id="department-name" ref={firstFieldRef} {...bind('name')} maxLength={120} placeholder="Roads Department" />
          </FormField>
          <FormField label="Code" htmlFor="department-code" required error={errors.code}>
            <Input
              id="department-code"
              value={form.code}
              onChange={(event) => set('code', event.target.value.toUpperCase())}
              maxLength={20}
              placeholder="ROADS"
              className="uppercase tabular"
              spellCheck={false}
            />
          </FormField>
        </div>
        <FormField label="Description" htmlFor="department-description" optional error={errors.description}>
          <Textarea id="department-description" {...bind('description')} rows={2} maxLength={500} placeholder="What this department looks after." />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Icon" htmlFor="department-icon" error={errors.icon}>
            <IconPicker id="department-icon" value={form.icon} color={form.color} onChange={(icon) => set('icon', icon)} />
          </FormField>
          <FormField label="Colour" htmlFor="department-color" error={errors.color}>
            <ColorField id="department-color" value={form.color} onChange={(color) => set('color', color)} invalid={Boolean(errors.color)} />
          </FormField>
        </div>
        <FormField
          label="Service level (hours)"
          htmlFor="department-sla"
          required
          error={errors.sla_hours}
          hint={Number.isInteger(sla) && sla > 0 ? `Complaints are due ${formatHours(sla)} after they are reported, unless a category overrides it.` : 'Default deadline for this department’s complaints.'}
        >
          <Input id="department-sla" type="number" inputMode="numeric" min={1} max={8760} step={1} {...bind('sla_hours')} className="w-32 tabular" />
        </FormField>
        <fieldset className="grid gap-4 sm:grid-cols-3">
          <legend className="mb-2 text-sm font-semibold text-ink sm:col-span-3">Contacts</legend>
          <FormField label="Head of department" htmlFor="department-head" optional error={errors.head_name}>
            <Input id="department-head" {...bind('head_name')} maxLength={120} />
          </FormField>
          <FormField label="Email" htmlFor="department-email" optional error={errors.email}>
            <Input id="department-email" type="email" inputMode="email" {...bind('email')} maxLength={254} />
          </FormField>
          <FormField label="Phone" htmlFor="department-phone" optional error={errors.phone}>
            <Input id="department-phone" type="tel" inputMode="tel" {...bind('phone')} maxLength={20} />
          </FormField>
        </fieldset>
        <Switch
          checked={form.is_active}
          onCheckedChange={(checked) => set('is_active', checked)}
          label="Active"
          description="Inactive departments are skipped by routing, so their categories fall back to the secondary or general department."
        />
        {errors.non_field_errors ? <Alert tone="danger">{errors.non_field_errors}</Alert> : null}
      </form>
    </Modal>
  )
}

export default DepartmentFormModal
