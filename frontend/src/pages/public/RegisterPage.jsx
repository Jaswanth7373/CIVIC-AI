/**
 * Create an account (public, guests only). Public sign-up always creates a CITIZEN account
 * (POST /api/auth/register/ through `useAuth().register()`, which also signs the person in); GuestRoute
 * then sends them to the citizen dashboard (or a safe `?next=` path, e.g. back to "Report an issue").
 *
 * Validation mirrors the server so most mistakes are caught while typing: required names and email, phone
 * format (7-15 digits), password rules with live strength hints, matching confirmation and the consent
 * checkbox. Server messages (email already registered, common password ...) appear under their field.
 *
 * Feedback (AuthShell): a well-formed email gets a sign-green tick, the strength meter fills segment by segment
 * and each rule ticks off as it is met, the confirmation says when it matches; while the request runs the AI scan
 * passes over the card; a failed attempt jolts the card and errors ease in under their fields. Reduced motion
 * keeps every state, without the movement.
 */
import { Bell, Check, Circle, MapPinPlus, Route, Star, UserPlus } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Checkbox } from '@/components/ui/Checkbox'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { toneBar } from '@/components/ui/tones'
import { useAuth } from '@/hooks/useAuth'
import { useConfig } from '@/hooks/useConfig'
import { useToast } from '@/hooks/useToast'
import { cn } from '@/utils/cn'
import { getErrorMessage, getErrorStatus, getFieldErrors } from '@/utils/errors'
import { AuthShell } from './components/AuthShell'
import { EMAIL_PATTERN, isValidPhone, passwordChecks, passwordStrength, withNext } from './components/authUtils'
import { FormAlert } from './components/FormAlert'
import { retryAfterSeconds } from './components/landing/demoUtils'
import { PasswordInput } from './components/PasswordInput'
import { ValidTick } from './components/ValidTick'

const FIELD_ORDER = ['first_name', 'last_name', 'email', 'phone', 'password', 'confirm_password', 'terms']

const EMPTY = { first_name: '', last_name: '', email: '', phone: '', password: '', confirm_password: '', terms: false }

function validate(values) {
  const errors = {}
  if (!values.first_name.trim()) errors.first_name = 'Enter your first name.'
  const email = values.email.trim()
  if (!email) errors.email = 'Enter your email address.'
  else if (!EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email address, like name@example.com.'
  if (!isValidPhone(values.phone)) errors.phone = 'Enter a valid phone number: 7 to 15 digits, optionally starting with +.'
  if (!values.password) errors.password = 'Choose a password.'
  else if (values.password.length < 8) errors.password = 'Use at least 8 characters.'
  else if (/^\d+$/.test(values.password)) errors.password = "A password can't be only numbers."
  if (!values.confirm_password) errors.confirm_password = 'Type the password again.'
  else if (values.confirm_password !== values.password) errors.confirm_password = "The passwords don't match."
  if (!values.terms) errors.terms = 'Accept the terms to create your account.'
  return errors
}

function PasswordHints({ password, checks, strength }) {
  if (!password) {
    return <p className="text-xs text-ink-3">At least 8 characters. Common passwords such as “password123” are refused.</p>
  }
  return (
    <div aria-live="polite">
      <div className="flex items-center gap-3">
        <div aria-hidden className="grid flex-1 grid-cols-4 gap-1">
          {[1, 2, 3, 4].map((step) => (
            <span key={step} className="relative h-1.5 overflow-hidden rounded-full bg-sunken">
              {/* Each segment fills from the left, one after another, in the colour of the current level. */}
              <span
                className={cn(
                  'absolute inset-0 origin-left rounded-full transition-[scale,background-color] duration-300 ease-standard',
                  toneBar[strength.tone],
                  step <= strength.score ? 'scale-x-100' : 'scale-x-0',
                )}
                style={{ transitionDelay: `${(step - 1) * 45}ms` }}
              />
            </span>
          ))}
        </div>
        <span className="w-14 text-right text-xs font-semibold text-ink">{strength.label}</span>
      </div>
      <ul className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        {checks.map((check) => (
          <li
            key={check.key}
            className={cn('flex items-center gap-1.5 transition-colors duration-200', check.met ? 'text-sign-700 dark:text-sign-300' : 'text-ink-3')}
          >
            {check.met ? (
              <Check aria-hidden className="size-3.5 shrink-0 animate-pop-in" strokeWidth={3} />
            ) : (
              <Circle aria-hidden className="size-3 shrink-0" />
            )}
            <span>
              {check.label}
              <span className="sr-only">{check.met ? ' (done)' : ' (not yet)'}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export default function RegisterPage() {
  const { register } = useAuth()
  const { reopenWindowDays } = useConfig()
  const toast = useToast()
  const [searchParams] = useSearchParams()
  const next = searchParams.get('next')
  const [values, setValues] = useState(EMPTY)
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const fieldRefs = useRef({})

  const checks = passwordChecks(values.password, {
    firstName: values.first_name,
    lastName: values.last_name,
    email: values.email,
  })
  const strength = passwordStrength(values.password, checks)
  const confirmMatches = Boolean(values.confirm_password) && values.confirm_password === values.password

  const bind = (field) => ({
    ref: (element) => {
      fieldRefs.current[field] = element
    },
    value: values[field],
    onChange: (event) => {
      const { value } = event.target
      setValues((current) => ({ ...current, [field]: value }))
      if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }))
    },
  })

  const focusFirstError = (found) => {
    const field = FIELD_ORDER.find((key) => found[key])
    if (field) fieldRefs.current[field]?.focus()
  }

  const submit = async (event) => {
    event.preventDefault()
    const found = validate(values)
    setErrors(found)
    setFormError('')
    if (Object.values(found).some(Boolean)) {
      setAttempt((count) => count + 1)
      focusFirstError(found)
      return
    }
    setSubmitting(true)
    try {
      const user = await register({
        first_name: values.first_name.trim(),
        last_name: values.last_name.trim(),
        email: values.email.trim(),
        phone: values.phone.trim(),
        password: values.password,
        confirm_password: values.confirm_password,
      })
      toast.success('Account created', `Welcome to CivicAI, ${user?.first_name || values.first_name.trim()}.`)
    } catch (error) {
      const fields = getFieldErrors(error)
      const mapped = Object.fromEntries(FIELD_ORDER.filter((key) => fields[key]).map((key) => [key, fields[key]]))
      setErrors(mapped)
      if (getErrorStatus(error) === 429) {
        setFormError(`Too many sign-ups from this network. Wait ${retryAfterSeconds(error)} seconds, then try again.`)
      } else if (!Object.keys(mapped).length) {
        setFormError(getErrorMessage(error, 'Your account could not be created. Try again.'))
      }
      focusFirstError(mapped)
      setAttempt((count) => count + 1)
      setSubmitting(false)
    }
  }

  const emailLooksValid = !errors.email && EMAIL_PATTERN.test(values.email.trim())

  const benefits = [
    { icon: MapPinPlus, title: 'Report in under a minute', text: 'A photo, a sentence and a pin on the map. The AI fills in the rest.' },
    { icon: Route, title: 'Follow every step', text: 'See who has your complaint and what happened to it, on one timeline.' },
    { icon: Bell, title: 'Hear about changes', text: 'Get a notification when it is assigned, resolved or verified.' },
    {
      icon: Star,
      title: 'Have the last word',
      text: `Rate the fix, and reopen the complaint within ${reopenWindowDays} days if it did not hold.`,
    },
  ]

  return (
    <AuthShell
      title="Create your account"
      tagline="One account to report an issue, follow it to the fix and rate the result."
      busy={submitting}
      attempt={attempt}
      lead={<p>Citizen accounts are free. Report civic issues, follow them to the fix and rate the result.</p>}
      footer={
        <p>
          Already have an account?{' '}
          <Link to={withNext('/login', next)} className="font-semibold text-primary-ink underline-offset-4 hover:underline">
            Log in
          </Link>
        </p>
      }
      aside={
        <section aria-labelledby="account-benefits-title">
          <h2 id="account-benefits-title" className="font-display text-lg font-bold text-ink">
            What your account is for
          </h2>
          <ul className="mt-5 grid gap-x-6 gap-y-5 sm:grid-cols-2">
            {benefits.map((benefit) => (
              <li key={benefit.title} className="flex gap-3.5">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2">
                  <benefit.icon aria-hidden className="size-5" />
                </span>
                <div className="min-w-0">
                  <p className="font-semibold leading-snug text-ink">{benefit.title}</p>
                  <p className="mt-0.5 text-sm text-ink-2">{benefit.text}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-6 text-xs text-ink-3">Officer and administrator accounts are created by the city administration.</p>
        </section>
      }
    >
      <form onSubmit={submit} noValidate className="space-y-5">
        <FormAlert message={formError} title="Your account wasn't created" />

        <div className="grid gap-5 sm:grid-cols-2">
          <FormField label="First name" htmlFor="register-first-name" error={errors.first_name} required>
            <Input id="register-first-name" autoComplete="given-name" maxLength={150} {...bind('first_name')} />
          </FormField>
          <FormField label="Last name" htmlFor="register-last-name" error={errors.last_name} optional>
            <Input id="register-last-name" autoComplete="family-name" maxLength={150} {...bind('last_name')} />
          </FormField>
        </div>

        <FormField label="Email" htmlFor="register-email" error={errors.email} required hint="You log in with this address.">
          <Input
            id="register-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={254}
            placeholder="name@example.com"
            rightSlot={<ValidTick show={emailLooksValid} />}
            {...bind('email')}
          />
        </FormField>

        <FormField
          label="Phone"
          htmlFor="register-phone"
          error={errors.phone}
          optional
          hint="Officers may call you if they cannot find the spot."
        >
          <Input id="register-phone" type="tel" inputMode="tel" autoComplete="tel" maxLength={20} placeholder="+91 98765 43210" {...bind('phone')} />
        </FormField>

        <FormField label="Password" htmlFor="register-password" error={errors.password} required>
          <PasswordInput id="register-password" autoComplete="new-password" maxLength={128} {...bind('password')} />
        </FormField>
        <div className="-mt-2">
          <PasswordHints password={values.password} checks={checks} strength={strength} />
        </div>

        <FormField
          label="Confirm password"
          htmlFor="register-confirm-password"
          error={errors.confirm_password}
          required
          hint={confirmMatches ? 'The passwords match.' : undefined}
        >
          <PasswordInput id="register-confirm-password" autoComplete="new-password" maxLength={128} {...bind('confirm_password')} />
        </FormField>

        <div>
          <Checkbox
            id="register-terms"
            ref={(element) => {
              fieldRefs.current.terms = element
            }}
            checked={values.terms}
            onCheckedChange={(checked) => {
              setValues((current) => ({ ...current, terms: checked }))
              if (errors.terms) setErrors((current) => ({ ...current, terms: undefined }))
            }}
            aria-invalid={errors.terms ? true : undefined}
            aria-describedby={errors.terms ? 'register-terms-description register-terms-error' : 'register-terms-description'}
            label="I agree to these terms"
            description="My reports are accurate, and CivicAI may share them, with my name and contact details, with the municipal departments that resolve them."
          />
          {errors.terms ? (
            <p
              id="register-terms-error"
              className="mt-1.5 text-xs font-medium text-signal-600 transition-[opacity,translate] duration-200 ease-standard starting:-translate-y-1 starting:opacity-0 dark:text-signal-300"
            >
              {errors.terms}
            </p>
          ) : null}
        </div>

        <Button type="submit" size="lg" fullWidth leftIcon={UserPlus} loading={submitting}>
          Create account
        </Button>
      </form>
    </AuthShell>
  )
}
