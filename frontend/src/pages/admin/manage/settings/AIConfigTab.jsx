/**
 * AIConfigTab - every tunable of the AI engine, validated while typing.
 *
 * Data: GET /ai/config/ -> AIConfiguration (+ updated_by, updated_at). Save: PUT /ai/config/ with every
 * field; "Save & recalculate open complaints" adds `?recalculate=true`, which re-scores the priority of every
 * open complaint with the new weights and reports `recalculated` / `recalculation_failed`. Changes are
 * audit-logged with the old and new values. The form keeps a dirty state against the saved configuration,
 * offers "Discard changes", and shows the weights as a live 100-point stacked bar and the level thresholds as
 * a zone scale in the level colours.
 */
import { RotateCcw, Save, Sigma } from 'lucide-react'
import { useState } from 'react'
import { Alert } from '@/components/ui/Alert'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ErrorState } from '@/components/ui/ErrorState'
import { FormField } from '@/components/ui/FormField'
import { Input } from '@/components/ui/Input'
import { Skeleton } from '@/components/ui/Skeleton'
import { Switch } from '@/components/ui/Switch'
import { useApi } from '@/hooks/useApi'
import { useConfirm } from '@/hooks/useConfirm'
import { useToast } from '@/hooks/useToast'
import { aiService } from '@/services'
import { cn } from '@/utils/cn'
import { getErrorMessage, getFieldErrors } from '@/utils/errors'
import { LEVEL_META, LEVEL_ORDER } from '@/utils/constants'
import { formatDateTime, formatNumber } from '@/utils/format'
import { CONFIG_SECTIONS, THRESHOLD_FIELDS, WEIGHT_FIELDS, changedKeys, toFormValues, toPayload, validateConfig } from './configSchema'
import { WeightsPreview } from './WeightsPreview'

function NumberInput({ field, value, onChange, error }) {
  return (
    <FormField label={field.label} htmlFor={`ai-${field.key}`} error={error} hint={field.hint}>
      <div className="flex items-center gap-2">
        <Input
          id={`ai-${field.key}`}
          type="number"
          inputMode="decimal"
          min={field.min}
          max={field.max}
          step={field.step}
          value={value}
          onChange={(event) => onChange(field.key, event.target.value)}
          className="max-w-36 tabular"
        />
        {field.unit ? (
          <span aria-hidden className="shrink-0 text-xs text-ink-3">
            {field.unit}
          </span>
        ) : null}
      </div>
    </FormField>
  )
}

/** The four priority levels as zones of the 0-100 scale, sized by the thresholds being edited. */
function ThresholdPreview({ thresholds }) {
  const bounds = [0, thresholds.medium, thresholds.high, thresholds.critical, 101]
  const zones = LEVEL_ORDER.map((key, index) => ({
    key,
    meta: LEVEL_META[key],
    from: bounds[index],
    to: bounds[index + 1] - 1,
  }))
  return (
    <div className="max-w-2xl">
      <div className="flex h-3 w-full gap-0.5" aria-hidden>
        {zones.map((zone, index) => (
          <span
            key={zone.key}
            className={cn(
              'h-full transition-[flex-basis] duration-300 ease-standard',
              index === 0 && 'rounded-l-full',
              index === zones.length - 1 && 'rounded-r-full',
            )}
            style={{ flexBasis: `${Math.max(0, zone.to - zone.from + 1)}%`, backgroundColor: zone.meta.color }}
          />
        ))}
      </div>
      <ul className="mt-2 flex w-full gap-0.5 text-xs">
        {zones.map((zone) => (
          <li
            key={zone.key}
            className="min-w-0 transition-[flex-basis] duration-300 ease-standard"
            style={{ flexBasis: `${Math.max(0, zone.to - zone.from + 1)}%` }}
          >
            <span className="block truncate font-semibold text-ink">{zone.meta.label}</span>
            <span className="block truncate text-ink-3 tabular">
              {zone.from}-{Math.min(100, zone.to)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ConfigForm({ config, onSaved }) {
  const toast = useToast()
  const confirm = useConfirm()
  const [values, setValues] = useState(() => toFormValues(config))
  const [serverErrors, setServerErrors] = useState({})
  const [saving, setSaving] = useState(null)

  const errors = { ...validateConfig(values), ...serverErrors }
  const dirty = changedKeys(values, config)
  const valid = Object.keys(validateConfig(values)).length === 0

  const change = (key, value) => {
    setValues((current) => ({ ...current, [key]: value }))
    if (Object.keys(serverErrors).length) setServerErrors({})
  }

  const save = async (recalculate) => {
    if (!valid) {
      toast.error('Settings not saved', 'Fix the highlighted values first.')
      return
    }
    if (recalculate) {
      const ok = await confirm({
        title: 'Save and recalculate open complaints?',
        message:
          'Every open complaint gets a new priority score with these settings. The change is recorded on each timeline, and officers see the new order in their queues.',
        confirmLabel: 'Save & recalculate',
        tone: 'warning',
      })
      if (!ok) return
    }
    setSaving(recalculate ? 'recalculate' : 'save')
    setServerErrors({})
    try {
      const result = await aiService.updateConfig(toPayload(values), { recalculate })
      if (recalculate) {
        const done = Number(result?.recalculated) || 0
        const failed = Number(result?.recalculation_failed) || 0
        if (failed) toast.warning('Settings saved, some priorities not recalculated', result?.recalculation_detail ?? `${failed} complaints failed.`)
        else toast.success('Settings saved and priorities recalculated', `${formatNumber(done)} open ${done === 1 ? 'complaint was' : 'complaints were'} re-scored.`)
      } else {
        toast.success('AI settings saved', dirty.length ? `${dirty.length} ${dirty.length === 1 ? 'setting' : 'settings'} changed. New analyses use them right away.` : 'Nothing had changed.')
      }
      onSaved?.(result)
    } catch (error) {
      setServerErrors(getFieldErrors(error))
      toast.error('Could not save the AI settings', getErrorMessage(error))
    } finally {
      setSaving(null)
    }
  }

  const thresholds = {
    medium: Number(values.threshold_medium) || 26,
    high: Number(values.threshold_high) || 51,
    critical: Number(values.threshold_critical) || 76,
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        save(false)
      }}
      noValidate
      className="space-y-5"
    >
      <Card>
        <CardHeader
          icon={Sigma}
          title="Priority weights"
          description="Points each factor can add to the 0-100 priority score. They must add up to 100."
        />
        <CardBody className="space-y-5">
          <WeightsPreview values={values} fields={WEIGHT_FIELDS} />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {WEIGHT_FIELDS.map((field) => (
              <NumberInput
                key={field.key}
                field={{ ...field, min: 0, max: 100, step: 0.5, unit: 'pts' }}
                value={values[field.key]}
                onChange={change}
                error={errors[field.key]}
              />
            ))}
          </div>
          {errors.weights ? <Alert tone="danger">{errors.weights}</Alert> : null}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Priority levels" description="A score from each threshold upward gets that level. The scale below follows your values." />
        <CardBody className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            {THRESHOLD_FIELDS.map((field) => (
              <NumberInput key={field.key} field={field} value={values[field.key]} onChange={change} error={errors[field.key]} />
            ))}
          </div>
          {errors.thresholds ? (
            <Alert tone="danger">{errors.thresholds}</Alert>
          ) : (
            <ThresholdPreview thresholds={thresholds} />
          )}
        </CardBody>
      </Card>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        {CONFIG_SECTIONS.map((section) => (
          <Card key={section.id} className={cn(section.id === 'duplicates' && 'xl:row-span-2')}>
            <CardHeader title={section.title} description={section.description} />
            <CardBody className="grid gap-4 sm:grid-cols-2">
              {section.fields.map((field) =>
                field.kind === 'boolean' ? (
                  <Switch
                    key={field.key}
                    checked={Boolean(values[field.key])}
                    onCheckedChange={(checked) => change(field.key, checked)}
                    label={field.label}
                    description={field.hint}
                    className="sm:col-span-2"
                  />
                ) : (
                  <NumberInput key={field.key} field={field} value={values[field.key]} onChange={change} error={errors[field.key]} />
                ),
              )}
            </CardBody>
          </Card>
        ))}
      </div>

      <div
        className={cn(
          'z-10 -mx-4 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur transition-shadow duration-300 ease-standard sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8',
          dirty.length && 'elev-raised sticky bottom-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]',
        )}
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <p className="text-xs text-ink-3" aria-live="polite">
            {dirty.length ? (
              <span className="font-semibold text-marking-800 dark:text-marking-300">
                {dirty.length} unsaved {dirty.length === 1 ? 'change' : 'changes'}
              </span>
            ) : config.updated_by ? (
              <>
                Last changed by <span className="font-semibold text-ink-2">{config.updated_by.full_name}</span>,{' '}
                <time dateTime={config.updated_at}>{formatDateTime(config.updated_at)}</time>
              </>
            ) : (
              <>Default settings, saved {formatDateTime(config.updated_at)}</>
            )}
          </p>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
            <Button variant="ghost" leftIcon={RotateCcw} disabled={!dirty.length || Boolean(saving)} onClick={() => setValues(toFormValues(config))}>
              Discard changes
            </Button>
            <Button
              variant="outline"
              className="order-last col-span-2 sm:order-none sm:col-span-1"
              disabled={Boolean(saving) || !valid}
              loading={saving === 'recalculate'}
              onClick={() => save(true)}
            >
              Save & recalculate open complaints
            </Button>
            <Button type="submit" leftIcon={Save} disabled={Boolean(saving) || !dirty.length || !valid} loading={saving === 'save'}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
}

export function AIConfigTab() {
  const config = useApi(() => aiService.getConfig(), [])
  const [version, setVersion] = useState(0)

  if (config.error && !config.data) {
    return <ErrorState title="The AI settings could not be loaded" error={config.error} onRetry={() => config.refetch()} />
  }
  if (!config.data) {
    return (
      <div aria-hidden className="space-y-5">
        <Skeleton className="h-64 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
        <div className="grid gap-5 xl:grid-cols-2">
          <Skeleton className="h-56 w-full rounded-xl" />
          <Skeleton className="h-56 w-full rounded-xl" />
        </div>
      </div>
    )
  }
  return (
    <ConfigForm
      key={`${config.data.updated_at}-${version}`}
      config={config.data}
      onSaved={(saved) => {
        if (saved && saved.id != null) config.setData(saved)
        else config.refetch()
        setVersion((value) => value + 1)
      }}
    />
  )
}

export default AIConfigTab
