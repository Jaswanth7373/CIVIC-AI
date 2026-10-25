/**
 * The one place an R3F <Canvas> is created (loaded lazily by SceneCanvas, so it may import three / R3F).
 *
 * - Renderer: ACES filmic tone mapping, sRGB output, no default MSAA (scenes antialias inside their post chain),
 *   opaque buffer, high-performance GPU preference, no stencil (CONTEXT_ATTRIBUTES in webgl.js).
 * - The renderer is created by an asynchronous factory, outside the task that mounts the canvas: it adopts the
 *   WebGL probe's context when one is waiting (so the page does not create a second context), or creates a context
 *   in an idle period and lets the GPU process initialise it behind a fence before three.js queries it. Each step
 *   runs through the shared GPU queue, so it never overlaps another scene's start-up work.
 * - Provides SceneContext (quality, reduced motion, interactivity, first-frame handshake) to the scene.
 * - Samples frame times for the adaptive-quality monitor (`lowerSceneTier`) once the scene is on screen and the
 *   loop runs continuously (start-up frames never count).
 * - Reports WebGL context loss so SceneCanvas can fall back to the still.
 */
import { Canvas, useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { ACESFilmicToneMapping, SRGBColorSpace, WebGLRenderer } from 'three'
import { gpuQueue, nextTask, quietFrames, waitForGpu } from './gpuTasks'
import { watchScroll } from './scrollActivity'
import { SceneContext } from './sceneContext'
import { lowerSceneTier } from './useSceneQuality'
import { CONTEXT_ATTRIBUTES, drawingBufferSize, isSoftwareRenderer, prepareSpareContext, takeSpareContext } from './webgl'

const RESIZE = Object.freeze({ scroll: false, debounce: { scroll: 0, resize: 0 } })
const CAMERA = Object.freeze({ fov: 32, near: 1, far: 2400, position: [120, 90, 160] })
const SPARE_RENDERER_LIFETIME_MS = 15000

/** Renderers built ahead of their canvas (see prepareRenderer): { renderer, timer }. */
const spareRenderers = []

/** R3F's device-pixel-ratio rule for a [min, max] range. */
const pixelRatio = (dpr) =>
  Array.isArray(dpr) ? Math.min(Math.max(dpr[0], window.devicePixelRatio || 1), dpr[1]) : dpr || window.devicePixelRatio || 1

/**
 * Builds a WebGLRenderer ahead of its canvas (SceneCanvas asks for it when it arms, in parallel with loading the
 * scene): on a context webgl.js made ready at the drawing-buffer size of the box it will fill, once the page's
 * frames arrive on time, right after a fence - so its capability queries find the GPU process idle. The renderer
 * then only records that size (setDrawingBufferSize with the same values: no reallocation). Resizing a live
 * context instead reallocates its drawing buffer synchronously: 2-8 s main-thread freezes in a cold browser.
 * Only a context of another size (none could be made at this size) is resized, in its own step after a fence.
 */
async function prepareRenderer({ quality, size } = {}) {
  const target = drawingBufferSize(size, quality?.dpr)
  await prepareSpareContext(target)
  const renderer = await gpuQueue(async () => {
    if (spareRenderers.length) return null
    const spare = takeSpareContext(target)
    if (!spare) return null
    await quietFrames({ timeout: 1500 })
    await waitForGpu(spare.context, { timeout: 2000 })
    return new WebGLRenderer({ ...CONTEXT_ATTRIBUTES, canvas: spare.canvas, context: spare.context })
  })
  if (!renderer) return
  const canvas = renderer.domElement
  if (target && canvas.width === target.width && canvas.height === target.height) {
    // Same values as the buffer already has: three records size and ratio (and the CSS size), nothing reallocates.
    renderer.setDrawingBufferSize(size.width, size.height, target.ratio)
    renderer.setSize(size.width, size.height)
  } else if (target) {
    await gpuQueue(async () => {
      await quietFrames({ timeout: 1000 })
      await waitForGpu(renderer.getContext(), { timeout: 2000 })
      renderer.setPixelRatio(pixelRatio(quality?.dpr))
      renderer.setSize(size.width, size.height)
    })
  }
  const entry = { renderer, timer: 0 }
  entry.timer = setTimeout(() => {
    const index = spareRenderers.indexOf(entry)
    if (index < 0) return
    spareRenderers.splice(index, 1)
    renderer.dispose()
    renderer.forceContextLoss()
  }, SPARE_RENDERER_LIFETIME_MS)
  spareRenderers.push(entry)
}

function takeSpareRenderer() {
  while (spareRenderers.length) {
    const entry = spareRenderers.shift()
    clearTimeout(entry.timer)
    if (!entry.renderer.getContext().isContextLost()) return entry.renderer
  }
  return null
}

/** Puts `canvas` in place of R3F's own canvas (same box, same parent); R3F's stays hidden, without a context. */
function swapIn(canvas, host) {
  canvas.style.display = 'block'
  host.parentNode.insertBefore(canvas, host)
  host.style.display = 'none'
}

/**
 * Creates the renderer for R3F's canvas (`defaults.canvas`), outside the mount task:
 * 1. adopt the renderer built ahead (prepareRenderer), or else the context made ready ahead (webgl.js: the
 *    probe's, or prepareSpareContext's - initialised, checked and with three's extensions enabled), putting its
 *    canvas in place of R3F's; without either, wait until the page's frames arrive on time and create a context
 *    on R3F's canvas;
 * 2. wait, without blocking, until the GPU process has executed everything queued (a new context's set-up
 *    included), then build the WebGLRenderer at once: its capability queries find the GPU process idle and return
 *    immediately. A context made here is checked for a software rasteriser first.
 */
async function createRenderer(defaults) {
  const host = defaults.canvas
  return gpuQueue(async () => {
    await nextTask()
    if (host?.parentNode) {
      const ready = takeSpareRenderer()
      if (ready) {
        swapIn(ready.domElement, host)
        return ready
      }
    }
    let canvas = host
    let context = null
    const adopted = host?.parentNode ? takeSpareContext() : null
    if (!adopted) await quietFrames({ timeout: 2000 })
    if (adopted) {
      canvas = adopted.canvas
      context = adopted.context
      swapIn(canvas, host)
    } else {
      context = host.getContext('webgl2', CONTEXT_ATTRIBUTES)
      if (!context) throw new Error('WebGL2 is not available for the 3D scene.')
    }
    await waitForGpu(context, { timeout: 4000 })
    if (!adopted && isSoftwareRenderer(context)) throw new Error('The 3D scene needs hardware graphics.')
    return new WebGLRenderer({ ...CONTEXT_ATTRIBUTES, canvas, context })
  })
}

/**
 * Adaptive quality: after a 2.5 s warm-up, a smoothed frame rate below 40 fps for 2 s drops the tier one step; on
 * `low`, below the same 40 fps for 3 s switches the 3D off for the session (the still takes over): a scene that
 * cannot hold the bar on the lightest tier would only compete with the page (form input on the auth pages).
 */
function createFrameMonitor(tier) {
  let warm = 0
  let average = 0
  let slow = 0
  let done = false
  return (delta) => {
    if (done || !(delta > 0)) return
    if (delta > 0.5) {
      // A paused tab or a hidden canvas resumed: restart the warm-up instead of counting the gap.
      warm = Math.min(warm, 1.5)
      return
    }
    warm += delta
    if (warm < 2.5) return
    average = average ? average * 0.92 + delta * 0.08 : delta
    const fps = 1 / average
    // One bar on every tier: a scene that cannot hold 40 fps even on 'low' gives way to the still.
    const limit = 40
    slow = fps < limit ? slow + delta : Math.max(0, slow - delta * 0.5)
    if (slow > (tier === 'low' ? 3 : 2)) {
      done = true
      lowerSceneTier(tier)
    }
  }
}

function FrameWatcher({ claimedRef, liveRef, onFirstFrame, monitor, sampling }) {
  const fired = useRef(false)
  useFrame((_, delta) => {
    if (sampling && liveRef.current) monitor(delta)
    if (fired.current || claimedRef.current) return
    fired.current = true
    liveRef.current = true
    // The frame being rendered is composited after this callback: reveal on the next animation frame.
    requestAnimationFrame(() => onFirstFrame())
  })
  return null
}

export default function SceneCanvasHost({
  children,
  className,
  style,
  frameloop,
  quality,
  reducedMotion,
  interactive,
  onFirstFrame,
  onContextLost,
}) {
  const claimedRef = useRef(false)
  const liveRef = useRef(false)
  const lostHandler = useRef(onContextLost)
  const readyHandler = useRef(onFirstFrame)
  useEffect(() => {
    lostHandler.current = onContextLost
    readyHandler.current = onFirstFrame
  })
  const cleanupRef = useRef(null)
  useEffect(() => () => cleanupRef.current?.(), [])
  // Scenes draw every other frame while the page scrolls (usePostPipeline reads it).
  useEffect(() => watchScroll(), [])

  const tier = quality.tier
  const monitor = useMemo(() => createFrameMonitor(tier), [tier])

  const context = useMemo(
    () => ({
      quality,
      reducedMotion,
      interactive,
      claimReady: () => {
        claimedRef.current = true
      },
      markReady: () => {
        liveRef.current = true
        readyHandler.current?.()
      },
    }),
    [quality, reducedMotion, interactive],
  )

  const handleCreated = ({ gl }) => {
    gl.toneMapping = ACESFilmicToneMapping
    gl.outputColorSpace = SRGBColorSpace
    const canvas = gl.domElement
    const onLost = (event) => {
      event.preventDefault()
      lostHandler.current?.()
    }
    canvas.addEventListener('webglcontextlost', onLost)
    cleanupRef.current = () => canvas.removeEventListener('webglcontextlost', onLost)
  }

  return (
    <Canvas
      className={className}
      style={{ ...style, pointerEvents: interactive ? 'auto' : 'none' }}
      frameloop={frameloop}
      dpr={quality.dpr}
      gl={createRenderer}
      camera={CAMERA}
      resize={RESIZE}
      onCreated={handleCreated}
      aria-hidden="true"
    >
      <SceneContext.Provider value={context}>
        <FrameWatcher
          claimedRef={claimedRef}
          liveRef={liveRef}
          onFirstFrame={() => readyHandler.current?.()}
          monitor={monitor}
          sampling={frameloop === 'always' && !reducedMotion}
        />
        {children}
      </SceneContext.Provider>
    </Canvas>
  )
}

/**
 * Called through lazyScenes when SceneCanvas arms (`preload({ quality, size })`): builds this canvas's renderer
 * ahead, in short steps of its own (see prepareRenderer). Resolves when it is ready, or when it could not be made
 * (the canvas then creates one itself).
 */
SceneCanvasHost.prepare = (props, options) => prepareRenderer(options)
