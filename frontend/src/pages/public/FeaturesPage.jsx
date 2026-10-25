/**
 * Features (public): a capability matrix per role (citizen / officer / administrator), the AI capabilities
 * with an honest Demo vs Production comparison, and - for signed-in visitors - the live status of every AI
 * model in this deployment (GET /api/ai/model-info/). The current AI mode comes from GET /api/system/config/;
 * when that request fails the mode card says why (with the Retry-After wait for a 429) and offers a retry.
 *
 * Interaction and motion (final states with reduced motion):
 * - Role cards above the matrix lean towards the pointer (TiltCard) and are toggle buttons: pressing one lights
 *   that role's column and dims the others, so "what can an officer do?" is answered at a glance.
 * - The matrix ticks stamp in group by group as the table enters the screen (each group is its own row group).
 * - The AI capabilities read as one comparison sheet with a hierarchy: a key names the two modes once (Demo AI
 *   Mode in road-marking yellow with a flask, production in sign green with a chip), then the two perception
 *   models as featured cards that lean towards the pointer, then the other capabilities as grouped rows -
 *   "upgraded in production" and "same engine in both modes". Every demo / production text carries the mode's
 *   rule and icon, and its name for screen readers, so the label is not repeated on screen.
 * - Section headings rise from a mask; body copy never animates.
 */
import {
  Activity,
  Building2,
  Camera,
  Check,
  CircleAlert,
  Combine,
  Copy,
  Cpu,
  FlaskConical,
  Gauge,
  HardHat,
  Languages,
  ListChecks,
  LogIn,
  MapPinned,
  MessageSquareText,
  Minus,
  RefreshCw,
  ScanEye,
  TriangleAlert,
  UserRound,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { TiltCard } from '@/components/motion/TiltCard'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { useAuth } from '@/hooks/useAuth'
import { useConfig } from '@/hooks/useConfig'
import { cn } from '@/utils/cn'
import { DEMO_MODE_DESCRIPTION } from '@/utils/constants'
import { getErrorMessage } from '@/utils/errors'
import { ROLE_DESCRIPTIONS } from './components/authUtils'
import { useEngineSettings } from './components/engineSettings'
import { MUTED_TEXT_AA } from './components/contrast'
import { retryAfterSeconds } from './components/landing/demoUtils'
import { useCountdown } from './components/landing/useCountdown'
import { PageIntro } from './components/PageIntro'
import { Section, SectionHeading } from './components/Section'
import '@/styles/public.css'

const ROLES = [
  { key: 'citizen', label: 'Citizen', short: 'Citizen', icon: UserRound },
  { key: 'officer', label: 'Officer', short: 'Officer', icon: HardHat },
  { key: 'admin', label: 'Administrator', short: 'Admin', icon: Building2 },
]

function capabilityGroups(reopenDays) {
  return [
    {
      group: 'Reporting and tracking',
      rows: [
        { label: 'Report an issue with a photo, a description and a GPS pin', roles: ['citizen'] },
        { label: 'See the AI category, severity and priority of a complaint, with the reasons', roles: ['citizen', 'officer', 'admin'] },
        { label: 'Follow a complaint step by step on its timeline', roles: ['citizen', 'officer', 'admin'] },
        { label: 'Get a notification at every change', roles: ['citizen', 'officer', 'admin'] },
        { label: 'Edit or withdraw a report until an officer accepts it', roles: ['citizen'] },
      ],
    },
    {
      group: 'Field work',
      rows: [
        { label: 'Work a priority-sorted queue with search, filters and a map', roles: ['officer', 'admin'] },
        { label: 'Accept a complaint and start work', roles: ['officer'] },
        { label: 'Resolve or reject a complaint, with remarks', roles: ['officer', 'admin'] },
        { label: 'Upload before and after photos', roles: ['officer', 'admin'] },
        { label: 'Run AI verification of the fix, or ask for a manual review', roles: ['officer', 'admin'] },
        { label: 'Review possible duplicate reports', roles: ['officer', 'admin'] },
      ],
    },
    {
      group: 'Feedback',
      rows: [
        { label: 'Rate the fix and leave written feedback', roles: ['citizen'] },
        { label: `Reopen a complaint within ${reopenDays} days of the fix`, roles: ['citizen', 'admin'] },
        { label: 'See sentiment analytics of all feedback', roles: ['admin'] },
      ],
    },
    {
      group: 'Administration',
      rows: [
        { label: 'Assign and reassign officers, with AI recommendations', roles: ['admin'] },
        { label: 'Override the AI category, severity or priority (audited)', roles: ['admin'] },
        { label: 'Manage users, officers, departments, categories and routing', roles: ['admin'] },
        { label: 'Tune AI weights, thresholds and risk zones', roles: ['admin'] },
        { label: 'Hotspot map, AI analytics and CSV or PDF reports', roles: ['admin'] },
        { label: 'Audit log of every important action', roles: ['admin'] },
      ],
    },
  ]
}

const AI_CAPABILITIES = [
  {
    name: 'Issue detection in photos',
    icon: Camera,
    featured: true,
    demo: 'OpenCV colour, texture and shape heuristics with boxes from the contours they found. Confidence is capped at 75%.',
    production: 'A YOLOv8 detector when trained weights are installed, otherwise CLIP zero-shot classification with an approximate region.',
  },
  {
    name: 'Understanding the description',
    icon: MessageSquareText,
    featured: true,
    demo: 'TF-IDF features and logistic regression trained on a labelled complaint corpus, plus database keywords.',
    production: 'MiniLM sentence embeddings with a logistic-regression head, plus the same database keywords.',
  },
  {
    name: 'Hinglish and Telugu words',
    icon: Languages,
    demo: 'Normalised before analysis: gaddha becomes pothole, kachra garbage, nala drain, chettu tree.',
    production: 'Same normalisation.',
  },
  {
    name: 'Combining photo and text',
    icon: Combine,
    demo: 'Confidence-weighted late fusion with weak priors from the citizen and nearby reports.',
    production: 'Same fusion engine.',
  },
  {
    name: 'Severity and priority',
    icon: Gauge,
    demo: 'Weighted factor models with plain-language reasons; weights and thresholds are configurable.',
    production: 'Same engines.',
  },
  {
    name: 'Duplicate detection',
    icon: Copy,
    demo: 'TF-IDF text vectors, perceptual hashes, colour histograms and GPS distance.',
    production: 'Adds MiniLM text embeddings and CLIP image embeddings.',
  },
  {
    name: 'Verifying a fix',
    icon: ScanEye,
    demo: 'ORB alignment, SSIM and region change, then the demo detector looks for the issue again.',
    production: 'Adds CLIP scene similarity and the production detector.',
  },
  {
    name: 'Feedback sentiment',
    icon: Activity,
    demo: 'A lexicon model with negation, intensifiers and civic phrases.',
    production: 'A RoBERTa sentiment model (cardiffnlp twitter-roberta-base-sentiment-latest).',
  },
  {
    name: 'Hotspots',
    icon: MapPinned,
    demo: 'DBSCAN clustering on map coordinates with the haversine distance.',
    production: 'Same clustering.',
  },
]

const STATUS_TONES = {
  active: { tone: 'green', label: 'Active' },
  available: { tone: 'blue', label: 'Available' },
  loaded: { tone: 'green', label: 'Loaded' },
  not_installed: { tone: 'neutral', label: 'Not installed' },
  not_loaded: { tone: 'neutral', label: 'Not loaded' },
  unavailable: { tone: 'orange', label: 'Unavailable' },
  error: { tone: 'red', label: 'Error' },
  failed: { tone: 'red', label: 'Failed' },
}

function statusMeta(status) {
  return STATUS_TONES[status] ?? { tone: 'neutral', label: String(status ?? 'Unknown').replace(/_/g, ' ') }
}

/** "Demo AI Mode: results come from ..." -> "Results come from ..." (the card title already names the mode). */
function withoutModePrefix(text) {
  const rest = String(text ?? '').replace(/^\s*Demo AI Mode:\s*/i, '')
  return rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : rest
}

/**
 * Shown instead of the AI mode when GET /api/system/config/ failed (rate limit, server error, offline):
 * what happened, how long to wait after a 429, and a retry that reloads the shared configuration.
 */
function ModeCardError({ error, retrying, onRetry }) {
  const waitSeconds = retryAfterSeconds(error)
  const remaining = useCountdown(waitSeconds ?? 0, error)
  const limited = waitSeconds != null
  const Icon = limited ? TriangleAlert : CircleAlert
  let message = getErrorMessage(error, 'The server did not answer. Try again in a moment.')
  if (limited) {
    message =
      remaining > 0
        ? `The server is limiting requests from this network. Wait ${remaining}\u00a0s, then try again.`
        : 'The server is limiting requests from this network. You can try again now.'
  }

  return (
    <div className="rounded-xl border border-line bg-surface-2 p-5">
      <div role={limited ? 'status' : 'alert'}>
        <p className="flex items-center gap-2 font-display text-lg font-bold leading-snug text-ink">
          <Icon
            aria-hidden
            className={cn(
              'size-5 shrink-0',
              limited ? 'text-marking-700 dark:text-marking-300' : 'text-signal-600 dark:text-signal-300',
            )}
          />
          AI mode could not be loaded
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink-2">{message}</p>
      </div>
      <Button
        size="sm"
        variant="outline"
        leftIcon={RefreshCw}
        className="mt-4"
        onClick={onRetry}
        loading={retrying}
        disabled={remaining > 0}
      >
        {remaining > 0 ? `Try again in ${remaining}\u00a0s` : 'Try again'}
      </Button>
    </div>
  )
}

function ModeCard() {
  const { loaded, loading, error, isDemo, config, reload } = useConfig()
  if (!loaded && error) return <ModeCardError error={error} retrying={loading} onRetry={reload} />
  if (!loaded) {
    return (
      <div aria-hidden className="space-y-3 rounded-xl border border-line bg-surface-2 p-5">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-5">
      <p className="text-xs font-medium text-ink-3">This deployment runs in</p>
      <p className="mt-1.5 flex items-center gap-2 font-display text-xl font-extrabold text-ink">
        {isDemo ? <FlaskConical aria-hidden className="size-5 text-marking-700 dark:text-marking-300" /> : <Cpu aria-hidden className="size-5 text-sign-600" />}
        {isDemo ? 'Demo AI Mode' : 'Production AI'}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-ink-2">
        {isDemo ? withoutModePrefix(config.demo_disclaimer || DEMO_MODE_DESCRIPTION) : 'The AI engine uses trained deep-learning models where they are installed.'}
      </p>
      {isDemo ? (
        <p className="mt-2 text-sm leading-relaxed text-ink-2">
          Every result is still computed from the real photo, description and location, and is labelled as demo.
        </p>
      ) : null}
    </div>
  )
}

/**
 * The three roles as cards that lean towards the pointer. Each is a toggle button: pressed, it lights that
 * role's column in the matrix below (and dims the others); pressing it again shows every column equally.
 */
function RoleCards({ focus, onFocus }) {
  return (
    <ul className="mt-10 grid gap-3 sm:grid-cols-3" aria-label="Highlight a role in the table">
      {ROLES.map((role) => {
        const pressed = focus === role.key
        return (
          <li key={role.key} className="min-w-0">
            <TiltCard
              as="button"
              type="button"
              max={7}
              aria-pressed={pressed}
              onClick={() => onFocus(pressed ? null : role.key)}
              className={cn(
                'pressable group flex h-full w-full items-start gap-3.5 rounded-xl border p-4 text-left [--press-scale:0.985] sm:p-5',
                'transition-[border-color,background-color,box-shadow] duration-200 ease-standard',
                pressed
                  ? 'border-sign-300 bg-primary-soft elev-raised dark:border-sign-500/40'
                  : 'border-line bg-surface hover:border-line-strong hover:elev-raised',
              )}
            >
              <span
                className={cn(
                  'grid size-11 shrink-0 place-items-center rounded-lg transition-colors duration-200',
                  pressed ? 'bg-primary text-white' : 'bg-sunken text-ink-2 group-hover:text-ink',
                )}
              >
                <role.icon aria-hidden className="size-5" />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-2 font-display text-lg font-bold leading-tight text-ink">
                  {role.label}
                  {pressed ? <Check aria-hidden className="size-4 animate-pop-in text-primary-ink" strokeWidth={3} /> : null}
                </span>
                <span className="mt-1 block text-sm leading-snug text-ink-2">{ROLE_DESCRIPTIONS[role.key]}</span>
              </span>
            </TiltCard>
          </li>
        )
      })}
    </ul>
  )
}

/** One group of the matrix as its own row group, whose ticks stamp in when it first enters the screen. */
function CapabilityGroup({ group }) {
  const ref = useRef(null)
  const stamped = useInViewOnce(ref, { margin: '0px 0px -12% 0px' })
  return (
    <tbody ref={ref} data-stamped={stamped ? 'true' : 'false'}>
      <tr className="border-b border-line">
        <th scope="rowgroup" colSpan={ROLES.length + 1} className="bg-bg px-4 pb-2 pt-5 font-display text-base font-bold text-ink sm:px-5">
          {group.group}
        </th>
      </tr>
      {group.rows.map((row, rowIndex) => (
        <tr key={row.label} className="border-b border-line">
          <th scope="row" className="px-4 py-3 text-sm font-normal leading-snug text-ink sm:px-5 sm:text-[15px]">
            {row.label}
          </th>
          {ROLES.map((role, colIndex) => {
            const allowed = row.roles.includes(role.key)
            return (
              <td key={role.key} data-col={role.key} className="px-1 py-3 text-center sm:px-2">
                {allowed ? (
                  <Check
                    aria-hidden
                    className="pub-stamp mx-auto size-5 text-sign-600 dark:text-sign-300"
                    strokeWidth={2.5}
                    style={{ '--stamp-delay': rowIndex * 55 + colIndex * 35 }}
                  />
                ) : (
                  <Minus aria-hidden className="mx-auto size-4 text-line-strong" />
                )}
                <span className="sr-only">{allowed ? 'Yes' : 'No'}</span>
              </td>
            )
          })}
        </tr>
      ))}
    </tbody>
  )
}

function CapabilityMatrix({ groups, focus }) {
  const reduced = usePrefersReducedMotion()
  return (
    <div className="relative mt-6 overflow-x-auto rounded-xl border border-line bg-surface scrollbar-thin">
      <table
        className="pub-matrix w-full border-collapse text-left sm:min-w-[34rem] [&_tbody:last-child_tr:last-child]:border-b-0"
        data-focus={focus ?? undefined}
        data-stamp-ready={reduced ? undefined : ''}
      >
        <caption className="sr-only">What each role can do in CivicAI</caption>
        <thead>
          <tr className="border-b border-line bg-surface-2 text-xs font-semibold text-ink-3">
            <th scope="col" className="px-4 py-3 sm:px-5">
              Capability
            </th>
            {ROLES.map((role) => (
              <th
                key={role.key}
                scope="col"
                data-col={role.key}
                className={cn('w-[3.75rem] px-1 py-3 text-center sm:w-28 sm:px-2', focus === role.key && 'text-primary-ink')}
              >
                <span className="sm:hidden">{role.short}</span>
                <span className="hidden sm:inline">{role.label}</span>
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((group) => (
          <CapabilityGroup key={group.group} group={group} />
        ))}
      </table>
    </div>
  )
}

/** The two modes: name, icon and colour, named once on screen by the key (ModeKey). */
const MODES = {
  demo: {
    label: 'Demo AI Mode',
    icon: FlaskConical,
    rule: 'before:bg-marking-500',
    chip: 'bg-marking-100 text-marking-800 ring-marking-300 dark:bg-marking-500/15 dark:text-marking-300 dark:ring-marking-500/35',
  },
  production: {
    label: 'Production mode',
    icon: Cpu,
    rule: 'before:bg-sign-500',
    chip: 'bg-sign-50 text-sign-700 ring-sign-200 dark:bg-sign-500/15 dark:text-sign-300 dark:ring-sign-500/35',
  },
}

const isSame = (item) => item.production.startsWith('Same')

/** The key of the comparison: each mode's chip, once, above the cards and rows that use its rule and icon. */
function ModeKey({ className }) {
  return (
    <div aria-hidden className={cn('flex flex-wrap items-center gap-2.5', className)}>
      {['demo', 'production'].map((key) => {
        const mode = MODES[key]
        return (
          <span
            key={key}
            className={cn('inline-flex min-h-8 items-center gap-2 rounded-full px-3 text-[13px] font-semibold ring-1 ring-inset', mode.chip)}
          >
            <mode.icon className="size-4" />
            {mode.label}
          </span>
        )
      })}
    </div>
  )
}

/**
 * One mode's text for a capability: a coloured rule and the mode's icon (the key above names them), and the
 * mode's name for screen readers. `muted` for production texts that only say "Same ...".
 */
function ModeText({ mode: key, children, muted = false, className }) {
  const mode = MODES[key]
  return (
    <div
      className={cn(
        "relative pl-4 before:absolute before:inset-y-0.5 before:left-0 before:w-[3px] before:rounded-full before:content-['']",
        mode.rule,
        className,
      )}
    >
      <dt className="sr-only">{mode.label}</dt>
      <dd className={cn('flex gap-2', muted ? 'text-ink-3' : 'text-ink-2')}>
        <mode.icon aria-hidden className={cn('mt-[0.3em] size-3.5 shrink-0', key === 'demo' ? 'text-marking-700 dark:text-marking-300' : 'text-sign-600 dark:text-sign-400')} />
        <span>{children}</span>
      </dd>
    </div>
  )
}

/** A featured capability (the two perception models): a large card that tilts, the two modes side by side. */
function FeaturedCapability({ item }) {
  return (
    <TiltCard as="article" max={4} className="flex h-full flex-col rounded-2xl border border-line bg-surface p-6 transition-shadow duration-200 hover:elev-raised sm:p-7">
      <div className="flex items-center gap-4">
        <span className="grid size-14 shrink-0 place-items-center rounded-xl bg-asphalt-900 text-marking-400 ring-1 ring-inset ring-white/10 dark:bg-asphalt-800">
          <item.icon aria-hidden className="size-6" />
        </span>
        <h3 className="display-sm text-ink">{item.name}</h3>
      </div>
      <dl className="mt-6 grid gap-5 text-[15px] leading-relaxed sm:grid-cols-2 sm:gap-6 sm:text-base">
        <ModeText mode="demo">{item.demo}</ModeText>
        <ModeText mode="production" muted={isSame(item)}>
          {item.production}
        </ModeText>
      </dl>
    </TiltCard>
  )
}

/** A group of capabilities as rows: name, then the two modes in the key's order (columns from lg). */
function CapabilityRows({ id, title, items }) {
  if (!items.length) return null
  return (
    <section aria-labelledby={id} className="min-w-0">
      <h3 id={id} className="font-display text-xs font-bold uppercase tracking-[0.14em] text-ink-3">
        {title}
      </h3>
      <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {items.map((item) => (
          <li key={item.name} className="grid gap-x-8 gap-y-3 px-5 py-4 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
            <div className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-asphalt-800 text-white dark:bg-asphalt-700">
                <item.icon aria-hidden className="size-[18px]" />
              </span>
              <h4 className="font-display text-base font-bold leading-snug text-ink">{item.name}</h4>
            </div>
            <dl className="contents text-[15px] leading-relaxed">
              <ModeText mode="demo">{item.demo}</ModeText>
              <ModeText mode="production" muted={isSame(item)}>
                {item.production}
              </ModeText>
            </dl>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The AI capabilities: the key, the featured perception models, then the other capabilities in two groups. */
function CapabilitySheet() {
  const featured = AI_CAPABILITIES.filter((item) => item.featured)
  const upgraded = AI_CAPABILITIES.filter((item) => !item.featured && !isSame(item))
  const same = AI_CAPABILITIES.filter((item) => !item.featured && isSame(item))
  return (
    <div className="mt-10">
      <ModeKey />
      <ul className="mt-5 grid gap-4 lg:grid-cols-2">
        {featured.map((item) => (
          <li key={item.name} className="min-w-0">
            <FeaturedCapability item={item} />
          </li>
        ))}
      </ul>
      <div className="mt-10 grid gap-10">
        <CapabilityRows id="ai-upgraded-title" title="Upgraded in production" items={upgraded} />
        <CapabilityRows id="ai-same-title" title="Same engine in both modes" items={same} />
      </div>
    </div>
  )
}

function ModelStatus() {
  const { isAuthenticated } = useAuth()
  const location = useLocation()
  const { modelInfo, loading } = useEngineSettings()
  const models = Array.isArray(modelInfo?.models) ? modelInfo.models : []

  if (!isAuthenticated) {
    return (
      <div className="flex flex-col gap-4 rounded-xl border border-dashed border-line-strong bg-surface p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="font-display text-base font-bold text-ink">Which models are installed here?</h3>
          <p className="mt-1 text-sm text-ink-2">Signed-in users can see the live status of every model in this deployment.</p>
        </div>
        <Button variant="outline" leftIcon={LogIn} to={`/login?next=${encodeURIComponent(location.pathname)}`}>
          Log in to see the models
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-line bg-surface">
      <div className="border-b border-line px-5 py-4">
        <h3 className="font-display text-base font-bold text-ink">Models in this deployment</h3>
        <p className="mt-0.5 text-sm text-ink-2">Live status reported by the AI engine.</p>
      </div>
      {loading && !models.length ? (
        <div aria-hidden className="space-y-3 px-5 py-4">
          {[0, 1, 2, 3].map((key) => (
            <Skeleton key={key} className="h-5 w-full" />
          ))}
        </div>
      ) : models.length ? (
        <ul className="divide-y divide-line">
          {models.map((model) => {
            const meta = statusMeta(model.status)
            return (
              <li key={`${model.name}-${model.version}`} className="grid gap-x-4 gap-y-1 px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <div className="min-w-0">
                  <p className="font-semibold text-ink">
                    {model.name}
                    {model.is_demo ? <span className="font-normal text-ink-3"> (demo technique)</span> : null}
                  </p>
                  <p className="text-sm text-ink-2">{model.task}</p>
                  {model.detail ? <p className="text-xs text-ink-3">{model.detail}</p> : null}
                </div>
                <Badge tone={meta.tone} size="sm" className="justify-self-start sm:justify-self-end">
                  {meta.label}
                </Badge>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="px-5 py-4 text-sm text-ink-2">The AI engine did not report any models.</p>
      )}
    </div>
  )
}

export default function FeaturesPage() {
  const { reopenWindowDays } = useConfig()
  const groups = capabilityGroups(reopenWindowDays)
  const [focus, setFocus] = useState(null)

  return (
    <div className={MUTED_TEXT_AA}>
      <PageIntro
        scene="analyze"
        icon={ListChecks}
        title="Features"
        lead="Three roles share one complaint record. Citizens report and follow, officers fix and prove it, administrators steer the whole city. Everything listed here works end to end in this deployment."
        aside={<ModeCard />}
      />

      <Section id="roles" labelledBy="roles-title" tone="bg">
        <SectionHeading
          id="roles-title"
          reveal
          title="What each role can do"
          lead="Permissions are enforced by the API, not just hidden in the interface: a citizen only ever sees their own complaints, an officer their assigned or department complaints."
        />
        <RoleCards focus={focus} onFocus={setFocus} />
        <CapabilityMatrix groups={groups} focus={focus} />
      </Section>

      <Section id="ai-capabilities" labelledBy="ai-title" tone="surface">
        <SectionHeading
          id="ai-title"
          reveal
          title="AI capabilities"
          lead="Every AI feature works in two modes. Demo AI Mode needs no trained weights and is honest about it: each result carries a Demo AI Mode label. Production mode swaps in trained models where they are installed."
        />
        <CapabilitySheet />
        <div className="mt-8">
          <ModelStatus />
        </div>
      </Section>
    </div>
  )
}
