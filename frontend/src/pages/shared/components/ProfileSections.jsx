/**
 * Sections of the shared profile page (all roles). Every section writes through the real API:
 * - IdentityCard: avatar upload (multipart PATCH /auth/profile/ with `avatar`) with an instant local preview,
 *   or removal (`remove_avatar`), plus name, role, civic points (citizens) and account details. It reads like
 *   an ID badge: a highway-sign band across the top (the one sign panel of the screen) with the photo set
 *   into its lower edge, so the photo sits in front of the band; civic points count up the first time
 * - PersonalInfoForm: names, phone and - for citizens - the citizen profile (address, area, city, PIN,
 *   date of birth, gender, language, e-mail notifications); only changed fields are sent
 * - OfficerSummary: the officer's read-only service profile (department, employee id, zone, workload, skills)
 * - ChangePasswordForm: POST /auth/change-password/ `{old_password, new_password, confirm_password}`
 */
import { Award, Camera, Eye, EyeOff, KeyRound, Save, ShieldCheck, Trash2, Undo2, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { isHexColor } from '@/components/charts/palette'
import { DepartmentBadge } from '@/components/complaints/DepartmentBadge'
import { CountUp } from '@/components/motion/CountUp'
import { Avatar } from '@/components/ui/Avatar'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardFooter, CardHeader } from '@/components/ui/Card'
import { FormField } from '@/components/ui/FormField'
import { IconButton } from '@/components/ui/IconButton'
import { Input } from '@/components/ui/Input'
import { KeyValueList } from '@/components/ui/KeyValueList'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { useConfig } from '@/hooks/useConfig'
import { useConfirm } from '@/hooks/useConfirm'
import { useToast } from '@/hooks/useToast'
import { setTokens } from '@/services/api'
import { authService } from '@/services/authService'
import { GENDER_OPTIONS, ROLE_LABELS } from '@/utils/constants'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { formatDate, formatDateInput, formatDateTime, formatFileSize, formatNumber } from '@/utils/format'

// Role is identity, not status: quiet asphalt chips, with the CivicAI sign green kept for administrators.
const ROLE_TONES = { citizen: 'neutral', officer: 'neutral', admin: 'green' }
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const LANGUAGE_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'te', label: 'Telugu' },
  { value: 'hi', label: 'Hindi' },
  { value: 'ur', label: 'Urdu' },
]

/** Local preview URL for a chosen file (revoked when it changes). */
function usePreview(file) {
  const [entry, setEntry] = useState({ file: null, url: null })
  useEffect(() => {
    if (!file) return undefined
    const url = URL.createObjectURL(file)
    setEntry({ file, url })
    return () => URL.revokeObjectURL(url)
  }, [file])
  return file && entry.file === file ? entry.url : null
}

export function IdentityCard({ profile, onUpdate }) {
  const toast = useToast()
  const confirm = useConfirm()
  const { maxImageMB } = useConfig()
  const inputRef = useRef(null)
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(null)
  const [fileError, setFileError] = useState('')
  const preview = usePreview(file)
  const isCitizen = profile.role === 'citizen'
  const points = profile.citizen_profile?.civic_points ?? profile.stats?.civic_points ?? 0
  const departmentColor = profile.officer_profile?.department?.color
  const bandColor = profile.role === 'officer' && isHexColor(departmentColor) ? departmentColor : null

  const choose = (event) => {
    const picked = event.target.files?.[0]
    event.target.value = ''
    if (!picked) return
    if (!IMAGE_TYPES.includes(picked.type)) {
      setFileError('Choose a JPG, PNG or WebP image.')
      return
    }
    if (picked.size > maxImageMB * 1024 * 1024) {
      setFileError(`This image is ${formatFileSize(picked.size)}. The limit is ${maxImageMB} MB.`)
      return
    }
    setFileError('')
    setFile(picked)
  }

  const savePhoto = async () => {
    setBusy('upload')
    try {
      await onUpdate({ avatar: file })
      setFile(null)
      toast.success('Profile photo updated')
    } catch (error) {
      const message = getFieldErrors(error).avatar || getErrorMessage(error)
      setFileError(message)
      toast.error('Could not update profile photo', message)
    } finally {
      setBusy(null)
    }
  }

  const removePhoto = async () => {
    const ok = await confirm({
      title: 'Remove your profile photo?',
      message: 'Your initials are shown instead. You can upload a new photo at any time.',
      confirmLabel: 'Remove photo',
      tone: 'danger',
    })
    if (!ok) return
    setBusy('remove')
    try {
      await onUpdate({ remove_avatar: true })
      toast.success('Profile photo removed')
    } catch (error) {
      toast.error('Could not remove profile photo', getErrorMessage(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card className="overflow-hidden elev-raised">
      {/* The badge band: the officer's department colour (CivicAI sign green for citizens and administrators),
          with a road marking along its lower edge and the photo set into it. */}
      <div aria-hidden className="relative h-20 bg-sign-600" style={bandColor ? { backgroundColor: bandColor } : undefined}>
        <div className="absolute inset-0 bg-[radial-gradient(120%_90%_at_50%_0%,rgb(255_255_255/0.16),transparent_60%)]" />
        <div className="lane-line-x absolute inset-x-0 bottom-0 h-[3px]" />
      </div>
      <CardBody className="-mt-12 flex flex-col items-center px-5 pb-5 pt-0 text-center">
        {/* ID-badge photo: a white ring, and initials (no photo) on asphalt so no disc colour fights the band. */}
        <div className="relative rounded-full ring-4 ring-white">
          <Avatar
            src={preview ?? profile.avatar}
            name={profile.full_name}
            size="xl"
            className="size-24 bg-asphalt-800 text-3xl text-white"
          />
          <IconButton
            icon={Camera}
            label={profile.avatar ? 'Change profile photo' : 'Upload a profile photo'}
            variant="outline"
            size="sm"
            className="absolute -bottom-1 -right-1 rounded-full"
            onClick={() => inputRef.current?.click()}
            disabled={Boolean(busy)}
          />
          <input ref={inputRef} type="file" accept={IMAGE_TYPES.join(',')} className="hidden" tabIndex={-1} aria-hidden onChange={choose} />
        </div>
        <h2 className="mt-4 font-display text-xl font-bold text-ink">{profile.full_name}</h2>
        <p className="mt-0.5 break-all text-sm text-ink-2">{profile.email}</p>
        <Badge tone={ROLE_TONES[profile.role] ?? 'neutral'} size="sm" className="mt-2">
          {ROLE_LABELS[profile.role] ?? profile.role}
        </Badge>

        {file ? (
          <div className="mt-4 w-full rounded-lg bg-surface-2 p-3 text-left">
            <p className="truncate text-xs font-medium text-ink-2">
              New photo: {file.name} <span className="text-ink-3 tabular">({formatFileSize(file.size)})</span>
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" leftIcon={Save} loading={busy === 'upload'} onClick={savePhoto}>
                Save photo
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFile(null)} disabled={busy === 'upload'}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="outline" leftIcon={Camera} onClick={() => inputRef.current?.click()} disabled={Boolean(busy)}>
              {profile.avatar ? 'Change photo' : 'Upload photo'}
            </Button>
            {profile.avatar ? (
              <Button
                size="sm"
                variant="ghost"
                leftIcon={Trash2}
                loading={busy === 'remove'}
                onClick={removePhoto}
                className="text-signal-600 hover:text-signal-700 dark:text-signal-300"
              >
                Remove photo
              </Button>
            ) : null}
          </div>
        )}
        {fileError ? (
          <p role="alert" className="mt-2 text-xs font-medium text-signal-600 dark:text-signal-300">
            {fileError}
          </p>
        ) : (
          <p className="mt-2 text-xs text-ink-3">JPG, PNG or WebP up to {maxImageMB} MB.</p>
        )}
      </CardBody>

      {isCitizen ? (
        <div className="flex items-center gap-3 border-t border-line px-5 py-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-sign-50 text-sign-700 dark:bg-sign-500/15 dark:text-sign-300">
            <Award aria-hidden className="size-5" />
          </span>
          <div className="min-w-0">
            <CountUp as="p" value={Number(points) || 0} className="font-display text-2xl font-extrabold leading-none text-ink tabular" />
            <p className="mt-1 text-xs text-ink-3">Civic points from your reports and ratings</p>
          </div>
        </div>
      ) : null}

      <div className="border-t border-line px-5 py-4">
        <KeyValueList
          layout="inline"
          items={[
            { label: 'Account', value: profile.is_active ? 'Active' : 'Deactivated' },
            { label: 'Member since', value: formatDate(profile.date_joined) },
            { label: 'Last login', value: profile.last_login ? formatDateTime(profile.last_login) : null },
            profile.role === 'citizen'
              ? { label: 'Complaints reported', value: formatNumber(profile.stats?.complaints ?? 0) }
              : profile.role === 'officer'
                ? { label: 'Complaints assigned', value: formatNumber(profile.stats?.complaints ?? 0) }
                : null,
          ]}
        />
      </div>
    </Card>
  )
}

function personalValues(profile) {
  const citizen = profile.citizen_profile ?? {}
  return {
    first_name: profile.first_name ?? '',
    last_name: profile.last_name ?? '',
    phone: profile.phone ?? '',
    address: citizen.address ?? '',
    area: citizen.area ?? '',
    city: citizen.city ?? '',
    pincode: citizen.pincode ?? '',
    date_of_birth: citizen.date_of_birth ? formatDateInput(citizen.date_of_birth) : '',
    gender: citizen.gender ?? '',
    preferred_language: citizen.preferred_language || 'en',
    email_notifications: citizen.email_notifications ?? true,
  }
}

const ACCOUNT_KEYS = ['first_name', 'last_name', 'phone']
const CITIZEN_KEYS = ['address', 'area', 'city', 'pincode', 'date_of_birth', 'gender', 'preferred_language', 'email_notifications']

export function PersonalInfoForm({ profile, onUpdate }) {
  const toast = useToast()
  const isCitizen = profile.role === 'citizen'
  const [initial, setInitial] = useState(() => personalValues(profile))
  const [values, setValues] = useState(initial)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const keys = isCitizen ? [...ACCOUNT_KEYS, ...CITIZEN_KEYS] : ACCOUNT_KEYS
  const changed = keys.filter((key) => values[key] !== initial[key])
  const languageOptions = LANGUAGE_OPTIONS.some((option) => option.value === values.preferred_language)
    ? LANGUAGE_OPTIONS
    : [...LANGUAGE_OPTIONS, { value: values.preferred_language, label: values.preferred_language }]

  const update = (key, value) => {
    setValues((current) => ({ ...current, [key]: value }))
    setErrors((current) => (current[key] ? { ...current, [key]: undefined } : current))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!changed.length || saving) return
    if (!values.first_name.trim()) {
      setErrors({ first_name: 'Enter your first name.' })
      return
    }
    const payload = {}
    changed.filter((key) => ACCOUNT_KEYS.includes(key)).forEach((key) => {
      payload[key] = values[key].trim()
    })
    const citizenChanges = changed.filter((key) => CITIZEN_KEYS.includes(key))
    if (citizenChanges.length) {
      payload.citizen_profile = Object.fromEntries(
        citizenChanges.map((key) => {
          const value = values[key]
          if (key === 'date_of_birth') return [key, value || null]
          return [key, typeof value === 'string' ? value.trim() : value]
        }),
      )
    }
    setSaving(true)
    try {
      const updated = await onUpdate(payload)
      const next = personalValues(updated)
      setInitial(next)
      setValues(next)
      setErrors({})
      toast.success('Profile updated', 'Your details are saved.')
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error('Could not update profile', getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  const today = formatDateInput(new Date())

  return (
    <Card as="section" aria-labelledby="personal-info-heading">
      <form noValidate onSubmit={handleSubmit}>
        <CardHeader
          icon={UserRound}
          title={<span id="personal-info-heading">Personal information</span>}
          description={
            isCitizen
              ? 'Your name and contact details. Officers see your name and phone on complaints you report.'
              : 'Your name and contact details as shown to colleagues and citizens.'
          }
        />
        <CardBody className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="First name" htmlFor="profile-first-name" required error={errors.first_name}>
              <Input
                id="profile-first-name"
                autoComplete="given-name"
                maxLength={150}
                value={values.first_name}
                onChange={(event) => update('first_name', event.target.value)}
              />
            </FormField>
            <FormField label="Last name" htmlFor="profile-last-name" error={errors.last_name}>
              <Input
                id="profile-last-name"
                autoComplete="family-name"
                maxLength={150}
                value={values.last_name}
                onChange={(event) => update('last_name', event.target.value)}
              />
            </FormField>
            <FormField
              label="Email"
              htmlFor="profile-email"
              hint={
                profile.role === 'admin'
                  ? 'This is your login email.'
                  : 'This is your login. Contact an administrator to change it.'
              }
            >
              <Input id="profile-email" type="email" value={profile.email} readOnly />
            </FormField>
            <FormField label="Mobile number" htmlFor="profile-phone" error={errors.phone}>
              <Input
                id="profile-phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={20}
                value={values.phone}
                onChange={(event) => update('phone', event.target.value)}
              />
            </FormField>
          </div>

          {isCitizen ? (
            <fieldset className="min-w-0 space-y-4 border-t border-line pt-5">
              <legend className="sr-only">Home address and preferences</legend>
              <p aria-hidden className="text-sm font-semibold text-ink">
                Home address and preferences
              </p>
              <FormField label="Address" htmlFor="profile-address" error={errors.address}>
                <Input
                  id="profile-address"
                  autoComplete="street-address"
                  value={values.address}
                  onChange={(event) => update('address', event.target.value)}
                />
              </FormField>
              <div className="grid gap-4 sm:grid-cols-3">
                <FormField label="Area" htmlFor="profile-area" error={errors.area}>
                  <Input id="profile-area" value={values.area} onChange={(event) => update('area', event.target.value)} />
                </FormField>
                <FormField label="City" htmlFor="profile-city" error={errors.city}>
                  <Input
                    id="profile-city"
                    autoComplete="address-level2"
                    value={values.city}
                    onChange={(event) => update('city', event.target.value)}
                  />
                </FormField>
                <FormField label="PIN code" htmlFor="profile-pincode" error={errors.pincode}>
                  <Input
                    id="profile-pincode"
                    inputMode="numeric"
                    autoComplete="postal-code"
                    maxLength={10}
                    value={values.pincode}
                    onChange={(event) => update('pincode', event.target.value)}
                  />
                </FormField>
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <FormField label="Date of birth" htmlFor="profile-dob" error={errors.date_of_birth}>
                  <Input
                    id="profile-dob"
                    type="date"
                    max={today}
                    value={values.date_of_birth}
                    onChange={(event) => update('date_of_birth', event.target.value)}
                  />
                </FormField>
                <FormField label="Gender" htmlFor="profile-gender" error={errors.gender}>
                  <Select
                    id="profile-gender"
                    placeholder="Not set"
                    options={GENDER_OPTIONS}
                    value={values.gender}
                    onChange={(event) => update('gender', event.target.value)}
                  />
                </FormField>
                <FormField label="Preferred language" htmlFor="profile-language" error={errors.preferred_language}>
                  <Select
                    id="profile-language"
                    options={languageOptions}
                    value={values.preferred_language}
                    onChange={(event) => update('preferred_language', event.target.value)}
                  />
                </FormField>
              </div>
              <Switch
                label="Email me about my complaints"
                description="Status changes, resolutions and feedback requests. In-app notifications are always on."
                checked={values.email_notifications}
                onCheckedChange={(checked) => update('email_notifications', checked)}
              />
              {errors.email_notifications ? (
                <p className="text-xs font-medium text-signal-600 dark:text-signal-300">{errors.email_notifications}</p>
              ) : null}
            </fieldset>
          ) : null}
        </CardBody>
        <CardFooter>
          <p className="mr-auto text-xs text-ink-3" aria-live="polite">
            {changed.length ? `${changed.length} unsaved ${changed.length === 1 ? 'change' : 'changes'}` : 'All changes saved'}
          </p>
          <Button
            variant="ghost"
            leftIcon={Undo2}
            onClick={() => {
              setValues(initial)
              setErrors({})
            }}
            disabled={!changed.length || saving}
          >
            Discard changes
          </Button>
          <Button type="submit" leftIcon={Save} loading={saving} disabled={!changed.length}>
            Save changes
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

export function OfficerSummary({ profile }) {
  const officer = profile.officer_profile
  if (!officer) return null
  const active = Number(officer.active_workload) || 0
  const capacity = Number(officer.max_active_complaints) || 0
  const ratio = capacity > 0 ? active / capacity : 0
  const tone = ratio > 1 ? 'red' : ratio >= 0.8 ? 'yellow' : 'green'
  const skills = Array.isArray(officer.skills) ? officer.skills.filter(Boolean) : []
  return (
    <Card as="section" aria-labelledby="officer-profile-heading">
      <CardHeader
        icon={ShieldCheck}
        title={<span id="officer-profile-heading">Officer profile</span>}
        description="Managed by your administrator. Ask them to change your department, zone or capacity."
      />
      <CardBody className="space-y-5">
        <KeyValueList
          columns={2}
          items={[
            { label: 'Department', value: <DepartmentBadge department={officer.department} size="sm" /> },
            { label: 'Employee ID', value: <span className="tabular">{officer.employee_id}</span> },
            { label: 'Designation', value: officer.designation },
            { label: 'Zone', value: officer.zone },
            {
              label: 'Availability',
              value: (
                <Badge tone={officer.is_available ? 'green' : 'neutral'} size="sm" dot>
                  {officer.is_available ? 'Available for new assignments' : 'Not taking new assignments'}
                </Badge>
              ),
            },
            { label: 'Joined', value: officer.joined_on ? formatDate(officer.joined_on) : null },
            officer.base_latitude != null && officer.base_longitude != null
              ? {
                  label: 'Base location',
                  value: (
                    <span className="tabular">
                      {Number(officer.base_latitude).toFixed(4)}, {Number(officer.base_longitude).toFixed(4)}
                    </span>
                  ),
                }
              : null,
          ]}
        />
        <div className="border-t border-line pt-4">
          <ProgressBar
            value={Math.min(active, capacity || active)}
            max={capacity || 1}
            tone={tone}
            label="Active workload"
            showValue
            valueLabel={`${formatNumber(active)} of ${formatNumber(capacity)} complaints`}
          />
          {ratio > 1 ? (
            <p className="mt-1.5 text-xs font-medium text-signal-600 dark:text-signal-300">
              Over capacity: new complaints go to colleagues first.
            </p>
          ) : null}
        </div>
        {skills.length ? (
          <div>
            <p className="mb-2 text-xs font-medium text-ink-3">Skills</p>
            <ul className="flex flex-wrap gap-1.5">
              {skills.map((skill) => (
                <li key={skill} className="rounded-md bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2 ring-1 ring-inset ring-line">
                  {skill}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardBody>
    </Card>
  )
}

function PasswordInput({ id, value, onChange, autoComplete, visible, onToggle }) {
  return (
    <Input
      id={id}
      type={visible ? 'text' : 'password'}
      autoComplete={autoComplete}
      value={value}
      onChange={onChange}
      rightSlot={
        <IconButton icon={visible ? EyeOff : Eye} label={visible ? 'Hide password' : 'Show password'} size="sm" onClick={onToggle} />
      }
    />
  )
}

const EMPTY_PASSWORDS = { old_password: '', new_password: '', confirm_password: '' }

export function ChangePasswordForm() {
  const toast = useToast()
  const [values, setValues] = useState(EMPTY_PASSWORDS)
  const [visible, setVisible] = useState({})
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const update = (key, value) => {
    setValues((current) => ({ ...current, [key]: value }))
    setErrors((current) => (current[key] || current.non_field_errors ? { ...current, [key]: undefined, non_field_errors: undefined } : current))
  }
  const toggle = (key) => setVisible((current) => ({ ...current, [key]: !current[key] }))

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (saving) return
    const local = {}
    if (!values.old_password) local.old_password = 'Enter your current password.'
    if (!values.new_password) local.new_password = 'Choose a new password.'
    else if (values.new_password.length < 8) local.new_password = 'Use at least 8 characters.'
    else if (values.new_password === values.old_password) local.new_password = 'The new password must be different from the current one.'
    if (values.new_password && values.confirm_password !== values.new_password) local.confirm_password = 'The passwords do not match.'
    if (Object.keys(local).length) {
      setErrors(local)
      return
    }
    setSaving(true)
    try {
      // The API ends every earlier session of the account and returns a fresh token pair for this one.
      const body = await authService.changePassword(values)
      const renewed = Boolean(body?.access)
      if (renewed) setTokens({ access: body.access, refresh: body.refresh })
      setValues(EMPTY_PASSWORDS)
      setVisible({})
      setErrors({})
      toast.success(
        'Password changed',
        renewed ? 'You stay signed in here; your other devices were signed out.' : 'Use your new password the next time you log in.',
      )
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error('Could not change password', getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card as="section" aria-labelledby="password-heading">
      <form noValidate onSubmit={handleSubmit}>
        <CardHeader
          icon={KeyRound}
          title={<span id="password-heading">Change password</span>}
          description="Use at least 8 characters that are not only numbers, and avoid your name or a common word."
        />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          <FormField label="Current password" htmlFor="password-old" required error={errors.old_password}>
            <PasswordInput
              id="password-old"
              autoComplete="current-password"
              value={values.old_password}
              onChange={(event) => update('old_password', event.target.value)}
              visible={visible.old_password}
              onToggle={() => toggle('old_password')}
            />
          </FormField>
          <FormField label="New password" htmlFor="password-new" required error={errors.new_password}>
            <PasswordInput
              id="password-new"
              autoComplete="new-password"
              value={values.new_password}
              onChange={(event) => update('new_password', event.target.value)}
              visible={visible.new_password}
              onToggle={() => toggle('new_password')}
            />
          </FormField>
          <FormField label="Confirm new password" htmlFor="password-confirm" required error={errors.confirm_password}>
            <PasswordInput
              id="password-confirm"
              autoComplete="new-password"
              value={values.confirm_password}
              onChange={(event) => update('confirm_password', event.target.value)}
              visible={visible.confirm_password}
              onToggle={() => toggle('confirm_password')}
            />
          </FormField>
          {errors.non_field_errors ? (
            <p role="alert" className="text-xs font-medium text-signal-600 sm:col-span-3 dark:text-signal-300">
              {errors.non_field_errors}
            </p>
          ) : null}
        </CardBody>
        <CardFooter>
          <Button type="submit" leftIcon={KeyRound} loading={saving}>
            Change password
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}
