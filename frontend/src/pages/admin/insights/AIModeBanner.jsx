/**
 * AIModeBanner - a one-line notice of which AI produced the numbers on the AI analytics page, with the
 * details one click away. The page opens on model performance, not on documentation: the top bar's "Demo AI
 * Mode" pill already discloses the mode on every screen, so this line only names it and says what it means
 * here; "How it works" unfolds the model lists in place, and Settings > Model information has the full story.
 *
 * Built from GET /analytics/ai/ `model_info` (`{mode, is_demo, badge, disclaimer, models: [{name, task,
 * framework, version, status, is_demo, detail}]}`), so the lists always match the server: in Demo AI Mode
 * the demo techniques that answer now, and the production models this server has (with their real status:
 * available, not installed, weights missing); in production mode the models in use.
 *
 * Props:
 * - modelInfo: the `model_info` object (null while loading -> renders nothing)
 * - className
 *
 * Accessibility: the toggle is a button with aria-expanded / aria-controls; the details are `hidden` while
 * folded, so they are out of the tab order and the reading order until asked for.
 */
import { ArrowUpRight, ChevronDown, Cpu, FlaskConical } from 'lucide-react'
import { useId, useState } from 'react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { cn } from '@/utils/cn'
import { modelDisplayName, modelStatus } from './insightUtils'

const ACTIVE = ['active', 'available', 'loaded']

function ModelLine({ model, showStatus }) {
  const status = modelStatus(model.status)
  return (
    <li className="flex min-w-0 items-center gap-3 py-1.5">
      {/* Phones: name above version; wider: one line, version right-aligned. */}
      <span className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
        <span className="block truncate font-medium text-ink sm:flex-1" title={model.task || undefined}>
          {modelDisplayName(model)}
        </span>
        {model.version ? (
          <span className="block truncate text-xs text-ink-3 tabular sm:max-w-[45%] sm:text-right" title={model.version}>
            {model.version}
          </span>
        ) : null}
      </span>
      {showStatus ? (
        <Badge tone={status.tone} size="sm" dot>
          {status.label}
        </Badge>
      ) : null}
    </li>
  )
}

function ModelList({ title, models, showStatus, empty, footer }) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-line bg-surface px-3 py-2">
      <h3 className="py-1 font-sans text-xs font-semibold text-ink-2">{title}</h3>
      {models.length ? (
        <ul className="divide-y divide-line">
          {models.map((model) => (
            <ModelLine key={`${model.name}-${model.version}`} model={model} showStatus={showStatus} />
          ))}
        </ul>
      ) : (
        <p className="py-1.5 text-ink-3">{empty}</p>
      )}
      {footer ? <p className="mt-auto border-t border-line pt-2 text-xs text-ink-3">{footer}</p> : null}
    </div>
  )
}

export function AIModeBanner({ modelInfo, className }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  if (!modelInfo) return null

  const models = Array.isArray(modelInfo.models) ? modelInfo.models : []
  const demo = Boolean(modelInfo.is_demo ?? modelInfo.mode === 'demo')
  const demoModels = models.filter((model) => model.is_demo && ACTIVE.includes(model.status))
  const productionModels = models.filter((model) => !model.is_demo)
  const runningProduction = productionModels.filter((model) => ACTIVE.includes(model.status))
  const disclaimer = String(modelInfo.disclaimer ?? '').replace(/^Demo AI Mode:\s*/i, '').trim()
  const name = demo ? modelInfo.badge || 'Demo AI Mode' : 'Production AI'
  const summary = demo
    ? disclaimer || 'lightweight heuristics stand in for the trained models.'
    : 'predictions come from trained models; older predictions keep their demo label.'
  const Icon = demo ? FlaskConical : Cpu

  return (
    <section
      aria-label={name}
      className={cn(
        'rounded-xl border px-3 py-2 sm:px-4',
        demo
          ? 'border-marking-200 bg-marking-50/70 dark:border-marking-500/30 dark:bg-marking-500/10'
          : 'border-sign-200 bg-sign-50/70 dark:border-sign-500/30 dark:bg-sign-500/10',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-md',
            demo ? 'bg-marking-500 text-asphalt-950' : 'bg-primary text-white',
          )}
        >
          <Icon aria-hidden className="size-4" />
        </span>
        <p className="min-w-0 flex-1 basis-56 text-sm leading-snug text-ink-2">
          <strong className="font-semibold text-ink">{name}:</strong> {summary}
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className="-mr-1 ml-auto inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm font-semibold text-primary-ink transition-colors hover:bg-black/5 pointer-coarse:min-h-11 dark:hover:bg-white/5"
        >
          How it works
          <ChevronDown aria-hidden className={cn('size-4 transition-transform duration-200', open && 'rotate-180')} />
        </button>
      </div>

      <div id={panelId} hidden={!open} className="pb-2 pt-3 sm:pl-10">
        <p className="max-w-3xl text-sm text-ink-2">
          Every number on this page is computed from the real photos, descriptions and locations citizens submitted, and every
          prediction is labelled with the mode that produced it.
        </p>
        <div className="mt-3 grid gap-3 text-sm lg:grid-cols-2 lg:gap-4">
          {demo ? (
            <>
              <ModelList title="Answering now: demo techniques" models={demoModels} empty="No demo technique is answering." />
              <ModelList
                title="In production mode (MODEL_MODE=production)"
                models={productionModels}
                showStatus
                empty="No production models are registered on this server."
                footer="Production swaps the heuristics for trained models: object detection or CLIP zero-shot for photos, sentence embeddings for text and a RoBERTa sentiment model. Results computed in demo mode keep their demo label."
              />
            </>
          ) : (
            <ModelList title="Models in use" models={runningProduction} showStatus empty="No production model reports as running." />
          )}
        </div>
        <Button variant="link" size="sm" to="/admin/settings?tab=models" rightIcon={ArrowUpRight} className="mt-2">
          Model information
        </Button>
      </div>
    </section>
  )
}

export default AIModeBanner
