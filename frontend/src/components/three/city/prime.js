/**
 * Start-up primer for the 3D scenes: everything a scene's first frames would otherwise do synchronously (and every
 * stage's first draw would repeat), done ahead of time in small steps while the canvas is still hidden behind its
 * still. After it, the first frame and every first stage switch only update uniforms and draw.
 *
 * Why each step exists (measured on an Intel iGPU, ANGLE / Direct3D 11):
 * 1. Compile: every program the scene can use - all objects, hidden ones included (pin, scan sheet), both faces of
 *    double-sided transparent materials, every post-processing pass, the label sprites and the light-map bake -
 *    is created with the render-target state it really draws in. three keys programs on that state and on the
 *    geometry's attributes: pass materials are compiled on a full-screen triangle without normals, like three's
 *    FullScreenQuad (compiled on any other mesh they get a different key and compile again in the first frame).
 *    Shaders compile in parallel on the GPU process (KHR_parallel_shader_compile); readiness is polled without
 *    blocking. A few at a time: the GPU process compiles on a small worker pool that it shares with the page's own
 *    painting, so queueing every program at once made the page's next paint wait behind them (200+ ms stalls).
 * 2. Resolve: a program's first query (three's first use: logs and uniform locations) waits on the main thread
 *    until the GPU process has finished linking it (6-20 ms per program, hundreds of ms for a whole scene in one
 *    frame). Each program is made current first (useProgram is not a query), a fence is awaited, and only then are
 *    the queries made - they return at once.
 * 3. Bake, allocate, upload: the light map is rendered, render targets are allocated, label signs are uploaded.
 * 4. Draw: each object, pass and label is drawn once into small targets of the same kind (or the hidden canvas),
 *    so whatever the driver still defers to a first draw happens now, not on the first stage switch.
 * 5. Rehearse: the whole post chain renders once into its real targets, at their real size (the canvas is still
 *    hidden). A framebuffer's first use makes the browser check its completeness with a synchronous round trip to
 *    the GPU process - 300-650 ms when that process is busy, which used to land in the first second of the
 *    establishing shot. Done here, right after a fence, every check returns at once.
 * Work is grouped into jobs of a few milliseconds of main-thread time, each run through the page-wide gpuQueue and
 * followed by a fence: the main thread never waits on the GPU, and two scenes never stall the GPU process
 * together. An AbortSignal stops the priming between jobs.
 */
import { BufferGeometry, Float32BufferAttribute, HalfFloatType, Mesh, OrthographicCamera, WebGLRenderTarget } from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { delay, gpuQueue, isCancelled, nextTask, throwIfAborted, waitForGpu } from '../gpuTasks'
import { whenFontsReady } from './labels'

/** Programs whose first use is done (per renderer: WebGLProgram objects belong to one renderer). */
const primedPrograms = new WeakSet()
const READY_TIMEOUT_MS = 12000
/** Main-thread budget of one job (ms); draws get less, their GPU cost is unknown until the fence returns. */
const JOB_BUDGET = 6
const DRAW_BUDGET = 3
/** Objects (one or two programs each) whose shaders may compile on the GPU process at the same time. */
const COMPILE_BATCH = 3

let fullscreenGeometry = null
/** Same attributes as three's FullScreenQuad geometry (position + uv, no normals): same program keys. */
function fullscreenTriangle() {
  if (!fullscreenGeometry) {
    fullscreenGeometry = new BufferGeometry()
    fullscreenGeometry.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3))
    fullscreenGeometry.setAttribute('uv', new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2))
  }
  return fullscreenGeometry
}
const passCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)

function withTarget(gl, target, run) {
  const previous = gl.getRenderTarget()
  gl.setRenderTarget(target)
  try {
    return run()
  } finally {
    gl.setRenderTarget(previous)
  }
}

/** Makes `root` and its descendants drawable for one call (visible, not frustum-culled), then restores them. */
function withEverythingDrawn(root, run) {
  const changed = []
  root.traverse((object) => {
    if (!object.visible || object.frustumCulled) {
      changed.push([object, object.visible, object.frustumCulled])
      object.visible = true
      object.frustumCulled = false
    }
  })
  try {
    return run()
  } finally {
    changed.forEach(([object, visible, culled]) => {
      object.visible = visible
      object.frustumCulled = culled
    })
  }
}

/** Waits (polling without blocking) until every program reports its compile and link complete, or a timeout. */
async function untilReady(programs, signal, timeout = READY_TIMEOUT_MS) {
  const start = performance.now()
  while (programs.some((program) => !program.isReady()) && performance.now() - start < timeout) {
    await delay(16, { signal })
  }
  return performance.now() - start
}

/**
 * Runs `run(item)` for every item, in gpuQueue jobs of at most `budget` ms of main-thread time each, every job
 * followed by a fence. A failing item is skipped (priming is best effort: a skipped item costs a frame later).
 */
async function inJobs(context, signal, items, run, { budget = JOB_BUDGET } = {}) {
  let index = 0
  while (index < items.length) {
    try {
      await gpuQueue(async () => {
        throwIfAborted(signal)
        await nextTask({ signal })
        const start = performance.now()
        do {
          const item = items[index]
          index += 1
          try {
            run(item)
          } catch (error) {
            if (isCancelled(error)) throw error
          }
        } while (index < items.length && performance.now() - start < budget)
        await waitForGpu(context, { signal })
      })
    } catch (error) {
      if (isCancelled(error)) throw error
    }
  }
}

/**
 * @param {object} options
 * @param {import('three').WebGLRenderer} options.gl
 * @param {import('three').Camera} options.camera camera the scene objects are drawn with (already framed)
 * @param {{ objects: import('three').Object3D[], target: object|null, samples?: number }[]} options.groups objects
 *   to compile and draw; `target` is a render target of the kind they draw into (null = the screen), `samples`
 *   its MSAA sample count
 * @param {object|null} [options.pipeline] createPostPipeline() result
 * @param {{ scene: object, camera: object, target: object, bake: () => void, done?: () => boolean }[]} [options.bakes]
 * @param {object|null} [options.labels] LabelLayer
 * @param {object[]} [options.labelSpecs] [{ id, spec }] signs to draw, upload and draw once
 * @param {AbortSignal} [options.signal]
 */
export async function primeScene({ gl, camera, groups = [], pipeline = null, bakes = [], labels = null, labelSpecs = [], signal }) {
  const context = gl.getContext()
  const extraTargets = []
  try {
    /* ---- 1. compile (parallel on the GPU process) ---- */
    const compiles = []
    groups.forEach(({ objects, target }) => {
      objects.forEach((object) => compiles.push(() => withTarget(gl, target, () => gl.compile(object, camera))))
    })
    ;(pipeline?.primeList ?? []).forEach(({ material, target }) => {
      const mesh = new Mesh(fullscreenTriangle(), material)
      compiles.push(() => withTarget(gl, target, () => gl.compile(mesh, passCamera)))
    })
    bakes.forEach((bake) => {
      if (!bake.done?.()) compiles.push(() => withTarget(gl, bake.target, () => gl.compile(bake.scene, bake.camera)))
    })
    for (let i = 0; i < compiles.length; i += COMPILE_BATCH) {
      const known = new Set(gl.info.programs ?? [])
      await inJobs(context, signal, compiles.slice(i, i + COMPILE_BATCH), (compile) => compile())
      await untilReady((gl.info.programs ?? []).filter((program) => !known.has(program)), signal)
    }

    let slots = []
    if (labels && labelSpecs.length) {
      await whenFontsReady()
      throwIfAborted(signal)
      // Draw every sign (CPU canvases) and give each sprite its texture: the sprite program is then compiled with a
      // map bound, exactly like the real draws. In jobs, like the GPU steps: the page's first 2D canvas makes the
      // browser set up its canvas machinery with a round trip to the GPU process, best done right after a fence.
      slots = labelSpecs.map(({ id, spec }) => ({ sprite: labels.slot(id, null), spec }))
      await inJobs(context, signal, slots, (slot) => labels.assign(slot.sprite, labels.prepare(slot.spec)))
      await inJobs(context, signal, [labels.scene], (scene) => withTarget(gl, null, () => gl.compile(scene, camera)))
    }

    /* ---- every program compiled (non-blocking polls) ---- */
    const created = (gl.info.programs ?? []).filter((program) => !primedPrograms.has(program))
    await untilReady(created, signal)

    /* ---- 2. resolve each link on the GPU, then make three's first queries (now immediate) ---- */
    let batch = 1
    for (let i = 0; i < created.length; ) {
      const programs = created.slice(i, i + batch)
      i += programs.length
      try {
        const wait = await gpuQueue(async () => {
          throwIfAborted(signal)
          await nextTask({ signal })
          programs.forEach((program) => gl.state.useProgram(program.program))
          const waited = await waitForGpu(context, { signal })
          programs.forEach((program) => {
            program.getUniforms()
            program.getAttributes()
            primedPrograms.add(program)
          })
          return waited
        })
        // Resolving costs the GPU process 5-20 ms per program: group them while that stays near a frame (fewer
        // jobs also means fewer first queries, each of which may wait if the GPU process is busy painting).
        batch = wait < 12 ? Math.min(batch * 2, 4) : wait < 30 ? 2 : 1
      } catch (error) {
        if (isCancelled(error)) throw error
      }
    }

    /* ---- 3. bake, allocate render targets, upload the signs ---- */
    await inJobs(context, signal, bakes.filter((bake) => !bake.done?.()), (bake) => bake.bake())
    const sceneKinds = groups.map((group) => {
      if (!group.target) return null
      const target = new WebGLRenderTarget(64, 64, { type: HalfFloatType, samples: group.samples ?? 0, depthBuffer: true })
      extraTargets.push(target)
      return target
    })
    const passTarget = new WebGLRenderTarget(64, 64, { type: HalfFloatType, depthBuffer: false })
    extraTargets.push(passTarget)
    await inJobs(context, signal, [...(pipeline?.renderTargets ?? []), ...extraTargets], (target) => gl.initRenderTarget(target))
    // One sign per job: an upload copies the canvas into the command buffer's transfer memory, and a few at once
    // can make the main thread wait for the GPU process to drain it.
    const signTextures = [...new Set(slots.map((slot) => labels.prepare(slot.spec).texture))]
    await inJobs(context, signal, signTextures, (texture) => gl.initTexture(texture), { budget: 0 })

    /* ---- 4. draw everything once ---- */
    const draws = []
    groups.forEach((group, k) => {
      group.objects.forEach((object) => {
        draws.push(() => withTarget(gl, sceneKinds[k], () => withEverythingDrawn(object, () => gl.render(object, camera))))
      })
    })
    ;(pipeline?.primeList ?? []).forEach(({ material, target }) => {
      const quad = new FullScreenQuad(material)
      draws.push(() => withTarget(gl, target ? passTarget : null, () => quad.render(gl)))
    })
    if (labels && slots.length) {
      draws.push(() => {
        const autoClear = gl.autoClear
        gl.autoClear = false
        try {
          withTarget(gl, null, () => withEverythingDrawn(labels.scene, () => gl.render(labels.scene, camera)))
        } finally {
          gl.autoClear = autoClear
        }
      })
    }
    await inJobs(context, signal, draws, (draw) => draw(), { budget: DRAW_BUDGET })

    /* ---- 5. the real chain once, into its real targets (first-use framebuffer checks) ---- */
    if (pipeline?.composer) {
      await inJobs(context, signal, [pipeline.composer], (composer) => composer.render(0), { budget: 0 })
    }
    // Signs needed later (new categories) are drawn and uploaded in idle periods by the layer itself.
    if (labels) labels.renderer = gl
  } finally {
    extraTargets.forEach((target) => target.dispose())
    // The shared compile triangle: dispose it after use, so this renderer drops its buffers and its dispose
    // listener (a module-level geometry would otherwise keep every primed renderer reachable). The next priming
    // uploads it again (three vertices).
    fullscreenGeometry?.dispose()
  }
}
