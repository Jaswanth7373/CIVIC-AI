/**
 * ModelInfoCard - one AI model or engine component from GET /ai/model-info/.
 *
 * Props:
 * - model: a `models[]` row `{name, task, framework, version, status, is_demo, detail}` or a
 *   `components[]` row (same keys plus `key`, `parameters: 'configured' | 'defaults'`, optional `weights`
 *   and `thresholds`); registry rows (`registry[]`) have the same core keys
 * - className
 *
 * Status meanings (computed by each module's describe_models() without loading weights):
 * active = loaded and in use; available = installed / ready but not loaded or not used in this mode;
 * fallback = production was requested but the demo technique answers; weights_missing / not_installed =
 * the production model cannot run here; error = the module failed to describe itself.
 */
import { Cpu, Settings2 } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/utils/cn'
import { formatNumber } from '@/utils/format'
import { AIModeBadge } from './AIModeBadge'
import { humanize } from './aiUtils'

const STATUS = {
  active: { tone: 'green', label: 'Active' },
  available: { tone: 'blue', label: 'Available' },
  loaded: { tone: 'green', label: 'Loaded' },
  fallback: { tone: 'yellow', label: 'Fallback in use' },
  weights_missing: { tone: 'orange', label: 'Weights missing' },
  not_installed: { tone: 'neutral', label: 'Not installed' },
  error: { tone: 'red', label: 'Error' },
}

function NumberMap({ title, values, suffix = '' }) {
  const entries = Object.entries(values ?? {}).filter(([, value]) => Number.isFinite(Number(value)))
  if (!entries.length) return null
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-ink-3">{title}</p>
      <dl className="flex flex-wrap gap-1.5">
        {entries.map(([key, value]) => (
          <div key={key} className="flex items-baseline gap-1 rounded-md bg-surface-2 px-2 py-0.5 text-xs ring-1 ring-inset ring-line">
            <dt className="text-ink-2">{humanize(key)}</dt>
            <dd className="font-semibold text-ink tabular">
              {formatNumber(value, { digits: 2 })}
              {suffix}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** "nlp.text_classifier" (registry id) -> "Text classifier (NLP)"; readable names are kept as they are. */
function displayName(model) {
  const name = String(model.name || model.key || '')
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(name)) return name || 'Model'
  const parts = name.split('.')
  return `${humanize(parts[parts.length - 1])} (${parts.slice(0, -1).join(' ').toUpperCase()})`
}

export function ModelInfoCard({ model, className }) {
  if (!model) return null
  const status = STATUS[model.status] ?? { tone: 'neutral', label: humanize(model.status) || 'Unknown' }
  return (
    <article className={cn('flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-4', className)}>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-sunken text-ink-2">
          {model.parameters ? <Settings2 aria-hidden className="size-[18px]" /> : <Cpu aria-hidden className="size-[18px]" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-base font-bold leading-snug text-ink">{displayName(model)}</h3>
          {model.task ? <p className="text-sm text-ink-2">{model.task}</p> : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={status.tone} size="sm" dot>
          {status.label}
        </Badge>
        <AIModeBadge isDemo={Boolean(model.is_demo)} size="sm" />
        {model.parameters ? (
          <Badge tone="neutral" size="sm">
            {model.parameters === 'configured' ? 'Live settings' : 'Default settings'}
          </Badge>
        ) : null}
      </div>
      {model.detail ? <p className="text-sm text-ink-2">{model.detail}</p> : null}
      <NumberMap title="Weights" values={model.weights} />
      <NumberMap title="Level thresholds" values={model.thresholds} />
      {model.framework || model.version ? (
        <dl className="mt-auto grid gap-x-4 gap-y-1 border-t border-line pt-3 text-xs sm:grid-cols-2">
          {model.framework ? (
            <div className="min-w-0">
              <dt className="text-ink-3">Framework</dt>
              <dd className="break-words font-medium text-ink">{model.framework}</dd>
            </div>
          ) : null}
          {model.version ? (
            <div className="min-w-0">
              <dt className="text-ink-3">Version</dt>
              <dd className="break-all font-medium text-ink">{model.version}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </article>
  )
}

export default ModelInfoCard
