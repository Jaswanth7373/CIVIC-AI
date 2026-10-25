/**
 * SceneCanvas - the only way a page shows a 3D scene. Never throws, never leaves the area empty.
 *
 * <SceneCanvas className="absolute inset-0" fallback={<CityFallback stage="hero" theme={theme} />}>
 *   <CityScene stage="hero" categories={categories} interactive />
 * </SceneCanvas>
 *
 * - The wrapper takes its size from `className` / `style` (the canvas fills it); the scene never changes layout.
 * - `fallback` is painted first and stays until the canvas has rendered its first frame, then the canvas
 *   cross-fades in over it (no layout shift). The fallback is also what remains when WebGL is missing or software
 *   only (`supportsWebGL()`), when the device is on the `low` tier, when the runtime monitor switches 3D off, when
 *   the scene throws (error boundary) and when the WebGL context is lost.
 * - three.js / R3F load lazily (lazyScenes.js) once the wrapper comes within 200 px of the viewport; the scene
 *   components passed as children are preloaded in parallel, and each may prepare its world in idle slices
 *   (`Scene.prepare`) before the canvas mounts. The WebGL check runs asynchronously (`probeWebGL`), so mounting
 *   a SceneCanvas never blocks the main thread on the GPU.
 * - Rendering pauses (`frameloop="never"`) while less than VISIBLE_SHARE of the wrapper is on screen (a sliver at
 *   the top of the window is not worth a full post chain) or the tab is hidden. With prefers-reduced-motion the
 *   canvas renders on demand: one composed still, re-rendered on resize / prop change.
 * - The WebGL probe waits until the wrapper is near the viewport (a scene far below the fold creates no context).
 * - Accessibility: decorative by default (`aria-hidden`). With `label`, the area is exposed as an image with that
 *   alternative text; the canvas itself stays hidden from assistive technology either way.
 * - Not interactive by default (pointer events pass through to the page). `interactive` enables pointer events.
 *
 * Props: className, style, fallback, label, onReady (called once, after the commit in which the first frame is on
 * screen - safe to set state in it), frameloop ('always' | 'demand'), interactive, maxTier ('high' | 'medium' |
 * 'low'), children (R3F elements, e.g. <CityScene />).
 */
import {
  Children,
  Component,
  Suspense,
  isValidElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/utils/cn'
import { SceneCanvasHost } from './lazyScenes'
import { useSceneQuality } from './useSceneQuality'
import { drawingBufferSize, peekWebGLSupport, prepareSpareContext, probeWebGL } from './webgl'

const FADE_MS = 900
/** Share of the wrapper (or of the window's height, for wrappers taller than it) that must be visible to render. */
const VISIBLE_SHARE = 0.3
const SHARE_STEPS = Array.from({ length: 21 }, (_, i) => i / 20)

/** Error boundary around the lazy host: any failure inside the canvas or a chunk load error -> fallback. */
class SceneBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    this.props.onError?.(error)
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

/* ---- Visibility ---------------------------------------------------------------------------------------------- */

function subscribeVisibility(onChange) {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}
const getPageVisible = () => document.visibilityState !== 'hidden'

/** Tracks whether the element is within `margin` of the viewport (true when IntersectionObserver is missing). */
function useNearViewport(ref, margin) {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver((entries) => setNear(entries.some((entry) => entry.isIntersecting)), {
      rootMargin: margin,
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref, margin])
  return near
}

/** Whether at least `share` of the element, or of the window's height, is visible (true without the API). */
function useMostlyVisible(ref, share) {
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const node = ref.current
    if (!node || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1]
        const viewport = entry.rootBounds?.height || window.innerHeight
        setVisible(
          entry.isIntersecting && (entry.intersectionRatio >= share || entry.intersectionRect.height >= viewport * share),
        )
      },
      { threshold: SHARE_STEPS },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref, share])
  return visible
}

/** The element's latest content-box size, from a ResizeObserver (read when needed; never forces a layout). */
function useBoxSize(ref) {
  const size = useRef(null)
  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[entries.length - 1].contentRect
      size.current = { width, height }
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return size
}

/**
 * Preloads the lazy scene components among `children` (see lazyScenes.js) and lets each prepare for these props
 * and this quality tier (e.g. build its world in idle slices) before the canvas mounts.
 */
function collectPreloads(children, quality) {
  const loads = []
  Children.forEach(children, (child) => {
    if (isValidElement(child) && typeof child.type?.preload === 'function') {
      loads.push(child.type.preload({ props: child.props, quality }))
    }
  })
  return loads
}

export function SceneCanvas({
  className,
  style,
  fallback = null,
  label,
  onReady,
  frameloop = 'always',
  interactive = false,
  maxTier,
  children,
}) {
  const quality = useSceneQuality({ max: maxTier })
  const reducedMotion = useMediaQuery(BREAKPOINTS.reducedMotion)
  // null while the asynchronous probe runs (the fallback shows meanwhile); then true / false.
  const [webgl, setWebgl] = useState(peekWebGLSupport)
  const containerRef = useRef(null)
  const boxSize = useBoxSize(containerRef)
  const near = useNearViewport(containerRef, '200px 0px')
  const inView = useMostlyVisible(containerRef, VISIBLE_SHARE)
  const pageVisible = useSyncExternalStore(subscribeVisibility, getPageVisible, () => true)

  const [failed, setFailed] = useState(false)
  const [armed, setArmed] = useState(false)
  const [hostReady, setHostReady] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [fallbackGone, setFallbackGone] = useState(false)

  const want3D = webgl === true && quality.render3D && !failed
  const childrenRef = useRef(children)
  const qualityRef = useRef(quality)
  const onReadyRef = useRef(onReady)
  useEffect(() => {
    childrenRef.current = children
    qualityRef.current = quality
    onReadyRef.current = onReady
  })

  // The WebGL check, once per page, off the critical path: only devices that may get the 3D, and only once a scene
  // comes near the viewport (the 200 px margin leaves it time to finish before the scene arms).
  useEffect(() => {
    if (webgl !== null || !quality.render3D || !near) return undefined
    let alive = true
    probeWebGL().then((supported) => alive && setWebgl(supported))
    return () => {
      alive = false
    }
  }, [webgl, quality.render3D, near])

  // Arm once the area is close to the viewport; stay armed (pausing handles off-screen time).
  useEffect(() => {
    if (want3D && near) setArmed(true)
  }, [want3D, near])

  useEffect(() => {
    if (!armed || !want3D) return undefined
    let cancelled = false
    // In parallel: the chunks, the scene's own preparation (its world, in idle slices), a WebGL context made ready
    // ahead and the renderer built on it for this box (so mounting the canvas creates neither).
    const ready = [
      prepareSpareContext(drawingBufferSize(boxSize.current, qualityRef.current.dpr)),
      SceneCanvasHost.preload({ props: {}, quality: qualityRef.current, size: boxSize.current }),
      ...collectPreloads(childrenRef.current, qualityRef.current),
    ]
    Promise.all(ready).then(
      () => !cancelled && setHostReady(true),
      () => !cancelled && setFailed(true),
    )
    return () => {
      cancelled = true
    }
  }, [armed, want3D, boxSize])

  // onReady runs after the commit that reveals the canvas (never inside a state updater or during render), once.
  const readyCalled = useRef(false)
  useEffect(() => {
    if (!revealed || readyCalled.current) return
    readyCalled.current = true
    onReadyRef.current?.()
  }, [revealed])

  // The fallback is removed once the canvas has fully faded in (a timer, so reduced motion needs no event).
  useEffect(() => {
    if (!revealed) return undefined
    const timer = window.setTimeout(() => setFallbackGone(true), reducedMotion ? 0 : FADE_MS + 60)
    return () => window.clearTimeout(timer)
  }, [revealed, reducedMotion])

  const handleFirstFrame = useCallback(() => setRevealed(true), [])

  const handleFailure = useCallback(() => {
    setFailed(true)
    setRevealed(false)
    setFallbackGone(false)
  }, [])

  const showCanvas = want3D && armed && hostReady
  const active = inView && pageVisible
  const loop = active ? (reducedMotion ? 'demand' : frameloop) : 'never'
  const probing = webgl === null && quality.render3D && !failed
  const state = showCanvas ? (revealed ? 'live' : 'loading') : want3D || probing ? 'loading' : 'still'

  return (
    <div
      ref={containerRef}
      className={cn('relative isolate overflow-hidden', className)}
      style={style}
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      data-scene={state}
    >
      {!fallbackGone || !showCanvas ? (
        <div aria-hidden className="absolute inset-0">
          {fallback}
        </div>
      ) : null}
      {showCanvas ? (
        <SceneBoundary onError={handleFailure}>
          {/* Preloaded, so this never suspends in practice; the boundary keeps a suspension local if it did. */}
          <Suspense fallback={null}>
            <SceneCanvasHost
              style={{
                position: 'absolute',
                inset: 0,
                opacity: revealed ? 1 : 0,
                transition: `opacity ${FADE_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`,
              }}
              frameloop={loop}
              quality={quality}
              reducedMotion={reducedMotion}
              interactive={interactive}
              onFirstFrame={handleFirstFrame}
              onContextLost={handleFailure}
            >
              {children}
            </SceneCanvasHost>
          </Suspense>
        </SceneBoundary>
      ) : null}
    </div>
  )
}

export default SceneCanvas
