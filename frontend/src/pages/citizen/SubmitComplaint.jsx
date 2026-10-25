/**
 * Report an issue (/citizen/report) - the core citizen flow, built mobile-first as a four-step wizard:
 * Photo -> Details -> Location -> Review.
 *
 * - Photo: drag & drop or browse, preview, replace / remove, and the rear camera on phones.
 * - Details: description (10-2000 characters), optional category, incident time (now by default, never in
 *   the future), optional title. As soon as there is a photo and/or 15 characters, POST /ai/classify/ runs in
 *   the background (debounced, stale answers dropped) and a live "AI suggestion" chip offers its category.
 * - Location: LocationPicker (GPS, search, click or drag) fills the editable address fields by reverse
 *   geocoding.
 * - Review: everything at a glance, plus POST /ai/duplicates/ to show "Similar issue already reported
 *   nearby" (advisory only). The button reads "Analyze & Submit".
 *
 * Submitting sends one multipart POST /api/complaints/. While it runs, the photo (or, without one, the
 * description) sits under the AI scan (AIScanOverlay) with the real elapsed time, and AnalysisProgress shows an
 * honest indeterminate state; the response's real `analysis.steps` are then replayed, the scan locks onto the
 * region the vision model detected when the replay reaches the image step, and the summary is revealed as an
 * AI work order with "Track complaint" and "Report another issue". API field errors are mapped back to the
 * step that owns the field. Leaving with unsaved input asks for confirmation (in-app and tab close).
 *
 * Phones: the wizard's Back / Continue bar sticks to the bottom of the screen (above the tab bar) while the
 * step is longer than the screen, so the next action is always under the thumb.
 *
 * Motion: a new step slides in from the side it comes from (forward from the right, back from the left) while
 * the stepper's lane paints to it; nothing waits for an exit, so the form is usable at once. Reduced motion:
 * the step simply changes.
 */
import { motion, useReducedMotion } from 'framer-motion'
import { ArrowLeft, MapPinPlus, Route, ScanSearch } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AIScanOverlay } from '@/components/ai/AIScanOverlay'
import { AnalysisProgress } from '@/components/complaints/AnalysisProgress'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { PageHeader } from '@/components/ui/PageHeader'
import { useApi } from '@/hooks/useApi'
import { useAuth } from '@/hooks/useAuth'
import { useConfig } from '@/hooks/useConfig'
import { useNotifications } from '@/hooks/useNotifications'
import { useToast } from '@/hooks/useToast'
import { categoryService } from '@/services/categoryService'
import { complaintService } from '@/services/complaintService'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { complaintPath, trackingPath } from './components/complaintHelpers'
import { ReportRail } from './components/report/ReportRail'
import { ReportStepper } from './components/report/ReportStepper'
import { DetailsStep, LocationStep, PhotoStep, ReviewStep } from './components/report/ReportSteps'
import {
  REPORT_STEPS,
  STEP_INDEX,
  acceptFromExtensions,
  buildComplaintFormData,
  hasUserInput,
  initialReport,
  stepForErrors,
  validateUntil,
} from './components/report/reportForm'
import { useCategorySuggestion } from './components/report/useCategorySuggestion'
import { useSimilarReports } from './components/report/useSimilarReports'
import { useObjectUrl } from './components/report/useObjectUrl'
import { useLeaveGuard } from './components/useLeaveGuard'
import { useOwnComplaintIds } from './components/useOwnComplaintIds'

export default function SubmitComplaint() {
  const toast = useToast()
  const { refreshUser } = useAuth()
  const { refresh: refreshNotifications } = useNotifications()
  const { upload, maxImageMB } = useConfig()
  const reducedMotion = useReducedMotion()

  const { data: categoryData } = useApi(() => categoryService.list(), [])
  const categories = useMemo(
    () => (Array.isArray(categoryData) ? categoryData.filter((category) => category.is_active !== false) : []),
    [categoryData],
  )

  const [form, setForm] = useState(() => initialReport())
  const [step, setStep] = useState(STEP_INDEX.photo)
  const [furthest, setFurthest] = useState(STEP_INDEX.photo)
  const [errors, setErrors] = useState({})
  const [addressSource, setAddressSource] = useState(null)
  const [phase, setPhase] = useState('form') // form | submitting | done
  const [submitError, setSubmitError] = useState(null)
  const [result, setResult] = useState(null)
  // Real clock of the submission (request start / response) and how far the replay of the pipeline has got.
  const [timing, setTiming] = useState({ startedAt: null, endedAt: null })
  const [revealed, setRevealed] = useState(0)
  const photoUrl = useObjectUrl(form.image)
  // True while the photo is pre-decoded before the scan screen (a second click must not submit twice).
  const startingRef = useRef(false)
  const cardRef = useRef(null)
  const headingRef = useRef(null)
  const moveFocusRef = useRef(false)
  // Which way the wizard last moved (1 forward, -1 back): the next step slides in from that side.
  const [direction, setDirection] = useState(1)

  const suggestion = useCategorySuggestion({ image: form.image, description: form.description })
  const similar = useSimilarReports({
    enabled: phase === 'form' && step === STEP_INDEX.review,
    description: form.description,
    position: form.position,
    image: form.image,
  })
  const { ids: ownIds } = useOwnComplaintIds(similar.items.length > 0)

  const submitting = phase === 'submitting'
  useLeaveGuard((phase === 'form' && hasUserInput(form)) || submitting, {
    title: submitting ? 'Your report is still being submitted' : 'Leave without submitting?',
    message: submitting
      ? 'The AI analysis is running. If you leave now, the complaint is still created, but you will not see the result here.'
      : 'Your photo, description and location have not been sent yet and will be lost.',
    confirmLabel: 'Leave page',
    cancelLabel: submitting ? 'Stay here' : 'Keep editing',
  })

  // After a step change, bring the wizard into view and move focus to the new step's heading.
  useEffect(() => {
    if (!moveFocusRef.current) return
    moveFocusRef.current = false
    cardRef.current?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' })
    headingRef.current?.focus({ preventScroll: true })
  }, [step, reducedMotion])

  const stepRef = useRef(step)
  useEffect(() => {
    stepRef.current = step
  }, [step])

  const showStep = useCallback((index) => {
    moveFocusRef.current = true
    setDirection(index >= stepRef.current ? 1 : -1)
    setStep(index)
    setFurthest((current) => Math.max(current, index))
  }, [])

  const clearErrors = useCallback((...keys) => {
    setErrors((current) => {
      if (!keys.some((key) => key in current)) return current
      const next = { ...current }
      keys.forEach((key) => delete next[key])
      return next
    })
  }, [])

  const setField = useCallback(
    (key, value) => {
      setForm((current) => ({ ...current, [key]: value }))
      clearErrors(key === 'incidentAt' ? 'incident_at' : key, 'non_field_errors')
    },
    [clearErrors],
  )

  const handleImage = useCallback(
    (file) => {
      setForm((current) => ({ ...current, image: file }))
      clearErrors('image')
    },
    [clearErrors],
  )

  const handlePosition = useCallback(
    (position) => {
      setForm((current) => ({ ...current, position }))
      clearErrors('latitude', 'longitude')
    },
    [clearErrors],
  )

  // A new pin means a new place: the street, area, city and PIN follow it; the landmark stays the citizen's.
  // Without a street address, the first parts of the geocoder's long display name stand in for it.
  const handleAddress = useCallback(
    (found) => {
      if (!found) return
      const fallback = String(found.display_name ?? '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(', ')
      setForm((current) => ({
        ...current,
        address: {
          ...current.address,
          address: (found.address || fallback).slice(0, 255),
          area: found.area || '',
          city: found.city || '',
          pincode: found.pincode || '',
        },
      }))
      setAddressSource(found.source || 'map')
      clearErrors('address', 'area', 'city', 'pincode')
    },
    [clearErrors],
  )

  const handleAddressField = useCallback(
    (key, value) => {
      setForm((current) => ({ ...current, address: { ...current.address, [key]: value } }))
      clearErrors(key)
    },
    [clearErrors],
  )

  const goTo = (target) => {
    if (target === step || target < 0 || target >= REPORT_STEPS.length) return
    if (target > step) {
      const check = validateUntil(target, form)
      if (check.step !== -1) {
        setErrors(check.errors)
        if (check.step !== step) showStep(check.step)
        return
      }
    }
    showStep(target)
  }

  const submit = async () => {
    const check = validateUntil(STEP_INDEX.review, form)
    if (check.step !== -1) {
      setErrors(check.errors)
      showStep(check.step)
      toast.error('Some details are missing', 'Fix the highlighted fields, then submit again.')
      return
    }
    if (startingRef.current) return
    // Decode the photo before the scan screen opens, so its first frame already shows the picture (the object
    // URL is in memory: a few milliseconds; never more than 400 ms of waiting).
    if (photoUrl) {
      startingRef.current = true
      const image = new Image()
      image.src = photoUrl
      await Promise.race([image.decode().catch(() => undefined), new Promise((resolve) => window.setTimeout(resolve, 400))])
      startingRef.current = false
    }
    setPhase('submitting')
    setSubmitError(null)
    setRevealed(0)
    setTiming({ startedAt: Date.now(), endedAt: null })
    try {
      const created = await complaintService.create(buildComplaintFormData(form))
      setTiming((current) => ({ ...current, endedAt: Date.now() }))
      setResult(created)
      setPhase('done')
      window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' })
      toast.success('Complaint submitted', `${created.complaint_number} was received and analysed.`)
      refreshUser()
      refreshNotifications()
    } catch (error) {
      setPhase('form')
      const fieldErrors = getFieldErrors(error)
      if (Object.keys(fieldErrors).length) {
        setErrors(fieldErrors)
        const target = stepForErrors(fieldErrors)
        if (target !== step) showStep(target)
      } else {
        setSubmitError(error)
      }
      toast.error('Could not submit complaint', getErrorMessage(error))
    }
  }

  const handleFormSubmit = (event) => {
    event.preventDefault()
    if (submitting) return
    if (step < STEP_INDEX.review) goTo(step + 1)
    else submit()
  }

  const reportAnother = () => {
    setForm(initialReport())
    setErrors({})
    setAddressSource(null)
    setSubmitError(null)
    setResult(null)
    setStep(STEP_INDEX.photo)
    setFurthest(STEP_INDEX.photo)
    setPhase('form')
    window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' })
  }

  /* ---- After submitting: the replayed AI analysis -------------------------------------------------- */
  if (phase !== 'form') {
    const analysis = result?.analysis
    const department = analysis?.summary?.department?.name
    const steps = Array.isArray(analysis?.steps) ? analysis.steps : []
    // The scan locks on when the replay shows the step that read the evidence (image, or text without a photo).
    const lockStep = steps.findIndex((step) => step.key === (photoUrl ? 'image_analysis' : 'text_analysis'))
    const locked =
      phase === 'done' && (reducedMotion || !steps.length || revealed >= (lockStep >= 0 ? lockStep + 1 : steps.length))
    return (
      <>
        <PageHeader
          title={phase === 'submitting' ? 'Analysing your report' : 'Complaint submitted'}
          documentTitle="Report an issue"
          description={
            phase === 'submitting'
              ? 'Your report is uploading and the AI pipeline is running. This usually takes a few seconds.'
              : `${result?.complaint_number ?? 'Your complaint'} has been received${department ? ` and routed to the ${department}` : ''}.`
          }
        />
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          <div className="min-w-0 lg:sticky lg:top-24">
            <AIScanOverlay
              src={photoUrl}
              alt="Your photo of the problem"
              text={form.description.trim()}
              phase={locked ? 'locked' : 'scanning'}
              prediction={result?.ai_prediction}
              categories={categories}
              startedAt={timing.startedAt}
              endedAt={timing.endedAt}
            />
          </div>
          <div className="min-w-0">
            {submitting ? (
              <AnalysisProgress running />
            ) : analysis?.steps?.length ? (
              <AnalysisProgress
                steps={analysis.steps}
                summary={analysis.summary}
                onProgress={setRevealed}
                complaintNumber={result.complaint_number}
                actions={
                  <>
                    <Button variant="outline" leftIcon={MapPinPlus} onClick={reportAnother}>
                      Report another issue
                    </Button>
                    <Button leftIcon={Route} to={trackingPath(result.id)}>
                      Track complaint
                    </Button>
                  </>
                }
              />
            ) : (
              <Alert
                tone="success"
                title="Complaint submitted"
                action={
                  <>
                    <Button size="sm" leftIcon={Route} to={trackingPath(result.id)}>
                      Track complaint
                    </Button>
                    <Button size="sm" variant="outline" to={complaintPath(result.id)}>
                      View details
                    </Button>
                    <Button size="sm" variant="ghost" leftIcon={MapPinPlus} onClick={reportAnother}>
                      Report another issue
                    </Button>
                  </>
                }
              >
                {result?.complaint_number} was saved. The analysis details will appear on the complaint page.
              </Alert>
            )}
          </div>
        </div>
      </>
    )
  }

  /* ---- The wizard ----------------------------------------------------------------------------------- */
  const meta = REPORT_STEPS[step]
  const isReview = step === STEP_INDEX.review
  const generalError = errors.non_field_errors || (submitError ? getErrorMessage(submitError) : '')

  return (
    <>
      <PageHeader
        title="Report an issue"
        description="Add a photo, describe the problem and drop a pin. The AI identifies the issue and sends it to the right department."
      />

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <Card ref={cardRef} as="section" aria-labelledby="report-step-heading" className="scroll-mt-20">
          <div className="border-b border-line px-3 py-4 sm:px-6">
            <ReportStepper steps={REPORT_STEPS} current={step} furthest={furthest} onSelect={goTo} />
          </div>

          <form noValidate onSubmit={handleFormSubmit}>
            <div className="px-4 py-5 sm:px-6 sm:py-6">
              <p className="text-xs font-semibold text-ink-3 tabular">
                Step {step + 1} of {REPORT_STEPS.length}
              </p>
              <h2
                id="report-step-heading"
                ref={headingRef}
                tabIndex={-1}
                className="mt-0.5 font-display text-xl font-bold text-ink outline-hidden"
              >
                {meta.title}
              </h2>
              <p className="mt-1 text-sm text-ink-2">{meta.description}</p>

              <motion.div
                key={step}
                className="mt-5"
                initial={reducedMotion ? false : { opacity: 0, x: direction * 18 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
              >
                {step === STEP_INDEX.photo ? (
                  <PhotoStep
                    form={form}
                    onImage={handleImage}
                    error={errors.image}
                    suggestion={suggestion}
                    categories={categories}
                    onApplyCategory={(slug) => setField('category', slug)}
                    accept={acceptFromExtensions(upload?.allowed_extensions)}
                    maxSizeMB={maxImageMB}
                  />
                ) : null}
                {step === STEP_INDEX.details ? (
                  <DetailsStep
                    form={form}
                    errors={errors}
                    onField={setField}
                    suggestion={suggestion}
                    categories={categories}
                    onApplyCategory={(slug) => setField('category', slug)}
                  />
                ) : null}
                {step === STEP_INDEX.location ? (
                  <LocationStep
                    form={form}
                    errors={errors}
                    onPosition={handlePosition}
                    onAddress={handleAddress}
                    onAddressField={handleAddressField}
                    addressSource={addressSource}
                  />
                ) : null}
                {isReview ? (
                  <ReviewStep
                    form={form}
                    categories={categories}
                    suggestion={suggestion}
                    similar={similar}
                    ownIds={ownIds}
                    onEdit={goTo}
                  />
                ) : null}
              </motion.div>

              {isReview && generalError ? (
                <Alert tone="danger" title="The complaint was not submitted" className="mt-5">
                  {generalError} Your report is still here, so you can try again.
                </Alert>
              ) : null}
            </div>

            <div className="app-wizard-bar flex items-center gap-2 rounded-b-xl border-t border-line bg-surface-2 px-4 py-3 sm:px-6">
              {step > STEP_INDEX.photo ? (
                <Button variant="ghost" leftIcon={ArrowLeft} onClick={() => goTo(step - 1)}>
                  Back
                </Button>
              ) : null}
              <div className="hidden flex-1 sm:block" />
              {isReview ? (
                <Button type="submit" size="lg" leftIcon={ScanSearch} className="flex-1 sm:flex-none">
                  Analyze &amp; Submit
                </Button>
              ) : (
                <Button type="submit" className="flex-1 sm:flex-none">
                  {step === STEP_INDEX.photo && !form.image ? 'Continue without a photo' : 'Continue'}
                </Button>
              )}
            </div>
          </form>
        </Card>

        <aside aria-label="Report checklist" className="hidden xl:block">
          <ReportRail form={form} categories={categories} suggestion={suggestion} />
        </aside>
      </div>
    </>
  )
}
