/**
 * ComplaintTimeline - the complaint's journey as a road: every TimelineEvent is a sign-like stop on a dashed
 * yellow lane line, and the lifecycle steps not reached yet follow as muted "upcoming" stops.
 *
 * Props:
 * - events: TimelineEvent[] `{id, event, event_display, old_status, new_status, changed_by, actor_label,
 *   remarks, metadata, is_public, timestamp}` (any order; shown oldest first)
 * - status: current complaint status - decides which canonical steps are still upcoming (see lifecycle.js)
 * - compact: smaller stops, relative time only, remarks clamped to two lines, and only the latest
 *   `maxEvents` events with a "Show all" button (dashboards, side panels)
 * - maxEvents: events shown in compact mode before "Show all" (default 4)
 * - showUpcoming: render the upcoming lifecycle stops (default true; compact shows only the next one)
 * - emptyMessage: text when there are no events and no upcoming steps
 * - className
 *
 * Visual language (BUILD_SPEC 5.2 "civic signage"):
 * - stop markers are small road signs coloured by what the event means (EVENT_META tone): a rounded plate
 *   for information, a diamond for work-zone / warning events (work in progress, duplicate flagged, manual
 *   review), an octagon - the stop sign - for a rejection. Shape repeats the meaning, so it never rests on
 *   colour alone;
 * - completed stops are joined by the yellow lane-line dashes; the road ahead (upcoming stops) is drawn in
 *   muted grey dashes with hollow, dashed sign outlines;
 * - each stop shows who acted (actor_label: "CivicAI Engine" or "Ravi Kumar (Officer)"), the relative time
 *   and the absolute time, any status transition, and the remarks. Internal (non-public) events carry an
 *   "Internal" tag, because citizens never see them.
 *
 * Motion (first time the timeline scrolls into view): the road is drawn from the first stop down - each lane
 * segment paints itself toward the next stop, every sign pops in as the lane reaches it, the stop's text
 * slides in beside it, and the latest stop sends out a road-marking yellow "you are here" ring. The road
 * ahead fades in last. The whole cascade is capped at about a second. Stops that appear later (Show all, a
 * live update) get a short pop of their own. Reduced motion: the finished road, at once. The lane dashes are
 * revealed with clip-path, so they keep their real length while drawing.
 */
import { motion } from 'framer-motion'
import { ArrowRight, Bot, ChevronDown, EyeOff, Flag, UserRound } from 'lucide-react'
import { useRef, useState } from 'react'
import { EASE } from '@/components/motion/tokens'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { cn } from '@/utils/cn'
import { EVENT_META, getEventMeta } from '@/utils/constants'
import { formatDateTime, timeAgo } from '@/utils/format'
import { lifecycleProgress } from './lifecycle'
import { StatusBadge } from './StatusBadge'
import { useNow } from './useNow'
import { useSequence } from './useSequence'

/** Events drawn as diamonds (work zone / warning) or an octagon (stop); everything else is a plate. */
const DIAMOND_EVENTS = new Set(['in_progress', 'duplicate_flagged', 'duplicate_confirmed', 'manual_review_requested'])
const OCTAGON_EVENTS = new Set(['rejected'])

const TONE_FILL = {
  neutral: 'fill-asphalt-500',
  green: 'fill-sign-600',
  yellow: 'fill-marking-500',
  orange: 'fill-hazard-600',
  red: 'fill-signal-600',
  blue: 'fill-guide-600',
  violet: 'fill-violet-600',
  teal: 'fill-teal-600',
  magenta: 'fill-fuchsia-600',
  slate: 'fill-slate-500',
}

const SHAPES = {
  plate: {
    outer: <rect x="1" y="1" width="30" height="30" rx="7" />,
    inner: <rect x="3.75" y="3.75" width="24.5" height="24.5" rx="4.75" />,
  },
  diamond: {
    outer: <path d="M16 0.6 31.4 16 16 31.4 0.6 16Z" />,
    inner: <path d="M16 4.5 27.5 16 16 27.5 4.5 16Z" />,
  },
  octagon: {
    outer: <path d="M9.8 1h12.4L31 9.8v12.4L22.2 31H9.8L1 22.2V9.8Z" />,
    inner: <path d="M10.9 3.75h10.2l7.15 7.15v10.2l-7.15 7.15H10.9l-7.15-7.15V10.9Z" />,
  },
}

const MUTED_LANE = {
  backgroundImage: 'repeating-linear-gradient(to bottom, var(--c-line-strong) 0 6px, transparent 6px 12px)',
}

/* Entrance poses. The lane is revealed top-down with clip-path (it keeps its dash pattern while it draws). */
const LANE_HIDDEN = { clipPath: 'inset(0% 0% 100% 0%)' }
const LANE_SHOWN = { clipPath: 'inset(0% 0% 0% 0%)' }
const SIGN_POP = { type: 'spring', stiffness: 560, damping: 22, mass: 0.7 }

function shapeFor(eventKey) {
  if (OCTAGON_EVENTS.has(eventKey)) return 'octagon'
  if (DIAMOND_EVENTS.has(eventKey)) return 'diamond'
  return 'plate'
}

/**
 * Motion props for one part of a stop. `kind`: 'sign' | 'text' | 'lane' | 'fade'. During the first entrance
 * each part waits for its place in the cascade; parts that mount later get a short entrance of their own.
 */
function partMotion(sequence, index, kind) {
  if (sequence.reduced) return {}
  const start = sequence.delay(index)
  if (kind === 'lane') {
    if (!sequence.play) return {}
    return {
      initial: LANE_HIDDEN,
      animate: sequence.inView ? LANE_SHOWN : LANE_HIDDEN,
      transition: { duration: sequence.step, delay: start + 0.03, ease: 'linear' },
    }
  }
  const late = !sequence.play
  if (kind === 'sign') {
    return {
      initial: { opacity: 0, scale: late ? 0.7 : 0.3 },
      animate: late || sequence.inView ? { opacity: 1, scale: 1 } : undefined,
      transition: late ? { ...SIGN_POP, delay: 0.02 } : { ...SIGN_POP, delay: start },
    }
  }
  if (kind === 'text') {
    return {
      initial: { opacity: 0, x: late ? 0 : -8 },
      animate: late || sequence.inView ? { opacity: 1, x: 0 } : undefined,
      transition: { duration: late ? 0.22 : 0.36, ease: EASE.enter, delay: late ? 0.04 : start + 0.05 },
    }
  }
  return {
    initial: { opacity: 0 },
    animate: late || sequence.inView ? { opacity: 1 } : undefined,
    transition: { duration: 0.3, ease: EASE.standard, delay: late ? 0 : start },
  }
}

/** A small road sign: coloured field + inset white (or black, on yellow) border + icon. */
function StopSign({ shape, tone, icon: Icon, upcoming = false, compact = false, beacon = null, motionProps }) {
  const parts = SHAPES[shape] ?? SHAPES.plate
  const yellow = tone === 'yellow'
  return (
    <motion.span aria-hidden className={cn('relative grid shrink-0 place-items-center', compact ? 'size-6' : 'size-8')} {...motionProps}>
      {beacon ? <Beacon shape={shape} active={beacon.active} delay={beacon.delay} /> : null}
      <svg viewBox="0 0 32 32" className="absolute inset-0 size-full overflow-visible">
        {upcoming ? (
          <g className="fill-surface stroke-line-strong" strokeWidth="1.5" strokeDasharray="3 2.5">
            {parts.outer}
          </g>
        ) : (
          <>
            <g className={TONE_FILL[tone] ?? TONE_FILL.neutral}>{parts.outer}</g>
            <g className={cn('fill-none', yellow ? 'stroke-asphalt-950/70' : 'stroke-white/85')} strokeWidth="1.4">
              {parts.inner}
            </g>
          </>
        )}
      </svg>
      <Icon
        strokeWidth={2.4}
        className={cn(
          'relative',
          compact ? 'size-3' : 'size-3.5',
          upcoming ? 'text-ink-3' : yellow ? 'text-asphalt-950' : 'text-white',
        )}
      />
    </motion.span>
  )
}

/** "You are here": two road-marking yellow rings leave the latest stop once it has popped in. */
function Beacon({ shape, active, delay }) {
  return (
    <motion.span
      className={cn(
        'pointer-events-none absolute -inset-1 border-2 border-marking-400',
        shape === 'diamond' ? 'rotate-45 rounded-[5px]' : shape === 'octagon' ? 'rounded-[9px]' : 'rounded-[10px]',
      )}
      initial={{ opacity: 0, scale: 0.8 }}
      animate={active ? { opacity: [0, 0.75, 0], scale: [0.8, 1.15, 1.75] } : undefined}
      transition={{ duration: 1.1, ease: EASE.standard, delay: delay + 0.32, repeat: 1, repeatDelay: 0.25 }}
    />
  )
}

function actorOf(event) {
  if (event.actor_label) return event.actor_label
  if (event.changed_by?.full_name) return event.changed_by.full_name
  return 'CivicAI Engine'
}

function EventStop({ event, isLatest, isLast, connectorMuted, compact, sequence, index }) {
  const meta = getEventMeta(event.event)
  const title = EVENT_META[event.event] ? meta.label : event.event_display || meta.label
  const system = !event.changed_by && (!event.actor_label || event.actor_label === 'CivicAI Engine')
  const ActorIcon = system ? Bot : UserRound
  const transition = event.old_status && event.new_status && event.old_status !== event.new_status
  const absolute = formatDateTime(event.timestamp)
  const signMotion = partMotion(sequence, index, 'sign')
  // Only a stop that is on the road when the entrance plays sends out the "you are here" rings.
  const [inEntrance] = useState(sequence.play)

  return (
    <li className="relative flex gap-3" aria-current={isLatest ? 'step' : undefined}>
      {!isLast ? (
        <motion.span
          aria-hidden
          className={cn(
            'absolute w-[3px] rounded-full',
            compact ? 'bottom-0.5 left-[10.5px] top-[27px]' : 'bottom-1 left-[14.5px] top-[35px]',
            !connectorMuted && 'lane-line',
          )}
          style={connectorMuted ? MUTED_LANE : undefined}
          {...partMotion(sequence, index, 'lane')}
        />
      ) : null}
      <StopSign
        shape={shapeFor(event.event)}
        tone={meta.tone}
        icon={meta.icon}
        compact={compact}
        beacon={isLatest && inEntrance && !sequence.reduced ? { active: sequence.inView, delay: sequence.delay(index) } : null}
        motionProps={signMotion}
      />
      <motion.div
        className={cn('min-w-0 flex-1', compact ? 'pb-4 pt-0.5' : 'pb-6 pt-1', isLast && 'pb-0')}
        {...partMotion(sequence, index, 'text')}
      >
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className={cn('text-sm text-ink', isLatest ? 'font-bold' : 'font-semibold')}>
            {title}
            {isLatest ? <span className="sr-only"> (latest update)</span> : null}
          </p>
          <time dateTime={event.timestamp} title={absolute} className="shrink-0 text-xs text-ink-3 tabular">
            {timeAgo(event.timestamp)}
          </time>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-2">
          <span className="inline-flex min-w-0 items-center gap-1">
            <ActorIcon aria-hidden className="size-3.5 shrink-0 text-ink-3" />
            <span className="truncate">{actorOf(event)}</span>
          </span>
          {!compact ? <span className="text-ink-3 tabular">{absolute}</span> : null}
          {event.is_public === false ? (
            <Badge tone="neutral" size="sm" icon={EyeOff} title="Visible to officers and administrators only">
              Internal
            </Badge>
          ) : null}
        </div>
        {transition && !compact ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={event.old_status} size="sm" showIcon={false} />
            <ArrowRight aria-hidden className="size-3.5 text-ink-3" />
            <span className="sr-only">to</span>
            <StatusBadge status={event.new_status} size="sm" showIcon={false} />
          </div>
        ) : null}
        {event.remarks ? (
          // The panel carries the padding; the clamp sits on the text inside it, because a clamped element with
          // vertical padding paints the top of its third line into that padding under the ellipsis.
          <div
            className={cn(
              'mt-2 rounded-lg border-l-[3px] border-line-strong bg-surface-2 px-3 text-ink-2',
              compact ? 'py-1.5 text-xs' : 'py-2 text-sm',
            )}
          >
            <p className={cn('whitespace-pre-line break-words', compact && 'line-clamp-2')}>{event.remarks}</p>
          </div>
        ) : null}
      </motion.div>
    </li>
  )
}

function UpcomingStop({ step, isNext, isLast, compact, sequence, index }) {
  const fade = partMotion(sequence, index, 'fade')
  return (
    <li className="relative flex gap-3">
      {!isLast ? (
        <motion.span
          aria-hidden
          className={cn(
            'absolute w-[3px] rounded-full',
            compact ? 'bottom-0.5 left-[10.5px] top-[27px]' : 'bottom-1 left-[14.5px] top-[35px]',
          )}
          style={MUTED_LANE}
          {...partMotion(sequence, index, 'lane')}
        />
      ) : null}
      <StopSign shape="plate" tone="neutral" icon={step.icon ?? Flag} upcoming compact={compact} motionProps={fade} />
      <motion.div className={cn('min-w-0 flex-1', compact ? 'pb-4 pt-0.5' : 'pb-5 pt-1', isLast && 'pb-0')} {...fade}>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium text-ink-3">
            <span className="sr-only">Upcoming step: </span>
            {step.label}
          </p>
          {isNext ? (
            <Badge tone="yellow" variant="outline" size="sm">
              Next
            </Badge>
          ) : null}
        </div>
        {!compact && step.description ? <p className="mt-0.5 text-xs text-ink-3">{step.description}</p> : null}
      </motion.div>
    </li>
  )
}

export function ComplaintTimeline({
  events,
  status,
  compact = false,
  maxEvents = 4,
  showUpcoming = true,
  emptyMessage = 'No updates yet. Every step of this complaint will appear here.',
  className,
}) {
  useNow(60_000) // keeps "5 minutes ago" labels current
  const [expanded, setExpanded] = useState(false)
  const listRef = useRef(null)
  const progress = lifecycleProgress(events, status)
  const allEvents = progress.events
  const limit = compact && !expanded ? Math.max(1, maxEvents) : Infinity
  const hiddenCount = Math.max(0, allEvents.length - limit)
  const shown = hiddenCount > 0 ? allEvents.slice(-limit) : allEvents
  const upcoming = showUpcoming ? (compact ? progress.upcoming.slice(0, 1) : progress.upcoming) : []
  const sequence = useSequence(listRef, { count: shown.length + upcoming.length })

  if (!shown.length && !upcoming.length) {
    return <EmptyState compact bordered={false} title="No updates yet" description={emptyMessage} className={className} />
  }

  return (
    <div className={cn('min-w-0', className)}>
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mb-3 inline-flex items-center gap-1 rounded-md text-xs font-semibold text-primary-ink hover:underline pointer-coarse:min-h-11"
        >
          <ChevronDown aria-hidden className="size-3.5" />
          Show all {allEvents.length} updates
        </button>
      ) : null}
      <ol ref={listRef} aria-label="Complaint timeline" className="relative">
        {shown.map((event, index) => {
          const isLastEvent = index === shown.length - 1
          return (
            <EventStop
              key={event.id ?? `${event.event}-${event.timestamp}-${index}`}
              event={event}
              isLatest={isLastEvent}
              isLast={isLastEvent && !upcoming.length}
              connectorMuted={isLastEvent}
              compact={compact}
              sequence={sequence}
              index={index}
            />
          )
        })}
        {upcoming.map((step, index) => (
          <UpcomingStop
            key={step.key}
            step={step}
            isNext={index === 0}
            isLast={index === upcoming.length - 1}
            compact={compact}
            sequence={sequence}
            index={shown.length + index}
          />
        ))}
      </ol>
    </div>
  )
}

export default ComplaintTimeline
