/**
 * About CivicAI (public): the problem the project addresses, its objectives, the system architecture
 * (drawn in HTML: React PWA -> Django REST API -> MySQL, with the framework-independent AI engine and its
 * modules), the technology stack and a factual note about the project. The fact sheet (version, AI mode,
 * map region) is read live from GET /api/system/config/.
 *
 * Motion that means something (once, as each part enters the screen; final states with reduced motion):
 * - The problem: each row's status signal turns from signal red to a sign-green tick when its answer is read.
 * - Objectives: numbered like kilometre stones along a highway; a stone's yellow cap fills as the reader reaches
 *   it, so scrolling the list is travelling the complaint's route.
 * - Architecture: the request travels down the stack - the app, the API, then the database and the AI engine
 *   arrive in that order - and the connectors carry flowing lane dashes in the direction of the calls.
 * - Section headings rise from a mask; body copy never animates.
 */
import { motion } from 'framer-motion'
import {
  Activity,
  Brain,
  Camera,
  Check,
  Combine,
  Copy,
  Database,
  Gauge,
  Info,
  MapPinned,
  MessageSquareText,
  ScanEye,
  Smartphone,
  SquareStack,
  TriangleAlert,
} from 'lucide-react'
import { useRef } from 'react'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { RevealHeading } from '@/components/motion/MaskReveal'
import { EASE } from '@/components/motion/tokens'
import { KeyValueList } from '@/components/ui/KeyValueList'
import { Skeleton } from '@/components/ui/Skeleton'
import { useConfig } from '@/hooks/useConfig'
import { cn } from '@/utils/cn'
import { MUTED_TEXT_AA } from './components/contrast'
import { PageIntro } from './components/PageIntro'
import { Section, SECTION_TITLE_CLASS, SectionHeading } from './components/Section'

const PROBLEMS = [
  {
    title: 'Unstructured',
    problem: 'Complaints arrive as free text, a blurry photo and a vague address, in English, Hinglish or Telugu.',
    answer: 'Multimodal AI turns the photo, the text and the GPS pin into a category, a severity and a priority, each with its reason.',
  },
  {
    title: 'Misrouted',
    problem: 'A complaint sent to the wrong desk waits for days before someone forwards it.',
    answer: 'A routing table sends every category to its department, and the best-placed officer is recommended and assigned.',
  },
  {
    title: 'Duplicated',
    problem: 'Ten people report the same pothole and ten separate jobs are opened.',
    answer: 'Text, photo and location similarity link repeat reports to the original, so the crew gets one job.',
  },
  {
    title: 'Unverified',
    problem: 'A complaint is marked resolved without anyone checking the street.',
    answer: 'Before and after photos are compared by AI, and the citizen rates the fix and can reopen it.',
  },
]

const OBJECTIVES = [
  'Identify the civic issue from a photo, a description and a location.',
  'Classify the issue into a civic category.',
  'Estimate its severity.',
  'Calculate a priority score with an explanation.',
  'Detect duplicate complaints.',
  'Identify the responsible department.',
  'Recommend and assign an officer.',
  'Track the progress of every complaint.',
  'Monitor resolution against response targets.',
  'Verify resolution with before and after photos.',
  'Collect citizen feedback.',
  'Analyse the sentiment of that feedback.',
  'Find geographical hotspots of civic issues.',
  'Give administrators live analytics.',
]

const AI_MODULES = [
  { icon: Camera, name: 'Vision', technique: 'YOLOv8, CLIP or OpenCV heuristics' },
  { icon: MessageSquareText, name: 'NLP', technique: 'TF-IDF or MiniLM, Hinglish normalisation' },
  { icon: Combine, name: 'Multimodal fusion', technique: 'Confidence-weighted late fusion' },
  { icon: TriangleAlert, name: 'Severity', technique: 'Seven weighted factors' },
  { icon: Gauge, name: 'Priority', technique: 'Five weighted factors, 0-100' },
  { icon: Copy, name: 'Duplicates', technique: 'Text, perceptual-hash and GPS similarity' },
  { icon: MapPinned, name: 'Geospatial', technique: 'Location risk and DBSCAN hotspots' },
  { icon: ScanEye, name: 'Verification', technique: 'ORB alignment, SSIM, re-detection' },
  { icon: Activity, name: 'Sentiment', technique: 'Lexicon or RoBERTa' },
]

const STACK = [
  {
    layer: 'Frontend',
    items: 'React 19, Vite 7, Tailwind CSS 4, React Router 7, Axios, Framer Motion, Recharts, Leaflet with React-Leaflet, Lucide icons',
    note: 'An installable progressive web app, so citizens can use it like a phone app.',
  },
  {
    layer: 'Backend',
    items: 'Python 3.13, Django 5.2, Django REST Framework, Simple JWT, django-filter, django-cors-headers, Pillow',
    note: 'A REST API with role-based permissions, JWT authentication and an audit log.',
  },
  {
    layer: 'Database',
    items: 'MySQL 8 through the Django ORM and migrations (SQLite for local development)',
    note: 'Complaints, AI predictions, priorities, assignments, feedback and notifications are all stored rows.',
  },
  {
    layer: 'AI and ML',
    items: 'PyTorch, Ultralytics YOLOv8, OpenCV, scikit-learn, Sentence-Transformers, Hugging Face Transformers, ImageHash, pandas, NumPy',
    note: 'A framework-independent engine package with a demo mode that needs no trained weights.',
  },
  {
    layer: 'Maps',
    items: 'Leaflet, OpenStreetMap tiles, Nominatim geocoding through the API',
    note: 'GPS pins, address lookup, clustered complaint maps and hotspot circles.',
  },
  {
    layer: 'Background jobs',
    items: 'Celery with Redis (optional)',
    note: 'Response-target checks and hotspot scans; both also run on demand.',
  },
  {
    layer: 'Deployment',
    items: 'Vercel for the web app, Render or Railway for the API, a MySQL-compatible cloud database',
    note: 'Configured through environment variables; no secrets in the code.',
  },
]

/** A labelled vertical link between two tiers; its dashes flow downwards while the diagram is on screen. */
function Connector({ label, shown, delay }) {
  return (
    <motion.div
      className="flex flex-col items-center py-1"
      aria-hidden
      initial={false}
      animate={shown ? { opacity: 1, scaleY: 1 } : { opacity: 0, scaleY: 0 }}
      transition={{ duration: 0.4, delay, ease: EASE.enter }}
      style={{ originY: 0 }}
    >
      <span className="pub-flow-y h-5 w-0.5" />
      <span className="rounded-md bg-sunken px-2 py-0.5 text-center text-xs font-medium text-ink-2">{label}</span>
      <span className="pub-flow-y h-5 w-0.5" />
    </motion.div>
  )
}

function Tier({ title, subtitle, icon: Icon, shown, delay = 0, children, className }) {
  return (
    <motion.div
      initial={false}
      animate={shown ? { opacity: 1, y: 0 } : { opacity: 0, y: 14 }}
      transition={{ duration: 0.5, delay, ease: EASE.enter }}
      className={cn('min-w-0 rounded-xl border border-line bg-surface p-4 sm:p-5', className)}
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-asphalt-800 text-white dark:bg-asphalt-700">
          <Icon aria-hidden className="size-[18px]" />
        </span>
        <div className="min-w-0">
          <h3 className="font-display text-base font-bold leading-snug text-ink">{title}</h3>
          {subtitle ? <p className="text-sm text-ink-2">{subtitle}</p> : null}
        </div>
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </motion.div>
  )
}

/**
 * The stack drawn in HTML. When it first enters the screen the request travels down it: the web app, the link,
 * the API, the bus, then the database, workers and AI engine arrive in that order. While it stays on screen the
 * connectors' dashes flow in the direction of the calls (yellow lane marking); reduced motion shows it complete
 * and still.
 */
function ArchitectureDiagram() {
  const ref = useRef(null)
  const reduced = usePrefersReducedMotion()
  const inView = useInViewOnce(ref, { margin: '0px 0px -20% 0px' })
  const shown = reduced || inView
  const step = (index) => (reduced ? 0 : index * 0.16)

  return (
    <figure ref={ref} className="mt-10" data-flowing={shown && !reduced ? 'true' : undefined}>
      <div className="mx-auto max-w-5xl">
        <Tier
          icon={Smartphone}
          title="React web app (installable PWA)"
          subtitle="One app for three roles: citizens on phones, officers in the field, administrators at a desk."
          shown={shown}
          delay={step(0)}
        >
          <ul className="flex flex-wrap gap-1.5 text-xs">
            {['Citizen portal', 'Officer workspace', 'Administration', 'Public site and live AI demo'].map((item) => (
              <li key={item} className="rounded-md bg-surface-2 px-2 py-0.5 font-medium text-ink-2 ring-1 ring-inset ring-line">
                {item}
              </li>
            ))}
          </ul>
        </Tier>

        <Connector label="HTTPS: JSON and photo uploads, JWT bearer tokens" shown={shown} delay={step(1)} />

        <Tier
          icon={SquareStack}
          title="Django REST API"
          subtitle="Validates every request, applies role permissions, runs the complaint workflow and writes the audit log."
          shown={shown}
          delay={step(2)}
        >
          <ul className="flex flex-wrap gap-1.5 text-xs">
            {['Accounts', 'Complaints', 'Assignments', 'Feedback', 'Notifications', 'Analytics', 'Audit'].map((item) => (
              <li key={item} className="rounded-md bg-surface-2 px-2 py-0.5 font-medium text-ink-2 ring-1 ring-inset ring-line">
                {item}
              </li>
            ))}
          </ul>
        </Tier>

        {/* Large screens: one bus from the API down to both columns (column centres of a 1fr / 2fr grid). */}
        <motion.div
          aria-hidden
          className="hidden lg:block"
          initial={false}
          animate={shown ? { opacity: 1 } : { opacity: 0 }}
          transition={{ duration: 0.4, delay: step(3) }}
        >
          <div className="pub-flow-y mx-auto h-5 w-0.5" />
          <div className="relative grid grid-cols-[1fr_2fr] gap-4">
            <span
              className="pub-flow-x absolute top-0 h-0.5"
              style={{ left: 'calc((100% - 1rem) / 6)', right: 'calc((100% - 1rem) / 3)' }}
            />
            {['Django ORM and scheduled jobs', 'Python function calls'].map((label) => (
              <div key={label} className="flex flex-col items-center">
                <span className="pub-flow-y h-4 w-0.5" />
                <span className="rounded-md bg-sunken px-2 py-0.5 text-xs font-medium text-ink-2">{label}</span>
                <span className="pub-flow-y h-4 w-0.5" />
              </div>
            ))}
          </div>
        </motion.div>
        <div className="lg:hidden">
          <Connector label="Django ORM, function calls and scheduled jobs" shown={shown} delay={step(3)} />
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_2fr]">
          <div className="grid content-start gap-4">
            <Tier
              icon={Database}
              title="MySQL 8"
              subtitle="Users, complaints, AI predictions, priorities, assignments, feedback, notifications and the audit log."
              shown={shown}
              delay={step(4)}
            />
            <Tier
              icon={Activity}
              title="Celery and Redis"
              subtitle="Optional workers for response-target checks and hotspot scans, which also run on demand."
              shown={shown}
              delay={step(5)}
            />
          </div>
          <Tier
            icon={Brain}
            title="AI engine"
            subtitle="A plain Python package with no Django imports, so it can be tested and replaced on its own."
            shown={shown}
            delay={step(4)}
          >
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {AI_MODULES.map((module) => (
                <li key={module.name} className="flex items-start gap-2 rounded-lg bg-surface-2 p-2.5 ring-1 ring-inset ring-line">
                  <module.icon aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-3" />
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-ink">{module.name}</span>
                    <span className="block text-xs text-ink-3">{module.technique}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Tier>
        </div>
      </div>
      <figcaption className="mx-auto mt-5 max-w-5xl text-sm text-ink-3">
        Photos are kept in media storage next to the API. Maps use OpenStreetMap tiles, and addresses are looked up
        through the API's Nominatim proxy.
      </figcaption>
    </figure>
  )
}

/**
 * One row of "The problem". Its status signal starts in signal red (the problem as it is today) and turns into a
 * sign-green tick once the row has been read on screen (what CivicAI does about it). Decorative: the columns'
 * text says the same in words.
 */
function ProblemRow({ item }) {
  const ref = useRef(null)
  const solved = useInViewOnce(ref, { margin: '0px 0px -28% 0px' })
  return (
    <li ref={ref} className="grid gap-2 px-5 py-5 sm:px-6 md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)] md:gap-6">
      <h3 className="flex items-center gap-2.5 font-display text-lg font-bold text-ink">
        <span
          aria-hidden
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded-full transition-colors delay-300 duration-500 ease-standard',
            solved ? 'bg-sign-500' : 'bg-signal-500',
          )}
        >
          {solved ? <Check className="size-3 animate-pop-in text-white [animation-delay:300ms]" strokeWidth={3.5} /> : null}
        </span>
        {item.title}
      </h3>
      <p className="text-[15px] leading-relaxed text-ink-2">{item.problem}</p>
      <p className="text-[15px] leading-relaxed text-ink">
        <span className="sr-only">What CivicAI does: </span>
        {item.answer}
      </p>
    </li>
  )
}

/** One objective, numbered with a kilometre stone whose yellow cap fills once the reader has reached it. */
function Objective({ index, text }) {
  const ref = useRef(null)
  const reached = useInViewOnce(ref, { margin: '0px 0px -22% 0px' })
  return (
    <li ref={ref} className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-center gap-3 border-b border-line pb-4">
      <span aria-hidden className="pub-milestone" data-reached={reached ? 'true' : 'false'}>
        <span>{index + 1}</span>
      </span>
      <span className="text-[17px] leading-relaxed text-ink">{text}</span>
    </li>
  )
}

function FactSheet() {
  const { config, loaded, loading, isDemo, city } = useConfig()
  if (loading && !loaded) {
    return (
      <div aria-hidden className="space-y-3 rounded-xl border border-line bg-surface-2 p-5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-36" />
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-5">
      <KeyValueList
        layout="inline"
        items={[
          { label: 'Project', value: 'B.Tech CSE final-year project' },
          loaded && config.version ? { label: 'Version', value: config.version } : null,
          loaded ? { label: 'AI mode right now', value: isDemo ? 'Demo AI Mode' : 'Production AI' } : null,
          { label: 'Map region', value: city },
        ]}
      />
    </div>
  )
}

export default function AboutPage() {
  return (
    <div className={MUTED_TEXT_AA}>
      <PageIntro
        scene="calm"
        icon={Info}
        title="About CivicAI"
        lead="CivicAI is a civic complaint platform that gives the sorting work to AI: what the problem is, how urgent it is, whether it was already reported and who should fix it. People make the final calls."
        aside={<FactSheet />}
      />

      <Section id="the-problem" labelledBy="problem-title" tone="bg">
        <SectionHeading
          id="problem-title"
          reveal
          title="The problem"
          lead="Cities already receive plenty of complaints. What slows repairs down is what happens between the report and the crew."
        />
        <div className="mt-10 overflow-hidden rounded-xl border border-line bg-surface">
          <div className="hidden grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)] gap-6 border-b border-line bg-surface-2 px-6 py-2.5 text-xs font-semibold text-ink-3 md:grid">
            <span>Today, complaints are</span>
            <span>What happens</span>
            <span>What CivicAI does</span>
          </div>
          <ul className="divide-y divide-line">
            {PROBLEMS.map((item) => (
              <ProblemRow key={item.title} item={item} />
            ))}
          </ul>
        </div>
      </Section>

      <Section id="objectives" labelledBy="objectives-title" tone="surface">
        <SectionHeading
          id="objectives-title"
          reveal
          title="Objectives"
          lead="The project's fourteen objectives, in the order a complaint meets them."
        />
        <ol className="mt-10 grid gap-x-12 gap-y-4 md:grid-cols-2">
          {OBJECTIVES.map((objective, index) => (
            <Objective key={objective} index={index} text={objective} />
          ))}
        </ol>
      </Section>

      <Section id="architecture" labelledBy="architecture-title" tone="bg">
        <SectionHeading
          id="architecture-title"
          reveal
          title="Architecture"
          lead="Three layers and an AI engine. The web app only talks to the REST API; the API owns the database and calls the AI engine as an ordinary Python library."
        />
        <ArchitectureDiagram />
      </Section>

      <Section id="technology" labelledBy="technology-title" tone="surface">
        <SectionHeading id="technology-title" title="Technology stack" reveal />
        <div className="mt-8 overflow-hidden rounded-xl border border-line">
          <ul className="divide-y divide-line">
            {STACK.map((row) => (
              <li key={row.layer} className="grid gap-2 bg-surface px-5 py-4 sm:px-6 md:grid-cols-[11rem_minmax(0,1.4fr)_minmax(0,1fr)] md:gap-6">
                <h3 className="font-display text-base font-bold text-ink">{row.layer}</h3>
                <p className="text-[15px] leading-relaxed text-ink">{row.items}</p>
                <p className="text-sm leading-relaxed text-ink-3">{row.note}</p>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section id="project" labelledBy="project-title" tone="bg">
        <div className="max-w-3xl">
          <RevealHeading as="h2" id="project-title" split="words" className={SECTION_TITLE_CLASS}>
            A final-year project, built to really work
          </RevealHeading>
          <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
            CivicAI is a B.Tech Computer Science and Engineering final-year project. It is a working system rather than a
            mock-up: complaints, photos, AI predictions, assignments and feedback are stored in the database, and every
            number on the dashboards is calculated from them.
          </p>
          <p className="mt-4 text-[17px] leading-relaxed text-ink-2">
            When the AI runs its lightweight demo techniques instead of trained deep-learning models, every result says so
            with a Demo AI Mode label. AI results support decisions; officers and administrators can always override them.
          </p>
        </div>
      </Section>
    </div>
  )
}
