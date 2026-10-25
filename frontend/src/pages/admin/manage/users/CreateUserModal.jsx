/**
 * CreateUserModal - create a citizen or administrator account (POST /users/).
 *
 * Officers are created in Officer management instead, because they also need a department, an employee id
 * and a workload capacity (POST /officers/ creates the user and the officer profile together); the dialog
 * links there. The password is checked by Django's password validators on the server; their messages are
 * shown under the field.
 *
 * Props: open, onClose, onCreated(user)
 */
import { Eye, EyeOff, HardHat, UserPlus } from 'lucide-react'
import { useRef, useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { RadioGroup } from '@/components/ui/RadioGroup'
import { Switch } from '@/components/ui/Switch'
import { useToast } from '@/hooks/useToast'
import { userService } from '@/services'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'

const ROLE_CHOICES = [
  { value: 'citizen', label: 'Citizen', description: 'Reports issues and follows their complaints.' },
  { value: 'admin', label: 'Administrator', description: 'Full access to every complaint, setting and report.' },
]

const EMPTY = { role: 'citizen', first_name: '', last_name: '', email: '', phone: '', password: '', is_active: true }

export function CreateUserModal({ open, onClose, onCreated }) {
  const toast = useToast()
  const [form, setForm] = useState(EMPTY)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)
  const firstFieldRef = useRef(null)
  const [showPassword, setShowPassword] = useState(false)

  const set = (key) => (event) => {
    const value = event?.target ? (event.target.type === 'checkbox' ? event.target.checked : event.target.value) : event
    setForm((current) => ({ ...current, [key]: value }))
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }))
  }

  const submit = async (event) => {
    event.preventDefault()
    const nextErrors = {}
    if (!form.first_name.trim()) nextErrors.first_name = 'Enter the first name.'
    if (!form.email.trim()) nextErrors.email = 'Enter the email address the person signs in with.'
    if (!form.password) nextErrors.password = 'Set a first password; the person can change it from their profile.'
    if (Object.keys(nextErrors).length) {
      setErrors(nextErrors)
      return
    }
    setSaving(true)
    setErrors({})
    try {
      const user = await userService.create({
        ...form,
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
      })
      toast.success('User created', `${user?.full_name || form.email} can sign in as ${form.role === 'admin' ? 'an administrator' : 'a citizen'}.`)
      onCreated?.(user)
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error('Could not create the user', getErrorMessage(error))
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
      title="Create user"
      description="A new account for a citizen or an administrator."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form="create-user-form" loading={saving} leftIcon={UserPlus}>
            Create user
          </Button>
        </>
      }
    >
      <form id="create-user-form" onSubmit={submit} className="space-y-5" noValidate autoComplete="off">
        <RadioGroup
          label="Role"
          orientation="horizontal"
          options={ROLE_CHOICES}
          value={form.role}
          onChange={(value) => setForm((current) => ({ ...current, role: value }))}
          error={errors.role}
          className="[&>div>label]:flex-1"
        />
        <p className="-mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
          Officers need a department and a workload capacity.
          <Button variant="link" size="sm" to="/admin/officers?new=1" leftIcon={HardHat}>
            Add an officer instead
          </Button>
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="First name" htmlFor="new-user-first" required error={errors.first_name}>
            <Input id="new-user-first" ref={firstFieldRef} value={form.first_name} onChange={set('first_name')} autoComplete="off" maxLength={150} />
          </FormField>
          <FormField label="Last name" htmlFor="new-user-last" error={errors.last_name}>
            <Input id="new-user-last" value={form.last_name} onChange={set('last_name')} autoComplete="off" maxLength={150} />
          </FormField>
          <FormField label="Email" htmlFor="new-user-email" required error={errors.email}>
            <Input id="new-user-email" type="email" inputMode="email" value={form.email} onChange={set('email')} autoComplete="off" maxLength={254} />
          </FormField>
          <FormField label="Phone" htmlFor="new-user-phone" optional error={errors.phone}>
            <Input id="new-user-phone" type="tel" inputMode="tel" value={form.phone} onChange={set('phone')} autoComplete="off" maxLength={20} />
          </FormField>
        </div>

        <FormField
          label="Password"
          htmlFor="new-user-password"
          required
          error={errors.password}
          hint="At least 8 characters, not only numbers, and not similar to the name or email."
        >
          <Input
            id="new-user-password"
            type={showPassword ? 'text' : 'password'}
            value={form.password}
            onChange={set('password')}
            autoComplete="new-password"
            maxLength={128}
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

        <Switch
          checked={form.is_active}
          onCheckedChange={(checked) => setForm((current) => ({ ...current, is_active: checked }))}
          label="Active account"
          description="Inactive accounts exist but cannot sign in until you activate them."
        />

        {errors.non_field_errors ? <Alert tone="danger">{errors.non_field_errors}</Alert> : null}
      </form>
    </Modal>
  )
}

export default CreateUserModal
