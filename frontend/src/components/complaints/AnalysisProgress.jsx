/**
 * AnalysisProgress - replays the real AI pipeline of a submitted complaint, step by step, then reveals the
 * result as an "AI work order".
 *
 * Props:
 * - steps: `analysis.steps` from POST /complaints/ (or /reanalyze/): `[{key, label, status: 'done' |
 *   'skipped' | 'failed', duration_ms, detail}]` in execution order (validate, upload, save, preprocess,
 *   image_analysis, text_analysis, multimodal_fusion, severity, priority, duplicate_detection,
 *   department_routing, officer_assignment, database_save, notification)
 * - summary: `analysis.summary` `{category, confidence, severity, severity_score, priority_score,
 *   priority_level, department, officer, duplicates_found, is_demo, mode, explanation, needs_review}`
 * - running: the request is still in flight and no steps exist yet - shows an honest indeterminate state
 *   (no invented progress)
 * - onDone(summary): called once when the replay has finished and the summary is visible
 * - onProgress(revealed, steps): called whenever another step has been revealed (0..steps.length), so a page
 *   can sync its own visuals to the replay (the report flow's AI scan locks on when the image step is shown)
 * - actions: nodes under the summary (e.g. "Track complaint" / "Report another issue")
 * - complaintNumber: shown in the work-order header when known
 * - minStepMs / maxStepMs: replay time per step (default 250 / 1400 ms)
 * - className
 *
 * Timing: the work has already happened on the server when the response arrives, so this is a REPLAY of
 * the measured pipeline. Each step stays "running" for its real `duration_ms`, clamped to 250-1400 ms so
 * very fast steps are still readable and slow model steps do not keep the citizen waiting; the measured
 * duration is printed next to each step, unaltered. Statuses are shown exactly as reported (done / skipped /
 * failed with the server's detail). With `prefers-reduced-motion` everything is shown at once. A "Skip"
 * button jumps to the result, and a polite live region announces each step for screen readers.
 *
 * Motion: each finished step's tick pops in and the lane line to the next step fills with road-marking
 * yellow; the work order then arrives with its lane marking drawing across the header and its findings in a
 * short cascade (category, priority needle, severity, department, officer, duplicates).
 */
import { motion, useReducedMotion } from 'framer-motion'
import {
  Building2,
  CircleCheck,
  CircleMinus,
  CircleX,
  ClipboardList,
  Copy,
  FastForward,
  LoaderCircle,
  TriangleAlert,
  UserRound,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AIModeBadge } from '@/components/ai/AIModeBadge'
import { ConfidenceBar } from '@/components/ai/ConfidenceBar'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { Stagger, StaggerItem } from '@/components/motion/Stagger'
import { EASE } from '@/components/motion/tokens'
import { Alert } from '@/components/ui/Alert'
import { Avatar } from '@/components/ui/Avatar'
import { cn } from '@/utils/cn'
import { formatNumber } from '@/utils/format'
import { CategoryBadge } from './CategoryBadge'
import { DepartmentBadge } from './DepartmentBadge'
import { PriorityMeter } from './PriorityMeter'
import { SeverityBadge } from './SeverityBadge'

const STATUS_TEXT = { done: 'Done', skipped: 'Skipped', failed: 'Failed' }
const MUTED_LANE = {
  backgroundImage: 'repeating-linear-gradient(to bottom, var(--c-line-strong) 0 5px, transparent 5px 10px)',
}

function clampDelay(ms, min, max) {
  const number = Number(ms)
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : 0))
}

function StepIcon({ state }) {
  if (state === 'running') return <LoaderCircle aria-hidden className="size-5 animate-spin text-primary-ink" />
  // A finished step's icon mounts fresh, so it pops in (CSS only; static with reduced motion).
  if (state === 'done') return <CircleCheck aria-hidden className="size-5 animate-pop-in motion-reduce:animate-none text-sign-600 dark:text-sign-300" />
  if (state === 'skipped') return <CircleMinus aria-hidden className="size-5 animate-pop-in motion-reduce:animate-none text-ink-3" />
  if (state === 'failed') return <CircleX aria-hidden className="size-5 animate-pop-in motion-reduce:animate-none text-signal-600 dark:text-signal-300" />
  return <span aria-hidden className="m-[3px] block size-3.5 rounded-full border-2 border-dashed border-line-strong" />
}

function StepRow({ step, state, isLast }) {
  const finished = state === 'done' || state === 'skipped' || state === 'failed'
  return (
    <li className="relative flex gap-3">
      {!isLast ? (
        <>
          <span aria-hidden className="absolute bottom-0 left-[9px] top-6 w-[2px] rounded-full" style={MUTED_LANE} />
          {/* the road marking fills down to the next step once this one has finished */}
          <span
            aria-hidden
            className="lane-line absolute bottom-0 left-[9px] top-6 w-[2px] rounded-full transition-[clip-path] duration-300 ease-standard"
            style={{ clipPath: finished ? 'inset(0% 0% 0% 0%)' : 'inset(0% 0% 100% 0%)' }}
          />
        </>
      ) : null}
      <span className="relative z-10 grid size-5 shrink-0 place-items-center bg-surface">
        <StepIcon state={state} />
      </span>
      <div className={cn('min-w-0 flex-1', isLast ? 'pb-0' : 'pb-3')}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <p
            className={cn(
              'text-sm',
              state === 'running' ? 'font-bold text-ink' : finished ? 'font-semibold text-ink' : 'text-ink-3',
              state === 'failed' && 'text-signal-700 dark:text-signal-300',
            )}
          >
            {step.label || step.key}
          </p>
          {finished ? (
            <span className="shrink-0 text-xs text-ink-3 tabular">
              {state === 'done' ? `${formatNumber(step.duration_ms ?? 0)} ms` : STATUS_TEXT[state]}
            </span>
          ) : state === 'running' ? (
            <span className="shrink-0 text-xs font-medium text-primary-ink">Running</span>
          ) : null}
        </div>
        {finished && step.detail ? <p className="mt-0.5 text-xs text-ink-2">{step.detail}</p> : null}
      </div>
    </li>
  )
}

function SummaryItem({ index = 0, label, children }) {
  return (
    <StaggerItem index={index} className="min-w-0">
      <p className="mb-1.5 text-xs font-medium text-ink-3">{label}</p>
      {children}
    </StaggerItem>
  )
}

function WorkOrder({ summary, complaintNumber, failedSteps, actions }) {
  const reduced = usePrefersReducedMotion()
  const duplicates = Number(summary.duplicates_found) || 0
  const analysisFailed = !summary.category && failedSteps > 0
  return (
    <section aria-label="AI analysis result" className="@container overflow-hidden rounded-xl border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-sidebar px-4 py-3 text-white">
        <p className="flex items-center gap-2 font-display text-base font-bold">
          <ClipboardList aria-hidden className="size-5 text-marking-400" />
          AI work order
          {complaintNumber ? <span className="font-sans text-sm font-semibold text-asphalt-300 tabular">{complaintNumber}</span> : null}
        </p>
        <AIModeBadge isDemo={summary.is_demo} mode={summary.mode} size="sm" />
      </div>
      <div aria-hidden className="h-[3px] bg-sidebar">
        <motion.div
          className="lane-line-x h-full"
          initial={reduced ? false : { clipPath: 'inset(0% 100% 0% 0%)' }}
          animate={{ clipPath: 'inset(0% 0% 0% 0%)' }}
          transition={{ duration: 0.7, ease: EASE.enter, delay: 0.15 }}
        />
      </div>

      <div className="space-y-4 p-4">
        {analysisFailed ? (
          <Alert tone="warning" title="AI analysis could not finish">
            Your complaint was saved. An administrator will review it and set the category and priority by hand.
          </Alert>
        ) : null}

        <Stagger className="grid gap-4 @lg:grid-cols-2" delay={0.2} step={0.07}>
          <SummaryItem index={0} label="Detected category">
            <CategoryBadge category={summary.category} size="lg" />
            {summary.confidence != null ? (
              <ConfidenceBar value={summary.confidence} label="Confidence" size="sm" className="mt-2.5" delay={0.3} />
            ) : null}
          </SummaryItem>
          <SummaryItem index={1} label="Priority">
            <PriorityMeter score={summary.priority_score} level={summary.priority_level} size="md" />
          </SummaryItem>
          <SummaryItem index={2} label="Severity">
            <SeverityBadge severity={summary.severity} score={summary.severity_score} withLabel />
          </SummaryItem>
          <SummaryItem index={3} label="Department">
            {summary.department ? (
              <DepartmentBadge department={summary.department} />
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm text-ink-2">
                <Building2 aria-hidden className="size-4 text-ink-3" />
                Routing pending
              </span>
            )}
          </SummaryItem>
          <SummaryItem index={4} label="Officer">
            {summary.officer ? (
              <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Avatar src={summary.officer.avatar} name={summary.officer.full_name} size="sm" decorative />
                {summary.officer.full_name}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-sm text-ink-2">
                <UserRound aria-hidden className="size-4 text-ink-3" />
                An officer will be assigned soon
              </span>
            )}
          </SummaryItem>
          <SummaryItem index={5} label="Similar complaints nearby">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 text-sm',
                duplicates ? 'font-semibold text-hazard-700 dark:text-hazard-300' : 'text-ink-2',
              )}
            >
              <Copy aria-hidden className="size-4" />
              {duplicates
                ? `${duplicates} possible duplicate${duplicates === 1 ? '' : 's'} found`
                : 'None found'}
            </span>
          </SummaryItem>
        </Stagger>

        {summary.explanation ? <p className="text-sm text-ink-2">{summary.explanation}</p> : null}

        {summary.needs_review && !analysisFailed ? (
          <Alert tone="info" title="Flagged for a quick human check">
            The image and text signals did not fully agree, or the confidence was low, so an administrator will
            confirm the category.
          </Alert>
        ) : null}

        {actions ? <div className="flex flex-wrap justify-end gap-2 pt-1">{actions}</div> : null}
      </div>
    </section>
  )
}

export function AnalysisProgress({
  steps,
  summary,
  running = false,
  onDone,
  actions,
  complaintNumber,
  minStepMs = 250,
  maxStepMs = 1400,
  onProgress,
  className,
}) {
  const reducedMotion = useReducedMotion()
  const list = useMemo(() => (Array.isArray(steps) ? steps.filter(Boolean) : []), [steps])
  const stepsKey = useMemo(() => JSON.stringify(list.map((step) => [step.key, step.status, step.duration_ms])), [list])
  const [progress, setProgress] = useState({ key: null, revealed: 0 })
  const onDoneRef = useRef(onDone)
  const onProgressRef = useRef(onProgress)
  const summaryRef = useRef(summary)
  const doneKeyRef = useRef(null)

  useEffect(() => {
    onDoneRef.current = onDone
    onProgressRef.current = onProgress
    summaryRef.current = summary
  })

  const revealed = reducedMotion ? list.length : progress.key === stepsKey ? progress.revealed : 0
  const finished = list.length > 0 && revealed >= list.length

  useEffect(() => {
    if (list.length) onProgressRef.current?.(revealed, list)
  }, [revealed, list])

  useEffect(() => {
    if (reducedMotion || !list.length || revealed >= list.length) return undefined
    const delay = clampDelay(list[revealed]?.duration_ms, minStepMs, maxStepMs)
    const timer = window.setTimeout(() => setProgress({ key: stepsKey, revealed: revealed + 1 }), delay)
    return () => window.clearTimeout(timer)
  }, [reducedMotion, list, stepsKey, revealed, minStepMs, maxStepMs])

  useEffect(() => {
    if (!finished || doneKeyRef.current === stepsKey) return
    doneKeyRef.current = stepsKey
    onDoneRef.current?.(summaryRef.current)
  }, [finished, stepsKey])

  // When the replay ends, bring the work order (the result) into view - the smallest scroll that shows it.
  // Not with reduced motion, where everything is on screen from the start.
  const resultRef = useRef(null)
  const scrolledKeyRef = useRef(null)
  useEffect(() => {
    if (reducedMotion || !finished || scrolledKeyRef.current === stepsKey) return undefined
    scrolledKeyRef.current = stepsKey
    const timer = window.setTimeout(() => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 120)
    return () => window.clearTimeout(timer)
  }, [reducedMotion, finished, stepsKey])

  if (!list.length) {
    if (!running) return null
    return (
      <div role="status" className={cn('rounded-xl border border-line bg-surface p-5', className)}>
        <p className="font-display text-base font-bold text-ink">Running the AI analysis</p>
        <p className="mt-1 text-sm text-ink-2">
          Uploading your report, then classifying the photo and description, scoring severity and priority, checking for
          duplicates and routing it to a department. This usually takes a few seconds.
        </p>
        <span aria-hidden className="mt-4 block h-1.5 w-full overflow-hidden rounded-full bg-sunken">
          <span className="lane-line-x animate-lane block h-full w-full" />
        </span>
      </div>
    )
  }

  const failedSteps = list.filter((step) => step.status === 'failed').length
  const latest = revealed > 0 ? list[Math.min(revealed, list.length) - 1] : null
  const announcement = finished
    ? 'AI analysis complete.'
    : latest
      ? `${latest.label || latest.key}: ${STATUS_TEXT[latest.status] ?? latest.status}.`
      : ''

  return (
    <div className={cn('min-w-0 space-y-4', className)}>
      <div className="rounded-xl border border-line bg-surface p-4 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-display text-base font-bold text-ink">{finished ? 'AI analysis complete' : 'AI analysis'}</p>
            <p className="text-xs text-ink-3 tabular">
              {finished ? `${list.length} steps` : `Step ${Math.min(revealed + 1, list.length)} of ${list.length}`}
              {failedSteps ? `, ${failedSteps} failed` : ''}
            </p>
          </div>
          {!finished ? (
            <button
              type="button"
              onClick={() => setProgress({ key: stepsKey, revealed: list.length })}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-ink-2 transition-colors hover:bg-sunken hover:text-ink pointer-coarse:min-h-11"
            >
              <FastForward aria-hidden className="size-3.5" />
              Skip to result
            </button>
          ) : null}
        </div>
        <ol aria-label="AI analysis steps">
          {list.map((step, index) => {
            const state = index < revealed ? step.status || 'done' : index === revealed ? 'running' : 'pending'
            return <StepRow key={step.key ?? index} step={step} state={state} isLast={index === list.length - 1} />
          })}
        </ol>
        {failedSteps && finished ? (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-2">
            <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-hazard-600" />
            Failed steps did not stop the submission: the remaining steps ran with the information available.
          </p>
        ) : null}
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </div>

      {finished && summary ? (
        <motion.div
          ref={resultRef}
          className="scroll-mb-6 scroll-mt-24"
          initial={reducedMotion ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
        >
          <WorkOrder summary={summary} complaintNumber={complaintNumber} failedSteps={failedSteps} actions={actions} />
        </motion.div>
      ) : null}
    </div>
  )
}

export default AnalysisProgress
