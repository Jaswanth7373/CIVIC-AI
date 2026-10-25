/**
 * OfficerFormModal - create or edit an officer: the account, the work assignment and the base location.
 *
 * POST /officers/ (create: user with role officer + OfficerProfile in one transaction; password required) or
 * PATCH /officers/{id}/ (edit; an empty password keeps the current one). The base location feeds the
 * recommendation engine's proximity score (exp(-distance / 5 km)), so it is picked on a map (LocationPicker:
 * search, GPS, click or drag). Lazy-loaded by the page because the map pulls in Leaflet.
 *
 * Props: open, onClose, officer (OfficerOut | null for a new officer), departments (DepartmentOut[]), onSaved(officer)
 */
import { Eye, EyeOff, MapPinOff, Save, UserPlus } from 'lucide-react'
import { useRef, useState } from 'react'
import { LocationPicker } from '@/components/maps'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { useToast } from '@/hooks/useToast'
import { officerService } from '@/services'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { TagInput } from '../shared/FormControls'

function initialForm(officer) {
  const user = officer?.user ?? {}
  return {
    first_name: user.first_name ?? '',
    last_name: user.last_name ?? '',
    email: user.email ?? '',
    phone: user.phone ?? '',
    password: '',
    is_active: user.is_active ?? true,
    department: officer?.department_id != null ? String(officer.department_id) : '',
    employee_id: officer?.employee_id ?? '',
    designation: officer?.designation ?? '',
    zone: officer?.zone ?? '',
    max_active_complaints: String(officer?.max_active_complaints ?? 10),
    is_available: officer?.is_available ?? true,
    skills: Array.isArray(officer?.skills) ? officer.skills : [],
    joined_on: officer?.joined_on ?? '',
    location:
      officer?.base_latitude != null && officer?.base_longitude != null
        ? { lat: Number(officer.base_latitude), lng: Number(officer.base_longitude) }
        : null,
  }
}

function SectionTitle({ children, description }) {
  return (
    <div className="mb-3">
      <h3 className="text-sm font-bold text-ink">{children}</h3>
      {description ? <p className="mt-0.5 text-xs text-ink-3">{description}</p> : null}
    </div>
  )
}

export default function OfficerFormModal({ open, onClose, officer, departments, onSaved }) {
  const toast = useToast()
  const editing = Boolean(officer)
  const [form, setForm] = useState(() => initialForm(officer))
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const firstFieldRef = useRef(null)
  const [showPassword, setShowPassword] = useState(false)

  const set = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }))
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }))
  }
  const bind = (key) => ({ value: form[key], onChange: (event) => set(key, event.target.value) })

  const departmentOptions = (Array.isArray(departments) ? departments : [])
    .filter((department) => department.is_active !== false || String(department.id) === form.department)
    .map((department) => ({
      value: String(department.id),
      label: department.is_active === false ? `${department.name} (inactive)` : department.name,
    }))

  const submit = async (event) => {
    event.preventDefault()
    const nextErrors = {}
    if (!form.first_name.trim()) nextErrors.first_name = 'Enter the first name.'
    if (!form.email.trim()) nextErrors.email = 'Enter the email address the officer signs in with.'
    if (!editing && !form.password) nextErrors.password = 'Set a first password for the new account.'
    const capacity = Number(form.max_active_complaints)
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 200) {
      nextErrors.max_active_complaints = 'Enter a whole number from 1 to 200.'
    }
    if (!form.department) nextErrors.department = 'Choose the department this officer works for.'
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }

    const payload = {
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      department: Number(form.department),
      employee_id: form.employee_id.trim(),
      designation: form.designation.trim(),
      zone: form.zone.trim(),
      max_active_complaints: capacity,
      is_available: form.is_available,
      skills: form.skills,
      joined_on: form.joined_on || null,
      base_latitude: form.location ? form.location.lat : null,
      base_longitude: form.location ? form.location.lng : null,
    }
    if (form.password) payload.password = form.password
    if (editing) payload.is_active = form.is_active

    setSaving(true)
    setErrors({})
    try {
      const saved = editing ? await officerService.update(officer.id, payload) : await officerService.create(payload)
      const name = saved?.user?.full_name || `${payload.first_name} ${payload.last_name}`.trim()
      toast.success(
        editing ? 'Officer updated' : 'Officer added',
        editing
          ? `${name}'s profile was saved.`
          : (saved?.is_available ?? payload.is_available)
            ? `${name} can sign in and receive assignments.`
            : `${name} can sign in. Switch on availability when they should receive assignments.`,
      )
      onSaved?.(saved)
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error(editing ? 'Could not update the officer' : 'Could not add the officer', getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      initialFocusRef={firstFieldRef}
      onClose={saving ? undefined : onClose}
      size="xl"
      title={editing ? `Edit ${officer.user?.full_name ?? 'officer'}` : 'Add officer'}
      description={editing ? 'Changes apply to new assignments right away.' : 'Creates the sign-in account and the officer profile together.'}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="officer-form" loading={saving} leftIcon={editing ? Save : UserPlus}>
            {editing ? 'Save changes' : 'Add officer'}
          </Button>
        </>
      }
    >
      <form id="officer-form" onSubmit={submit} className="space-y-7" noValidate autoComplete="off">
        <section>
          <SectionTitle>Account</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="First name" htmlFor="officer-first" required error={errors.first_name}>
              <Input id="officer-first" ref={firstFieldRef} {...bind('first_name')} maxLength={150} />
            </FormField>
            <FormField label="Last name" htmlFor="officer-last" error={errors.last_name}>
              <Input id="officer-last" {...bind('last_name')} maxLength={150} />
            </FormField>
            <FormField label="Email" htmlFor="officer-email" required error={errors.email}>
              <Input id="officer-email" type="email" inputMode="email" {...bind('email')} maxLength={254} />
            </FormField>
            <FormField label="Phone" htmlFor="officer-phone" optional error={errors.phone}>
              <Input id="officer-phone" type="tel" inputMode="tel" {...bind('phone')} maxLength={20} />
            </FormField>
            <FormField
              label={editing ? 'New password' : 'Password'}
              htmlFor="officer-password"
              required={!editing}
              optional={editing}
              error={errors.password}
              hint={editing ? 'Leave empty to keep the current password.' : 'At least 8 characters, not only numbers.'}
              className="sm:col-span-2"
            >
              <Input
                id="officer-password"
                type={showPassword ? 'text' : 'password'}
                {...bind('password')}
                autoComplete="new-password"
                maxLength={128}
                containerClassName="sm:max-w-sm"
                rightSlot={
                  <IconButton
                    icon={showPassword ? EyeOff : Eye}
                    label={showPassword ? 'Hide password' : 'Show password'}
                    size="sm"
                    onClick={() => setShowPassword((value) => !value)}
                  />
                }
              />
            </FormField>
            {editing ? (
              <Switch
                checked={form.is_active}
                onCheckedChange={(checked) => set('is_active', checked)}
                label="Account active"
                description="A deactivated officer cannot sign in and receives no new work."
                className="sm:col-span-2"
              />
            ) : null}
          </div>
        </section>

        <section>
          <SectionTitle description="Decides which complaints the recommendation engine offers this officer.">Work assignment</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Department" htmlFor="officer-department" required error={errors.department}>
              <Select id="officer-department" placeholder="Choose a department" options={departmentOptions} {...bind('department')} />
            </FormField>
            <FormField
              label="Employee id"
              htmlFor="officer-employee-id"
              optional
              error={errors.employee_id}
              hint={editing ? undefined : 'Generated as EMP-<id> when left empty.'}
            >
              <Input id="officer-employee-id" {...bind('employee_id')} maxLength={30} className="uppercase tabular" />
            </FormField>
            <FormField label="Designation" htmlFor="officer-designation" optional error={errors.designation}>
              <Input id="officer-designation" {...bind('designation')} maxLength={100} placeholder="Assistant Engineer (Roads)" />
            </FormField>
            <FormField label="Zone or ward" htmlFor="officer-zone" optional error={errors.zone}>
              <Input id="officer-zone" {...bind('zone')} maxLength={120} placeholder="Khairatabad Zone - Ward 97" />
            </FormField>
            <FormField
              label="Capacity"
              htmlFor="officer-capacity"
              required
              error={errors.max_active_complaints}
              hint="Open complaints at once before the officer counts as overloaded."
            >
              <Input
                id="officer-capacity"
                type="number"
                inputMode="numeric"
                min={1}
                max={200}
                step={1}
                {...bind('max_active_complaints')}
                className="w-32 tabular"
              />
            </FormField>
            <FormField label="Joined the department" htmlFor="officer-joined" optional error={errors.joined_on}>
              <Input id="officer-joined" type="date" {...bind('joined_on')} className="w-48" />
            </FormField>
            <FormField label="Skills" htmlFor="officer-skills" optional error={errors.skills} hint="Press Enter after each skill." className="sm:col-span-2">
              <TagInput id="officer-skills" value={form.skills} onChange={(skills) => set('skills', skills)} maxItems={30} placeholder="pothole repair, asphalt" />
            </FormField>
            <Switch
              checked={form.is_available}
              onCheckedChange={(checked) => set('is_available', checked)}
              label="Available for new assignments"
              description="Unavailable officers are ranked last by the recommendation engine."
              className="sm:col-span-2"
            />
          </div>
        </section>

        <section>
          <SectionTitle description="Where the officer usually starts work. Closer officers score higher for a new complaint.">
            Base location
          </SectionTitle>
          <LocationPicker
            value={form.location}
            onChange={(location) => set('location', location)}
            reverseGeocode={false}
            height={260}
            label="Officer base location"
            error={errors.base_latitude || errors.base_longitude}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3">
            <span className="tabular">
              {form.location ? `${form.location.lat.toFixed(6)}, ${form.location.lng.toFixed(6)}` : 'No base location: distance counts as neutral.'}
            </span>
            {form.location ? (
              <Button variant="ghost" size="sm" leftIcon={MapPinOff} onClick={() => set('location', null)}>
                Clear location
              </Button>
            ) : null}
          </div>
        </section>

        {errors.non_field_errors ? <Alert tone="danger">{errors.non_field_errors}</Alert> : null}
      </form>
    </Modal>
  )
}
