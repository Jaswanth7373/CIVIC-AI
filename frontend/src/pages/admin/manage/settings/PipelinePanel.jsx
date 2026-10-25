/**
 * PipelinePanel - the model playground's "Full pipeline" tool.
 *
 * POST /ai/analyze/ (multipart `{image?, description, latitude?, longitude?, address?, category?}`) runs everything a
 * new complaint goes through - image model, text classifier, multimodal fusion, location risk, severity, priority,
 * the duplicate search around the pin, department routing and the officer recommendation - and stores nothing: no
 * complaint, no assignment, no notification. The answer (`vision, text, fusion, location_risk, severity, category,
 * priority, duplicates, department, recommended_officer, recommendation, steps, model_versions, is_demo, mode,
 * processing_time_ms`) is shown with the components of a real complaint, so the preview reads like the result would:
 * the decision, the pipeline's own steps with their measured times, AIAnalysisPanel, PriorityBreakdown, the similar
 * complaints nearby (linked) and why the recommended officer was picked. Without a map pin the duplicate search is
 * skipped, and the step says so. Shares the `ai` rate limit (60 requests a minute per user); a 429 is reported in
 * words. Default export: lazy-loaded by PlaygroundTab, because the location picker brings in Leaflet.
 */
import { Building2, CircleCheck, CircleMinus, CircleX, Copy, Eraser, MapPinX, UserRound, Workflow } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AIAnalysisPanel, AIModeBadge, ConfidenceBar, humanize } from '@/components/ai'
import { CategoryBadge, DepartmentBadge, PriorityBreakdown, PriorityMeter, SeverityBadge, StatusBadge } from '@/components/complaints'
import { LocationPicker } from '@/components/maps'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { FileDropzone } from '@/components/ui/FileDropzone'
import { FormField } from '@/components/ui/FormField'
import { Select } from '@/components/ui/Select'
import { Textarea } from '@/components/ui/Textarea'
import { useConfig } from '@/hooks/useConfig'
import { useToast } from '@/hooks/useToast'
import { aiService } from '@/services'
import { cn } from '@/utils/cn'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { formatNumber, formatPercent } from '@/utils/format'
import { PersonCell } from '../shared/Controls'
import { WorkloadBar } from '../shared/WorkloadBar'
import { toPrediction, toPriorityBreakdown } from './engineOutput'
import { RunningCard, ToolLayout } from './PlaygroundParts'
import { useObjectUrl } from './useObjectUrl'

const DESCRIPTION_MIN = 3
const DESCRIPTION_MAX = 2000
const ADDRESS_MAX = 255

const STEP_STATES = {
  done: { label: 'Done', icon: CircleCheck, className: 'text-sign-600 dark:text-sign-300' },
  skipped: { label: 'Skipped', icon: CircleMinus, className: 'text-ink-3' },
  failed: { label: 'Failed', icon: CircleX, className: 'text-signal-600 dark:text-signal-300' },
}

function stepOf(result, key) {
  return (Array.isArray(result?.steps) ? result.steps : []).find((step) => step?.key === key) ?? null
}

/** "Roads / Potholes, critical priority" - the toast after a run. */
function decisionLine(result) {
  const category = result?.category?.name ?? 'No category'
  const level = result?.priority?.priority_level
  return level ? `${category}, ${level} priority.` : `${category}.`
}

function Decision({ label, children }) {
  return (
    <div className="min-w-0">
      <dt className="mb-1.5 text-xs font-medium text-ink-3">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function StepList({ steps }) {
  return (
    <ol className="space-y-3" aria-label="Pipeline steps">
      {steps.map((step, index) => {
        const state = STEP_STATES[step.status] ?? STEP_STATES.done
        const Icon = state.icon
        return (
          <li key={step.key ?? index} className="flex gap-3">
            <Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', state.className)} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="text-sm font-semibold text-ink">
                  <span className="sr-only">{state.label}: </span>
                  {step.label || humanize(step.key)}
                </p>
                <span className="shrink-0 text-xs text-ink-3 tabular">
                  {step.status === 'skipped' || step.status === 'failed' ? state.label : `${formatNumber(step.duration_ms ?? 0)} ms`}
                </span>
              </div>
              {step.detail ? <p className="mt-0.5 text-xs text-ink-2">{step.detail}</p> : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function SimilarList({ items, skipped }) {
  if (!items.length) {
    return (
      <EmptyState
        compact
        bordered={false}
        icon={Copy}
        title={skipped ? 'Not searched' : 'No similar complaints nearby'}
        description={skipped ?? 'Nothing similar has been reported around this spot recently.'}
      />
    )
  }
  return (
    <ul className="divide-y divide-line">
      {items.map((item, index) => {
        const complaint = item.complaint ?? {}
        return (
          <li key={complaint.id ?? index} className="flex gap-3 px-4 py-3 sm:px-5">
            {complaint.thumbnail ? (
              <img src={complaint.thumbnail} alt="" loading="lazy" className="size-12 shrink-0 rounded-lg bg-sunken object-cover" />
            ) : null}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Link
                  to={`/admin/complaints/${complaint.id}`}
                  className="text-xs font-semibold text-primary-ink tabular hover:underline"
                >
                  {complaint.complaint_number}
                </Link>
                {item.is_duplicate ? (
                  <Badge tone="yellow" size="sm" icon={Copy}>
                    Likely duplicate
                  </Badge>
                ) : null}
                {complaint.status ? <StatusBadge status={complaint.status} label={complaint.status_display} size="sm" /> : null}
              </div>
              <p className="mt-0.5 truncate text-sm font-semibold text-ink" title={complaint.title}>
                {complaint.title}
              </p>
              {item.explanation ? <p className="mt-0.5 text-xs text-ink-2">{item.explanation}</p> : null}
            </div>
            <div className="shrink-0 text-right">
              <p className="font-display text-lg font-extrabold leading-none text-ink tabular">{formatPercent(item.overall_similarity)}</p>
              <p className="mt-1 text-[11px] text-ink-3">match</p>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function Routing({ result }) {
  const officer = result.recommended_officer
  const recommendation = result.recommendation ?? {}
  const routingStep = stepOf(result, 'department_routing')
  const officerStep = stepOf(result, 'officer_recommendation')
  const reasons = Array.isArray(recommendation.reasons) ? recommendation.reasons.filter((reason) => typeof reason === 'string') : []
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-ink-3">Department</p>
        {result.department ? (
          <DepartmentBadge department={result.department} />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm text-ink-2">
            <Building2 aria-hidden className="size-4 text-ink-3" />
            No department
          </span>
        )}
        {routingStep?.detail ? <p className="mt-1.5 text-xs text-ink-2">{routingStep.detail}</p> : null}
      </div>
      <div className="border-t border-line pt-4">
        <p className="mb-1.5 text-xs font-medium text-ink-3">Recommended officer</p>
        {officer ? (
          <div className="space-y-3">
            <PersonCell name={officer.full_name} avatar={officer.avatar} secondary={officer.designation || officer.employee_id} />
            <WorkloadBar
              active={recommendation.workload}
              capacity={recommendation.capacity}
              utilization={recommendation.utilization}
              overloaded={recommendation.overloaded}
            />
            {recommendation.score != null ? (
              <p className="text-xs text-ink-2">
                Match score <span className="font-semibold text-ink tabular">{formatNumber(recommendation.score, { digits: 2 })}</span>{' '}
                out of 1, weighing spare capacity, distance, availability and track record:
              </p>
            ) : null}
            {reasons.length ? (
              <ul className="list-disc space-y-0.5 pl-4 text-xs text-ink-2">
                {reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <p className="flex items-start gap-1.5 text-sm text-ink-2">
            <UserRound aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
            {officerStep?.detail || 'No available officer with spare capacity.'}
          </p>
        )}
      </div>
    </div>
  )
}

function PipelineResult({ run, imageUrl, categories }) {
  const { result } = run
  const fusion = result.fusion ?? {}
  const severity = result.severity ?? {}
  const priority = result.priority ?? null
  const steps = Array.isArray(result.steps) ? result.steps : []
  const duplicates = Array.isArray(result.duplicates) ? result.duplicates : []
  const likely = duplicates.filter((item) => item.is_duplicate).length
  const duplicateStep = stepOf(result, 'duplicate_detection')
  const duplicatesSkipped = duplicateStep?.status === 'skipped' ? duplicateStep.detail || 'The duplicate search was skipped.' : null
  const reviewReasons = Array.isArray(fusion.review_reasons) ? fusion.review_reasons : []
  const officer = result.recommended_officer

  return (
    <>
      <Card>
        <CardHeader
          title="What the pipeline decided"
          description="The decisions a new complaint with these inputs would get. Nothing was saved."
          actions={
            <span className="flex items-center gap-2">
              <AIModeBadge isDemo={result.is_demo} mode={result.mode} size="sm" />
              {result.processing_time_ms != null ? (
                <span className="text-xs text-ink-3 tabular">{formatNumber(result.processing_time_ms)} ms</span>
              ) : null}
            </span>
          }
        />
        <CardBody className="@container space-y-5">
          <dl className="grid gap-x-6 gap-y-5 @lg:grid-cols-2 @3xl:grid-cols-3">
            <Decision label="Category">
              <CategoryBadge category={result.category} size="lg" />
              <ConfidenceBar value={fusion.confidence} label="Fused confidence" size="sm" className="mt-2.5" />
            </Decision>
            <Decision label="Severity">
              <SeverityBadge severity={severity.severity} score={severity.score} withLabel />
            </Decision>
            <Decision label="Priority">
              {priority ? (
                <PriorityMeter score={priority.final_score} level={priority.priority_level} thresholds={priority.thresholds} />
              ) : (
                <span className="text-sm text-ink-2">Not scored</span>
              )}
            </Decision>
            <Decision label="Department">
              {result.department ? (
                <DepartmentBadge department={result.department} />
              ) : (
                <span className="text-sm text-ink-2">No department</span>
              )}
            </Decision>
            <Decision label="Recommended officer">
              {officer ? (
                <PersonCell name={officer.full_name} avatar={officer.avatar} secondary={officer.designation || officer.employee_id} />
              ) : (
                <span className="text-sm text-ink-2">No available officer</span>
              )}
            </Decision>
            <Decision label="Similar complaints nearby">
              <span className={cn('inline-flex items-center gap-1.5 text-sm', likely ? 'font-semibold text-ink' : 'text-ink-2')}>
                <Copy aria-hidden className="size-4 shrink-0" />
                {duplicatesSkipped
                  ? 'Not searched without a location'
                  : duplicates.length
                    ? `${likely} likely duplicate${likely === 1 ? '' : 's'} among ${duplicates.length} similar`
                    : 'None found'}
              </span>
            </Decision>
          </dl>
          {fusion.explanation ? <p className="text-sm text-ink-2">{fusion.explanation}</p> : null}
          {fusion.needs_review ? (
            <Alert tone="warning" title="Would be flagged for manual review">
              {reviewReasons.length ? reviewReasons.map(humanize).join('. ') : 'The confidence is low or the photo and the description disagree.'}
            </Alert>
          ) : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Pipeline steps"
          description={`${steps.length} steps, in the order they ran, with the time each one took.`}
        />
        <CardBody>
          <StepList steps={steps} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="AI analysis" description="Category, severity and location risk, with the evidence behind them." />
        <CardBody>
          <AIAnalysisPanel prediction={toPrediction(result)} imageUrl={imageUrl} categories={categories} />
        </CardBody>
      </Card>

      <div className="grid items-start gap-5 2xl:grid-cols-2">
        <Card>
          <CardHeader title="Priority" description="Points from each factor, with the saved AI settings." />
          <CardBody>
            <PriorityBreakdown priority={toPriorityBreakdown(priority)} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Routing and officer" description="Where the complaint would go and who would get it." />
          <CardBody>
            <Routing result={result} />
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Similar complaints nearby"
          description={
            duplicatesSkipped
              ? 'Searched around the map pin, so add a location to include it.'
              : 'Earlier reports around the pin, scored on text, photo and distance.'
          }
        />
        <SimilarList items={duplicates} skipped={duplicatesSkipped} />
      </Card>
    </>
  )
}

export function PipelinePanel({ categories = [] }) {
  const toast = useToast()
  const { maxImageMB } = useConfig()
  const [description, setDescription] = useState('')
  const [image, setImage] = useState(null)
  const [location, setLocation] = useState(null)
  const [address, setAddress] = useState('')
  const [category, setCategory] = useState('')
  const [pickerKey, setPickerKey] = useState(0)
  const [errors, setErrors] = useState({})
  const [running, setRunning] = useState(false)
  const [runKey, setRunKey] = useState(0)
  const [run, setRun] = useState(null)
  const imageUrl = useObjectUrl(run?.image ?? null)
  const categoryOptions = categories
    .filter((item) => item.is_active !== false)
    .map((item) => ({ value: item.slug, label: item.name }))

  const submit = async (event) => {
    event.preventDefault()
    const text = description.trim()
    if (text.length < DESCRIPTION_MIN) {
      setErrors({ description: 'Describe the issue in a few words; the text classifier needs at least 3 characters.' })
      return
    }
    setRunning(true)
    setRunKey((key) => key + 1)
    setErrors({})
    try {
      const result = await aiService.analyze({
        description: text,
        image: image ?? undefined,
        latitude: location?.lat,
        longitude: location?.lng,
        address: location && address ? address.slice(0, ADDRESS_MAX) : undefined,
        category: category || undefined,
      })
      setRun({ result, image })
      toast.success('Analysis finished', decisionLine(result))
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error('Could not run the analysis', getErrorMessage(error))
    } finally {
      setRunning(false)
    }
  }

  const removePin = () => {
    setLocation(null)
    setAddress('')
    setPickerKey((key) => key + 1)
  }

  const clear = () => {
    setDescription('')
    setImage(null)
    setCategory('')
    setErrors({})
    setRun(null)
    removePin()
  }

  const form = (
    <Card>
      <CardHeader
        icon={Workflow}
        title="Analyse a complaint"
        description="Everything a new complaint goes through, from the photo to the recommended officer. Nothing is saved and nobody is notified."
      />
      <CardBody>
        <form onSubmit={submit} noValidate className="space-y-5">
          <FormField label="Description" htmlFor="pipeline-description" required error={errors.description || errors.non_field_errors}>
            <Textarea
              id="pipeline-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={DESCRIPTION_MAX}
              rows={4}
              placeholder="Large pothole near the school entrance causing traffic problems."
            />
          </FormField>
          <FileDropzone
            label="Photo (optional)"
            value={image}
            onChange={setImage}
            maxSizeMB={maxImageMB}
            error={errors.image}
            hint={`JPG, PNG or WebP up to ${maxImageMB} MB. Analysed in memory and never saved.`}
          />
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="text-sm font-semibold text-ink">
                Location <span className="font-normal text-ink-3">(optional)</span>
              </p>
              {location ? (
                <Button variant="link" size="sm" leftIcon={MapPinX} onClick={removePin}>
                  Remove pin
                </Button>
              ) : null}
            </div>
            <p className="mb-2 text-xs text-ink-3">Adds the location risk and the search for similar complaints nearby.</p>
            <LocationPicker
              key={pickerKey}
              value={location}
              onChange={setLocation}
              onAddress={(found) => setAddress(found?.address || found?.display_name || '')}
              height={240}
              label="Location to analyse"
              error={errors.latitude || errors.longitude || errors.address}
            />
          </div>
          <FormField
            label="Citizen's category"
            htmlFor="pipeline-category"
            optional
            hint="The category a citizen would choose; the fusion weighs it as extra evidence."
            error={errors.category}
          >
            <Select
              id="pipeline-category"
              placeholder="Not chosen"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              options={categoryOptions}
            />
          </FormField>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              leftIcon={Eraser}
              onClick={clear}
              disabled={running || (!description && !image && !location && !category && !run)}
            >
              Clear
            </Button>
            <Button type="submit" leftIcon={Workflow} loading={running}>
              Run full analysis
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )

  return (
    <ToolLayout form={form} runKey={runKey}>
      {running ? (
        <RunningCard title="Running the full pipeline">
          Classifying the photo and the description, scoring severity and priority, searching for similar complaints and
          choosing a department and an officer. The first run after a restart can take a few seconds while the models load.
        </RunningCard>
      ) : run ? (
        <PipelineResult run={run} imageUrl={imageUrl} categories={categories} />
      ) : (
        <EmptyState
          icon={Workflow}
          title="The result appears here"
          description="Describe an issue, optionally add a photo and a map pin, then run the analysis to see what the system would decide."
        />
      )}
    </ToolLayout>
  )
}

export default PipelinePanel
