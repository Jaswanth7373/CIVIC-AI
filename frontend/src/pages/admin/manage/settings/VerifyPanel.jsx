/**
 * VerifyPanel - the model playground's "Before / after check" tool.
 *
 * POST /ai/verify-resolution/ with two photos (multipart `{before_image, after_image, category?}`) runs the resolution
 * verification engine the way it runs on a resolved complaint - the after photo is aligned onto the before photo
 * (ORB features + RANSAC homography) and compared with SSIM, colour histograms and pixel change where the issue was
 * (or where the scene changed most), and the vision model checks whether the issue is still visible - but stores
 * nothing. The engine output `{score, status, status_label, explanation, metrics, model_version, mode, is_demo,
 * disclaimer, processing_time_ms, details}` renders with VerificationResult, the view officers and citizens get for
 * a stored verification, next to the two photos in the BeforeAfterSlider. The result is advisory: the disclaimer is
 * always shown. Shares the `ai` rate limit (60 requests a minute per user).
 */
import { Eraser, ScanEye } from 'lucide-react'
import { useState } from 'react'
import { categoryFromSlug } from '@/components/ai'
import { BeforeAfterSlider, VerificationResult } from '@/components/complaints'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { FileDropzone } from '@/components/ui/FileDropzone'
import { FormField } from '@/components/ui/FormField'
import { Select } from '@/components/ui/Select'
import { useConfig } from '@/hooks/useConfig'
import { useToast } from '@/hooks/useToast'
import { aiService } from '@/services'
import { getVerificationMeta } from '@/utils/constants'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { RunningCard, ToolLayout } from './PlaygroundParts'
import { useObjectUrl } from './useObjectUrl'

/** Which issue the engine looked for in the after photo, and where that choice came from. */
function CheckedIssue({ details, categories }) {
  if (!details?.category) return null
  const name = categoryFromSlug(details.category, categories)?.name ?? details.category
  return (
    <p className="mt-4 border-t border-line pt-3 text-xs text-ink-3">
      Issue looked for in the after photo: <span className="font-semibold text-ink-2">{name}</span>
      {details.category_inferred ? ', recognised in the before photo.' : ', as chosen.'}
    </p>
  )
}

export function VerifyPanel({ categories = [] }) {
  const toast = useToast()
  const { maxImageMB } = useConfig()
  const [before, setBefore] = useState(null)
  const [after, setAfter] = useState(null)
  const [category, setCategory] = useState('')
  const [errors, setErrors] = useState({})
  const [running, setRunning] = useState(false)
  const [runKey, setRunKey] = useState(0)
  const [run, setRun] = useState(null)
  const beforeUrl = useObjectUrl(run?.before ?? null)
  const afterUrl = useObjectUrl(run?.after ?? null)
  const fileHint = `JPG, PNG or WebP up to ${maxImageMB} MB. Compared in memory and never saved.`

  const submit = async (event) => {
    event.preventDefault()
    const missing = {}
    if (!before) missing.before_image = 'Add a photo of the issue as it was reported.'
    if (!after) missing.after_image = 'Add a photo of the same place after the work.'
    if (Object.keys(missing).length) {
      setErrors(missing)
      return
    }
    setRunning(true)
    setRunKey((key) => key + 1)
    setErrors({})
    try {
      const result = await aiService.verifyResolution({ before_image: before, after_image: after, category: category || undefined })
      setRun({ result, before, after })
      const status = result?.status ? getVerificationMeta(result.status).label : 'Result'
      toast.success('Photos compared', `${status}, score ${Math.round(Number(result?.score) || 0)}/100.`)
    } catch (error) {
      setErrors(getFieldErrors(error))
      toast.error('Could not compare the photos', getErrorMessage(error))
    } finally {
      setRunning(false)
    }
  }

  const clear = () => {
    setBefore(null)
    setAfter(null)
    setCategory('')
    setErrors({})
    setRun(null)
  }

  const form = (
    <Card>
      <CardHeader
        icon={ScanEye}
        title="Compare before and after photos"
        description="The resolution verification engine on two photos of the same place. Nothing is saved."
      />
      <CardBody>
        <form onSubmit={submit} noValidate className="space-y-5">
          <FileDropzone
            id="verify-before"
            label="Before photo"
            required
            value={before}
            onChange={setBefore}
            maxSizeMB={maxImageMB}
            error={errors.before_image}
            hint={`The issue as it was reported. ${fileHint}`}
          />
          <FileDropzone
            id="verify-after"
            label="After photo"
            required
            value={after}
            onChange={setAfter}
            maxSizeMB={maxImageMB}
            error={errors.after_image || errors.non_field_errors}
            hint="The same place after the work, taken from about the same spot."
          />
          <FormField
            label="Issue type"
            htmlFor="verify-category"
            optional
            hint="The issue to look for in the after photo; recognised from the before photo when left empty."
            error={errors.category}
          >
            <Select
              id="verify-category"
              placeholder="Recognise from the before photo"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              options={categories.map((item) => ({ value: item.slug, label: item.name }))}
            />
          </FormField>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" leftIcon={Eraser} onClick={clear} disabled={running || (!before && !after && !category && !run)}>
              Clear
            </Button>
            <Button type="submit" leftIcon={ScanEye} loading={running}>
              Compare photos
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  )

  return (
    <ToolLayout form={form} runKey={runKey}>
      {running ? (
        <RunningCard title="Comparing the photos">
          Aligning the after photo onto the before photo, measuring how much changed where the issue was and checking
          whether the issue is still visible. This takes a few seconds.
        </RunningCard>
      ) : run ? (
        <>
          <Card>
            <CardHeader title="Before and after" description="The two photos the engine compared." />
            <CardBody>
              <BeforeAfterSlider before={beforeUrl} after={afterUrl} alt="The two uploaded photos of the same place" />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Verification result" description="What the verification engine concluded, and the measurements behind it." />
            <CardBody>
              <VerificationResult verification={run.result} />
              <CheckedIssue details={run.result?.details} categories={categories} />
            </CardBody>
          </Card>
        </>
      ) : (
        <EmptyState
          icon={ScanEye}
          title="The comparison appears here"
          description="Add a before and an after photo of the same place, then compare them to see the verification score, status and metrics."
        />
      )}
    </ToolLayout>
  )
}

export default VerifyPanel
