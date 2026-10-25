/**
 * Contact (public). A working message form (POST /api/contact/ via systemService.contact, rate limited)
 * with validation that mirrors the server, field errors from the API and a success state; plus an
 * emergency-numbers panel and the live list of department desks (GET /api/departments/, public) with
 * their response targets and open workload.
 *
 * Signed-in visitors get their name and email filled in.
 *
 * Feedback and motion (final states with reduced motion): a well-formed email gets a sign-green tick; while the
 * message is sent the AI scan passes over the form card (the auth forms' language); a failed send jolts the
 * card; a sent message swaps the form for a confirmation whose tick draws itself. The department desks arrive
 * one after another on their first load.
 */
import { Mail, MapPinPlus, Phone, Send, Siren } from 'lucide-react'
import { AnimatePresence, motion, useAnimate } from 'framer-motion'
import { useEffect, useState } from 'react'
import { DepartmentBadge } from '@/components/complaints/DepartmentBadge'
import { DrawPath } from '@/components/motion/DrawPath'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { Stagger, StaggerItem } from '@/components/motion/Stagger'
import { EASE } from '@/components/motion/tokens'
import { Button } from '@/components/ui/Button'
import { ErrorState } from '@/components/ui/ErrorState'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Skeleton } from '@/components/ui/Skeleton'
import { Textarea } from '@/components/ui/Textarea'
import { useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { useToast } from '@/hooks/useToast'
import { departmentService } from '@/services/departmentService'
import { systemService } from '@/services/systemService'
import { getErrorMessage, getErrorStatus, getFieldErrors } from '@/utils/errors'
import { formatHours, formatNumber } from '@/utils/format'
import { EMAIL_PATTERN } from './components/authUtils'
import { retryAfterSeconds } from './components/landing/demoUtils'
import { MUTED_TEXT_AA } from './components/contrast'
import { FormAlert } from './components/FormAlert'
import { PageIntro } from './components/PageIntro'
import { Container } from './components/Section'
import { ValidTick } from './components/ValidTick'
import '@/styles/public.css'

const MESSAGE_LIMIT = 5000
const FIELD_ORDER = ['name', 'email', 'subject', 'message']

/** Indian national emergency numbers (Emergency Response Support System and the classic services). */
const EMERGENCY_NUMBERS = [
  { label: 'Police', number: '100' },
  { label: 'Fire', number: '101' },
  { label: 'Ambulance', number: '108' },
]

function validate(values) {
  const errors = {}
  if (values.name.trim().length < 2) errors.name = 'Enter your name (at least 2 characters).'
  const email = values.email.trim()
  if (!email) errors.email = 'Enter your email address so the team can reply.'
  else if (!EMAIL_PATTERN.test(email)) errors.email = 'Enter a valid email address, like name@example.com.'
  if (values.subject.trim().length < 3) errors.subject = 'Add a short subject (at least 3 characters).'
  if (values.message.trim().length < 10) errors.message = 'Write a little more: at least 10 characters.'
  return errors
}

/**
 * Emergency numbers in the page's aside. A plain panel with a guide-blue chip: the sign-panel border is
 * reserved for the logo and the landing hero headline (BUILD_SPEC 5.2).
 */
function EmergencyNumbers() {
  return (
    <section aria-labelledby="emergency-title" className="rounded-xl border border-line bg-surface-2 p-5">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-guide-600 text-white">
          <Siren aria-hidden className="size-5" />
        </span>
        <div className="min-w-0">
          <h2 id="emergency-title" className="font-display text-lg font-bold leading-tight text-ink">
            Someone in danger?
          </h2>
          <p className="mt-1 text-sm text-ink-2">Call the emergency number first, then report the issue here.</p>
        </div>
      </div>
      <a
        href="tel:112"
        className="mt-4 inline-flex items-baseline gap-3 rounded-md font-display font-black leading-none text-guide-700 underline-offset-4 hover:underline dark:text-guide-300"
      >
        <span className="text-6xl">112</span>
        <span className="text-base font-bold text-ink">Emergency</span>
      </a>
      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-3">
        {EMERGENCY_NUMBERS.map((item) => (
          <li key={item.number}>
            <a href={`tel:${item.number}`} className="inline-flex items-baseline gap-1.5 text-sm underline-offset-4 hover:underline pointer-coarse:min-h-11 pointer-coarse:pt-2">
              <span className="text-ink-2">{item.label}</span>
              <span className="font-display text-lg font-extrabold text-ink">{item.number}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

function DepartmentDesks() {
  const { data, loading, error, refetch } = useApi(() => departmentService.list(), [])
  const departments = Array.isArray(data) ? data : []

  return (
    <section aria-labelledby="desks-title" className="rounded-xl border border-line bg-surface">
      <div className="border-b border-line px-5 py-4">
        <h2 id="desks-title" className="font-display text-lg font-bold text-ink">
          Department desks
        </h2>
        <p className="mt-1 text-sm text-ink-2">
          Civic problems go straight to these desks when you report them. Response targets are the departments' own.
        </p>
      </div>
      {loading && !departments.length ? (
        <div aria-hidden className="space-y-4 px-5 py-4">
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <Skeleton className="h-6 w-44" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      ) : error && !departments.length ? (
        <ErrorState compact bordered={false} title="Departments could not load" error={error} onRetry={() => refetch()} />
      ) : (
        <Stagger as="ul" className="divide-y divide-line" y={8}>
          {departments.map((department, index) => (
            <StaggerItem as="li" key={department.id} index={index} className="px-5 py-3">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                <DepartmentBadge department={department} />
                <span className="text-sm text-ink-2">
                  responds within <span className="font-semibold text-ink">{formatHours(department.sla_hours)}</span>
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-3 pointer-coarse:mt-0.5 pointer-coarse:gap-y-0">
                <span>
                  {formatNumber(department.open_complaints)} open {Number(department.open_complaints) === 1 ? 'complaint' : 'complaints'}
                </span>
                {department.phone ? (
                  <a href={`tel:${department.phone}`} className="inline-flex items-center gap-1 font-semibold text-primary-ink hover:underline pointer-coarse:min-h-11">
                    <Phone aria-hidden className="size-3.5" />
                    {department.phone}
                  </a>
                ) : null}
                {department.email ? (
                  <a href={`mailto:${department.email}`} className="inline-flex items-center gap-1 font-semibold text-primary-ink hover:underline pointer-coarse:min-h-11">
                    <Mail aria-hidden className="size-3.5" />
                    {department.email}
                  </a>
                ) : null}
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </section>
  )
}

/**
 * Confirmation that replaces the form: a sign-green disc whose tick draws itself, the heading and who the reply
 * goes to. `role="status"` announces it.
 */
function SentConfirmation({ sent, onAnother }) {
  return (
    <div role="status" className="flex flex-col items-start gap-4 py-6">
      <span className="grid size-14 place-items-center rounded-full bg-sign-50 text-sign-700 dark:bg-sign-500/15 dark:text-sign-300">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="size-8" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <DrawPath as="circle" cx="12" cy="12" r="9.5" duration={0.6} />
          <DrawPath d="M7.6 12.4 10.6 15.3 16.6 9" duration={0.42} delay={0.42} />
        </svg>
      </span>
      <div>
        <h2 className="font-display text-2xl font-extrabold text-ink">Message sent</h2>
        <p className="mt-2 text-base leading-relaxed text-ink-2">
          Thanks, {sent.name}. The CivicAI team will reply to <span className="font-semibold text-ink">{sent.email}</span>.
        </p>
      </div>
      <Button variant="outline" leftIcon={Send} onClick={onAnother}>
        Send another message
      </Button>
    </div>
  )
}

export default function ContactPage() {
  const { user, role } = useAuth()
  const toast = useToast()
  const canReport = !user || role === 'citizen'
  const [values, setValues] = useState(() => ({
    name: user?.full_name ?? '',
    email: user?.email ?? '',
    subject: '',
    message: '',
  }))
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(null)
  const reduced = usePrefersReducedMotion()
  const [cardRef, animateCard] = useAnimate()

  /** A failed send jolts the form card sideways once (never with reduced motion). */
  const jolt = () => {
    if (reduced || !cardRef.current) return
    animateCard(cardRef.current, { x: [0, -9, 8, -5, 3, 0] }, { duration: 0.46, ease: 'easeOut' })
  }

  // The session may still be restoring on the first render: fill the visitor's name and email once known,
  // without overwriting anything they already typed.
  useEffect(() => {
    if (!user) return
    setValues((current) => ({
      ...current,
      name: current.name || user.full_name || '',
      email: current.email || user.email || '',
    }))
  }, [user])

  const bind = (field) => ({
    value: values[field],
    onChange: (event) => {
      const { value } = event.target
      setValues((current) => ({ ...current, [field]: value }))
      if (errors[field]) setErrors((current) => ({ ...current, [field]: undefined }))
    },
  })

  const focusField = (found) => {
    const field = FIELD_ORDER.find((key) => found[key])
    if (field) document.getElementById(`contact-${field}`)?.focus()
  }

  const submit = async (event) => {
    event.preventDefault()
    const found = validate(values)
    setErrors(found)
    setFormError('')
    if (Object.values(found).some(Boolean)) {
      jolt()
      focusField(found)
      return
    }
    setSending(true)
    try {
      const payload = {
        name: values.name.trim(),
        email: values.email.trim(),
        subject: values.subject.trim(),
        message: values.message.trim(),
      }
      await systemService.contact(payload)
      setSent({ name: payload.name, email: payload.email })
      setValues((current) => ({ ...current, subject: '', message: '' }))
      toast.success('Message sent', 'The CivicAI team will reply by email.')
    } catch (error) {
      const fields = getFieldErrors(error)
      const mapped = Object.fromEntries(FIELD_ORDER.filter((key) => fields[key]).map((key) => [key, fields[key]]))
      setErrors(mapped)
      const message =
        getErrorStatus(error) === 429
          ? `Too many messages from this network. Wait ${retryAfterSeconds(error)} seconds, then send it again.`
          : getErrorMessage(error, 'Your message could not be sent. Try again.')
      if (!Object.keys(mapped).length) setFormError(message)
      toast.error('Could not send message', message)
      jolt()
      focusField(mapped)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={MUTED_TEXT_AA}>
      <PageIntro
        scene="route"
        icon={Mail}
        aside={<EmergencyNumbers />}
        title="Contact us"
        lead="Questions about CivicAI, a pilot in your ward, or a data request? Write to the team. To report a pothole, a broken streetlight or any other civic problem, use Report an issue instead: it reaches the right department directly and you can track it."
      >
        {canReport ? (
          <Button className="mt-6" variant="outline" to="/citizen/report" leftIcon={MapPinPlus}>
            Report an issue instead
          </Button>
        ) : null}
      </PageIntro>

      <section className="border-t border-line bg-bg py-12 sm:py-16">
        <Container className="grid gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start lg:gap-12">
          <div ref={cardRef} aria-busy={sending || undefined} className="relative min-w-0 rounded-2xl border border-line bg-surface p-5 sm:p-7">
            {sending ? (
              <span aria-hidden className="pub-scan">
                <span className="pub-busy-lane" />
              </span>
            ) : null}
            <AnimatePresence mode="wait" initial={false}>
              {sent ? (
                <motion.div
                  key="sent"
                  initial={reduced ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.36, ease: EASE.enter }}
                >
                  <SentConfirmation sent={sent} onAnother={() => setSent(null)} />
                </motion.div>
              ) : (
                <motion.div
                  key="form"
                  initial={reduced ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduced ? undefined : { opacity: 0, y: -6, transition: { duration: 0.16, ease: EASE.exit } }}
                  transition={{ duration: 0.36, ease: EASE.enter }}
                >
                  <form onSubmit={submit} noValidate className="space-y-5">
                    <h2 className="font-display text-xl font-bold text-ink">Write to the CivicAI team</h2>
                    <FormAlert message={formError} title="Your message wasn't sent" />
                    <div className="grid gap-5 sm:grid-cols-2">
                      <FormField label="Name" htmlFor="contact-name" error={errors.name} required>
                        <Input id="contact-name" autoComplete="name" maxLength={120} {...bind('name')} />
                      </FormField>
                      <FormField label="Email" htmlFor="contact-email" error={errors.email} required>
                        <Input
                          id="contact-email"
                          type="email"
                          inputMode="email"
                          autoComplete="email"
                          autoCapitalize="none"
                          spellCheck={false}
                          placeholder="name@example.com"
                          rightSlot={<ValidTick show={!errors.email && EMAIL_PATTERN.test(values.email.trim())} />}
                          {...bind('email')}
                        />
                      </FormField>
                    </div>
                    <FormField label="Subject" htmlFor="contact-subject" error={errors.subject} required>
                      <Input id="contact-subject" maxLength={160} placeholder="Pilot for our ward" {...bind('subject')} />
                    </FormField>
                    <FormField label="Message" htmlFor="contact-message" error={errors.message} required>
                      <Textarea id="contact-message" rows={6} maxLength={MESSAGE_LIMIT} {...bind('message')} />
                    </FormField>
                    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-xs text-ink-3">The team replies to the email address you give.</p>
                      <Button type="submit" leftIcon={Send} loading={sending} className="sm:shrink-0">
                        Send message
                      </Button>
                    </div>
                  </form>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="min-w-0">
            <DepartmentDesks />
          </div>
        </Container>
      </section>
    </div>
  )
}
