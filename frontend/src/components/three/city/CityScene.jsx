/**
 * CityScene - the procedural CivicAI district at night (dark theme) or at overcast dawn (light theme), read by an
 * AI survey scan. Render it inside <SceneCanvas>; it is loaded lazily (imports three.js).
 *
 * Props
 * - stage: 'hero' | 'report' | 'analyze' | 'prioritize' | 'route' | 'verify' | 'calm' (default 'hero')
 *   hero: the full loop (scan -> detect -> sign label -> routing arc -> resolve) with an establishing shot on the
 *   first visit of the session; report: a citizen pin drops onto a street; analyze: the scan crosses the pinned
 *   issue; prioritize: issues rise as columns whose heights / colours read as priority; route: arcs fly to the
 *   department headquarters; verify: issues turn sign-green with checks; calm (auth pages): one resolved issue
 *   seen down its street, with a slow sway.
 * - categories: CategoryOut[] (GET /api/categories/) - real category and department names / colours for the labels
 *   and beacons; generic wording without them. Never numbers.
 * - progress: number | MotionValue in [0, 1] - scrubs the story stages (read inside the frame loop, no re-render);
 *   for the hero it raises the camera as the page scrolls past.
 * - interactive: pointer parallax and hover highlight of the issue markers (fine pointers only).
 * - theme: 'dark' | 'light' (optional override; defaults to the app theme from ThemeContext).
 * - framing: 'auto' | 'left' | 'top' | 'center' - where the calm area for overlaid copy is (auto: left on wide
 *   frames, top on tall ones).
 * - openingAt: performance.now() time at which the page's opening began, or a function returning it (read on the
 *   first frame; the landing hero passes its commit time; default: this scene's mount). The establishing shot is
 *   decided on the first real frame, not at mount: it flies when that frame comes soon enough for the whole
 *   opening to end within OPENING.budget (a little shorter when late), and otherwise settles in (opening.js). The
 *   decision is written on the canvas as `data-opening`.
 *
 * Reduced motion: one composed still per stage (the scan mid-district, a label and an arc on screen for the hero),
 * no loop, no fly-in, no parallax; the canvas renders on demand.
 *
 * Start-up without long tasks: SceneCanvas calls `CityScene.prepare` before the canvas mounts, which builds the
 * district in idle slices (world.js buildWorld); on mount the scene takes that world (or builds one the same way),
 * creates its post chain and runs the primer (prime.js): every program, texture, render target and first draw of
 * every stage is done ahead, in small steps behind fences, while the still is still on screen. Only then does the
 * scene render and report ready, so neither the first frame nor a first stage switch stalls. A tier change builds
 * and primes a new world and chain while the current one keeps rendering, then swaps.
 */
import { useThree } from '@react-three/fiber'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Color, MathUtils, Matrix4, Vector3 } from 'three'
import { ThemeContext } from '@/context/contexts'
import { isCancelled, runSliced } from '../gpuTasks'
import { SceneContext } from '../sceneContext'
import { themeRevealing } from '../themeReveal'
import { TIER_SETTINGS } from '../useSceneQuality'
import { GENERIC_LABELS, MARKING_YELLOW, RESOLVED_GREEN, castCity } from './cast'
import { LabelLayer } from './labels'
import { PINNED_SITE, getCity } from './layout'
import { createSharedUniforms, setMarkerBlending } from './materials'
import { OPENING, flightFor } from './opening'
import { CALM_DAWN_FOG, DAWN, GRADE, NIGHT, SCALARS } from './palette'
import { createPostPipeline, usePostPipeline } from './post'
import { primeScene } from './prime'
import { RIGS, applyRig, copyRig, createRig, dampRig, establishing, frameRig, wobble } from './rig'
import { HERO_POSTER_TIME, STAGE_DURATION, STILL_PROGRESS, createFrameState, stageState } from './timeline'
import { arcPoint, buildWorld } from './world'

const INTRO_KEY = 'civicai.city.intro'
const STAGES = ['hero', 'report', 'analyze', 'prioritize', 'route', 'verify', 'calm']

const BLOOM = Object.freeze({
  high: Object.freeze({ strength: 0.95, radius: 0.62, threshold: 0.92 }),
  medium: Object.freeze({ strength: 0.85, radius: 0.55, threshold: 0.95 }),
  low: Object.freeze({ strength: 0, radius: 0, threshold: 1 }),
})

const toLinear = (palette) => Object.fromEntries(Object.entries(palette).map(([key, hex]) => [key, new Color(hex)]))
const NIGHT_LINEAR = toLinear(NIGHT)
const DAWN_LINEAR = toLinear(DAWN)
const SODIUM = new Color('#ffae54')
const KEY_NIGHT = new Vector3(-0.45, 0.62, 0.35).normalize()
const KEY_DAWN = new Vector3(0.72, 0.42, 0.3).normalize()
const LED = new Color('#f1eee6')

function readProgress(progress) {
  if (typeof progress === 'number') return Number.isFinite(progress) ? MathUtils.clamp(progress, 0, 1) : undefined
  if (progress && typeof progress.get === 'function') {
    const value = Number(progress.get())
    return Number.isFinite(value) ? MathUtils.clamp(value, 0, 1) : undefined
  }
  return undefined
}

function introPlayed() {
  try {
    return window.sessionStorage.getItem(INTRO_KEY) === '1'
  } catch {
    return false
  }
}

function markIntroPlayed() {
  try {
    window.sessionStorage.setItem(INTRO_KEY, '1')
  } catch {
    // Storage blocked: the fly-in simply plays again next time.
  }
}

/** The opening's state on the canvas element ('flight' | 'settle' | 'done'), for the page that cues its entrance. */
function markOpening(canvas, value) {
  if (canvas?.dataset) canvas.dataset.opening = value
}

function resolveTheme(themeProp, themeContext) {
  if (themeProp === 'dark' || themeProp === 'light') return themeProp
  if (themeContext?.resolvedTheme) return themeContext.resolvedTheme
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) return 'dark'
  return 'light'
}

const _v = new Vector3()
const _anchor = new Vector3()
const _project = new Vector3()
const _m4 = new Matrix4()
const _color = new Color()
const _tint = new Color()
const _white = new Color('#ffffff')
const _resolved = new Color(RESOLVED_GREEN)

/* ---- Worlds built ahead of mount ------------------------------------------------------------------------------- */

/** Worlds being built or built by `CityScene.prepare`, each taken by exactly one scene (matched on tier settings). */
const preparedWorlds = []
const PREPARED_LIMIT = 3

/** Builds a district in idle slices (resolves to the world). */
function buildWorldSliced(settings, signal) {
  return runSliced(buildWorld(getCity(), settings, createSharedUniforms()), { budget: 8, signal })
}

function prepareWorld(settings) {
  const promise = buildWorldSliced(settings)
  preparedWorlds.push({ settings, promise })
  // A page never shows more than a couple of districts: drop the oldest unclaimed ones.
  while (preparedWorlds.length > PREPARED_LIMIT) {
    preparedWorlds
      .shift()
      .promise.then((world) => world.dispose())
      .catch(() => undefined)
  }
  return promise
}

function takePreparedWorld(settings) {
  const index = preparedWorlds.findIndex((entry) => entry.settings === settings)
  return index < 0 ? null : preparedWorlds.splice(index, 1)[0].promise
}

/** Arcs and HQ colours follow the cast (real department names / colours). */
function applyCast(world, sites, hqs) {
  world.rebuildArcs(sites, hqs)
  world.materials.building.uniforms.uHQColors.value.forEach((value, i) => value.set(hqs[i]?.color ?? '#1f5fad'))
  world.materials.arc.uniforms.uArcColor.value.forEach((value, k) => {
    const hq = hqs.find((h) => h.index === sites[k].hq)
    value.set(hq?.color ?? '#1f5fad')
  })
}

/** Every sign the scene can show (ids and specs exactly as the frame loop asks for them). */
function signsOf(sites, hqs) {
  const signs = []
  sites.forEach((site, i) => {
    signs.push({ id: `d${i}`, spec: { text: site.label, glyph: 'dot', glyphColor: site.severityColor } })
    signs.push({ id: `r${i}`, spec: { text: GENERIC_LABELS.resolved, glyph: 'check' } })
    if (i === PINNED_SITE) {
      signs.push({ id: 'report', spec: { text: GENERIC_LABELS.report, glyph: 'pin', glyphColor: MARKING_YELLOW } })
    }
  })
  hqs.forEach((hq) => {
    signs.push({ id: `h${hq.index}`, spec: { text: hq.name ?? GENERIC_LABELS.department, glyph: 'hq', glyphColor: hq.color } })
  })
  return signs
}

export default function CityScene({
  stage = 'hero',
  categories,
  progress,
  interactive = false,
  theme: themeProp,
  framing = 'auto',
  openingAt,
}) {
  const scene = useContext(SceneContext)
  const themeContext = useContext(ThemeContext)
  const tier = scene?.quality?.tier ?? 'high'
  const reduced = Boolean(scene?.reducedMotion)
  const theme = resolveTheme(themeProp, themeContext)
  const stageKey = STAGES.includes(stage) ? stage : 'hero'
  scene?.claimReady?.()

  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)
  const dpr = useThree((state) => state.viewport.dpr)
  const invalidate = useThree((state) => state.invalidate)

  const city = getCity()
  const cast = useMemo(() => castCity(categories), [categories])
  const sites = useMemo(() => city.sites.map((site, k) => ({ ...site, ...cast.sites[k] })), [city, cast])
  const hqs = useMemo(() => city.hqs.map((hq) => ({ ...hq, ...cast.hqs[hq.index] })), [city, cast])
  const settings = TIER_SETTINGS[tier] ?? TIER_SETTINGS.high

  const labels = useMemo(() => new LabelLayer(), [])
  useEffect(() => {
    labels.revive()
    return () => labels.dispose()
  }, [labels])
  useEffect(() => {
    labels.onReady = () => invalidate()
    labels.onUpdate = () => invalidate()
    return () => {
      labels.onReady = null
      labels.onUpdate = null
    }
  }, [labels, invalidate])

  /* ---- live inputs for the frame loop (no React re-render per frame) ---- */
  const live = useRef(null)
  live.current = { stage: stageKey, progress, interactive, theme, reduced, sites, hqs, framing, size, dpr, openingAt }
  useEffect(() => {
    runtime.current.mountedAt = performance.now()
  }, [])

  /*
   * The rendered bundle: { world, pipeline, settings, tier } - null until the first one is primed (the still stays
   * on screen meanwhile). Built for the current tier on mount and again when the tier changes.
   */
  const [bundle, setBundle] = useState(null)
  const bundleRef = useRef(null)
  bundleRef.current = bundle

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    let world = null
    let pipeline = null
    let adopted = false
    const build = async () => {
      world = await (takePreparedWorld(settings) ?? buildWorldSliced(settings, signal))
      if (signal.aborted) return
      const input = live.current
      applyCast(world, input.sites, input.hqs)
      pipeline = createPostPipeline({ gl, scene: world.scene, camera, settings, bloom: BLOOM[tier] ?? BLOOM.high })
      pipeline.setSize(input.size.width, input.size.height, input.dpr)
      // Frame the stage, so the priming draws see what the first frames will see.
      const aspect = input.size.width / Math.max(input.size.height, 1)
      applyRig(camera, frameRig(input.stage, aspect, input.framing, createRig()), null)
      const { lightMap } = world
      await primeScene({
        gl,
        camera,
        signal,
        groups: [{ objects: world.root.children, target: pipeline.sceneTarget, samples: pipeline.samples }],
        pipeline,
        bakes: [
          {
            scene: lightMap.scene,
            camera: lightMap.camera,
            target: lightMap.target,
            bake: () => world.bake(gl),
            done: () => lightMap.isBaked(gl),
          },
        ],
        labels,
        labelSpecs: signsOf(input.sites, input.hqs),
      })
      if (signal.aborted) return
      world.bake(gl)
      adopted = true
      setBundle({ world, pipeline, settings, tier })
    }
    build().catch((error) => {
      if (isCancelled(error) || signal.aborted || !world || !pipeline) return
      // Priming is best effort: render anyway (the first frames then do the remaining work).
      world.bake(gl)
      adopted = true
      setBundle({ world, pipeline, settings, tier })
    })
    return () => {
      controller.abort()
      if (adopted) return
      pipeline?.dispose()
      world?.dispose()
    }
  }, [gl, camera, labels, settings, tier])

  // A replaced or unmounted bundle releases its GPU resources.
  useEffect(() => {
    if (!bundle) return undefined
    return () => {
      bundle.pipeline.dispose()
      bundle.world.dispose()
    }
  }, [bundle])

  // Arcs and HQ colours follow the cast (real department names / colours).
  useEffect(() => {
    if (!bundle) return
    applyCast(bundle.world, sites, hqs)
    invalidate()
  }, [bundle, sites, hqs, invalidate])

  const runtime = useRef(null)
  if (!runtime.current) {
    // A candidate only: the first real frame decides between the flight and the settle (see `update`).
    const intro = !reduced && stageKey === 'hero' && !introPlayed()
    const rig = createRig(intro ? RIGS.aerial : RIGS[stageKey])
    if (!intro && !reduced) {
      // Later visits: a 1 s settle into the composition.
      rig.dist *= 1.12
      rig.el += 3.5
    }
    runtime.current = {
      time: 0,
      heroTime: 0,
      stageTime: 0,
      stage: stageKey,
      intro,
      introPending: stageKey === 'hero',
      introTime: 0,
      introStart: 0,
      introHold: false,
      introQuiet: 0,
      introSeconds: OPENING.flight,
      mountedAt: 0,
      fogScale: stageKey === 'calm' && theme !== 'dark' ? CALM_DAWN_FOG : 1,
      rig,
      aerial: createRig(RIGS.aerial),
      target: createRig(RIGS[stageKey]),
      frame: createFrameState(city.sites.length, city.hqs.length),
      visual: createFrameState(city.sites.length, city.hqs.length),
      night: theme === 'dark' ? 1 : 0,
      pointer: { x: 0, y: 0, sx: 0, sy: 0, px: -1e4, py: -1e4 },
      hover: -1,
      hoverAmt: new Array(city.sites.length).fill(0),
    }
  }

  // Pointer parallax + hover (fine pointers, not reduced motion). Window-level: the canvas never takes events.
  useEffect(() => {
    if (!interactive || reduced) return undefined
    if (!window.matchMedia?.('(pointer: fine)').matches) return undefined
    const canvas = gl.domElement
    const pointer = runtime.current.pointer
    const onMove = (event) => {
      const rect = canvas.getBoundingClientRect()
      const inside =
        event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
      pointer.x = MathUtils.clamp(((event.clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1, -1, 1)
      pointer.y = MathUtils.clamp(((event.clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1, -1, 1)
      const overControl = event.target?.closest?.('a, button, input, select, textarea, [role="button"], [role="link"]')
      pointer.px = inside && !overControl ? event.clientX - rect.left : -1e4
      pointer.py = inside && !overControl ? event.clientY - rect.top : -1e4
    }
    const onLeave = () => {
      pointer.x = 0
      pointer.y = 0
      pointer.px = -1e4
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
      onLeave()
    }
  }, [interactive, reduced, gl])

  // Demand mode (reduced motion): re-render the still when an input changes.
  useEffect(() => {
    invalidate()
  }, [stageKey, theme, progress, framing, sites, invalidate])

  const update = (delta) => {
    const current = bundleRef.current
    if (!current) return
    const rt = runtime.current
    const input = live.current
    const { world, pipeline } = current
    const { shared, materials, meshes, attributes } = world
    const dt = Math.min(Math.max(delta, 0), 0.1)
    const still = input.reduced

    /* ---- the opening, decided on this first real frame: the flight (shorter when late) or the settle ---- */
    if (rt.introPending) {
      rt.introPending = false
      const now = performance.now()
      const origin = typeof input.openingAt === 'function' ? input.openingAt() : input.openingAt
      const openedAt = Number.isFinite(origin) && origin > 0 ? origin : rt.mountedAt
      const seconds = rt.intro && input.stage === 'hero' && !introPlayed() ? flightFor(openedAt, now) : 0
      if (seconds > 0) {
        // The flight's clock starts once frames arrive on time (see the clocks below).
        rt.introSeconds = seconds
        rt.introHold = true
        rt.introQuiet = 0
        rt.introStart = now
        markOpening(gl.domElement, 'flight')
      } else {
        if (rt.intro) {
          // Too late for a flight within the opening's budget (or the page has settled it): settle in instead.
          rt.intro = false
          markIntroPlayed()
          frameRig(input.stage, input.size.width / Math.max(input.size.height, 1), input.framing, rt.rig)
          rt.rig.dist *= 1.12
          rt.rig.el += 3.5
        }
        markOpening(gl.domElement, 'settle')
      }
    }

    /* ---- clocks ---- */
    if (input.stage !== rt.stage) {
      rt.stage = input.stage
      rt.stageTime = 0
      if (rt.intro) {
        rt.intro = false
        markOpening(gl.domElement, 'done')
      }
    }
    if (!still) {
      rt.time += dt
      rt.stageTime += dt
      if (rt.intro && rt.introHold) {
        // Hold the aerial pose (lamps still off) until three frames in a row arrive on time, at most OPENING.hold:
        // the page's own entrance raster or a late GPU job then never makes the flight skip in its first second.
        const now = performance.now()
        rt.introQuiet = delta > 0 && delta <= 0.025 ? rt.introQuiet + 1 : 0
        const held = (now - rt.introStart) / 1000
        if (rt.introQuiet >= 3 || held >= OPENING.hold) {
          rt.introHold = false
          rt.introSeconds = Math.max(OPENING.minFlight, rt.introSeconds - held)
          rt.introStart = now
        }
        rt.introTime = 0
      } else if (rt.intro) {
        // Wall-clock time: slow start-up frames never stretch the opening past its budget.
        rt.introTime = Math.min((performance.now() - rt.introStart) / 1000, rt.introSeconds)
        if (rt.introTime >= rt.introSeconds) {
          rt.intro = false
          markIntroPlayed()
          markOpening(gl.domElement, 'done')
        }
      } else if (rt.stage === 'hero') {
        rt.heroTime += dt
      }
    }

    /* ---- theme blend (night <-> dawn) ---- */
    const nightTarget = input.theme === 'dark' ? 1 : 0
    // eased, except under the theme's circular reveal (the new snapshot must already hold the new palette)
    const snapTheme = still || themeRevealing()
    rt.night = snapTheme ? nightTarget : rt.night + (nightTarget - rt.night) * (1 - Math.exp(-dt * 2.4))
    const n = rt.night
    const lerpColor = (uniform, key) => uniform.value.copy(DAWN_LINEAR[key]).lerp(NIGHT_LINEAR[key], n)
    const mix = (key) => MathUtils.lerp(SCALARS.dawn[key], SCALARS.night[key], n)
    const { common, fog, scan, lamps, light } = shared
    common.uNight.value = n
    common.uTime.value = rt.time % 3600
    lerpColor(fog.uFogColor, 'fogColor')
    lerpColor(fog.uFogHorizon, 'fogHorizon')
    lerpColor(fog.uMistColor, 'mistColor')
    // The calm stage (auth pages) is a low, close view: thinner haze at dawn keeps the panel from turning milky.
    const fogScale = rt.stage === 'calm' ? MathUtils.lerp(CALM_DAWN_FOG, 1, n) : 1
    rt.fogScale = snapTheme ? fogScale : rt.fogScale + (fogScale - rt.fogScale) * (1 - Math.exp(-dt * 2.4))
    fog.uFogDensity.value = mix('fogDensity') * rt.fogScale
    fog.uFogFalloff.value = mix('fogFalloff')
    fog.uMist.value = mix('mist') * rt.fogScale
    lerpColor(light.uAmbSky, 'ambSky')
    lerpColor(light.uAmbGround, 'ambGround')
    lerpColor(light.uKeyColor, 'keyColor')
    light.uKeyDir.value.copy(KEY_DAWN).lerp(KEY_NIGHT, n).normalize()
    lerpColor(light.uStreetGlow, 'streetGlow').multiplyScalar(mix('streetGlow'))
    lerpColor(light.uSkyRefl, 'skyRefl')
    lerpColor(light.uGlass, 'glass')
    light.uWindowPower.value = mix('windowPower')
    light.uLitWindows.value = mix('litWindows')
    lerpColor(scan.uScanColor, 'scan')
    lamps.uLampsOn.value = mix('lampsOn')
    const lampPower = mix('lampPower')
    lamps.uLampPower.value = lampPower
    lamps.uSodium.value.copy(SODIUM).multiplyScalar(5.2 * lampPower)
    lamps.uLed.value.copy(LED).multiplyScalar(2.5 * lampPower)
    const sky = materials.sky.uniforms
    lerpColor(sky.uZenith, 'zenith')
    lerpColor(sky.uMid, 'mid')
    lerpColor(sky.uHorizon, 'horizon')
    lerpColor(sky.uHaze, 'haze')
    sky.uCloud.value = mix('cloud')
    const groundU = materials.ground.uniforms
    lerpColor(groundU.uAsphalt, 'asphalt')
    lerpColor(groundU.uWalk, 'walk')
    lerpColor(groundU.uKerb, 'kerb')
    lerpColor(groundU.uGrass, 'grass')
    lerpColor(groundU.uPlazaCol, 'plaza')
    lerpColor(groundU.uLotCol, 'lot')
    groundU.uWet.value = mix('wet')
    if (materials.streak) materials.streak.uniforms.uWetAmount.value = mix('wet')
    groundU.uMarkGlow.value = mix('markGlow')
    // Marker blending: additive at night, premultiplied "over" at dawn (per world: a swapped-in world starts at night).
    const nightBlend = n > 0.5
    if (nightBlend !== (world.blendNight ?? true)) {
      world.blendNight = nightBlend
      ;[materials.ring, materials.beam, materials.beamGhost, materials.arc].forEach((material) => setMarkerBlending(material, nightBlend))
    }

    /* ---- post grade ---- */
    if (pipeline) {
      const grade = pipeline.grade.uniforms
      grade.uTime.value = still ? 0.37 : rt.time
      grade.uExposure.value = mix('exposure')
      grade.uContrast.value = mix('contrast')
      grade.uSaturation.value = mix('saturation')
      grade.uVignette.value = mix('vignette')
      grade.uVignetteCenter.value.set(0.5 + rt.rig.sx * 0.42, 0.5 + rt.rig.sy * 0.3)
      grade.uShadowTint.value.setRGB(...GRADE.dawn.shadow).lerp(_tint.setRGB(...GRADE.night.shadow), n)
      grade.uHighlightTint.value.setRGB(...GRADE.dawn.highlight).lerp(_tint.setRGB(...GRADE.night.highlight), n)
      grade.uVignetteColor.value.setRGB(...GRADE.dawn.vignette).lerp(_tint.setRGB(...GRADE.night.vignette), n)
      const nearTarget = current.settings.defocus ? (rt.stage === 'hero' || rt.stage === 'calm' ? 1 : 0.55) : 0
      rt.near = (rt.near ?? nearTarget) + (nearTarget - (rt.near ?? nearTarget)) * (still ? 1 : 1 - Math.exp(-dt * 1.6))
      grade.uNearBlur.value = rt.intro ? rt.near * MathUtils.smoothstep(rt.introTime / rt.introSeconds, 0.6, 1) : rt.near
      if (pipeline.bloomPass) {
        const bloom = BLOOM[current.tier] ?? BLOOM.high
        pipeline.bloomPass.strength = bloom.strength * mix('bloom')
        pipeline.bloomPass.threshold = MathUtils.lerp(1.5, bloom.threshold, n)
      }
    }

    /* ---- choreography ---- */
    const stageNow = rt.stage
    const scrub = readProgress(input.progress)
    let u = scrub ?? 0
    if (stageNow !== 'hero' && stageNow !== 'calm') {
      if (still) u = STILL_PROGRESS[stageNow] ?? 1
      else if (scrub === undefined) u = MathUtils.clamp(rt.stageTime / (STAGE_DURATION[stageNow] ?? 3), 0, 1)
    }
    const t = stageNow === 'hero' ? (still ? HERO_POSTER_TIME : rt.heroTime) : still ? 6 : rt.time
    stageState(rt.frame, stageNow, { t, u, sites: input.sites })
    if (stageNow === 'hero' && rt.intro) {
      rt.frame.scanAmp = 0
      rt.frame.sites.forEach((s) => {
        s.alpha = 0
      })
    }

    // Ease the visuals towards the frame state, so a stage switch never pops.
    const k = still ? 1 : 1 - Math.exp(-dt * 9)
    const target = rt.frame
    const visual = rt.visual
    visual.scanAmp += (target.scanAmp - visual.scanAmp) * k
    visual.scanPos = target.scanPos
    visual.sites.forEach((s, i) => {
      const f = target.sites[i]
      for (const key in f) s[key] += (f[key] - s[key]) * k
      // A new hero cycle restarts its arcs from the issue, not by rewinding them.
      if (f.arcDraw < s.arcDraw - 0.5) s.arcDraw = f.arcDraw
    })
    for (let i = 0; i < visual.hqFlare.length; i += 1) {
      visual.hqFlare[i] += (target.hqFlare[i] - visual.hqFlare[i]) * k
      visual.hqLabel[i] += (target.hqLabel[i] - visual.hqLabel[i]) * k
    }
    visual.pin.alpha += (target.pin.alpha - visual.pin.alpha) * k
    visual.pin.drop = target.pin.drop
    visual.pin.land = target.pin.land

    /* ---- lamps switch on in a wave from the centre (establishing shot) ---- */
    lamps.uWaveRadius.value = rt.intro ? Math.max(0, rt.introTime / rt.introSeconds - 0.1) * 480 : 2000

    /* ---- scan ---- */
    scan.uScanPos.value = visual.scanPos
    scan.uScanAmp.value = visual.scanAmp
    meshes.curtain.position.x = visual.scanPos
    meshes.curtain.visible = visual.scanAmp > 0.01

    /* ---- camera ---- */
    const aspect = input.size.width / Math.max(input.size.height, 1)
    frameRig(stageNow, aspect, input.framing, rt.target)
    if (stageNow === 'hero' && scrub !== undefined) {
      rt.target.el += scrub * 16
      rt.target.dist *= 1 + scrub * 0.22
      rt.target.ty += scrub * 10
    }
    // calm: a slow sway either side of the view down the resolved issue's street and a slow breath in and out (an
    // orbit, or a wider sway, would put the roofs between the camera and the issue)
    if (stageNow === 'calm' && !still) {
      rt.target.az += Math.sin(rt.time * 0.09) * 4
      rt.target.dist *= 1 + Math.sin(rt.time * 0.061 + 1.3) * 0.05
    }
    if (rt.intro) {
      frameRig('aerial', aspect, 'center', rt.aerial)
      establishing(rt.introTime / rt.introSeconds, rt.aerial, rt.target, rt.rig)
    } else if (still) {
      copyRig(rt.target, rt.rig)
    } else {
      dampRig(rt.rig, rt.target, dt, 2.6)
    }
    const p = rt.pointer
    const parallax = input.interactive && !still
    p.sx += ((parallax ? p.x : 0) - p.sx) * (1 - Math.exp(-dt * 2.2))
    p.sy += ((parallax ? p.y : 0) - p.sy) * (1 - Math.exp(-dt * 2.2))
    const idle = still
      ? null
      : {
          az: wobble(rt.time * 0.12, 1) * 1.6 + p.sx * 2.4,
          el: wobble(rt.time * 0.1, 2) * 0.9 - p.sy * 1.3,
          distScale: 1 + wobble(rt.time * 0.07, 3) * 0.014,
          roll: wobble(rt.time * 0.9, 4) * 0.035,
          pitch: wobble(rt.time * 1.1, 5) * 0.03,
        }
    applyRig(camera, rt.rig, idle)

    /* ---- markers ---- */
    const { ringState, ringColor, beamState, beamColor, beamResolve, glowColor, glowParams } = attributes
    const arcU = materials.arc.uniforms
    arcU.uArcWidth.value = MathUtils.lerp(1.1, 0.55, n)
    input.sites.forEach((site, i) => {
      const s = visual.sites[i]
      rt.hoverAmt[i] += ((rt.hover === i ? 1 : 0) - rt.hoverAmt[i]) * (still ? 1 : 1 - Math.exp(-dt * 10))
      const hover = rt.hoverAmt[i]
      _color.set(s.report > s.detect ? MARKING_YELLOW : site.severityColor)
      ringColor.setXYZ(i, _color.r, _color.g, _color.b)
      beamColor.setXYZ(i, _color.r, _color.g, _color.b)
      ringState.setXYZW(i, Math.max(s.detect, s.report), s.resolve, hover, s.alpha)
      // dawn draws beams as inked ribbons, a little wider than the night's light pillars
      const width = MathUtils.lerp(4.2, 8.5, s.column) * MathUtils.lerp(1.15, 1, n)
      beamState.setXYZW(i, s.height * (1 + hover * 0.06), width, s.alpha * Math.min(1, s.detect * 1.4), hover * 0.8)
      beamResolve.setXY(i, s.resolve, s.column)
      arcU.uArcDraw.value[i] = s.arcDraw
      arcU.uArcAlpha.value[i] = s.arcDraw > 0.001 ? s.arcAlpha : 0
      // The packet rides the head of the arc.
      const curve = world.arcCurves[i]
      if (curve) arcPoint(curve, MathUtils.clamp(s.arcDraw, 0, 1), _v)
      else _v.set(site.x, 2, site.z)
      meshes.glows.setMatrixAt(i, _m4.makeTranslation(_v.x, _v.y, _v.z))
      const hq = input.hqs.find((h) => h.index === site.hq)
      _color.set(hq?.color ?? '#ffffff').lerp(_white, 0.45)
      glowColor.setXYZ(i, _color.r * 2.2, _color.g * 2.2, _color.b * 2.2)
      glowParams.setXY(i, 1.25, s.packet * s.arcAlpha * 1.4)
    })
    const siteCount = input.sites.length
    input.hqs.forEach((hq, j) => {
      const flare = visual.hqFlare[hq.index] ?? 0
      materials.building.uniforms.uHQGlow.value[hq.index] = flare
      const idx = siteCount + j
      meshes.glows.setMatrixAt(idx, _m4.makeTranslation(hq.x, hq.top + 1.4, hq.z))
      _color.set(hq.color)
      const pulse = still ? 1 : 0.82 + 0.18 * Math.sin(rt.time * 2.1 + j * 1.3)
      glowColor.setXYZ(idx, _color.r * 3, _color.g * 3, _color.b * 3)
      glowParams.setXY(idx, 2.2 + flare * 1.6, (0.55 + flare * 2.4) * pulse * MathUtils.lerp(0.6, 1, n))
    })

    /* ---- report pin: falls, squashes on landing, one small bounce ---- */
    const pinned = input.sites[PINNED_SITE]
    const pinAlpha = visual.pin.alpha
    const showPin = pinAlpha > 0.01
    meshes.pin.visible = showPin
    meshes.pinShadow.visible = showPin
    const drop = visual.pin.drop
    const land = visual.pin.land
    const pinY = (1 - drop * drop) * 26 + Math.sin(land * Math.PI) * 1.4
    const squash = 1 - 0.16 * Math.max(0, 1 - Math.abs(land - 0.04) * 12) * (drop >= 1 ? 1 : 0)
    meshes.pin.position.set(pinned.x, pinY + 0.05, pinned.z)
    meshes.pin.scale.set(1 / Math.sqrt(squash), squash, 1 / Math.sqrt(squash)).multiplyScalar(0.95)
    materials.pin.uniforms.uAlpha.value = Math.min(1, pinAlpha)
    meshes.pinShadow.position.set(pinned.x, 0.08, pinned.z)
    const shadowSize = MathUtils.lerp(6.5, 2.8, drop)
    meshes.pinShadow.scale.set(shadowSize, 1, shadowSize)
    materials.shadow.uniforms.uAlpha.value = pinAlpha * MathUtils.lerp(0.1, 0.5, drop)
    const pinGlow = siteCount + input.hqs.length
    meshes.glows.setMatrixAt(pinGlow, _m4.makeTranslation(pinned.x, pinY + 3.1, pinned.z))
    glowColor.setXYZ(pinGlow, 2.4, 1.7, 0.3)
    glowParams.setXY(pinGlow, 2.6, showPin ? pinAlpha * 0.55 * n : 0)
    // beacon caps on top of the issue beams (the sign label hangs just above)
    const capBase = pinGlow + 1
    input.sites.forEach((site, i) => {
      const s = visual.sites[i]
      const hover = rt.hoverAmt[i]
      meshes.glows.setMatrixAt(capBase + i, _m4.makeTranslation(site.x, Math.max(s.height, 1) * (1 + hover * 0.06), site.z))
      _color.set(site.severityColor).lerp(_resolved, s.resolve).lerp(_white, 0.22)
      glowColor.setXYZ(capBase + i, _color.r * 2.8, _color.g * 2.8, _color.b * 2.8)
      glowParams.setXY(capBase + i, 1.5 + s.column * 0.8, s.alpha * Math.min(1, s.detect * 1.4) * (0.9 + hover * 0.9))
    })

    ringState.needsUpdate = true
    ringColor.needsUpdate = true
    beamState.needsUpdate = true
    beamColor.needsUpdate = true
    beamResolve.needsUpdate = true
    glowColor.needsUpdate = true
    glowParams.needsUpdate = true
    meshes.glows.instanceMatrix.needsUpdate = true

    /* ---- particles, glow sizing ---- */
    const pixel = (2 * Math.tan(MathUtils.degToRad(camera.fov) / 2)) / Math.max(input.size.height, 1)
    materials.glow.uniforms.uPixel.value = pixel
    materials.lampGlow.uniforms.uPixel.value = pixel
    if (materials.particles) {
      // the drizzle volume sits in front of the lens, where streaks are big enough to read
      _v.set(rt.rig.tx - camera.position.x, 0, rt.rig.tz - camera.position.z).normalize()
      materials.particles.uniforms.uCenter.value.set(
        camera.position.x + _v.x * 110,
        Math.max(24, camera.position.y - 30),
        camera.position.z + _v.z * 110,
      )
      materials.particles.uniforms.uPixelRatio.value = gl.getPixelRatio()
      materials.particles.uniforms.uViewport.value = input.size.height
    }

    /* ---- hover: screen-space distance to each visible marker ---- */
    rt.hover = -1
    if (input.interactive && !still && p.px > -1e3) {
      // Distance from the pointer to each beam (base to cap) in screen space; the cap gets a generous radius.
      let best = 22
      const toScreen = (x, y, z) => {
        _project.set(x, y, z).project(camera)
        return [(_project.x * 0.5 + 0.5) * input.size.width, (-_project.y * 0.5 + 0.5) * input.size.height]
      }
      input.sites.forEach((site, i) => {
        const s = visual.sites[i]
        if (s.alpha < 0.3 || s.detect < 0.5) return
        const [ax, ay] = toScreen(site.x, 0, site.z)
        const [bx, by] = toScreen(site.x, Math.max(s.height, 2), site.z)
        const vx = bx - ax
        const vy = by - ay
        const t = MathUtils.clamp(((p.px - ax) * vx + (p.py - ay) * vy) / Math.max(vx * vx + vy * vy, 1), 0, 1)
        const d = Math.min(Math.hypot(ax + vx * t - p.px, ay + vy * t - p.py), Math.hypot(bx - p.px, by - p.py) - 14)
        if (d < best) {
          best = d
          rt.hover = i
        }
      })
    }

    /* ---- sign labels ---- */
    const perPixel = (anchor) => camera.position.distanceTo(anchor) * pixel
    const labelScale = MathUtils.clamp(input.size.height / 860, 0.82, 1.16) * (input.size.width < 640 ? 0.9 : 1)
    const pop = (o) => labelScale * (0.88 + 0.12 * Math.min(1, o * 1.15))
    // A visible sign is kept inside the frame (shifted sideways, or down from the top edge), never clipped.
    const inView = (sprite, o, size) => (o > 0.01 ? labels.keepInView(sprite, _v.copy(_anchor), camera, input.size, size) : _anchor)
    input.sites.forEach((site, i) => {
      const s = visual.sites[i]
      const hover = rt.hoverAmt[i]
      _anchor.set(site.x, Math.max(s.height, 6) + 2.4, site.z)
      const wpp = perPixel(_anchor)
      const resolvedOpacity = Math.max(s.labelResolve, hover * s.alpha * s.resolve)
      const detectOpacity = Math.max(s.labelDetect, hover * s.alpha * (1 - s.resolve)) * (1 - resolvedOpacity)
      const detect = labels.slot(`d${i}`, { text: site.label, glyph: 'dot', glyphColor: site.severityColor })
      labels.place(detect, inView(detect, detectOpacity, pop(detectOpacity)), detectOpacity, wpp, pop(detectOpacity))
      const resolved = labels.slot(`r${i}`, { text: GENERIC_LABELS.resolved, glyph: 'check' })
      labels.place(resolved, inView(resolved, resolvedOpacity, pop(resolvedOpacity)), resolvedOpacity, wpp, pop(resolvedOpacity))
      if (i === PINNED_SITE) {
        _anchor.set(site.x, 7.8, site.z)
        const report = labels.slot('report', { text: GENERIC_LABELS.report, glyph: 'pin', glyphColor: MARKING_YELLOW })
        const o = s.labelReport * Math.min(1, pinAlpha)
        labels.place(report, inView(report, o, pop(s.labelReport)), o, perPixel(_anchor), pop(s.labelReport))
      }
    })
    input.hqs.forEach((hq) => {
      const o = visual.hqLabel[hq.index] ?? 0
      _anchor.set(hq.x, hq.top + 6, hq.z)
      const sprite = labels.slot(`h${hq.index}`, { text: hq.name ?? GENERIC_LABELS.department, glyph: 'hq', glyphColor: hq.color })
      labels.place(sprite, inView(sprite, o, pop(o)), o, perPixel(_anchor), pop(o))
    })
  }

  usePostPipeline({
    pipeline: bundle?.pipeline ?? null,
    overlay: labels.scene,
    enabled: Boolean(bundle),
    onBeforeRender: update,
    onAfterFirstRender: () => requestAnimationFrame(() => scene?.markReady?.()),
  })
  useEffect(() => {
    if (bundle) invalidate()
  }, [bundle, invalidate])

  // The district renders through its own scene (bundle.world.scene) in the post chain: nothing for R3F to mount.
  return null
}

/**
 * Called by SceneCanvas (through lazyScenes) before the canvas mounts: builds the district for this tier in idle
 * slices, so mounting the scene costs no main-thread time for it. Resolves when the world is built.
 */
CityScene.prepare = (props, { quality } = {}) => prepareWorld(TIER_SETTINGS[quality?.tier] ?? TIER_SETTINGS.high)
