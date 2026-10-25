/**
 * Log in (public, guests only - GuestRoute sends a logged-in user to `?next=` or their dashboard).
 *
 * Email + password (with show / hide) through `useAuth().login()`. Problems are explained where they
 * happen: missing or malformed fields under each input, wrong credentials / deactivated account / rate limit
 * in an alert above the form. After a successful login GuestRoute redirects to the safe `?next=` path or the
 * role dashboard. A "Demo accounts" panel that fills in the form for each role appears only when the API
 * publishes demo accounts (`demo_accounts` in /api/system/config/, an explicit server setting - not Demo AI
 * Mode) or on the development server; production bundles contain no demo credentials (see authUtils).
 * Otherwise the side panel explains where each role lands and who helps when logging in fails.
 *
 * Feedback (AuthShell): a sign-green tick appears in the email field once the address is well formed; picking a
 * demo account flashes the two fields it filled; while the request runs the AI scan passes over the card; a
 * failed attempt jolts the card. Reduced motion keeps the tick and the messages, without the movement.
 */
import { LogIn } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { FormField } from '@/components/ui/FormField'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { Input } from '@/components/ui/Input'
import { useAuth } from '@/hooks/useAuth'
import { useConfig } from '@/hooks/useConfig'
import { useToast } from '@/hooks/useToast'
import { getErrorMessage, getErrorStatus, getFieldErrors } from '@/utils/errors'
import { AuthShell } from './components/AuthShell'
import { EMAIL_PATTERN, demoAccountsFrom, nextPurpose, withNext } from './components/authUtils'
import { DemoAccounts } from './components/DemoAccounts'
import { FormAlert } from './components/FormAlert'
import { retryAfterSeconds } from './components/landing/demoUtils'
import { LoginHelp } from './components/LoginHelp'
import { flashFilled } from './components/formMotion'
import { PasswordInput } from './components/PasswordInput'
import { ValidTick } from './components/ValidTick'

function validate(values) {
  const errors = {}
  const email = values.email.trim()
  if (!email) errors.email = 'Enter your email address.'
  else if (!EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email address, like name@example.com.'
  if (!values.password) errors.password = 'Enter your password.'
  return errors
}

export default function LoginPage() {
  const { login } = useAuth()
  const { config, loaded: configLoaded, error: configError } = useConfig()
  const toast = useToast()
  const [searchParams] = useSearchParams()
  const next = searchParams.get('next')
  const [values, setValues] = useState({ email: '', password: '' })
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const reduced = usePrefersReducedMotion()
  const emailRef = useRef(null)
  const passwordRef = useRef(null)
  const submitRef = useRef(null)
  const demoAccounts = demoAccountsFrom(config)
  // Until the API has answered it is unknown whether it publishes demo accounts: show no side panel yet
  // rather than swapping the help panel for the demo accounts a moment later.
  const configSettled = configLoaded || Boolean(configError)

  const update = (field) => (event) => {
    const { value } = event.target
    setValues((current) => ({ ...current, [field]: value }))
    if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }))
  }

  const pickDemoAccount = (account) => {
    setValues({ email: account.email, password: account.password })
    setErrors({})
    setFormError('')
    if (!reduced) flashFilled([emailRef.current, passwordRef.current])
    submitRef.current?.focus()
  }

  const submit = async (event) => {
    event.preventDefault()
    const found = validate(values)
    setErrors(found)
    setFormError('')
    if (found.email || found.password) {
      setAttempt((count) => count + 1)
      const firstInvalid = found.email ? emailRef : passwordRef
      firstInvalid.current?.focus()
      return
    }
    setSubmitting(true)
    try {
      const user = await login({ email: values.email.trim(), password: values.password })
      toast.success('Logged in', `Welcome back, ${user?.first_name || user?.full_name || 'to CivicAI'}.`)
    } catch (error) {
      const fields = getFieldErrors(error)
      setErrors({ email: fields.email, password: fields.password })
      if (getErrorStatus(error) === 429) {
        setFormError(`Too many login attempts from this network. Wait ${retryAfterSeconds(error)} seconds, then try again.`)
      } else if (!fields.email && !fields.password) {
        setFormError(getErrorMessage(error, 'Logging in failed. Try again.'))
      }
      setAttempt((count) => count + 1)
      setSubmitting(false)
    }
  }

  const emailLooksValid = !errors.email && EMAIL_PATTERN.test(values.email.trim())

  return (
    <AuthShell
      title="Log in to CivicAI"
      documentTitle="Log in"
      busy={submitting}
      attempt={attempt}
      lead={
        <p>
          {nextPurpose(next) ??
            'Citizens follow their reports, officers work their queue and administrators run the city dashboards.'}
        </p>
      }
      footer={
        <p>
          New to CivicAI?{' '}
          <Link to={withNext('/register', next)} className="font-semibold text-primary-ink underline-offset-4 hover:underline">
            Create a citizen account
          </Link>
        </p>
      }
      aside={
        demoAccounts.length ? (
          <DemoAccounts accounts={demoAccounts} onPick={pickDemoAccount} activeEmail={values.email} />
        ) : configSettled ? (
          <LoginHelp />
        ) : null
      }
    >
      <form onSubmit={submit} noValidate className="space-y-5">
        <FormAlert message={formError} title="You're not logged in yet" />

        <FormField label="Email" htmlFor="login-email" error={errors.email} required>
          <Input
            ref={emailRef}
            id="login-email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={values.email}
            onChange={update('email')}
            placeholder="name@example.com"
            rightSlot={<ValidTick show={emailLooksValid} />}
          />
        </FormField>

        <FormField label="Password" htmlFor="login-password" error={errors.password} required>
          <PasswordInput
            ref={passwordRef}
            id="login-password"
            autoComplete="current-password"
            value={values.password}
            onChange={update('password')}
          />
        </FormField>

        <Button ref={submitRef} type="submit" size="lg" fullWidth leftIcon={LogIn} loading={submitting}>
          Log in
        </Button>
      </form>
    </AuthShell>
  )
}
