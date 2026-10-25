/**
 * ModelInfoTab - which AI is answering right now, honestly.
 *
 * Data: GET /ai/model-info/ -> `{mode, is_demo, badge, models[], components[], registry[], disclaimer, config}`.
 * - Mode panel: Demo AI Mode or production, with what that means and the API's own disclaimer.
 * - Models: every model of the vision, NLP and verification modules with its status (active / available /
 *   fallback / weights missing / not installed) and version; split into the ones answering now and the rest.
 * - Engine components: priority, duplicates, hotspots, fusion and severity with their live settings.
 * - Runtime registry: what this server process has loaded so far.
 * - How to switch to production: the exact steps (requirements-ml.txt, YOLO weights, MODEL_MODE).
 */
import { Cpu, FlaskConical, ListChecks, Settings2, Terminal } from 'lucide-react'
import { ModelInfoCard } from '@/components/ai'
import { Badge } from '@/components/ui/Badge'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { DataTable } from '@/components/ui/DataTable'
import { ErrorState } from '@/components/ui/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { useApi } from '@/hooks/useApi'
import { aiService } from '@/services'
import { DEMO_MODE_DESCRIPTION } from '@/utils/constants'
import { formatDateTime } from '@/utils/format'

const STATUS_TONES = { active: 'green', loaded: 'green', available: 'blue', fallback: 'yellow', weights_missing: 'orange', not_installed: 'neutral', error: 'red' }
const STATUS_LABELS = {
  active: 'Active',
  loaded: 'Loaded',
  available: 'Available',
  fallback: 'Fallback in use',
  weights_missing: 'Weights missing',
  not_installed: 'Not installed',
  error: 'Error',
}

/** "Demo AI Mode: the AI engine ..." -> "The AI engine ..." (the panel heading already names the mode). */
function withoutModePrefix(text) {
  const rest = String(text ?? '').replace(/^Demo AI Mode:\s*/i, '')
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : rest
}

function Code({ children }) {
  return <code className="rounded bg-sunken px-1.5 py-0.5 text-[13px] text-ink">{children}</code>
}

const PRODUCTION_STEPS = [
  {
    title: 'Install the deep-learning stack',
    body: (
      <>
        In <Code>backend/</Code> run <Code>pip install -r requirements-ml.txt</Code> (PyTorch, Ultralytics YOLO, Transformers,
        Sentence-Transformers).
      </>
    ),
  },
  {
    title: 'Provide the trained detector',
    body: (
      <>
        Train the civic-issue detector with <Code>python scripts/train_yolo.py</Code>, which exports{' '}
        <Code>ml_models/yolo/civicai_yolov8.pt</Code> (or point <Code>YOLO_WEIGHTS</Code> at your weights). Without it the image
        model falls back to CLIP zero-shot classification.
      </>
    ),
  },
  {
    title: 'Switch the mode',
    body: (
      <>
        Set <Code>MODEL_MODE=production</Code> in <Code>backend/.env</Code>. Optional: <Code>TEXT_EMBEDDING_MODEL</Code>,{' '}
        <Code>SENTIMENT_MODEL</Code>, <Code>CLIP_MODEL</Code> and <Code>AI_DEVICE</Code> (cpu or cuda).
      </>
    ),
  },
  {
    title: 'Restart the API server',
    body: <>Models load on first use. Any model that cannot load reports “Fallback in use” here and the demo technique keeps answering.</>,
  },
]

function ModelGrid({ models }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
      {models.map((model) => (
        <ModelInfoCard key={`${model.key ?? model.name}-${model.version}`} model={model} />
      ))}
    </div>
  )
}

export function ModelInfoTab() {
  const info = useApi(() => aiService.modelInfo(), [])
  const data = info.data

  if (info.error && !data) {
    return <ErrorState title="Model information could not be loaded" error={info.error} onRetry={() => info.refetch()} />
  }
  if (!data) {
    return (
      <div aria-hidden className="space-y-5">
        <Skeleton className="h-36 w-full rounded-xl" />
        <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <Skeleton key={index} className="h-44 w-full rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  const models = Array.isArray(data.models) ? data.models : []
  const running = models.filter((model) => ['active', 'loaded', 'fallback'].includes(model.status))
  const standby = models.filter((model) => !['active', 'loaded', 'fallback'].includes(model.status))
  const components = Array.isArray(data.components) ? data.components : []
  const registry = Array.isArray(data.registry) ? data.registry : []
  const demo = Boolean(data.is_demo)

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-line bg-surface p-5" aria-labelledby="ai-mode-heading">
        <div className="flex flex-col gap-4 md:flex-row md:items-start">
          <span className={demo ? 'grid size-12 shrink-0 place-items-center rounded-xl bg-marking-50 text-marking-700 dark:bg-marking-500/15 dark:text-marking-300' : 'grid size-12 shrink-0 place-items-center rounded-xl bg-sign-50 text-sign-700 dark:bg-sign-500/15 dark:text-sign-300'}>
            {demo ? <FlaskConical aria-hidden className="size-6" /> : <Cpu aria-hidden className="size-6" />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="ai-mode-heading" className="font-display text-xl font-extrabold text-ink">
                {demo ? 'Demo AI Mode' : 'Production AI'}
              </h2>
              <Code>MODEL_MODE={data.mode}</Code>
            </div>
            <p className="mt-2 max-w-3xl text-sm text-ink-2">
              {demo
                ? withoutModePrefix(DEMO_MODE_DESCRIPTION)
                : 'The engine uses the trained deep-learning models: YOLO detection or CLIP for photos, sentence-transformer embeddings for text and duplicates, and a RoBERTa sentiment model. Results are still advisory and labelled with their model version.'}
            </p>
            {data.disclaimer ? <p className="mt-2 max-w-3xl text-xs text-ink-3">{withoutModePrefix(data.disclaimer)}</p> : null}
          </div>
        </div>
      </section>

      <section aria-labelledby="models-running">
        <h2 id="models-running" className="mb-1 font-display text-lg font-bold text-ink">
          Answering now
        </h2>
        <p className="mb-3 text-sm text-ink-2">The models that produce today&apos;s classifications, sentiment and verifications.</p>
        <ModelGrid models={running} />
      </section>

      {standby.length ? (
        <section aria-labelledby="models-standby">
          <h2 id="models-standby" className="mb-1 font-display text-lg font-bold text-ink">
            Production models
          </h2>
          <p className="mb-3 text-sm text-ink-2">Installed or prepared models that take over when the mode is switched to production.</p>
          <ModelGrid models={standby} />
        </section>
      ) : null}

      <section aria-labelledby="engine-components">
        <h2 id="engine-components" className="mb-1 font-display text-lg font-bold text-ink">
          Engine components
        </h2>
        <p className="mb-3 text-sm text-ink-2">Rule-based and statistical parts of the pipeline, with the live values from the AI configuration.</p>
        <ModelGrid models={components} />
      </section>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader icon={ListChecks} title="Runtime registry" description="Models this server process has loaded since it started." />
          <CardBody className="p-0 sm:p-0">
            <DataTable
              caption="Loaded models"
              className="relative rounded-none border-0"
              data={registry}
              rowKey={(row) => row.name}
              columns={[
                { key: 'name', header: 'Model', render: (row) => <span className="font-semibold text-ink">{row.name}</span> },
                {
                  key: 'status',
                  header: 'Status',
                  render: (row) => (
                    <Badge tone={STATUS_TONES[row.status] ?? 'neutral'} size="sm" dot>
                      {STATUS_LABELS[row.status] ?? row.status}
                    </Badge>
                  ),
                },
                { key: 'version', header: 'Version', render: (row) => <span className="text-xs text-ink-2">{row.version}</span> },
                {
                  key: 'updated',
                  header: 'Since',
                  hideOnMobile: true,
                  render: (row) => <span className="whitespace-nowrap text-xs text-ink-3 tabular">{row.updated_at ? formatDateTime(row.updated_at * 1000) : '—'}</span>,
                },
              ]}
              empty={<p className="px-5 py-6 text-sm text-ink-3">Nothing loaded yet: models load on their first request.</p>}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={Terminal} title="How to switch to production" description="Run on the server that hosts the API." />
          <CardBody>
            <ol className="space-y-4">
              {PRODUCTION_STEPS.map((step, index) => (
                <li key={step.title} className="flex gap-3">
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-ink font-display text-sm font-bold text-surface tabular">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{step.title}</p>
                    <p className="mt-0.5 text-sm leading-relaxed text-ink-2">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-4 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">
              <Settings2 aria-hidden className="mt-px size-4 shrink-0 text-ink-3" />
              The tuning on the AI configuration tab applies in both modes.
            </p>
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

export default ModelInfoTab
