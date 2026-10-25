/**
 * PlaygroundTab - try the live AI engine on your own inputs without creating any data.
 *
 * Four tools, picked at the top (the choice is kept in the URL as `?tool=`), each with its inputs on the left and the
 * engine's answer on the right:
 * - Full pipeline (PipelinePanel, lazy-loaded with its map): POST /ai/analyze/ - everything a new complaint goes
 *   through, from the photo to the recommended officer.
 * - Classify: a typed description and / or an uploaded photo -> POST /ai/classify/ (multipart) -> `{vision, text,
 *   fusion, category, is_demo, mode}`: the fused decision, how the image model and the text classifier voted, the
 *   most likely classes, keywords / impacts, and the photo with its detections.
 * - Before / after check (VerifyPanel): POST /ai/verify-resolution/ with two photos -> the resolution verification
 *   engine's score, status and metrics.
 * - Feedback sentiment: feedback text with an optional star rating -> POST /ai/sentiment/ -> `{label, score (-1..1),
 *   confidence, evidence, explanation, rating_agreement, model_version, is_demo}`.
 * A tool stays mounted once opened, so switching between tools keeps its inputs and result. The endpoints share the
 * `ai` rate limit (60 per minute per user); a 429 is reported in words.
 */
import { Eraser, MessageSquareText, ScanEye, ScanSearch, Star, Workflow } from 'lucide-react'
import { Suspense, lazy, useState } from 'react'
import { AIModeBadge, ConfidenceBar, ImageWithBoxes } from '@/components/ai'
import { categoryFromSlug, humanize } from '@/components/ai/aiUtils'
import { CategoryBadge } from '@/components/complaints'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { FileDropzone } from '@/components/ui/FileDropzone'
import { FormField } from '@/components/ui/FormField'
import { Skeleton } from '@/components/ui/Skeleton'
import { StarRating } from '@/components/ui/StarRating'
import { Textarea } from '@/components/ui/Textarea'
import { useApi } from '@/hooks/useApi'
import { useConfig } from '@/hooks/useConfig'
import { useToast } from '@/hooks/useToast'
import { aiService, categoryService } from '@/services'
import { cn } from '@/utils/cn'
import { RATING_LABELS, getSentimentMeta } from '@/utils/constants'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { formatNumber, formatPercent } from '@/utils/format'
import { toList } from '../shared/listUtils'
import { useUrlParams } from '../shared/useUrlParams'
import { RunningCard, ToolLayout } from './PlaygroundParts'
import { useObjectUrl } from './useObjectUrl'
import { VerifyPanel } from './VerifyPanel'

const PipelinePanel = lazy(() => import('./PipelinePanel'))

const TOOLS = [
  {
    value: 'pipeline',
    label: 'Full pipeline',
    icon: Workflow,
    description: 'Photo, description and map pin through every step of a new complaint.',
  },
  { value: 'classify', label: 'Classify', icon: ScanSearch, description: 'The category the image model, text classifier and fusion choose.' },
  { value: 'verify', label: 'Before / after check', icon: ScanEye, description: 'Two photos of one place through resolution verification.' },
  { value: 'sentiment', label: 'Feedback sentiment', icon: MessageSquareText, description: 'Citizen feedback scored positive, neutral or negative.' },
]
const DEFAULT_TOOL = TOOLS[0].value

/** `rating_agreement` of the sentiment engine (ai/nlp/sentiment.py) in words. */
const RATING_AGREEMENT = {
  no_rating: 'No star rating given',
  agree: 'Rating agrees with the text',
  mild_conflict: 'Neutral rating for a non-neutral text',
  conflict: 'Rating contradicts the text',
  rating_decided: 'Neutral text, so the rating decided the label',
  rating_only: 'No text, so the label comes from the rating',
}

const AGREEMENT = {
  agree: { tone: 'green', label: 'Photo and text agree' },
  disagree: { tone: 'orange', label: 'Photo and text disagree' },
  single_modality: { tone: 'blue', label: 'Decided from one source' },
  none: { tone: 'neutral', label: 'No model evidence' },
}

/** Native radio group styled as cards: arrow keys move between tools, the choice is announced as a radio. */
function ToolPicker({ value, onChange }) {
  return (
    <fieldset className="mb-5 min-w-0">
      <legend className="sr-only">Model to try</legend>
      <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
        {TOOLS.map((tool) => {
          const checked = tool.value === value
          const Icon = tool.icon
          return (
            <label
              key={tool.value}
              className={cn(
                'flex min-w-0 cursor-pointer items-start gap-3 rounded-xl border bg-surface p-3 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus pointer-coarse:min-h-11',
                checked ? 'border-primary bg-primary-soft' : 'border-line hover:border-line-strong',
              )}
            >
              <input
                type="radio"
                name="playground-tool"
                value={tool.value}
                checked={checked}
                onChange={() => onChange(tool.value)}
                className="sr-only"
              />
              <span
                aria-hidden
                className={cn('grid size-8 shrink-0 place-items-center rounded-lg', checked ? 'bg-primary text-white' : 'bg-sunken text-ink-2')}
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0 self-center sm:self-auto">
                <span className="block text-sm font-semibold text-ink">{tool.label}</span>
                <span className="hidden text-xs text-ink-3 sm:block">{tool.description}</span>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

function TopClasses({ probabilities, categories, fallback }) {
  const rows = Object.entries(probabilities ?? {})
    .map(([slug, value]) => ({ slug, value: Number(value) || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 4)
  if (!rows.length) return null
  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.slug} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3 text-xs">
          <span className="truncate font-medium text-ink-2">{categoryFromSlug(row.slug, categories, fallback)?.name}</span>
          <span aria-hidden className="h-1.5 overflow-hidden rounded-full bg-sunken">
            <span className="block h-full rounded-full bg-guide-500" style={{ width: `${Math.min(1, row.value) * 100}%` }} />
          </span>
          <span className="font-semibold text-ink tabular">{formatPercent(row.value)}</span>
        </li>
      ))}
    </ul>
  )
}

function ClassifyResult({ result, imageUrl, categories }) {
  const fusion = result.fusion ?? {}
  const vision = result.vision
  const text = result.text
  const agreement = AGREEMENT[fusion.agreement] ?? AGREEMENT.none
  const reasons = Array.isArray(fusion.review_reasons) ? fusion.review_reasons : []
  const keywords = Array.isArray(text?.keywords) ? text.keywords : []
  const impacts = Array.isArray(text?.impacts) ? text.impacts : []

  return (
    <div className="@container space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-3">AI category</p>
          <CategoryBadge category={result.category ?? fusion.category} size="lg" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={agreement.tone} size="sm">
            {agreement.label}
          </Badge>
          <AIModeBadge isDemo={result.is_demo} mode={result.mode} size="sm" />
        </div>
      </div>
      <ConfidenceBar value={fusion.confidence} label="Fused confidence" />
      {fusion.explanation ? <p className="text-sm text-ink-2">{fusion.explanation}</p> : null}
      {fusion.needs_review ? (
        <Alert tone="warning" title="Would be flagged for manual review">
          {reasons.length ? reasons.map(humanize).join('. ') : 'The confidence is low or the two sources disagree.'}
        </Alert>
      ) : null}

      <div className="grid gap-4 @lg:grid-cols-2">
        <ConfidenceBar
          size="sm"
          label="Image model"
          detail={vision ? categoryFromSlug(vision.category, categories)?.name : 'No photo sent'}
          value={vision ? vision.confidence : null}
        />
        <ConfidenceBar
          size="sm"
          label="Text classifier"
          detail={text ? categoryFromSlug(text.category, categories)?.name : 'No description sent'}
          value={text ? text.confidence : null}
        />
      </div>

      <div>
        <p className="mb-2 text-xs font-medium text-ink-3">Most likely categories</p>
        <TopClasses probabilities={fusion.probabilities} categories={categories} fallback={result.category} />
      </div>

      {text ? (
        <div className="grid gap-4 @lg:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-medium text-ink-3">Keywords</p>
            {keywords.length ? (
              <ul className="flex flex-wrap gap-1.5">
                {keywords.map((keyword) => (
                  <li key={keyword} className="rounded-md bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2 ring-1 ring-inset ring-line">
                    {keyword}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-ink-3">No keywords extracted.</p>
            )}
          </div>
          <div>
            <p className="mb-2 text-xs font-medium text-ink-3">Public impact</p>
            {impacts.length ? (
              <ul className="space-y-1 text-xs">
                {impacts.map((impact) => (
                  <li key={impact.type ?? impact.label} className="flex justify-between gap-3">
                    <span className="font-semibold text-ink">{impact.label ?? humanize(impact.type)}</span>
                    <span className="text-ink-2 tabular">{formatPercent(impact.score)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-ink-3">No public impact cues found.</p>
            )}
            {text.severity_hint ? (
              <p className="mt-2 text-xs text-ink-3">
                Severity hint from the text: <span className="font-semibold text-ink-2">{humanize(text.severity_hint)}</span>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {vision && imageUrl ? (
        <div>
          <p className="mb-2 text-xs font-medium text-ink-3">What the image model saw</p>
          <ImageWithBoxes
            src={imageUrl}
            alt="Uploaded photo with AI detections"
            objects={vision.detected_objects}
            boxes={vision.bounding_boxes}
            categories={categories}
            maxHeight="20rem"
          />
          {vision.explanation ? <p className="mt-2 text-xs text-ink-2">{vision.explanation}</p> : null}
        </div>
      ) : null}

      <p className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-3 text-[11px] text-ink-3">
        {vision?.model_version ? <span>Image {vision.model_version}</span> : null}
        {text?.model_version ? <span>Text {text.model_version}</span> : null}
        {fusion.version ? <span>Fusion {fusion.version}</span> : null}
        {vision?.processing_time_ms != null ? <span className="tabular">Image {formatNumber(vision.processing_time_ms)} ms</span> : null}
        {text?.processing_time_ms != null ? <span className="tabular">Text {formatNumber(text.processing_time_ms)} ms</span> : null}
      </p>
    </div>
  )
}

function ClassifyPanel({ categories }) {
  const toast = useToast()
  const { maxImageMB } = useConfig()
  const [description, setDescription] = useState('')
  const [image, setImage] = useState(null)
  const [result, setResult] = useState(null)
  const [resultImage, setResultImage] = useState(null)
  const [errors, setErrors] = useState({})
  const [running, setRunning] = useState(false)
  const [runKey, setRunKey] = useState(0)
  const imageUrl = useObjectUrl(resultImage)

  const run = async (event) => {
    event.preventDefault()
    if (!description.trim() && !image) {
      setErrors({ description: 'Type a description, add a photo, or both.' })
      return
    }
    setRunning(true)
    setRunKey((key) => key + 1)
    setErrors({})
    try {
      const response = await aiService.classify({ description: description.trim() || undefined, image: image ?? undefined })
      setResult(response)
      setResultImage(image)
      toast.success('Classification finished', response?.category ? `The AI chose ${response.category.name}.` : 'See the result.')
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error('Could not classify', getErrorMessage(error))
    } finally {
      setRunning(false)
    }
  }

  const clear = () => {
    setDescription('')
    setImage(null)
    setResult(null)
    setResultImage(null)
    setErrors({})
  }

  const form = (
    <Card>
      <CardHeader
        icon={ScanSearch}
        title="Classify a complaint"
        description="The same image model, text classifier and fusion the submission pipeline uses. Nothing is stored."
      />
      <CardBody>
        <form onSubmit={run} noValidate className="space-y-4">
          <FormField label="Description" htmlFor="playground-description" optional error={errors.description || errors.non_field_errors}>
            <Textarea
              id="playground-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="Large pothole near the school entrance causing traffic problems."
            />
          </FormField>
          <FileDropzone
            label="Photo (optional)"
            value={image}
            onChange={setImage}
            maxSizeMB={maxImageMB}
            error={errors.image}
            hint={`JPG, PNG or WebP up to ${maxImageMB} MB. The photo is analysed in memory and never saved.`}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" leftIcon={Eraser} onClick={clear} disabled={running || (!description && !image && !result)}>
              Clear
            </Button>
            <Button type="submit" leftIcon={ScanSearch} loading={running}>
              Classify
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )

  return (
    <ToolLayout form={form} runKey={runKey}>
      {running ? (
        <RunningCard title="Classifying">Running the image model and the text classifier, then fusing their votes.</RunningCard>
      ) : result ? (
        <Card>
          <CardHeader title="Classification" description="The fused decision and how each model voted." />
          <CardBody>
            <ClassifyResult result={result} imageUrl={imageUrl} categories={categories} />
          </CardBody>
        </Card>
      ) : (
        <EmptyState
          icon={ScanSearch}
          title="The classification appears here"
          description="Type a description, add a photo, or both, then classify to see the category and the confidence behind it."
        />
      )}
    </ToolLayout>
  )
}

function SentimentScale({ score }) {
  const value = Math.max(-1, Math.min(1, Number(score) || 0))
  const positive = value >= 0
  return (
    <div>
      <div className="relative h-2.5 w-full rounded-full bg-sunken" aria-hidden>
        <span className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
        <span
          className={cn('absolute inset-y-0 rounded-full', positive ? 'bg-sign-500' : 'bg-signal-500')}
          style={positive ? { left: '50%', width: `${value * 50}%` } : { right: '50%', width: `${-value * 50}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-ink-3 tabular">
        <span>-1 negative</span>
        <span>0</span>
        <span>+1 positive</span>
      </div>
    </div>
  )
}

function SentimentResult({ result }) {
  const meta = getSentimentMeta(result.label)
  const evidence = Array.isArray(result.evidence) ? result.evidence : []
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {meta ? (
            <Badge tone={meta.tone} icon={meta.icon} size="lg">
              {meta.label}
            </Badge>
          ) : (
            <Badge size="lg">{humanize(result.label)}</Badge>
          )}
          <span className="text-sm text-ink-2 tabular">
            score {formatNumber(result.score, { digits: 2 })}, {formatPercent(result.confidence)} confidence
          </span>
        </div>
        <AIModeBadge isDemo={result.is_demo} mode={result.mode} modelVersion={result.model_version} size="sm" />
      </div>
      <SentimentScale score={result.score} />
      {result.explanation ? <p className="text-sm text-ink-2">{result.explanation}</p> : null}
      {evidence.length ? (
        <div>
          <p className="mb-2 text-xs font-medium text-ink-3">Phrases that decided it</p>
          <ul className="flex flex-wrap gap-1.5">
            {evidence.map((phrase) => (
              <li key={phrase} className="rounded-md bg-surface-2 px-2 py-0.5 text-xs font-medium text-ink-2 ring-1 ring-inset ring-line">
                {phrase}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="flex flex-wrap gap-x-3 gap-y-1 border-t border-line pt-3 text-[11px] text-ink-3">
        {result.method ? <span>Method {humanize(result.method)}</span> : null}
        {result.model_version ? <span>Model {result.model_version}</span> : null}
        {result.rating_agreement ? (
          <span>{RATING_AGREEMENT[result.rating_agreement] ?? `Rating: ${humanize(result.rating_agreement).toLowerCase()}`}</span>
        ) : null}
      </p>
    </div>
  )
}

function SentimentPanel() {
  const toast = useToast()
  const [text, setText] = useState('')
  const [rating, setRating] = useState(0)
  const [result, setResult] = useState(null)
  const [errors, setErrors] = useState({})
  const [running, setRunning] = useState(false)
  const [runKey, setRunKey] = useState(0)

  const run = async (event) => {
    event.preventDefault()
    if (!text.trim() && !rating) {
      setErrors({ text: 'Type some feedback, or at least choose a rating.' })
      return
    }
    setRunning(true)
    setRunKey((key) => key + 1)
    setErrors({})
    try {
      const response = await aiService.sentiment({ text: text.trim(), rating: rating || null })
      setResult(response)
      toast.success('Sentiment analysed', `The feedback reads as ${response?.label ?? 'analysed'}.`)
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error('Could not analyse the sentiment', getErrorMessage(error))
    } finally {
      setRunning(false)
    }
  }

  const clear = () => {
    setText('')
    setRating(0)
    setResult(null)
    setErrors({})
  }

  const form = (
    <Card>
      <CardHeader
        icon={MessageSquareText}
        title="Analyse feedback sentiment"
        description="The model that scores every citizen feedback. Nothing is stored."
      />
      <CardBody>
        <form onSubmit={run} noValidate className="space-y-4">
          <FormField label="Feedback" htmlFor="playground-feedback" error={errors.text || errors.non_field_errors}>
            <Textarea
              id="playground-feedback"
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={5000}
              rows={3}
              placeholder="The issue was resolved quickly, thank you!"
            />
          </FormField>
          <div>
            <p id="playground-rating-label" className="mb-1.5 text-sm font-semibold text-ink">
              Rating <span className="font-normal text-ink-3">(optional)</span>
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <StarRating value={rating} onChange={setRating} label="Rating" />
              <span className="text-sm text-ink-2">{rating ? RATING_LABELS[rating] : 'No rating'}</span>
              {rating ? (
                <Button variant="link" size="sm" onClick={() => setRating(0)}>
                  Clear rating
                </Button>
              ) : null}
            </div>
            {errors.rating ? <p className="mt-1 text-xs font-medium text-signal-600 dark:text-signal-300">{errors.rating}</p> : null}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" leftIcon={Eraser} onClick={clear} disabled={running || (!text && !rating && !result)}>
              Clear
            </Button>
            <Button type="submit" leftIcon={Star} loading={running}>
              Analyse sentiment
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )

  return (
    <ToolLayout form={form} runKey={runKey}>
      {running ? (
        <RunningCard title="Analysing the feedback">Scoring the text and checking it against the star rating.</RunningCard>
      ) : result ? (
        <Card>
          <CardHeader title="Sentiment" description="How the feedback reads, and the phrases that decided it." />
          <CardBody>
            <SentimentResult result={result} />
          </CardBody>
        </Card>
      ) : (
        <EmptyState
          icon={MessageSquareText}
          title="The sentiment appears here"
          description="Type a piece of feedback, optionally with a star rating, then analyse it."
        />
      )}
    </ToolLayout>
  )
}

export function PlaygroundTab() {
  const { values, setValues } = useUrlParams({ tool: DEFAULT_TOOL })
  const tool = TOOLS.some((item) => item.value === values.tool) ? values.tool : DEFAULT_TOOL
  // Tools mount on first use and then stay mounted (hidden), so switching back keeps the inputs and the result.
  const [opened, setOpened] = useState(() => [tool])
  if (!opened.includes(tool)) setOpened([...opened, tool])
  const categories = useApi(() => categoryService.list({ include_inactive: true }), [])
  const list = toList(categories.data)

  const panels = {
    pipeline: (
      <Suspense fallback={<Skeleton className="h-[480px] w-full rounded-xl" />}>
        <PipelinePanel categories={list} />
      </Suspense>
    ),
    classify: <ClassifyPanel categories={list} />,
    verify: <VerifyPanel categories={list} />,
    sentiment: <SentimentPanel />,
  }

  return (
    <>
      <ToolPicker value={tool} onChange={(next) => setValues({ tool: next })} />
      {TOOLS.filter((item) => opened.includes(item.value)).map((item) => (
        <div key={item.value} hidden={item.value !== tool}>
          {panels[item.value]}
        </div>
      ))}
    </>
  )
}

export default PlaygroundTab
