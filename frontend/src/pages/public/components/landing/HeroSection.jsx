/**
 * Landing hero: the CivicAI gantry sign over a live 3D city, the specified subtitle and calls to action, live
 * platform figures, and the live AI work order as a glass dispatch card.
 *
 * Composition
 * - Large screens: the 3D district fills the hero edge to edge (at least the first screen, up to 75rem tall), which
 *   starts under the glass header (`data-hero-overlay`, see PublicLayout) and offsets its own content by
 *   --public-header-h. Three zones:
 *   1. the copy on the calm left of the frame, its sign hanging from a cantilever gantry whose post stands at the
 *      edge of the city. The text block under the sign carries its own scrim, shaped to it with feathered edges
 *      (styles/landing.css .hero-copy-scrim): AA over any pixel, while the city stays visible all around it;
 *   2. the stage - the open area right of the copy and above the card - where the scene frames its action (the
 *      scan, issue beams, sign labels, routing arcs and department beacons). The framing is measured from this
 *      layout (useStageFraming) and handed to the scene as an explicit composition, so the story is always in
 *      view at every width;
 *   3. the compact dispatch card, anchored at the lower right, over the foreground of the district.
 * - Phones and tablets: the scene is a band at the top (header + min(44svh, 28rem)); the gantry crosses it and the
 *   sign hangs across its lower edge; the copy and the work order follow on the page.
 * - Landscape phones (short landscape, styles/landing.css): the scene fills the first screen behind the copy, the
 *   sign (scaled to the height) sits beside the subtitle and the calls to action, so both are visible on arrival.
 *
 * Motion (one orchestrated moment, about 2 s): the text never waits for the 3D. The subtitle (the page's largest
 * text, its LCP element) is painted in the first frame and only glides up into place (a transform, no fade). The
 * rest of the entrance starts within ENTRANCE_HOLD_MS of the hero mounting, or at once when the scene cues it
 * earlier (`data-opening="waiting"` pauses the keyframes until then): the gantry's post rises and its arm reaches
 * across, the sign swings down and settles, the calls to action and live figures follow, and the dispatch card
 * arrives and fills in with the real AI answer. On the first visit of a session the 3D plays its establishing
 * shot as its own layer behind the composed copy (it fades up from the opening sky and flies in; if it is late,
 * HeroScene fades in the composed still after at most 3 s). The scene's cue (`onCue`, its first frame) times
 * the live figures' count, so the numbers run while the camera settles, never before the figures have risen.
 * Scrolling past raises the camera over the district (the scene reads the scroll progress in its render loop)
 * and the card drifts up slightly faster than the copy. Reduced motion: everything in its final state, the scene
 * a single composed frame.
 *
 * Contract: `section[aria-labelledby='hero-title']`, whose first `<p>` is the subtitle and which holds exactly one
 * "Report an Issue" link (citizens and guests) and one "Explore Dashboard" link. "Report an Issue" goes to
 * /citizen/report; guests pass through the login page and come back (?next=). Officers and administrators cannot
 * file complaints, so they only get "Explore Dashboard", like the header.
 */
import { motion, useTransform } from 'framer-motion'
import { LayoutDashboard, MapPinPlus } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useElementScrollProgress, usePrefersReducedMotion } from '@/components/motion/hooks'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/hooks/useAuth'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { Container } from '../Section'
import { GantrySign } from './GantrySign'
import { useHeroOpening } from './heroOpening'
import { HeroScene } from './HeroScene'
import { HeroWorkOrder } from './HeroWorkOrder'
import { LiveNumbers } from './LiveNumbers'
import { useReleaseScenes } from './useReleaseScenes'

/**
 * Entrance after the sign: a short rise with the house "enter" curve (CSS keyframes `hero-rise`, compositor-run;
 * none with reduced motion). The delays line the copy up behind the swinging sign; they count from the entrance
 * (the subtitle's transform-only glide is never held).
 */
const rise = (delay) => ({ '--rise-delay': `${delay}s` })
/** The longest the entrance waits for the scene's cue after the hero mounts (ms). */
const ENTRANCE_HOLD_MS = 350
/** The live figures count up just after they rise (seconds from the entrance); until the cue their count is held. */
const COUNT_DELAY = 1.3
const COUNT_HELD = 86400
/** A late cue still leaves this much time before the count starts (seconds). */
const COUNT_AFTER_CUE = 0.25

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
/** Two decimals: the framing only changes when the layout really moves (the still rebuilds on every change). */
const round2 = (value) => Math.round(value * 100) / 100

/** Layout offset of `node` inside `ancestor` (offset geometry: entrance and scroll transforms do not count). */
function offsetWithin(node, ancestor) {
  let left = 0
  let top = 0
  let current = node
  while (current && current !== ancestor) {
    left += current.offsetLeft
    top += current.offsetTop
    current = current.offsetParent
  }
  return { left, top }
}

/**
 * The composition of the 3D city on large screens, measured from the hero's own layout: the scene's subject (the
 * district core where the scan, beams, signs and arcs play) goes into the stage - right of the copy column, just
 * above the dispatch card - and the camera pulls back as far as the stage's height needs for the department signs
 * at the back of the district to stay under the header while every issue sign clears the card (within limits, so
 * the city never turns into a miniature). Also
 * writes `--gantry-drop` on the section (the height of the gantry's post, from its arm down to the bottom of the
 * hero). Returns the scene's composition string "x y zoom" (see CityScene `framing`), or 'auto' (the scene's own
 * framing) on phones and tablets and until measured.
 *
 * Measured before paint (so the still's first frame already has the final composition), then on resize only
 * (ResizeObserver on the section, the copy and the card); never per frame.
 */
function useStageFraming({ sectionRef, copyRef, cardRef, enabled }) {
  const [framing, setFraming] = useState('auto')

  useLayoutEffect(() => {
    const section = sectionRef.current
    const copy = copyRef.current
    const card = cardRef.current
    if (!enabled || !section || !copy || !card || typeof ResizeObserver === 'undefined') return undefined
    const measure = () => {
      const width = section.offsetWidth
      const height = section.offsetHeight
      if (width < 320 || height < 320) return
      const rem = parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16
      const copyBox = offsetWithin(copy, section)
      const stageLeft = copyBox.left + copy.offsetWidth + 1.5 * rem
      const cardTop = offsetWithin(card, section).top
      // The district core sits a little left of the stage's middle (the scan sweeps in from the left); the
      // foreground of the district runs on under the card, which floats in front of it. Measured on the
      // projected scene (frame height H, camera pull-back z): the lowest issue sign stands about 0.028 H / z
      // below the subject and the department signs at the back rise about 0.5 H / z above it. So the camera
      // pulls back until both fit between the header and the card's top edge, and the subject sits just high
      // enough for every sign to clear the card. (Very short windows reach the limit and the highest department
      // sign may pass under the header.)
      const x = (stageLeft + (width - stageLeft) * 0.42) / width
      const header = 4 * rem
      const zoom = clamp((0.53 * height) / Math.max(cardTop - header - rem, 1), 1, 1.7)
      const y = cardTop - 0.5 * rem - (0.028 * height) / zoom
      // The composition as the scene's value-typed "x y zoom" string (stable in memo dependencies and the
      // still's cache key).
      setFraming(
        `${round2(clamp(x * 2 - 1, 0, 0.62))} ${round2(clamp(1 - (2 * y) / height, -0.4, 0.4))} ${round2(zoom)}`,
      )
      const gantry = section.querySelector('[data-gantry-arm]')
      if (gantry) section.style.setProperty('--gantry-drop', `${Math.max(0, height - offsetWithin(gantry, section).top)}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    ;[section, copy, card].forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [sectionRef, copyRef, cardRef, enabled])

  return enabled ? framing : 'auto'
}

export function HeroSection({ demo, onRetryDemo, categories, categoriesLoading, stats, statsLoading, statsError, onTryOwn }) {
  const { isAuthenticated, role, homePath } = useAuth()
  const canReport = !isAuthenticated || role === 'citizen'
  const reduced = usePrefersReducedMotion()
  const desktop = useMediaQuery(BREAKPOINTS.lg)
  const sectionRef = useRef(null)
  const copyRef = useRef(null)
  const cardRef = useRef(null)
  const framing = useStageFraming({ sectionRef, copyRef, cardRef, enabled: desktop })
  // Leaving the page: the 3D layer is cut out of the removed page, so a lingering renderer cannot hold it.
  useReleaseScenes(sectionRef)
  // 0 while the hero fills the window, 1 once it has scrolled out: raises the camera, drifts the card.
  const scrollYProgress = useElementScrollProgress(sectionRef)
  const cardDrift = useTransform(scrollYProgress, [0, 1], [0, -72])
  // First visit with the establishing shot: the entrance starts at the scene's cue (HeroScene) or after
  // ENTRANCE_HOLD_MS, whichever comes first; the cue alone times the live figures' count. Times are
  // performance.now() stamps (null until it happens); without an opening both are there from the start.
  const opening = useHeroOpening()
  const [timing, setTiming] = useState(() => (opening ? { entered: null, cued: null } : { entered: 0, cued: 0 }))
  const entered = timing.entered != null
  const cued = timing.cued != null
  useEffect(() => {
    if (entered) return undefined
    const timer = window.setTimeout(
      () => setTiming((current) => (current.entered != null ? current : { ...current, entered: performance.now() })),
      ENTRANCE_HOLD_MS,
    )
    return () => window.clearTimeout(timer)
  }, [entered])
  const handleCue = () => {
    const now = performance.now()
    setTiming((current) => ({ entered: current.entered ?? now, cued: current.cued ?? now }))
  }
  // The count starts COUNT_DELAY after the entrance (the figures have risen by then), or just after a late cue.
  const countDelay = reduced
    ? 0
    : cued
      ? Math.max(COUNT_AFTER_CUE, COUNT_DELAY - Math.max(0, timing.cued - timing.entered) / 1000)
      : COUNT_HELD

  return (
    <section
      ref={sectionRef}
      aria-labelledby="hero-title"
      data-hero-overlay
      data-opening={entered ? undefined : 'waiting'}
      className="landing-hero relative isolate overflow-x-clip bg-bg [--hero-next:var(--c-bg)]"
    >
      <HeroScene
        className="absolute inset-x-0 top-0 h-[var(--hero-band)] lg:bottom-0 lg:h-auto"
        categories={categories}
        progress={scrollYProgress}
        framing={framing}
        opening={opening}
        onCue={handleCue}
      />

      <Container className="relative grid gap-y-12 pb-16 pt-[var(--hero-copy-top)] sm:pb-20 lg:min-h-[min(100svh,75rem)] lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)] lg:items-center lg:gap-x-14 lg:pb-10 lg:pt-[calc(var(--public-header-h)+2.5rem)] xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] xl:gap-x-16">
        <div ref={copyRef} className="hero-copy relative isolate min-w-0 lg:max-w-[34rem] lg:self-center">
          <GantrySign />

          {/* The text block under the sign, with its own scrim shaped to it (feathered beyond its edges). */}
          <div className="hero-text relative mt-8 sm:mt-9">
            <span aria-hidden className="hero-copy-scrim" />

            {/* Never hidden: painted in the first frame (the page's LCP), it only glides into place. */}
            <p className="hero-rise hero-rise-text lead-fluid max-w-xl text-ink-2 lg:text-ink" style={rise(0.1)}>
              Report civic issues using image, text and location. CivicAI uses artificial intelligence to identify,
              prioritize and route complaints for efficient resolution.
            </p>

            <div className="hero-ctas hero-rise mt-8 flex flex-col gap-3 sm:mt-9 sm:flex-row sm:flex-wrap" style={rise(1.07)}>
              {canReport ? (
                <Button size="lg" variant="warning" to="/citizen/report" leftIcon={MapPinPlus} className="w-full sm:w-auto">
                  Report an Issue
                </Button>
              ) : null}
              <Button
                size="lg"
                variant="outline"
                to={isAuthenticated ? homePath : '/login'}
                leftIcon={LayoutDashboard}
                className="w-full sm:w-auto lg:border-line-strong/80 lg:bg-surface/85 lg:backdrop-blur-sm"
              >
                Explore Dashboard
              </Button>
            </div>

            {statsError && !stats ? null : (
              <div className="hero-rise mt-11 sm:mt-12" style={rise(1.18)}>
                <LiveNumbers
                  stats={stats}
                  loading={statsLoading}
                  error={statsError}
                  delay={countDelay}
                />
              </div>
            )}
          </div>
        </div>

        <motion.div
          ref={cardRef}
          className="w-full min-w-0 max-w-xl lg:max-w-none lg:self-end"
          style={desktop && !reduced ? { y: cardDrift } : undefined}
        >
          <div className="hero-rise hero-rise-card" style={rise(0.7)}>
            <HeroWorkOrder
              demo={demo}
              onRetry={onRetryDemo}
              categories={categories}
              categoriesLoading={categoriesLoading}
              onTryOwn={onTryOwn}
              hold={!entered}
            />
          </div>
        </motion.div>
      </Container>
    </section>
  )
}

export default HeroSection
