/**
 * PrioritySimulatorTab - "what if" for the priority engine, nothing is stored.
 *
 * POST /ai/priority/ with simulation inputs `{severity_score, public_impact, location_risk, nearby_count,
 * frequency_count, duplicate_count, category?, is_reopened, weights?}` -> the engine output: final score,
 * level, five components (score / max / raw / reason), explanation, adjustments. The request is debounced
 * (450 ms after the last slider move) so dragging a slider costs one call; the live AI configuration is used
 * unless "Try different weights" is switched on (then the weights are sent as an override for this run only).
 */
import { FlaskConical, RotateCcw } from 'lucide-react'
import { useMemo, useState } from 'react'
import { PriorityBreakdown } from '@/components/complaints'
import { Alert } from '@/components/ui/Alert'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { ErrorState } from '@/components/ui/ErrorState'
import { FormField } from '@/components/ui/FormField'
import { Select } from '@/components/ui/Select'
import { Skeleton } from '@/components/ui/Skeleton'
import { Switch } from '@/components/ui/Switch'
import { useApi } from '@/hooks/useApi'
import { useDebounce } from '@/hooks/useDebounce'
import { aiService, categoryService } from '@/services'
import { formatNumber } from '@/utils/format'
import { RangeField } from '../shared/FormControls'
import { toList } from '../shared/listUtils'
import { WEIGHT_FIELDS } from './configSchema'
import { toPriorityBreakdown } from './engineOutput'

const DEFAULT_INPUTS = {
  severity_score: 60,
  public_impact: 0.5,
  location_risk: 0.4,
  nearby_count: 3,
  frequency_count: 1,
  duplicate_count: 0,
  category: '',
  is_reopened: false,
}

const WEIGHT_KEY = {
  weight_severity: 'severity',
  weight_public_impact: 'public_impact',
  weight_location_risk: 'location_risk',
  weight_frequency: 'frequency',
  weight_duplicates: 'duplicates',
}

const fraction = (value) => formatNumber(value, { digits: 2 })

export function PrioritySimulatorTab() {
  const [inputs, setInputs] = useState(DEFAULT_INPUTS)
  const [customWeights, setCustomWeights] = useState(false)
  const [weights, setWeights] = useState({ severity: 40, public_impact: 25, location_risk: 15, frequency: 10, duplicates: 10 })
  const categories = useApi(() => categoryService.list(), [])
  const config = useApi(() => aiService.getConfig(), [])

  const toggleCustomWeights = (checked) => {
    if (checked && config.data) {
      setWeights(Object.fromEntries(WEIGHT_FIELDS.map((field) => [WEIGHT_KEY[field.key], Number(config.data[field.key]) || 0])))
    }
    setCustomWeights(checked)
  }

  const set = (key, value) =>
    setInputs((current) => {
      const next = { ...current, [key]: value }
      if (key === 'nearby_count' && next.frequency_count > value) next.frequency_count = value
      return next
    })

  const request = useMemo(() => {
    const body = { ...inputs, category: inputs.category || null }
    if (customWeights) body.weights = weights
    return body
  }, [inputs, customWeights, weights])
  const debounced = useDebounce(request, 450)
  const simulation = useApi(() => aiService.priority(debounced), [debounced])
  const result = simulation.data
  const breakdown = toPriorityBreakdown(result)
  const pending = simulation.loading || JSON.stringify(request) !== JSON.stringify(debounced)
  const weightSum = Object.values(weights).reduce((sum, value) => sum + (Number(value) || 0), 0)
  const selectedCategory = toList(categories.data).find((category) => category.slug === inputs.category)

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
      <Card>
        <CardHeader
          icon={FlaskConical}
          title="Inputs"
          description="Move a slider; the engine recalculates the score a moment after you stop."
          actions={
            <Button
              variant="ghost"
              size="sm"
              leftIcon={RotateCcw}
              onClick={() => {
                setInputs(DEFAULT_INPUTS)
                setCustomWeights(false)
              }}
            >
              Reset
            </Button>
          }
        />
        <CardBody className="space-y-6">
          <div className="grid gap-5 md:grid-cols-2">
            <RangeField
              label="Severity score"
              value={inputs.severity_score}
              onChange={(value) => set('severity_score', value)}
              min={0}
              max={100}
              format={(value) => `${value}/100`}
              hint="What the severity engine rated the issue."
            />
            <RangeField
              label="Public impact"
              value={inputs.public_impact}
              onChange={(value) => set('public_impact', value)}
              min={0}
              max={1}
              step={0.05}
              format={fraction}
              hint="Safety, traffic and health cues from the description (0-1)."
            />
            <RangeField
              label="Location risk"
              value={inputs.location_risk}
              onChange={(value) => set('location_risk', value)}
              min={0}
              max={1}
              step={0.05}
              format={fraction}
              hint="Schools, hospitals, junctions and busy roads nearby (0-1)."
            />
            <RangeField
              label="Duplicate reports"
              value={inputs.duplicate_count}
              onChange={(value) => set('duplicate_count', value)}
              min={0}
              max={15}
              format={(value) => formatNumber(value)}
              hint="Other citizens who reported the same issue."
            />
            <RangeField
              label="Nearby complaints"
              value={inputs.nearby_count}
              onChange={(value) => set('nearby_count', value)}
              min={0}
              max={30}
              format={(value) => formatNumber(value)}
              hint="All open complaints within the nearby radius."
            />
            <RangeField
              label="Of those, same category"
              value={inputs.frequency_count}
              onChange={(value) => set('frequency_count', value)}
              min={0}
              max={Math.max(0, inputs.nearby_count)}
              format={(value) => formatNumber(value)}
              disabled={inputs.nearby_count === 0}
              hint="Drives the frequency factor; cannot exceed the nearby count."
            />
          </div>

          <div className="grid gap-4 border-t border-line pt-5 md:grid-cols-2">
            <FormField
              label="Category"
              htmlFor="simulator-category"
              optional
              hint={selectedCategory ? `Adds its public-safety weight (${fraction(selectedCategory.public_safety_weight)}) to the impact factor.` : 'Adds the category’s public-safety weight to the impact factor.'}
            >
              <Select
                id="simulator-category"
                placeholder="No category"
                value={inputs.category}
                onChange={(event) => set('category', event.target.value)}
                options={toList(categories.data).map((category) => ({ value: category.slug, label: category.name }))}
              />
            </FormField>
            <Switch
              checked={inputs.is_reopened}
              onCheckedChange={(checked) => set('is_reopened', checked)}
              label="Reopened complaint"
              description="Reopened complaints get a small priority bump."
              className="self-center"
            />
          </div>

          <div className="space-y-4 border-t border-line pt-5">
            <Switch
              checked={customWeights}
              onCheckedChange={toggleCustomWeights}
              label="Try different weights"
              description="Starts from the saved weights and overrides them for this simulation only."
            />
            {customWeights ? (
              <div className="grid gap-5 md:grid-cols-2">
                {WEIGHT_FIELDS.map((field) => (
                  <RangeField
                    key={field.key}
                    label={field.label}
                    value={weights[WEIGHT_KEY[field.key]]}
                    onChange={(value) => setWeights((current) => ({ ...current, [WEIGHT_KEY[field.key]]: value }))}
                    min={0}
                    max={100}
                    format={(value) => `${value} pts`}
                  />
                ))}
                <p className="self-end text-xs text-ink-3 md:col-span-2">
                  Total {formatNumber(weightSum)} points. The engine scales the weights to 100, so only their proportions matter.
                </p>
              </div>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card className="xl:sticky xl:top-20">
        <CardHeader
          title="Engine result"
          description="Exactly what the priority engine returns for these inputs."
          actions={
            pending && result ? (
              <Badge tone="neutral" size="sm">
                Recalculating
              </Badge>
            ) : null
          }
        />
        <CardBody aria-live="polite" aria-busy={pending || undefined}>
          {simulation.error && !pending ? (
            <ErrorState compact bordered={false} title="The simulation did not run" error={simulation.error} onRetry={() => simulation.refetch()} />
          ) : !result ? (
            <div aria-hidden className="space-y-3">
              <Skeleton className="h-10 w-1/2" />
              <Skeleton className="h-3 w-full" />
              <Skeleton lines={5} />
            </div>
          ) : (
            <div className="space-y-4">
              <PriorityBreakdown priority={breakdown} />
              {Array.isArray(result.adjustments) && result.adjustments.length ? (
                <Alert tone="info" title="Adjustments">
                  <ul className="list-disc space-y-0.5 pl-4">
                    {result.adjustments.map((item, index) => (
                      <li key={index}>{typeof item === 'string' ? item : (item.reason ?? item.label ?? JSON.stringify(item))}</li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line pt-3 text-xs">
                {Object.entries(result.components ?? {}).map(([key, component]) =>
                  component?.reason ? (
                    <div key={key} className="contents">
                      <dt className="text-ink-3">{component.label}</dt>
                      <dd className="text-right font-medium text-ink-2">{component.reason}</dd>
                    </div>
                  ) : null,
                )}
              </dl>
              <p className="text-[11px] text-ink-3">
                Engine {result.version ?? 'priority engine'}; levels from {result.thresholds?.medium} (medium), {result.thresholds?.high} (high)
                and {result.thresholds?.critical} (critical).
              </p>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}

export default PrioritySimulatorTab
