/**
 * StoryScene - the pinned 3D panel of the "How CivicAI Works" scroll story (decorative, aria-hidden: the steps
 * beside it say everything in text).
 *
 * - `CityScene` follows the chapter being read: report -> analyze -> prioritize -> route -> verify. `progress` (a
 *   MotionValue, 0..1 within the chapter) scrubs the stage as the reader scrolls, so the pin drops, the scan
 *   crosses, columns rise, arcs fly and issues turn green under the reader's own hand. The camera eases between
 *   chapters.
 * - The still `CityFallback` always shows the chapter being read: while the 3D is on its way, while it rehearses
 *   (below), and for good on the low tier / without hardware WebGL. A chapter change dissolves the new still in
 *   over the old one, which stays fully opaque underneath until the new one is in (the panel is never empty, even
 *   while the reader scrolls straight on); chapters the reader scrolls straight past (shown for less than
 *   STILL_SETTLE_MS) are never drawn. Reduced motion: each chapter is one composed still.
 *
 * Keeping the scroll smooth (the GPU work of a scene happens on first use, and it must never land mid-scroll):
 * 1. The 3D is mounted only once the panel is close to the window AND the reader has paused scrolling: building
 *    the district takes a few hundred milliseconds of main-thread work. Until then the panel shows the still.
 * 2. Once the scene is live it rehearses every stage once, out of sight, behind an opaque copy of the still:
 *    the graphics driver finishes the shader variants, label textures and blend states each stage needs the
 *    first time it is drawn (a few hundred milliseconds per stage on some GPUs). Then, once the reader has not
 *    scrolled for COVER_QUIET_MS, the still dissolves away (about a second, eased) and the live scene continues
 *    from the chapter being read; every chapter change after that is free.
 * - The rehearsal is a small step machine: each effect run only schedules the next step from the current one, so
 *   effect re-runs (Strict Mode, a hot update during development) neither restart it nor double it. Each step
 *   waits for time AND drawn frames, so a busy machine cannot lift the cover before the scene has caught up.
 * - Observable state (for tests and probes): `data-stage` on the panel is the stage the 3D scene is showing,
 *   `data-still` on the still is the chapter it draws.
 * - HUD: a highway-sign plate names the chapter; a lane-dash rail along the bottom fills as the story advances.
 *
 * Props: chapter (index into STORY_CHAPTERS), progress (MotionValue), chapterProgress (MotionValue[] - one per
 * chapter, for the rail), categories (CategoryOut[] | null), className, hud (default true; false hides the chapter
 * sign, for a host that names the stage with its own sign - the How it works monitor).
 */
import { AnimatePresence, motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE } from '@/components/motion/tokens'
import { CityFallback, CityScene, SceneCanvas, supportsWebGL, useSceneQuality } from '@/components/three'
import { cn } from '@/utils/cn'
import { StillFrame } from './HeroScene'
import { STORY_CHAPTERS } from './storyChapters'
import { useReleaseScenes } from './useReleaseScenes'

/** How long the page must be still before the 3D is built, and how close (px) the panel must be. */
const IDLE_MS = 320
const NEAR_MARGIN = '160px 0px'
/** The rehearsal: each stage at a moment where its markers, arcs and labels are all on screen. */
const REHEARSAL = Object.freeze([
  ['report', 0.9],
  ['analyze', 0.7],
  ['prioritize', 1],
  ['route', 0.62],
  ['verify', 0.9],
])
/** Each rehearsed stage is held this long, and for at least this many drawn frames. */
const REHEARSAL_STEP_MS = 380
const REHEARSAL_STEP_FRAMES = 3
/**
 * After the rehearsal the scene returns to the reader's chapter; the camera and markers settle before the cover
 * lifts. They ease per drawn frame, so on a busy machine (few frames per second) the settle also waits for frames.
 */
const SETTLE_MS = 1300
const SETTLE_FRAMES = 24
/** If the scene has not come live this long after mounting, stop covering it (SceneCanvas shows its still). */
const LIVE_TIMEOUT_MS = 9000
/** A chapter must be current this long before the still draws it (a fast scroll skips the chapters in between). */
const STILL_SETTLE_MS = 150
/** A new chapter still dissolves in over the previous one in this long (seconds). */
const STILL_DISSOLVE = 0.45
/** The cover lifts only after this long without a scroll event (never mid-scroll), over COVER_LIFT seconds. */
const COVER_QUIET_MS = 200
const COVER_LIFT = 1

/**
 * Calls `done` once `ms` have passed AND `frames` animation frames have been drawn (the scene's own render loop
 * runs on the same frames). Returns the cancel function.
 */
function after(ms, frames, done) {
  let drawn = 0
  let elapsed = false
  let raf = 0
  const check = () => {
    if (elapsed && drawn >= frames) done()
  }
  const tick = () => {
    drawn += 1
    if (drawn < frames) raf = window.requestAnimationFrame(tick)
    else check()
  }
  if (frames > 0) raf = window.requestAnimationFrame(tick)
  const timer = window.setTimeout(() => {
    elapsed = true
    check()
  }, ms)
  return () => {
    window.clearTimeout(timer)
    window.cancelAnimationFrame(raf)
  }
}

/** Stages to rehearse, farthest from the reader's chapter first (the camera then only has a short way back). */
function rehearsalOrder(currentStage) {
  const at = (stage) => REHEARSAL.findIndex(([name]) => name === stage)
  const current = at(currentStage)
  return REHEARSAL.map(([stage]) => stage)
    .filter((stage) => stage !== currentStage)
    .sort((a, b) => Math.abs(at(b) - current) - Math.abs(at(a) - current))
}

const rehearsalProgress = (stage) => REHEARSAL.find(([name]) => name === stage)?.[1] ?? 1

/**
 * The chapter still, as a stack of plates: a new chapter's still is laid on top and dissolves in while the one
 * underneath stays fully opaque; once it is in, the plates underneath are dropped. So the panel is never empty
 * (an exit fade under a still that is still mounting would show the dark panel between chapters).
 */
function StoryStill({ stage, categories, reduced }) {
  const [plates, setPlates] = useState(() => [{ stage, id: 0 }])
  const [shown, setShown] = useState(stage)
  if (stage !== shown) {
    // A new chapter: lay its plate on top (adjusting state during render, before the stack is drawn). Reduced
    // motion: the new still simply replaces the old one.
    setShown(stage)
    setPlates((current) => {
      const plate = { stage, id: current[current.length - 1].id + 1 }
      return reduced ? [plate] : [...current.slice(-2), plate]
    })
  }
  const top = plates[plates.length - 1]
  const settle = (id) => setPlates((current) => (current[current.length - 1].id === id ? current.slice(-1) : current))

  return plates.map((plate) => (
    <motion.div
      key={plate.id}
      data-still={plate.stage}
      className="absolute inset-0"
      initial={reduced || plate.id === 0 ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduced ? 0 : STILL_DISSOLVE, ease: EASE.inOut }}
      onAnimationComplete={plate.id === top.id ? () => settle(plate.id) : undefined}
    >
      <StillFrame>
        <CityFallback stage={plate.stage} categories={categories} framing="center" />
      </StillFrame>
    </motion.div>
  ))
}

/**
 * False until `active`, then true once no scroll event has arrived for `ms` (and true for good after that). The
 * still's cover over the live scene lifts only then, so the hand-off never lands mid-scroll.
 */
function useQuietAfter(active, ms) {
  const [quiet, setQuiet] = useState(false)
  useEffect(() => {
    if (!active || quiet) return undefined
    let timer = 0
    const arm = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setQuiet(true), ms)
    }
    arm()
    window.addEventListener('scroll', arm, { passive: true })
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('scroll', arm)
    }
  }, [active, quiet, ms])
  return quiet
}

/**
 * True (and then for good) once `ref`'s element is within NEAR_MARGIN of the window and no scroll event has
 * arrived for IDLE_MS. One passive scroll listener and one IntersectionObserver, removed as soon as it fires.
 */
function useNearAndIdle(ref) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const node = ref.current
    if (ready || !node) return undefined
    if (typeof IntersectionObserver === 'undefined') {
      setReady(true)
      return undefined
    }
    let near = false
    let timer = 0
    const arm = () => {
      window.clearTimeout(timer)
      if (near) timer = window.setTimeout(() => setReady(true), IDLE_MS)
    }
    const observer = new IntersectionObserver(
      (entries) => {
        near = entries.some((entry) => entry.isIntersecting)
        arm()
      },
      { rootMargin: NEAR_MARGIN },
    )
    observer.observe(node)
    window.addEventListener('scroll', arm, { passive: true })
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', arm)
      window.clearTimeout(timer)
    }
  }, [ref, ready])
  return ready
}

/** `value`, once it has stayed the same for `ms` (the first value at once). */
function useSettledValue(value, ms) {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    if (settled === value) return undefined
    const timer = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, settled, ms])
  return settled
}

/**
 * The out-of-sight rehearsal of every stage. The stage on screen when the scene came live has already been drawn,
 * so the other four are rehearsed (`order`, one step every REHEARSAL_STEP_MS), then the scene returns to the
 * reader's chapter and settles. Returns the stage / progress the scene should show right now (the rehearsal's
 * while it runs, otherwise null: the reader's) and whether the scene is still being covered.
 */
function useRehearsal({ mounted, live, expect3D, currentStage }) {
  const [run, setRun] = useState({ order: null, index: 0, done: false })
  const stageRef = useRef(currentStage)
  useEffect(() => {
    stageRef.current = currentStage
  })

  useEffect(() => {
    if (run.done) return undefined
    if (!live) {
      // Never cover the panel for good: a scene that does not come live (blocked GPU, lost context) gives up.
      if (!mounted) return undefined
      return after(LIVE_TIMEOUT_MS, 0, () => setRun((state) => ({ ...state, done: true })))
    }
    if (!Array.isArray(run.order)) {
      return after(0, 0, () => setRun((state) => ({ ...state, order: rehearsalOrder(stageRef.current), index: 0 })))
    }
    if (run.index < run.order.length) {
      return after(REHEARSAL_STEP_MS, REHEARSAL_STEP_FRAMES, () => setRun((state) => ({ ...state, index: state.index + 1 })))
    }
    return after(SETTLE_MS, SETTLE_FRAMES, () => setRun((state) => ({ ...state, done: true })))
  }, [mounted, live, run])

  const stage = live && !run.done && Array.isArray(run.order) ? (run.order[run.index] ?? null) : null
  return {
    stage,
    progress: stage ? rehearsalProgress(stage) : null,
    covering: mounted && expect3D && !run.done,
    done: run.done,
  }
}

function RailSegment({ value }) {
  return (
    <span className="story-rail-track relative block h-[3px] flex-1 overflow-hidden rounded-full">
      <motion.span className="story-rail-fill absolute inset-0 block" style={{ scaleX: value }} />
    </span>
  )
}

export function StoryScene({ chapter, progress, chapterProgress, categories, className, hud = true }) {
  const reduced = usePrefersReducedMotion()
  const quality = useSceneQuality()
  const index = Number.isInteger(chapter) && STORY_CHAPTERS[chapter] ? chapter : 0
  const current = STORY_CHAPTERS[index]
  const list = categories ?? undefined
  const rail = Array.isArray(chapterProgress) ? chapterProgress : []
  const frameRef = useRef(null)
  const mount3D = useNearAndIdle(frameRef)
  // Leaving the page: the 3D layer is cut out of the removed page, so a lingering renderer cannot hold it.
  useReleaseScenes(frameRef)
  const [expect3D] = useState(() => supportsWebGL() && quality.render3D)
  const [live, setLive] = useState(false)
  const rehearsal = useRehearsal({ mounted: mount3D, live, expect3D, currentStage: current.stage })
  // The cover stays up after the rehearsal until the reader has stopped scrolling for a moment.
  const quiet = useQuietAfter(rehearsal.done, COVER_QUIET_MS)
  const covering = rehearsal.covering || (mount3D && expect3D && rehearsal.done && !quiet)
  // The picture always shows the chapter being read (once it has been current for a moment).
  const stillStage = useSettledValue(current.stage, reduced ? 0 : STILL_SETTLE_MS)
  const still = <StoryStill stage={stillStage} categories={list} reduced={reduced} />
  // SceneCanvas may call onReady while it renders: defer our own update out of it.
  const handleReady = () => queueMicrotask(() => setLive(true))

  return (
    <div
      ref={frameRef}
      aria-hidden
      data-stage={rehearsal.stage ?? current.stage}
      className={cn('relative isolate h-full overflow-hidden bg-asphalt-950', className)}
    >
      {mount3D ? (
        <SceneCanvas
          className="absolute inset-0"
          // While the cover is up it is the only still on screen: no second copy under the canvas.
          fallback={covering ? <div className="absolute inset-0 bg-asphalt-950" /> : still}
          onReady={handleReady}
        >
          <CityScene
            stage={rehearsal.stage ?? current.stage}
            categories={list}
            progress={rehearsal.progress ?? progress}
            framing="center"
          />
        </SceneCanvas>
      ) : (
        <div className="absolute inset-0">{still}</div>
      )}

      {/* The rehearsal happens behind this copy of the still; once every stage has been drawn and the reader has
          paused, it dissolves away slowly (eased at both ends, so the hand-off never reads as a cut). */}
      <AnimatePresence>
        {covering ? (
          <motion.div
            key="cover"
            className="absolute inset-0"
            initial={false}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : COVER_LIFT, ease: EASE.inOut }}
          >
            {still}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* HUD legibility: a soft shade at the top and the bottom of the frame. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-asphalt-950/55 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-asphalt-950/60 to-transparent" />

      {hud ? (
        <div className="pointer-events-none absolute left-3 top-3 sm:left-5 sm:top-5">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={current.key}
              // Phones: a smaller plate, so the band's scene is not hidden behind it.
              className="flex max-w-[16rem] items-center gap-2 rounded-[9px] bg-sign-600 py-1 pl-1 pr-2.5 text-white shadow-[inset_0_0_0_2px_var(--color-sign-600),inset_0_0_0_3.5px_#fff,0_8px_20px_-8px_rgb(0_0_0/0.6)] sm:max-w-none sm:gap-2.5 sm:rounded-[10px] sm:py-1.5 sm:pl-1.5 sm:pr-3.5"
              initial={reduced ? false : { opacity: 0, y: -10, rotateX: -50 }}
              animate={{ opacity: 1, y: 0, rotateX: 0 }}
              exit={{ opacity: 0, y: 8, transition: { duration: 0.18, ease: EASE.exit } }}
              transition={{ duration: 0.5, ease: EASE.enter }}
              style={{ transformPerspective: 600, transformOrigin: '50% 0%' }}
            >
              <span className="grid size-6 shrink-0 place-items-center rounded-[5px] bg-white font-display text-[13px] font-black leading-none text-sign-700 tabular sm:size-7 sm:rounded-[6px] sm:text-[15px]">
                {index + 1}
              </span>
              <span className="font-display text-xs font-bold leading-tight sm:text-sm lg:text-[15px]">{current.title}</span>
            </motion.div>
          </AnimatePresence>
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-full bg-asphalt-950/55 px-3 py-2.5 backdrop-blur-sm sm:inset-x-5 sm:bottom-5">
        {rail.map((value, railIndex) => (
          <RailSegment key={STORY_CHAPTERS[railIndex]?.key ?? railIndex} value={value} />
        ))}
      </div>
    </div>
  )
}

export default StoryScene
