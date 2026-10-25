/**
 * How it works (public): a technical walkthrough of the CivicAI pipeline, stage by stage, with the formulas
 * the engines use. Parameter values are LIVE for signed-in visitors (AIConfiguration from
 * GET /api/ai/model-info/) and the documented defaults for guests - the page says which. The routing stage
 * lists the live category -> department table (GET /api/categories/).
 *
 * Layout: a sticky "On this page" index on large screens (the active stage is marked with the yellow lane
 * marker, like the dashboard sidebar), a collapsible index on phones. Deep links (#officer-assignment) work
 * even though the page is code-split: the target is scrolled into view once the page has rendered.
 *
 * Where am I: one measure answers it for the whole page (useReadingPosition) - the stage whose top has passed
 * a reading line 45% down the window. The index marks that stage and the monitor's sign names it with the
 * same number, while the 3D plays the chapter it belongs to, so the three always agree.
 *
 * Motion (final states with reduced motion): the index's lane marker slides along a track to the stage being
 * read (a spring, like the sidebar's), the stages are numbered with kilometre stones whose yellow caps fill as
 * the reader reaches them, and each stage title rises from a mask once. Formulas sit on plates edged with the
 * lane marking. Body copy never animates.
 *
 * Pipeline monitor (large screens): above the index, the landing page's 3D story scene (landing/StoryScene,
 * used read-only) follows the walkthrough. The twelve technical stages map onto its five chapters - the report
 * arrives (preprocessing), the AI reads it (vision, language, fusion), it gets a priority (severity, priority,
 * duplicates), the right department gets it (routing, assignment), the fix is checked (verification, sentiment,
 * hotspots) - and the reader's scroll through each group scrubs that chapter. Its signs use the live category
 * list this page already loads. The monitor's own sign counts the twelve stages, like the index (the scene's
 * five-chapter sign is hidden here). Decorative (aria-hidden); phones and tablets keep the text only.
 */
import { AnimatePresence, LayoutGroup, motion, motionValue } from 'framer-motion'
import { ArrowRight, Waypoints } from 'lucide-react'
import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { CategoryBadge } from '@/components/complaints/CategoryBadge'
import { DepartmentBadge } from '@/components/complaints/DepartmentBadge'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { RevealHeading } from '@/components/motion/MaskReveal'
import { EASE, SPRING } from '@/components/motion/tokens'
import { DemoModeBadge } from '@/components/ui/DemoModeBadge'
import { ErrorState } from '@/components/ui/ErrorState'
import { Skeleton } from '@/components/ui/Skeleton'
import { useApi } from '@/hooks/useApi'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { categoryService } from '@/services/categoryService'
import { cn } from '@/utils/cn'
import { formatHours } from '@/utils/format'
import { formatWeight, useEngineSettings } from './components/engineSettings'
import { MUTED_TEXT_AA } from './components/contrast'
import { StoryScene } from './components/landing/StoryScene'
import { STORY_CHAPTERS } from './components/landing/storyChapters'
import { PageIntro } from './components/PageIntro'
import { Container, SUBSECTION_TITLE_CLASS } from './components/Section'
import '@/styles/landing.css'
import '@/styles/public.css'

const STAGES = [
  { id: 'preprocessing', title: 'Preprocessing' },
  { id: 'computer-vision', title: 'Computer vision' },
  { id: 'nlp', title: 'Language understanding' },
  { id: 'multimodal-fusion', title: 'Multimodal fusion' },
  { id: 'severity', title: 'Severity' },
  { id: 'priority', title: 'Priority' },
  { id: 'duplicate-detection', title: 'Duplicate detection' },
  { id: 'department-routing', title: 'Department routing' },
  { id: 'officer-assignment', title: 'Officer assignment' },
  { id: 'verification', title: 'Before/after verification' },
  { id: 'sentiment', title: 'Sentiment analysis' },
  { id: 'hotspots', title: 'DBSCAN hotspots' },
]

/**
 * The story chapters of the landing scene (landing/storyChapters: report, analyze, prioritize, route, verify) and
 * the technical stages that belong to each, in page order.
 */
const PIPELINE_CHAPTERS = [
  ['preprocessing'],
  ['computer-vision', 'nlp', 'multimodal-fusion'],
  ['severity', 'priority', 'duplicate-detection'],
  ['department-routing', 'officer-assignment'],
  ['verification', 'sentiment', 'hotspots'],
]
/** A chapter's 3D stage plays over the first 80% of its stages and holds its final state for the rest. */
const STAGE_SPAN = 0.8
/** The reading line: a stage is being read once its top has passed this fraction of the window height. */
const READING_LINE = 0.45
/** Position of each stage in the page, and the chapter it belongs to. */
const STAGE_INDEX = Object.fromEntries(STAGES.map((stage, index) => [stage.id, index]))
const CHAPTER_OF_STAGE = STAGES.map((stage) => PIPELINE_CHAPTERS.findIndex((ids) => ids.includes(stage.id)))

const clamp01 = (value) => Math.min(1, Math.max(0, value))

/**
 * Where the reader is - the page's one answer, shared by the index and the pipeline monitor. One passive scroll
 * listener (and a resize observer, for content that loads late) measures the stages against the reading line
 * once per frame: the stage being read is the last one whose top has reached the line, or the last stage once
 * the page cannot scroll further. Its chapter is the one the monitor plays, so the index marker, the monitor's
 * sign and its scene change together. With `story` (large screens) it also writes the monitor's MotionValues:
 * the current chapter's stage progress and every chapter's fill for its lane rail. React re-renders only when
 * the stage being read changes.
 */
function useReadingPosition(story) {
  const [stageIndex, setStageIndex] = useState(0)
  const [values] = useState(() => ({
    stage: motionValue(0),
    chapters: PIPELINE_CHAPTERS.map(() => motionValue(0)),
  }))

  useEffect(() => {
    let frame = 0
    let current = -1
    const measure = () => {
      frame = 0
      const line = window.innerHeight * READING_LINE
      const boxes = STAGES.map((stage) => document.getElementById(stage.id)?.getBoundingClientRect() ?? null)
      let active = 0
      boxes.forEach((box, index) => {
        if (box && box.top <= line) active = index
      })
      const last = boxes[boxes.length - 1]
      const atEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2
      if (atEnd && last && last.top < window.innerHeight) active = boxes.length - 1
      if (story) {
        PIPELINE_CHAPTERS.forEach((ids, index) => {
          const first = boxes[STAGE_INDEX[ids[0]]]
          const final = boxes[STAGE_INDEX[ids[ids.length - 1]]]
          if (!first || !final) return
          values.chapters[index].set(clamp01((line - first.top) / Math.max(final.bottom - first.top, 1)))
        })
        values.stage.set(clamp01(values.chapters[CHAPTER_OF_STAGE[active]].get() / STAGE_SPAN))
      }
      if (active !== current) {
        current = active
        setStageIndex(active)
      }
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    const resizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    resizes?.observe(document.body)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      resizes?.disconnect()
    }
  }, [story, values])

  return {
    stageIndex,
    chapter: CHAPTER_OF_STAGE[stageIndex],
    progress: values.stage,
    chapterProgress: values.chapters,
  }
}

const NORMALISATION = [
  ['gaddha, khadda', 'pothole'],
  ['kachra, chetta', 'garbage'],
  ['nala', 'drain'],
  ['bijli, current', 'electricity'],
  ['paani, neeru', 'water'],
  ['chettu', 'tree'],
]

/** A formula on a plate edged with the lane marking: the one thing on the stage worth stopping at. */
function Formula({ children }) {
  return (
    <p className="relative my-5 overflow-x-auto rounded-lg bg-sunken py-3.5 pl-6 pr-4 text-[15px] leading-relaxed text-ink">
      <span aria-hidden className="lane-line absolute inset-y-2.5 left-2.5 w-[3px] rounded-full" />
      {children}
    </p>
  )
}

function Params({ items }) {
  return (
    <ul className="mt-4 flex flex-wrap gap-2" aria-label="Parameters">
      {items.map((item) => (
        <li key={item.label} className="rounded-md bg-surface px-2.5 py-1 text-sm text-ink-2 ring-1 ring-inset ring-line">
          {item.label} <span className="font-semibold text-ink">{item.value}</span>
        </li>
      ))}
    </ul>
  )
}

function Stage({ stage, index, children }) {
  const ref = useRef(null)
  const reached = useInViewOnce(ref, { margin: '0px 0px -30% 0px' })
  return (
    <section
      ref={ref}
      id={stage.id}
      aria-labelledby={`${stage.id}-title`}
      className="scroll-mt-24 border-t border-line py-10 first:border-t-0 first:pt-0 sm:py-12"
    >
      <div className="flex items-center gap-3.5">
        <span aria-hidden className="pub-milestone shrink-0" data-reached={reached ? 'true' : 'false'}>
          <span>{index + 1}</span>
        </span>
        <RevealHeading as="h2" id={`${stage.id}-title`} split="words" className={SUBSECTION_TITLE_CLASS}>
          {stage.title}
        </RevealHeading>
      </div>
      <div className="mt-4 max-w-3xl space-y-4 text-[17px] leading-relaxed text-ink-2 [&_strong]:font-semibold [&_strong]:text-ink">
        {children}
      </div>
    </section>
  )
}

/**
 * The stage index. A faint track runs down its left edge and the yellow lane marker slides along it to the
 * stage being read (a shared-layout spring, like the dashboard sidebar's marker), so the index doubles as a
 * position indicator on the pipeline. `id` scopes the shared layout, as the page renders two indexes.
 */
function StageIndex({ id, activeId, showTitle = true, compact = false, className }) {
  return (
    <nav aria-label="On this page" className={className}>
      {showTitle ? <p className="mb-3 text-sm font-semibold text-ink">On this page</p> : null}
      <LayoutGroup id={id}>
        <ol className="relative space-y-0.5">
          <span aria-hidden className="absolute inset-y-1 left-px w-px bg-line" />
          {STAGES.map((stage, index) => {
            const active = stage.id === activeId
            return (
              <li key={stage.id}>
                <a
                  href={`#${stage.id}`}
                  aria-current={active ? 'location' : undefined}
                  className={cn(
                    'relative flex items-baseline gap-2.5 rounded-md py-1.5 pl-4 pr-2 text-sm transition-colors duration-150 pointer-coarse:py-3',
                    compact && 'py-1',
                    active ? 'font-semibold text-ink' : 'text-ink-2 hover:text-ink',
                  )}
                >
                  {active ? (
                    <motion.span
                      aria-hidden
                      layoutId="stage-index-marker"
                      transition={SPRING.indicator}
                      className="lane-line absolute inset-y-1 left-0 w-[3px] rounded-full"
                    />
                  ) : null}
                  <span className="w-5 shrink-0 text-ink-3 tabular">{index + 1}</span>
                  {stage.title}
                </a>
              </li>
            )
          })}
        </ol>
      </LayoutGroup>
    </nav>
  )
}

function RoutingTable({ data, loading, error, onRetry }) {
  const categories = Array.isArray(data) ? data : []
  if (loading && !categories.length) {
    return (
      <div aria-hidden className="space-y-3 rounded-xl border border-line bg-surface p-4">
        {[0, 1, 2, 3].map((key) => (
          <Skeleton key={key} className="h-6 w-full" />
        ))}
      </div>
    )
  }
  if (error && !categories.length) {
    return <ErrorState compact title="The routing table could not load" error={error} onRetry={onRetry} />
  }
  return (
    <ul className="divide-y divide-line rounded-xl border border-line bg-surface text-base">
      {categories.map((category) => (
        <li key={category.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
          <CategoryBadge category={category} size="sm" />
          <ArrowRight aria-hidden className="size-4 text-ink-3" />
          <span className="sr-only">routed to</span>
          <DepartmentBadge department={category.department_detail} size="sm" />
          <span className="ml-auto text-sm text-ink-3">{formatHours(category.effective_sla_hours)}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Keeps the walkthrough readable whatever happens inside the monitor: the scene is another page's component
 * (landing/StoryScene), so any error it throws removes the monitor and leaves the index and the text in place.
 */
class MonitorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

/**
 * The pipeline monitor: the landing story scene in a small window at the top of the sticky index rail, with its
 * lane rail. Its sign names the stage being read with the index's number and, above it, the chapter the scene is
 * playing; the scene's own sign, which counts the landing's five chapters, is hidden here (styles/public.css).
 * Hidden on short windows, where the rail must keep room for the index (taller ones on touch screens, whose index
 * rows are 44 px).
 */
function PipelineMonitor({ story, categories }) {
  const reduced = usePrefersReducedMotion()
  const stage = STAGES[story.stageIndex] ?? STAGES[0]
  const chapter = STORY_CHAPTERS[story.chapter]

  return (
    <MonitorBoundary>
      <div className="pub-monitor relative aspect-[5/4] overflow-hidden rounded-xl elev-raised ring-1 ring-line [@media(max-height:779px)]:hidden pointer-coarse:[@media(max-height:959px)]:hidden">
        <StoryScene
          chapter={story.chapter}
          progress={story.progress}
          chapterProgress={story.chapterProgress}
          categories={categories}
          className="absolute inset-0"
          hud={false}
        />
        <div aria-hidden className="pointer-events-none absolute left-3 top-3 max-w-[calc(100%-1.5rem)]">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={stage.id}
              className="flex max-w-full items-center gap-2.5 rounded-[10px] bg-sign-600 py-1.5 pl-1.5 pr-3.5 text-white shadow-[inset_0_0_0_2px_var(--color-sign-600),inset_0_0_0_3.5px_#fff,0_8px_20px_-8px_rgb(0_0_0/0.6)]"
              initial={reduced ? false : { opacity: 0, y: -10, rotateX: -50 }}
              animate={{ opacity: 1, y: 0, rotateX: 0 }}
              exit={{ opacity: 0, y: 8, transition: { duration: 0.18, ease: EASE.exit } }}
              transition={{ duration: 0.5, ease: EASE.enter }}
              style={{ transformPerspective: 600, transformOrigin: '50% 0%' }}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-[6px] bg-white font-display text-[15px] font-black leading-none text-sign-700 tabular">
                {story.stageIndex + 1}
              </span>
              <span className="min-w-0">
                {chapter ? (
                  <span className="block truncate text-[11px] font-semibold leading-tight text-white/85">{chapter.title}</span>
                ) : null}
                <span className="block truncate font-display text-sm font-bold leading-tight">{stage.title}</span>
              </span>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </MonitorBoundary>
  )
}

export default function HowItWorksPage() {
  const location = useLocation()
  const wide = useMediaQuery(BREAKPOINTS.lg)
  const story = useReadingPosition(wide)
  const activeId = STAGES[story.stageIndex]?.id ?? STAGES[0].id
  const { settings: s, source, loading } = useEngineSettings()
  const live = source === 'live'
  const pct = (value) => `${Math.round(Number(value) * 100)}%`
  const thresholds = useMemo(
    () => `low below ${s.threshold_medium}, medium from ${s.threshold_medium}, high from ${s.threshold_high}, critical from ${s.threshold_critical}`,
    [s.threshold_medium, s.threshold_high, s.threshold_critical],
  )

  const routing = useApi(() => categoryService.list(), [])
  const routingSettled = !routing.loading

  // Deep links (#officer-assignment): scroll once the page has rendered, and again when the live routing
  // table above the target has loaded and changed the page height.
  useEffect(() => {
    if (!location.hash) return
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)))
    target?.scrollIntoView({ block: 'start' })
  }, [location.hash, routingSettled])

  return (
    <div className={MUTED_TEXT_AA}>
      <PageIntro
        scene="verify"
        icon={Waypoints}
        title="How it works"
        lead="A technical walkthrough of the CivicAI pipeline: what happens to a report at every stage, and the formulas the engines use."
        aside={
          <div className="rounded-xl border border-line bg-surface-2 p-5">
            <p className="text-sm font-semibold text-ink">{live ? 'Live values' : 'Default values'}</p>
            <p className="mt-1 text-sm text-ink-2">
              {loading
                ? 'Loading the settings of this deployment.'
                : live
                  ? 'The weights and thresholds below are the current settings of this deployment.'
                  : 'The weights and thresholds below are the documented defaults. Administrators can tune them; signed-in users see the live values.'}
            </p>
            <DemoModeBadge className="mt-3" />
          </div>
        }
      />

      <div className="border-t border-line bg-bg">
        <Container className="grid gap-10 py-10 sm:py-14 lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-12 xl:grid-cols-[20rem_minmax(0,1fr)] xl:gap-14">
          <aside className="hidden lg:block">
            <div className="sticky top-24 space-y-6">
              {wide ? <PipelineMonitor story={story} categories={Array.isArray(routing.data) ? routing.data : null} /> : null}
              <StageIndex id="stage-index-rail" activeId={activeId} compact />
            </div>
          </aside>
          <details className="rounded-xl border border-line bg-surface p-4 lg:hidden">
            <summary className="text-sm font-semibold text-ink pointer-coarse:py-3">On this page</summary>
            <StageIndex id="stage-index-phone" activeId={activeId} showTitle={false} className="mt-3" />
          </details>

          <article className="min-w-0">
            <Stage stage={STAGES[0]} index={0}>
              <p>
                <strong>Photos</strong> are turned upright using their EXIF orientation, resized, and checked for blur (the
                variance of the Laplacian) and brightness. A blurry or dark photo is still used, but it counts for less later.
              </p>
              <p>
                <strong>Text</strong> is normalised (Unicode, lower case), stripped of links, emoji and punctuation,
                tokenised, cleared of stop words and lightly lemmatised. Romanised Hinglish and Telugu words are mapped to
                one vocabulary, so every way of saying it reaches the same category:
              </p>
              <ul className="grid gap-2 sm:grid-cols-2">
                {NORMALISATION.map(([from, to]) => (
                  <li key={from} className="flex items-center gap-2 rounded-lg bg-surface px-3 py-2 text-[15px] ring-1 ring-inset ring-line">
                    <span className="text-ink">{from}</span>
                    <ArrowRight aria-hidden className="size-4 shrink-0 text-ink-3" />
                    <span className="sr-only">becomes</span>
                    <span className="font-semibold text-ink">{to}</span>
                  </li>
                ))}
              </ul>
            </Stage>

            <Stage stage={STAGES[1]} index={1}>
              <p>The vision engine uses the best model it has, in this order:</p>
              <ol className="list-decimal space-y-2 pl-5">
                <li>
                  <strong>YOLOv8</strong> (Ultralytics), when trained weights are installed: real object detection, each box
                  mapped to a civic category.
                </li>
                <li>
                  <strong>CLIP zero-shot</strong> (clip-ViT-B-32): the photo is compared with a sentence for each category,
                  such as “a photo of a pothole on a road”. Admin-added categories add their own sentences. The region comes
                  from OpenCV saliency and contours, so it is marked approximate and drawn dashed.
                </li>
                <li>
                  <strong>Demo AI Mode</strong>: deterministic OpenCV rules. Green vegetation ratio for fallen trees, dark
                  elliptical blobs on grey texture for potholes, a circular dark contour with a rim (Hough circles) for open
                  manholes, thin dark line networks (Canny and Hough lines) for road cracks, many small multi-coloured
                  contours for garbage, a dark scene with a bright point for streetlights, large reflective water for
                  drainage, a bluish streak and a pipe for water leaks. The scores go through a softmax and the confidence is
                  capped at 75%.
                </li>
              </ol>
              <p>
                Every mode returns the same shape: a category with its confidence, probabilities for every category,
                boxes in 0-1 image coordinates, a visual severity and the photo-quality flags.
              </p>
            </Stage>

            <Stage stage={STAGES[2]} index={2}>
              <p>
                In <strong>Demo AI Mode</strong> the description is classified with TF-IDF features (word pairs and
                character 3-5-grams) and logistic regression, trained on a labelled corpus of Indian-English and Hinglish
                complaints with typos and severity cues. In <strong>production</strong> the features are all-MiniLM-L6-v2
                sentence embeddings with a logistic-regression head.
              </p>
              <p>
                Both blend in keyword scores from the categories in the database, so a category an administrator adds is
                recognised immediately, without retraining. The text engine also extracts keywords, public-impact cues
                (public safety, traffic, health, environment, property, service disruption, accessibility), urgency and a
                severity hint.
              </p>
              <p>
                Example: “Large pothole near the school entrance causing traffic problems.” is read as a pothole with high
                severity and a public-safety impact, with the keywords pothole, school and traffic.
              </p>
            </Stage>

            <Stage stage={STAGES[3]} index={3}>
              <p>
                Each model first gives its own probabilities; fusion then combines the decisions (late fusion), so the
                vision and language models stay independent and replaceable:
              </p>
              <Formula>
                P(category) = w<sub>image</sub> × P<sub>image</sub> + w<sub>text</sub> × P<sub>text</sub> + w
                <sub>reported</sub> × [category the citizen picked] + w<sub>location</sub> × P<sub>nearby</sub>
              </Formula>
              <p>
                The image and text weights start from the configured split and are multiplied by each model's own
                confidence and a reliability factor: a blurry photo counts ×0.6, a dark one ×0.7 (except for streetlights,
                where darkness is the point). When both are present each keeps at least 20%. The citizen's chosen category
                gets 12% and nearby complaints up to 8%: enough to break a near-tie, never enough to overrule confident
                models. When photo and text agree, the confidence is raised a little, because two independent sources
                agreeing are more reliable than either alone.
              </p>
              <p>
                A complaint is flagged for manual review when both models are confident (above 60%) but disagree, when the
                top two categories are less than 10 points apart, or when the fused confidence is under the minimum.
              </p>
              <Params
                items={[
                  { label: 'Image weight', value: formatWeight(s.image_modality_weight) },
                  { label: 'Text weight', value: formatWeight(s.text_modality_weight) },
                  { label: 'Minimum confidence', value: pct(s.min_category_confidence) },
                ]}
              />
            </Stage>

            <Stage stage={STAGES[4]} index={4}>
              <p>Severity is a weighted sum of seven factors, each between 0 and 1:</p>
              <Formula>
                Severity = 100 × (0.25 × visual + 0.20 × issue type + 0.20 × public safety + 0.10 × location risk + 0.10 ×
                potential impact + 0.08 × nearby complaints + 0.07 × frequency)
              </Formula>
              <p>
                <strong>Visual</strong> is how bad the defect looks in the photo. <strong>Issue type</strong> is the
                category's base severity, because some issues are dangerous however they look. <strong>Public safety</strong>{' '}
                blends the category's safety weight with safety words in the text. <strong>Location risk</strong> counts
                nearby schools, hospitals, junctions and markets. <strong>Potential impact</strong> comes from the impact
                and urgency cues in the description, and the last two count complaints around the spot.
              </p>
              <p>
                Evidence from a blurry or dark photo counts less. Open manholes are never rated below high. The result is a
                score, a level ({thresholds}) and one reason, such as “Large road damage detected near a high-traffic
                area.”
              </p>
            </Stage>

            <Stage stage={STAGES[5]} index={5}>
              <Formula>
                Priority = {formatWeight(s.weight_severity)} × severity + {formatWeight(s.weight_public_impact)} × public
                impact + {formatWeight(s.weight_location_risk)} × location risk + {formatWeight(s.weight_frequency)} ×
                frequency + {formatWeight(s.weight_duplicates)} × duplicates
              </Formula>
              <p>
                Each factor is between 0 and 1, so each weight is the most points that factor can add. Frequency and
                duplicates saturate as 1 − e<sup>−0.4n</sup>: the second report adds more than the tenth. A reopened
                complaint gets 5 extra points per reopening, up to 10.
              </p>
              <p>
                Levels: {thresholds}. The explanation names the strongest factors: “Critical priority because the issue has
                critical severity, significant public impact and a high-risk location.”
              </p>
            </Stage>

            <Stage stage={STAGES[6]} index={6}>
              <p>
                A new report is compared with complaints from the last {s.duplicate_window_days} days around the same spot,
                on three signals:
              </p>
              <ul className="list-disc space-y-2 pl-5">
                <li>
                  <strong>Text</strong>: cosine similarity of text embeddings (TF-IDF vectors in demo mode, MiniLM in
                  production).
                </li>
                <li>
                  <strong>Photo</strong>: perceptual hashes (pHash, dHash, aHash) and colour-histogram correlation, plus CLIP
                  image embeddings in production.
                </li>
                <li>
                  <strong>Location</strong>: the map distance through a smooth Gaussian fall-off, 1.0 at the same spot, about
                  0.13 at the duplicate radius and 0 at one and a half times the radius.
                </li>
              </ul>
              <Formula>
                Overall = {formatWeight(s.duplicate_text_weight)} × text + {formatWeight(s.duplicate_image_weight)} × photo +{' '}
                {formatWeight(s.duplicate_location_weight)} × location
              </Formula>
              <p>
                Without a photo the weights are rescaled over text and location. Reports of different categories are scored
                15% lower unless their text is more than 80% similar. A pair is a duplicate when the overall score reaches
                the threshold within the radius; the newer complaint is linked to the original, the original's priority
                rises, and an officer or administrator confirms or rejects the link.
              </p>
              <Params
                items={[
                  { label: 'Threshold', value: pct(s.duplicate_threshold) },
                  { label: 'Radius', value: `${s.duplicate_radius_m} m` },
                  { label: 'Time window', value: `${s.duplicate_window_days} days` },
                ]}
              />
            </Stage>

            <Stage stage={STAGES[7]} index={7}>
              <p>
                The category decides the department. Each category has a primary department and, optionally, a backup; the
                response target is the category's own or, if it has none, the department's. This is the live routing table:
              </p>
              <RoutingTable data={routing.data} loading={routing.loading} error={routing.error} onRetry={() => routing.refetch()} />
            </Stage>

            <Stage stage={STAGES[8]} index={8}>
              <p>Every active officer of the department gets a score between 0 and 1:</p>
              <Formula>
                Score = 0.40 × (1 − active complaints ÷ capacity) + 0.25 × proximity + 0.15 × availability + 0.20 × track
                record
              </Formula>
              <p>
                Proximity is e<sup>−distance / 5 km</sup> from the officer's base (0.5 when a location is missing). Track
                record combines resolution rate and average citizen rating, and is neutral (0.5) for new officers. For
                critical complaints, track record weighs 0.30 and capacity 0.30. Officers at capacity are ranked last; if
                the department has nobody, the backup department, then the general department, is tried.
              </p>
              <p>
                {s.auto_assign_officer
                  ? 'Automatic assignment is on: the top-ranked officer is assigned as soon as the complaint is analysed, and administrators can reassign.'
                  : 'Automatic assignment is off: administrators assign from the ranked list.'}
              </p>
            </Stage>

            <Stage stage={STAGES[9]} index={9}>
              <p>
                When an officer uploads an after photo, the verification engine aligns it with the before photo (ORB
                keypoints and a RANSAC homography) and measures the change: structural similarity (SSIM with Gaussian
                filtering), histogram correlation, edge density, colour statistics, and the change inside the box where the
                issue was detected. Then the vision model looks for the issue again in the after photo. Production mode adds
                CLIP similarity of the two scenes, to check it is the same place.
              </p>
              <ul className="list-disc space-y-2 pl-5">
                <li>A different scene or a poor photo needs a manual review.</li>
                <li>
                  Strong change where the issue was, and the issue no longer detected, is likely resolved (score from{' '}
                  {s.verification_resolved_threshold}).
                </li>
                <li>Some change is partially resolved (score from {s.verification_partial_threshold}).</li>
                <li>Little change, or the issue still detected, is not resolved.</li>
              </ul>
              <p>
                The result always carries the note “AI-assisted verification, not a guarantee”, and officers or
                administrators can verify manually instead.
              </p>
            </Stage>

            <Stage stage={STAGES[10]} index={10}>
              <p>
                In <strong>Demo AI Mode</strong> feedback is scored by a VADER-style lexicon that handles negation,
                intensifiers, “but” clauses and civic phrases such as “resolved quickly” (positive) or “still not fixed”, “no
                action” and “waste of time” (negative). In <strong>production</strong> a RoBERTa model
                (cardiffnlp/twitter-roberta-base-sentiment-latest) reads the text.
              </p>
              <p>
                The star rating is checked against the text. Negative sentiment or a rating of 2 or less alerts the
                administrators, and the citizen is invited to reopen the complaint while the reopen window is open.
              </p>
            </Stage>

            <Stage stage={STAGES[11]} index={11}>
              <p>
                Hotspots are found with DBSCAN on the complaints' coordinates, using the haversine distance on the globe
                (ball-tree index, coordinates in radians):
              </p>
              <Formula>
                eps = {s.hotspot_eps_m} m ÷ 6,371 km, minimum {s.hotspot_min_samples} complaints per cluster
              </Formula>
              <p>
                For each cluster the engine reports the centre, the radius, the dominant category, the severity mix, the
                average priority and the density per square kilometre. A scan of the last 30 days raises a hotspot alert for
                administrators when a cluster reaches {s.hotspot_alert_threshold} complaints.
              </p>
            </Stage>
          </article>
        </Container>
      </div>
    </div>
  )
}
