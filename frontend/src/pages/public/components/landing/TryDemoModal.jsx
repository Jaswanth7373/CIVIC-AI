/**
 * TryDemoModal - "Try your own photo": a visitor drops a photo and / or types a description, the real AI
 * engine analyses it through the public demo endpoint (POST /api/ai/demo/ - no account, nothing stored) and
 * the result is shown with the same building blocks staff see on a complaint (DemoResultView).
 *
 * Errors are explained where they happen: field messages from the API (`errors.image`,
 * `errors.description`) under the inputs, a missing input before anything is sent, a rate limit (HTTP 429)
 * with a countdown, and an unreachable server with the network message.
 *
 * Props: open, onClose(), categories (public CategoryOut list).
 */
import { ImagePlus, ScanSearch, SquarePen } from 'lucide-react'
import { useId, useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { FileDropzone } from '@/components/ui/FileDropzone'
import { FormField } from '@/components/ui/FormField'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { Textarea } from '@/components/ui/Textarea'
import { useConfig } from '@/hooks/useConfig'
import { aiService } from '@/services/aiService'
import { cn } from '@/utils/cn'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { MUTED_TEXT_AA } from '../contrast'
import { SAMPLE_PHOTOS, retryAfterSeconds, sampleFile } from './demoUtils'
import { DemoResultView } from './DemoResultView'
import { useCountdown } from './useCountdown'
import { useObjectUrl } from './useObjectUrl'

const DESCRIPTION_LIMIT = 1000

export function TryDemoModal({ open, onClose, categories }) {
  const formId = useId()
  const { maxImageMB } = useConfig()
  const [file, setFile] = useState(null)
  const [description, setDescription] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [resultFile, setResultFile] = useState(null)
  const [error, setError] = useState(null)
  const [missingInput, setMissingInput] = useState(false)
  const [sampleLoading, setSampleLoading] = useState(null)
  const [sampleError, setSampleError] = useState('')

  const resultImageUrl = useObjectUrl(resultFile)
  const waitSeconds = retryAfterSeconds(error)
  const remaining = useCountdown(waitSeconds ?? 0, error)
  const fieldErrors = getFieldErrors(error)
  const validationOnly = error?.response?.status === 400 && (fieldErrors.image || fieldErrors.description)

  const resetErrors = () => {
    setError(null)
    setMissingInput(false)
    setSampleError('')
  }

  const chooseFile = (next) => {
    resetErrors()
    setFile(next)
  }

  const pickSample = async (sample) => {
    setSampleLoading(sample.id)
    resetErrors()
    try {
      setFile(await sampleFile(sample))
    } catch (err) {
      setSampleError(getErrorMessage(err))
    } finally {
      setSampleLoading(null)
    }
  }

  const submit = async (event) => {
    event.preventDefault()
    const text = description.trim()
    if (!file && !text) {
      setMissingInput(true)
      return
    }
    resetErrors()
    setRunning(true)
    try {
      const data = await aiService.demo({ image: file ?? undefined, description: text || undefined })
      setResultFile(file)
      setResult(data)
    } catch (err) {
      setError(err)
    } finally {
      setRunning(false)
    }
  }

  const backToForm = () => {
    setResult(null)
    setResultFile(null)
    resetErrors()
  }

  const footer = result ? (
    <>
      <Button variant="outline" leftIcon={SquarePen} onClick={backToForm}>
        Change photo or text
      </Button>
      <Button onClick={onClose}>Done</Button>
    </>
  ) : (
    <>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" form={formId} leftIcon={ScanSearch} loading={running} disabled={remaining > 0}>
        {remaining > 0 ? `Try again in ${remaining}\u00a0s` : 'Analyze with AI'}
      </Button>
    </>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      size={result ? 'xl' : 'lg'}
      className={MUTED_TEXT_AA}
      title={result ? 'What the AI found' : 'Try the AI on your own photo'}
      description={
        result
          ? 'The same engines that analyse real complaints produced this result. Nothing was stored.'
          : 'Add a photo of a civic issue, a short description, or both. The live engine analyses it; no complaint is filed.'
      }
      footer={footer}
    >
      {result ? (
        <DemoResultView result={result} imageUrl={resultImageUrl} categories={categories} />
      ) : (
        <form id={formId} onSubmit={submit} noValidate className="space-y-5">
          <FileDropzone
            label="Photo"
            value={file}
            onChange={chooseFile}
            maxSizeMB={maxImageMB}
            capture="environment"
            error={fieldErrors.image}
            disabled={running}
          />

          <div>
            <p id={`${formId}-samples`} className="text-sm font-medium text-ink-2">
              No photo at hand? Send one of the sample photos:
            </p>
            <ul aria-labelledby={`${formId}-samples`} className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {SAMPLE_PHOTOS.map((sample) => {
                const selected = file?.name === sample.filename
                return (
                  <li key={sample.id}>
                    <button
                      type="button"
                      onClick={() => pickSample(sample)}
                      disabled={running || sampleLoading !== null}
                      aria-pressed={selected}
                      className={cn(
                        'group flex w-full items-center gap-2 rounded-lg border p-1.5 pr-2 text-left text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 pointer-coarse:min-h-11',
                        selected ? 'border-primary bg-primary-soft text-primary-ink' : 'border-line bg-surface text-ink-2 hover:border-line-strong hover:bg-surface-2 hover:text-ink',
                      )}
                    >
                      <span className="relative size-9 shrink-0 overflow-hidden rounded-md bg-sunken">
                        <img src={sample.src} alt="" loading="lazy" className="size-full object-cover" />
                        {sampleLoading === sample.id ? (
                          <span className="absolute inset-0 grid place-items-center bg-asphalt-950/55 text-white">
                            <Spinner size="xs" decorative />
                          </span>
                        ) : null}
                      </span>
                      <span className="min-w-0 leading-tight">{sample.label}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
            {sampleError ? <p className="mt-1.5 text-xs font-medium text-signal-600 dark:text-signal-300">{sampleError}</p> : null}
          </div>

          <FormField
            label="Description"
            optional
            htmlFor={`${formId}-description`}
            hint="English, Hinglish and Telugu words work (gaddha, kachra, chetta ...)."
            error={fieldErrors.description}
          >
            <Textarea
              id={`${formId}-description`}
              value={description}
              onChange={(event) => {
                setDescription(event.target.value)
                if (missingInput) setMissingInput(false)
                if (fieldErrors.description) setError(null)
              }}
              maxLength={DESCRIPTION_LIMIT}
              rows={3}
              disabled={running}
              placeholder="Garbage has been dumped next to the bus stop for a week and it smells."
            />
          </FormField>

          {missingInput ? (
            <Alert tone="danger" icon={ImagePlus} title="Nothing to analyse yet">
              Add a photo, a description, or both.
            </Alert>
          ) : null}
          {error && waitSeconds != null ? (
            <Alert tone="warning" title="The live demo is busy">
              {remaining > 0
                ? `It has run many times from this network in the last minute. You can run it again in ${remaining}\u00a0s.`
                : 'You can run it again now.'}
            </Alert>
          ) : null}
          {error && waitSeconds == null && !validationOnly ? (
            <Alert tone="danger" title="The analysis didn't run">
              {getErrorMessage(error)}
            </Alert>
          ) : null}
          {running ? (
            <p role="status" className="flex items-center gap-2 text-sm text-ink-2">
              <Spinner size="sm" decorative />
              The engine is analysing your input. The first run after a server restart takes a little longer.
            </p>
          ) : null}
        </form>
      )}
    </Modal>
  )
}

export default TryDemoModal
