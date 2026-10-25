/**
 * WebGL capability probe for the 3D scenes (no three.js import: safe for every page bundle).
 *
 * `supportsWebGL()` answers one question: can this browser run the CivicAI scenes on real graphics hardware?
 * - It tries a WebGL2 context first, then WebGL1, with `failIfMajorPerformanceCaveat: true` (the browser refuses
 *   when it would fall back to a slow path).
 * - Chromium still hands out a software context (SwiftShader) despite that flag, for example in headless test
 *   browsers and on machines with a blocked GPU driver. The unmasked renderer name is therefore checked too, and a
 *   software rasteriser counts as "no WebGL": rendering a city in software would block the main thread.
 * - three.js r163+ renders through WebGL2 only, so a browser with WebGL1 alone also gets the still fallback.
 * The probe runs once per page load (cached). Server-side or without a DOM it answers false.
 *
 * Cost control: a context's first query waits for the GPU process, which can be busy painting the page.
 * - `probeWebGL()` (what SceneCanvas uses) answers asynchronously: it opens the context once the page's frames
 *   arrive on time, lets the GPU process initialise it behind a fence (polled without blocking), and only then
 *   reads the renderer name.
 * - The probe context is created with the scene renderer's own attributes (CONTEXT_ATTRIBUTES) and kept for a
 *   short while: a scene can adopt it (`takeSpareContext()`), so a small page scene creates one context instead of
 *   two. Scenes get theirs ready ahead the same way (`prepareSpareContext(size)`, called when SceneCanvas arms),
 *   created at the drawing-buffer size they will render at: resizing a live context's drawing buffer is a
 *   synchronous round trip to the GPU process (seconds in a cold browser), while a context created at its size
 *   allocates the buffer during its asynchronous start-up. An unused spare is released after SPARE_LIFETIME_MS.
 * - The answer is remembered for the tab session (sessionStorage `civicai.webgl`), so later page loads skip the
 *   probe. A renderer created without the probe checks the renderer name itself (`isSoftwareRenderer`).
 */
import { quietFrames, waitForGpu } from './gpuTasks'

const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|software|basic render|lavapipe|mesa offscreen/i

/** Context attributes of every scene renderer (SceneCanvasHost); the probe uses the same so its context is reusable. */
export const CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: false,
  antialias: false,
  depth: true,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
  failIfMajorPerformanceCaveat: true,
})

const SPARE_LIFETIME_MS = 15000
const SESSION_KEY = 'civicai.webgl'
/**
 * Extensions three's WebGLRenderer enables on start-up. Enabling one is a synchronous round trip to the GPU
 * process; done ahead on a kept context right after a fence (the GPU process has just answered, so they return at
 * once), a renderer that adopts the context finds them enabled and makes no round trip.
 */
const RENDERER_EXTENSIONS = Object.freeze([
  'EXT_color_buffer_float',
  'WEBGL_clip_cull_distance',
  'OES_texture_float_linear',
  'EXT_color_buffer_half_float',
  'WEBGL_multisampled_render_to_texture',
  'WEBGL_render_shared_exponent',
  'KHR_parallel_shader_compile',
  'EXT_texture_filter_anisotropic',
])

function readSession() {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) || 'null')
    if (value && typeof value.supported === 'boolean' && typeof value.renderer === 'string') {
      return Object.freeze({
        webgl2: Boolean(value.webgl2),
        webgl: Boolean(value.webgl),
        software: Boolean(value.software),
        renderer: value.renderer,
        supported: value.supported,
      })
    }
  } catch {
    // Storage blocked or malformed: probe again.
  }
  return null
}

function writeSession(result) {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(result))
  } catch {
    // Storage blocked: the probe simply runs again on the next page load.
  }
}

let cached = typeof window === 'undefined' ? null : readSession()
/** The probe's context while it is being initialised: { canvas, context, kind }. */
let opened = null
/** Verified hardware WebGL2 contexts waiting to be adopted by a scene: { canvas, context, timer }. */
const spares = []
let pendingSpare = null
let pendingProbe = null

function readRenderer(gl) {
  try {
    const masked = String(gl.getParameter(gl.RENDERER) || '')
    // Chromium and Safari mask RENDERER ("WebKit WebGL"); Firefox already returns the real (sanitised) name and
    // warns when the debug extension is requested, so the extension is only asked for when the name is masked.
    if (masked && !/^webkit webgl$/i.test(masked)) return masked
    const info = gl.getExtension('WEBGL_debug_renderer_info')
    return String((info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) || masked)
  } catch {
    return ''
  }
}

function loseContext(context) {
  try {
    context.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    // Already lost.
  }
}

/** Enables what three's renderer enables on start-up (call right after a query has returned: no waiting). */
function enableRendererExtensions(context) {
  RENDERER_EXTENSIONS.forEach((name) => {
    try {
      context.getExtension(name)
    } catch {
      // Unsupported here: three falls back on its own.
    }
  })
}

/**
 * Enables three's extensions on a kept context later, off the critical path: once frames arrive on time, right after
 * a fence (the synchronous probe runs during a page's first render, which should not wait for these round trips).
 */
function warmLater(context) {
  quietFrames({ timeout: 1500 })
    .then(() => waitForGpu(context, { timeout: 2000 }))
    .then(() => {
      if (!context.isContextLost()) enableRendererExtensions(context)
    })
    .catch(() => undefined)
}

/** Drawing-buffer size (device px) of a box of CSS size `box` at the scene's DPR range `[min, max]` (or a number). */
export function drawingBufferSize(box, dpr) {
  if (!(box?.width > 0 && box?.height > 0) || typeof window === 'undefined') return null
  const device = window.devicePixelRatio || 1
  const ratio = Array.isArray(dpr) ? Math.min(Math.max(dpr[0], device), dpr[1]) : dpr || device
  return { width: Math.floor(box.width * ratio), height: Math.floor(box.height * ratio), ratio }
}

/** Whether a kept context's drawing buffer already has the wanted size (any size when none is wanted). */
const fits = (entry, size) => !size || (entry.canvas.width === size.width && entry.canvas.height === size.height)
/** Larger than this (device px, either side), a scene never adopts a context of another size. */
const RESIZE_LIMIT = 64

/** Keeps a verified context for adoption; an unclaimed one is released after SPARE_LIFETIME_MS. */
function keepSpare(canvas, context) {
  const entry = { canvas, context, timer: 0 }
  entry.timer = setTimeout(() => {
    const index = spares.indexOf(entry)
    if (index < 0) return
    spares.splice(index, 1)
    loseContext(entry.context)
  }, SPARE_LIFETIME_MS)
  spares.push(entry)
}

/** Creates the probe context (WebGL2 first, then WebGL1). Cheap: the GPU process initialises it asynchronously. */
function openProbe() {
  if (opened || cached || typeof document === 'undefined') return opened
  for (const kind of ['webgl2', 'webgl']) {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const context = canvas.getContext(kind, CONTEXT_ATTRIBUTES)
      if (!context) continue
      opened = { canvas, context, kind }
      return opened
    } catch {
      // Context creation blocked (policy, sandbox): try the next kind.
    }
  }
  return null
}

/** Reads the renderer of the opened probe (synchronous queries) and settles the cached answer. */
function settleProbe() {
  if (cached) return cached
  const result = { webgl2: false, webgl: false, software: false, renderer: '', supported: false }
  const probe = opened
  opened = null
  if (probe) {
    result[probe.kind] = true
    result.renderer = readRenderer(probe.context)
  }
  result.software = SOFTWARE_RENDERER.test(result.renderer)
  result.supported = result.webgl2 && !result.software
  if (probe) {
    if (result.supported) {
      keepSpare(probe.canvas, probe.context)
      warmLater(probe.context)
    } else {
      loseContext(probe.context)
    }
  }
  cached = Object.freeze(result)
  writeSession(cached)
  return cached
}

/** True when `gl` (any WebGL context) is rendered by a software rasteriser (one synchronous query). */
export function isSoftwareRenderer(gl) {
  return SOFTWARE_RENDERER.test(readRenderer(gl))
}

/**
 * Detailed probe result: `{ webgl2, webgl, software, renderer, supported }` (synchronous; cached).
 * `supported` is the value `supportsWebGL()` returns.
 */
export function getWebGLSupport() {
  if (cached) return cached
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return Object.freeze({ webgl2: false, webgl: false, software: false, renderer: '', supported: false })
  }
  openProbe()
  return settleProbe()
}

/** True when the 3D scenes can run on hardware-accelerated WebGL2 (cached after the first call). */
export function supportsWebGL() {
  return getWebGLSupport().supported
}

/** The cached answer of `supportsWebGL()`, or `null` while it is not known yet (no probe has finished). */
export function peekWebGLSupport() {
  return cached ? cached.supported : null
}

/**
 * Asynchronous `supportsWebGL()`: resolves with the same boolean, without blocking the main thread on the GPU
 * process (the context is opened once the page's frames arrive on time, and read once a fence shows it is
 * initialised).
 */
export function probeWebGL() {
  if (cached) return Promise.resolve(cached.supported)
  if (typeof document === 'undefined' || typeof window === 'undefined') return Promise.resolve(false)
  if (!pendingProbe) {
    pendingProbe = (async () => {
      await quietFrames({ timeout: 1500 })
      if (cached) return cached.supported
      const probe = openProbe()
      // The queries run right after the fence signals: the GPU process has just been seen idle, so they return at
      // once (a later task could find it busy painting the page).
      if (probe?.kind === 'webgl2') await waitForGpu(probe.context, { timeout: 3000 })
      return settleProbe().supported
    })().catch(() => settleProbe().supported)
  }
  return pendingProbe
}

/**
 * Makes sure a ready context will be waiting for the next scene renderer (SceneCanvas calls it when it arms, in
 * parallel with loading the scene): once the page's frames arrive on time, a context is created, the GPU process
 * initialises it behind a fence, and right after that its renderer name is checked and three's extensions are
 * enabled - each step in its own short task, none inside the task that later builds the renderer. Resolves when
 * the spare is ready (or could not be made: the renderer then creates its own context).
 */
export function prepareSpareContext(size = null) {
  const big = size && (size.width > RESIZE_LIMIT || size.height > RESIZE_LIMIT)
  const want = big ? size : null
  if (spares.some((entry) => fits(entry, want)) || !peekWebGLSupport()) return Promise.resolve()
  if (pendingSpare) {
    // One spare at a time: a request for another size waits for the one being made, then looks again.
    return pendingSpare.then(() => (spares.some((entry) => fits(entry, want)) ? undefined : prepareSpareContext(size)))
  }
  pendingSpare = (async () => {
    await quietFrames({ timeout: 1500 })
    if (spares.some((entry) => fits(entry, want))) return
    const canvas = document.createElement('canvas')
    // At its final size from the start: the drawing buffer is allocated while the context starts up.
    canvas.width = want ? want.width : 1
    canvas.height = want ? want.height : 1
    const context = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES)
    if (!context) return
    await waitForGpu(context, { timeout: 3000 })
    // The synchronous part (renderer name, extensions) at a moment when frames are on time, right after a fence.
    await quietFrames({ timeout: 1000 })
    await waitForGpu(context, { timeout: 1000 })
    if (isSoftwareRenderer(context)) {
      loseContext(context)
      return
    }
    enableRendererExtensions(context)
    // A tiny kept context (the probe's 1 x 1) would only be adopted and resized: release it.
    if (want) {
      for (let i = spares.length - 1; i >= 0; i -= 1) {
        const { width, height } = spares[i].canvas
        if (width <= RESIZE_LIMIT && height <= RESIZE_LIMIT) {
          clearTimeout(spares[i].timer)
          loseContext(spares.splice(i, 1)[0].context)
        }
      }
    }
    keepSpare(canvas, context)
  })()
    .catch(() => undefined)
    .finally(() => {
      pendingSpare = null
    })
  return pendingSpare
}

/**
 * Hands a ready hardware WebGL2 context (created with CONTEXT_ATTRIBUTES: the probe's, or one made by
 * prepareSpareContext) to the caller, once: `{ canvas, context }`, or `null` when there is none. With `size`, one
 * whose drawing buffer already has that size is preferred.
 */
export function takeSpareContext(size = null) {
  const exact = spares.findIndex((entry) => fits(entry, size))
  if (exact > 0) spares.unshift(spares.splice(exact, 1)[0])
  while (spares.length) {
    const entry = spares.shift()
    clearTimeout(entry.timer)
    try {
      if (!entry.context.isContextLost()) return { canvas: entry.canvas, context: entry.context }
    } catch {
      // A context in a bad state: try the next one.
    }
  }
  return null
}

export default supportsWebGL
