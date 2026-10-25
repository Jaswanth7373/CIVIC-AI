/**
 * HeroScene - the full-bleed 3D city behind the landing hero (decorative, aria-hidden).
 *
 * - `CityScene stage="hero"` inside `SceneCanvas`: the night (dark theme) or dawn (light theme) district read by
 *   the AI scan, with real category and department names from GET /api/categories/ on the sign labels and
 *   beacons (never numbers). First visit of the session: the establishing shot (the camera flies down from an
 *   aerial view while the street lamps switch on in a wave); later visits settle in about a second.
 * - `progress` (the hero's scroll progress, a MotionValue) raises the camera as the page scrolls past; it is read
 *   inside the render loop, so scrolling never re-renders React.
 * - Until the first 3D frame is on screen the still `CityFallback` of the same composition is shown; it is also
 *   what low-tier devices and browsers without hardware WebGL keep. On the first visit of a session, when the
 *   establishing shot will play (`opening`, see useHeroOpening), the opening is the night (or dawn) sky instead,
 *   so the still's final framing never cuts to the aerial start of the flight.
 * - The hero's entrance (gantry, sign, copy) is cued by the scene, not by a page-load timer: `onCue` is called on
 *   the scene's first frame, so the sign swings in while the camera flies down and the lamps switch on. The whole
 *   opening fits OPENING.budget (about 4 s from this mount, components/three city/opening.js): the scene decides on
 *   its first real frame, timed from `openingAt`, between the flight (shorter when a little late) and the settle.
 *   If the canvas has not mounted by CUE_CAP_MS, or has drawn nothing by OPENING.deadline, the composed still fades
 *   in instead, the entrance plays over it at once and the scene, when it comes live, settles in (no flight).
 *   Without an opening the cue is immediate.
 * - Scrims keep the glass header calm over the scene and fade it into the next band; the copy has its own scrim,
 *   shaped to the text block (HeroSection). Phones and tablets: the band fades into the page under the sign.
 *
 * Props: categories (CategoryOut[] | null), progress (MotionValue 0..1), framing ('auto' | 'left' | 'top' |
 * 'center', or the explicit composition "x y zoom" that HeroSection measures from its layout on large screens:
 * where the scene's action sits in the frame (lens shift, normalised device coordinates) and how far the camera
 * pulls back; the still is rebuilt whenever it changes), opening (boolean, from useHeroOpening), onCue (called
 * once, when the entrance should start), className (size / position of the layer).
 */
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CityFallback, CityScene, OPENING, SceneCanvas } from '@/components/three'
import { ThemeContext } from '@/context/contexts'
import { cn } from '@/utils/cn'
import { skipIntro } from './heroOpening'

/** By then the canvas must have mounted, or the entrance plays over the composed still (and the scene settles in). */
const CUE_CAP_MS = 1200
/** By then the scene must have drawn its first frame (canvas[data-opening]), or the same happens. */
const CUE_DEADLINE_MS = OPENING.deadline * 1000
/** The entrance never waits longer than this, whatever the scene is doing. */
const CUE_LIMIT_MS = CUE_DEADLINE_MS + 500
/** If the 3D still has not appeared after this long, the composed still replaces the sky. */
const OPENING_TIMEOUT_MS = 6000

/** The empty sky the establishing shot fades up from (same colours as the scene's own sky and fog). */
function OpeningSky({ dark }) {
  return (
    <div
      aria-hidden
      className="absolute inset-0"
      style={{
        background: dark
          ? 'radial-gradient(120% 70% at 60% 108%, #2a2416 0%, #101a1b 46%, #070d0e 100%)'
          : 'radial-gradient(120% 70% at 60% 108%, #d8d3c6 0%, #c3c9c6 50%, #aab4b2 100%)',
      }}
    />
  )
}

/**
 * Frame for the SVG still with a minimum size. Browsers can lay a page out at a sliver width for a moment (a
 * full-page capture resizes the window, for example); the still then measures an extreme aspect ratio it cannot
 * project. Real layouts are never this small, and SceneCanvas clips the overflow, so nothing changes on screen.
 */
export function StillFrame({ children }) {
  return <div className="absolute inset-0 min-h-[120px] min-w-[320px]">{children}</div>
}

export function HeroScene({ categories, progress, framing = 'auto', opening = false, onCue, className }) {
  const theme = useContext(ThemeContext)
  const dark = theme?.resolvedTheme === 'dark'
  const rootRef = useRef(null)
  // The opening starts when the hero is committed (a render can be prepared well before it is shown): the scene
  // times its flight from here, so the whole opening keeps to its budget.
  const openedRef = useRef(0)
  useLayoutEffect(() => {
    openedRef.current = performance.now()
  }, [])
  const openedAt = useCallback(() => openedRef.current, [])
  const [live, setLive] = useState(false)
  // 'sky' while the opening waits for the flight; 'still' once the composed still is the fallback.
  const [cover, setCover] = useState(opening ? 'sky' : 'still')

  const onCueRef = useRef(onCue)
  useEffect(() => {
    onCueRef.current = onCue
  })
  const cuedRef = useRef(false)
  const cue = useCallback(() => {
    if (cuedRef.current) return
    cuedRef.current = true
    onCueRef.current?.()
  }, [])

  // No establishing shot: the entrance plays at once (over the still, then the live scene's short settle).
  useEffect(() => {
    if (!opening) cue()
  }, [opening, cue])

  // The establishing shot is late. At the cap, if the canvas has not even mounted, or at the deadline, if the scene
  // has not drawn its first frame, the still fades in and the entrance plays over it (the scene, when it comes,
  // settles in instead of flying). A first frame already drawn (the scene marks its canvas) means onReady is close.
  useEffect(() => {
    if (!opening || live) return undefined
    const settle = () => {
      skipIntro()
      setCover('still')
      cue()
    }
    const at = (ms, run) => window.setTimeout(run, Math.max(0, ms - (performance.now() - openedRef.current)))
    const timers = [
      at(CUE_CAP_MS, () => {
        if (!rootRef.current?.querySelector('canvas')) settle()
      }),
      at(CUE_DEADLINE_MS, () => {
        if (!rootRef.current?.querySelector('canvas[data-opening]')) settle()
      }),
      at(CUE_LIMIT_MS, cue),
      at(OPENING_TIMEOUT_MS, () => setCover('still')),
    ]
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [opening, live, cue])

  // Once the 3D is on screen the still becomes the fallback again (a lost WebGL context still shows the city).
  useEffect(() => {
    if (!live || cover === 'still') return undefined
    const timer = window.setTimeout(() => setCover('still'), 1500)
    return () => window.clearTimeout(timer)
  }, [live, cover])

  // SceneCanvas may call onReady while it renders (from a state updater): defer our own updates out of it. The
  // first frame is the flight's first frame: the entrance starts with it.
  const handleReady = () =>
    queueMicrotask(() => {
      setLive(true)
      cue()
    })

  const fallback =
    cover === 'sky' ? (
      <OpeningSky dark={dark} />
    ) : (
      <StillFrame>
        {/* A still that replaces the opening sky fades in (never a cut); otherwise it is simply there. */}
        <div className={cn('absolute inset-0', opening && !live && 'hero-still-in')}>
          <CityFallback stage="hero" categories={categories ?? undefined} framing={framing} />
        </div>
      </StillFrame>
    )

  return (
    <div ref={rootRef} aria-hidden className={cn('pointer-events-none overflow-hidden', className)}>
      <SceneCanvas className="absolute inset-0" fallback={fallback} onReady={handleReady}>
        <CityScene
          stage="hero"
          categories={categories ?? undefined}
          progress={progress}
          interactive
          framing={framing}
          openingAt={openedAt}
        />
      </SceneCanvas>

      {/* Desktop: a quiet strip under the glass header and a fade into the next band. The copy has its own scrim,
          shaped to the text block (HeroSection), so the city reads edge to edge around it. */}
      <div className="hero-scrim-top absolute inset-x-0 top-0 hidden h-24 lg:block" />
      <div className="hero-scrim-bottom absolute inset-x-0 bottom-0 hidden h-32 lg:block" />
      {/* Phones and tablets: the band fades into the page under the sign. */}
      <div className="hero-scrim-band absolute inset-0 lg:hidden" />
    </div>
  )
}

export default HeroScene
