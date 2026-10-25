/**
 * PulseScene - the admin "City pulse": real hotspot clusters (GET /api/analytics/hotspots/ `clusters`) as hexagonal
 * columns on a stylised district plane. Rendered by CityPulse3D inside SceneCanvas (loaded lazily, imports three).
 *
 * - Positions: latitude / longitude projected to local metres around the clusters' centre with the cos(latitude)
 *   correction, then fitted to the plane. Height is proportional to the complaint count; colour is the cluster's
 *   severity level colour (LEVEL_META). Nothing is invented: no data, no column.
 * - The three largest clusters carry a sign label with their area name; the hovered / focused one (pointer here, or
 *   the accessible list in CityPulse3D) is highlighted and labelled too, drawn on top of the others.
 * - Sign plates are laid out in screen space every frame: each plate tries a few spots above its column (on a short
 *   leader post when it has to move) and takes the one that covers no other plate, no column and not the caption
 *   chip; the active plate is placed first, a permanent plate with no free spot steps aside (fades out). On narrow
 *   canvases (phones) only the active column carries a plate - the caption chip already names the featured one.
 * - Camera: a high three-quarter view whose azimuth is chosen from the data, so that no column - above all the
 *   higher-severity ones - hides behind a taller neighbour anywhere along the slow orbit.
 * - Same post-processing and grade as the city at a lighter setting. Reduced motion: one still frame.
 * - Start-up: the primer (city/prime.js) compiles, links, uploads and draws everything once in small steps behind
 *   fences before the first frame, so the dashboard never gets a long task from the scene.
 *
 * Props: items [{ x, z (fitted plane units), height, color, label, key }], active (index | null),
 * onHover(index | null), onSelect(index), theme ('dark' | 'light', optional override).
 */
import { useThree } from '@react-three/fiber'
import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import {
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  MathUtils,
  Matrix4,
  Mesh,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three'
import { ThemeContext } from '@/context/contexts'
import { isCancelled } from '../gpuTasks'
import { createGlowMaterial, createRingMaterial, createSharedUniforms, setMarkerBlending } from '../city/materials'
import { LabelLayer } from '../city/labels'
import { createPostPipeline, usePostPipeline } from '../city/post'
import { primeScene } from '../city/prime'
import { applyRig, rigProjector, wobble } from '../city/rig'
import { SIGN_GREEN } from '../city/cast'
import { SIGN_MARGIN } from '../city/labels'
import { SceneContext } from '../sceneContext'
import { themeRevealing } from '../themeReveal'

const PULSE_SETTINGS = Object.freeze({
  high: Object.freeze({ msaa: 4, bloom: true, bloomScale: 0.5, grain: false, aberration: false }),
  medium: Object.freeze({ msaa: 0, bloom: true, bloomScale: 0.5, grain: false, aberration: false }),
  low: Object.freeze({ msaa: 0, bloom: false, bloomScale: 0.5, grain: false, aberration: false }),
})
const BLOOM = Object.freeze({ strength: 0.42, radius: 0.5, threshold: 0.98 })
const HEX_RADIUS = 4.4
const FOV = 30
const ELEVATION = 50
/** Slow orbit either side of the chosen azimuth (degrees). */
const SWAY = 9
/** Occlusion weight per severity level: hiding one higher-level column costs more than hiding all lower ones. */
const LEVEL_WEIGHT = Object.freeze({ critical: 4096, high: 512, medium: 64, low: 8 })
const LEVEL_RANK = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 })
/** Below this canvas width only the active column carries a plate. */
const NARROW = 480
/**
 * The HTML caption chip over the bottom-left corner (CityPulse3D figcaption), inset included: plates and columns
 * keep clear of it. Narrow canvases (below NARROW, the chip's own container breakpoint) get the one-line chip.
 */
const CAPTION = Object.freeze({ width: 280, height: 68 })
const CAPTION_COMPACT = Object.freeze({ width: 250, height: 40 })
const captionFor = (width) => (width < NARROW ? CAPTION_COMPACT : CAPTION)
const SAFE = 8
/**
 * Plate spots tried around a column's top, best first: [kind, leader px]. kind 0: centred above; -1 / 1: shifted
 * left / right so the post meets the plate near its end; -2 / 2: beside the column top.
 */
const SPOTS = Object.freeze([
  [0, 8], [0, 22], [-1, 12], [1, 12], [0, 38], [-1, 28], [1, 28], [-2, 0], [2, 0], [0, 56], [-1, 46], [1, 46], [0, 76],
])

const _m = new Matrix4()
const _q = new Quaternion()
const _p = new Vector3()
const _s = new Vector3()
const _c = new Color()
const _c2 = new Color()
const _anchor = new Vector3()
const _ndc = new Vector3()
const _right = new Vector3()

/** Camera rig of the pulse for an azimuth: a long lens, high three-quarter view, every column in frame. */
function pulseRig(extent, tallest, aspect, az, out) {
  const tan = Math.tan(MathUtils.degToRad(FOV / 2))
  const el = MathUtils.degToRad(ELEVATION)
  const fitW = (extent * 2.2) / (2 * tan * Math.max(aspect, 0.6))
  const fitH = (extent * 2 * Math.sin(el) * 1.12 + tallest * Math.cos(el) + 6) / (2 * tan)
  out.tx = 0
  out.ty = tallest * 0.24
  out.tz = 0
  out.dist = Math.max(fitW, fitH, 60)
  out.az = az
  out.el = ELEVATION
  out.fov = FOV
  out.sx = 0
  out.sy = -0.03
  return out
}

const overlapArea = (a, b) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))

/** Severity-weighted share of each column (and of its top, where the colour reads) hidden by nearer columns. */
function occlusionScore(items, rig, aspect) {
  const project = rigProjector(rig, aspect)
  const tan = Math.tan(MathUtils.degToRad(rig.fov / 2))
  const sinEl = Math.sin(MathUtils.degToRad(rig.el))
  const rects = items.map((item) => {
    const base = project.project(item.x, 0, item.z)
    const top = project.project(item.x, Math.max(item.height, 0.4), item.z)
    if (!base || !top) return null
    const hw = HEX_RADIUS / (base.depth * tan * Math.max(aspect, 0.01))
    const cap = (HEX_RADIUS * sinEl) / (top.depth * tan)
    return {
      x0: Math.min(base.x, top.x) - hw,
      x1: Math.max(base.x, top.x) + hw,
      y0: Math.min(base.y, top.y) - cap,
      y1: Math.max(base.y, top.y) + cap,
      depth: base.depth,
    }
  })
  let score = 0
  rects.forEach((r, i) => {
    if (!r) return
    const area = Math.max((r.x1 - r.x0) * (r.y1 - r.y0), 1e-9)
    const head = { x0: r.x0, x1: r.x1, y0: r.y1 - (r.y1 - r.y0) * 0.35, y1: r.y1 }
    const headArea = Math.max((head.x1 - head.x0) * (head.y1 - head.y0), 1e-9)
    let hidden = 0
    let headHidden = 0
    rects.forEach((o, j) => {
      if (j === i || !o || o.depth >= r.depth) return
      hidden += overlapArea(r, o) / area
      headHidden += overlapArea(head, o) / headArea
    })
    score += (LEVEL_WEIGHT[items[i].level] ?? 1) * (0.4 * Math.min(1, hidden) + 0.6 * Math.min(1, headHidden))
  })
  return score
}

/** The azimuth (roughly north-up, within 90 degrees) whose whole orbit keeps the important columns in view. */
function chooseAzimuth(items, extent, tallest, aspect) {
  const rig = {}
  let best = 24
  let bestScore = Infinity
  for (let az = -66; az <= 114; az += 6) {
    let worst = 0
    for (const offset of [-SWAY, 0, SWAY]) {
      worst = Math.max(worst, occlusionScore(items, pulseRig(extent, tallest, aspect, az + offset, rig), aspect))
    }
    const score = worst + Math.abs(az - 24) * 0.002
    if (score < bestScore) {
      bestScore = score
      best = az
    }
  }
  return best
}

/**
 * Distance and lens shift that fit every column, over the whole orbit, into the frame: room for plates above the
 * tallest tops and for the caption chip under the lowest bases. Narrow canvases (phones, a small 4:3 frame) have the
 * one-line chip and carry a single plate, so the columns get more of the frame (and a little more of its width).
 */
function frameView(items, extent, tallest, aspect, height, az) {
  const rig = pulseRig(extent, tallest, aspect, az, {})
  const tan = Math.tan(MathUtils.degToRad(FOV / 2))
  const sinEl = Math.sin(MathUtils.degToRad(ELEVATION))
  const narrow = aspect * height < NARROW
  // NDC band for the columns: the caption chip's band stays free at the bottom, a plate's height at the top
  const chipBand = captionFor(aspect * height).height + 4
  const bottom = MathUtils.clamp(-1 + (2 * chipBand) / Math.max(height, 1), -0.86, -0.3)
  const top = MathUtils.clamp(1 - (narrow ? 64 : 88) / Math.max(height, 1), 0.5, 0.8)
  const fill = narrow ? 1.84 : 1.72
  for (let pass = 0; pass < 3; pass += 1) {
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const offset of [-SWAY, 0, SWAY]) {
      const project = rigProjector({ ...rig, az: az + offset, sx: 0, sy: 0 }, aspect)
      items.forEach((item) => {
        for (const y of [0, Math.max(item.height, 0.4)]) {
          const q = project.project(item.x, y, item.z)
          if (!q) continue
          const rx = HEX_RADIUS / (q.depth * tan * aspect)
          const ry = (HEX_RADIUS * sinEl) / (q.depth * tan)
          x0 = Math.min(x0, q.x - rx)
          x1 = Math.max(x1, q.x + rx)
          y0 = Math.min(y0, q.y - ry)
          y1 = Math.max(y1, q.y + ry)
        }
      })
    }
    if (!Number.isFinite(x0)) break
    const scale = Math.max((x1 - x0) / fill, (y1 - y0) / (top - bottom), 0.2)
    rig.dist = Math.max(rig.dist * scale, 40)
    rig.sx = -(x0 + x1) / 2 / scale
    rig.sy = (top + bottom) / 2 - (y0 + y1) / 2 / scale
  }
  return { az, dist: rig.dist, sx: MathUtils.clamp(rig.sx, -0.5, 0.5), sy: MathUtils.clamp(rig.sy, -0.5, 0.5) }
}

/** Screen rect (CSS px, y down) of a plate of w x h at spot [kind, gap] around the anchor (ax, ay). */
function spotRect(kind, gap, ax, ay, w, h, out) {
  let cx = ax
  let bottom = ay - gap
  if (kind === -1 || kind === 1) cx = ax + kind * (w / 2 - 12)
  else if (kind === -2 || kind === 2) {
    cx = ax + Math.sign(kind) * (w / 2 + 14)
    bottom = ay + h / 2
  }
  out.x0 = cx - w / 2
  out.x1 = cx + w / 2
  out.y0 = bottom - h
  out.y1 = bottom
  return out
}

function grow(rect, by, out) {
  out.x0 = rect.x0 - by
  out.x1 = rect.x1 + by
  out.y0 = rect.y0 - by
  out.y1 = rect.y1 + by
  return out
}

function resolveTheme(theme, context) {
  if (theme === 'dark' || theme === 'light') return theme
  if (context?.resolvedTheme) return context.resolvedTheme
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) return 'dark'
  return 'light'
}

function createGroundMaterial(shared) {
  return new ShaderMaterial({
    uniforms: {
      ...shared.common,
      ...shared.fog,
      uBase: { value: new Color('#0d1618') },
      uLine: { value: new Color('#1f3034') },
      uGlow: { value: new Color('#16292c') },
      uExtent: { value: 70 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      uniform vec3 uBase;
      uniform vec3 uLine;
      uniform vec3 uGlow;
      uniform float uExtent;
      uniform vec3 uFogColor;
      void main() {
        vec2 q = vWorld.xz;
        // a stylised street grid (not geography): fine lanes every 6 units, arterials every 30
        vec2 g = abs(fract(q / 6.0 - 0.5) - 0.5) * 6.0;
        vec2 G = abs(fract(q / 30.0 - 0.5) - 0.5) * 30.0;
        float fw = max(fwidth(q.x), fwidth(q.y));
        float lanes = 1.0 - smoothstep(0.04, 0.04 + fw * 1.5, min(g.x, g.y));
        float arterial = 1.0 - smoothstep(0.18, 0.18 + fw * 1.5, min(G.x, G.y));
        float r = length(q) / uExtent;
        vec3 c = mix(uBase, uGlow, (1.0 - smoothstep(0.0, 1.1, r)) * 0.7);
        c = mix(c, uLine, lanes * 0.45 + arterial * 0.9);
        c = mix(c, uFogColor, smoothstep(0.75, 1.6, r));
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  })
}

function createColumnMaterial(shared) {
  return new ShaderMaterial({
    uniforms: { ...shared.common, uHover: { value: -1 } },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aIndex;
      varying vec3 vColor;
      varying vec3 vNormal;
      varying float vY;
      varying float vTop;
      varying float vActive;
      uniform float uHover;
      void main() {
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vColor = aColor;
        vNormal = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        vY = position.y;
        vTop = step(0.99, position.y);
        vActive = 1.0 - step(0.5, abs(aIndex - uHover));
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      varying vec3 vNormal;
      varying float vY;
      varying float vTop;
      varying float vActive;
      uniform float uNight;
      void main() {
        vec3 n = normalize(vNormal);
        float side = 1.0 - abs(n.y);
        float light = 0.55 + 0.45 * max(dot(n, normalize(vec3(-0.4, 0.8, 0.45))), 0.0);
        // glass column: body tinted by severity, brighter towards the top, crisp emissive cap
        // Inputs kept in the tone curve's near-linear range, so the columns display in their LEVEL_META colour.
        // Dawn: brighter bodies, so marking yellow stays yellow (not ochre) on the pale ground.
        vec3 body = vColor * mix(0.46 + 0.3 * vY, 0.12 + 0.3 * vY, uNight) * light;
        vec3 cap = vColor * mix(0.9, 1.5, uNight);
        vec3 c = mix(body, cap, vTop * (1.0 - side));
        c += vColor * vActive * mix(0.16, 0.55, uNight);
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  })
}

export default function PulseScene({ items, active = null, onHover, onSelect, theme: themeProp }) {
  const sceneContext = useContext(SceneContext)
  const themeContext = useContext(ThemeContext)
  const tier = sceneContext?.quality?.tier ?? 'high'
  const reduced = Boolean(sceneContext?.reducedMotion)
  const dark = resolveTheme(themeProp, themeContext) === 'dark'
  sceneContext?.claimReady?.()

  const gl = useThree((s) => s.gl)
  const r3fScene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const dpr = useThree((s) => s.viewport.dpr)
  const invalidate = useThree((s) => s.invalidate)

  const shared = useMemo(() => createSharedUniforms(), [])
  const count = items.length

  const world = useMemo(() => {
    const root = new Group()
    const disposables = []
    const ground = new Mesh(new PlaneGeometry(1600, 1600).rotateX(-Math.PI / 2), createGroundMaterial(shared))
    disposables.push(ground.geometry, ground.material)
    root.add(ground)

    const hex = new CylinderGeometry(HEX_RADIUS, HEX_RADIUS, 1, 6, 1).translate(0, 0.5, 0)
    const columnGeometry = hex.toNonIndexed()
    columnGeometry.computeVertexNormals()
    hex.dispose()
    const columnMaterial = createColumnMaterial(shared)
    const columns = new InstancedMesh(columnGeometry, columnMaterial, Math.max(count, 1))
    const colors = new Float32Array(Math.max(count, 1) * 3)
    const index = new Float32Array(Math.max(count, 1))
    items.forEach((item, i) => {
      _m.compose(_p.set(item.x, 0, item.z), _q.identity(), _s.set(1, Math.max(item.height, 0.4), 1))
      columns.setMatrixAt(i, _m)
      _c.set(item.color)
      colors.set([_c.r, _c.g, _c.b], i * 3)
      index[i] = i
    })
    columns.count = count
    columnGeometry.setAttribute('aColor', new InstancedBufferAttribute(colors, 3))
    columnGeometry.setAttribute('aIndex', new InstancedBufferAttribute(index, 1))
    columns.computeBoundingSphere()
    disposables.push(columnGeometry, columnMaterial)

    const ringGeometry = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
    const ringMaterial = createRingMaterial(shared)
    const rings = new InstancedMesh(ringGeometry, ringMaterial, Math.max(count, 1))
    const ringState = new InstancedBufferAttribute(new Float32Array(Math.max(count, 1) * 4), 4).setUsage(DynamicDrawUsage)
    ringGeometry.setAttribute('aRing', ringState)
    ringGeometry.setAttribute('aSev', new InstancedBufferAttribute(colors.slice(), 3))
    ringGeometry.setAttribute('aSeed', new InstancedBufferAttribute(new Float32Array(items.map((_, i) => (i * 0.37) % 1)), 1))
    items.forEach((item, i) => {
      _m.compose(_p.set(item.x, 0.05, item.z), _q.identity(), _s.set(HEX_RADIUS * 4.2, 1, HEX_RADIUS * 4.2))
      rings.setMatrixAt(i, _m)
    })
    rings.count = count
    rings.frustumCulled = false
    rings.renderOrder = 2
    disposables.push(ringGeometry, ringMaterial)
    root.add(rings)

    const glowGeometry = new PlaneGeometry(1, 1)
    const glowMaterial = createGlowMaterial(shared)
    const glows = new InstancedMesh(glowGeometry, glowMaterial, Math.max(count, 1))
    const glowColor = new InstancedBufferAttribute(new Float32Array(Math.max(count, 1) * 3), 3).setUsage(DynamicDrawUsage)
    const glowParams = new InstancedBufferAttribute(new Float32Array(Math.max(count, 1) * 2), 2).setUsage(DynamicDrawUsage)
    glowGeometry.setAttribute('aGlowColor', glowColor)
    glowGeometry.setAttribute('aGlow', glowParams)
    items.forEach((item, i) => {
      glows.setMatrixAt(i, _m.makeTranslation(item.x, Math.max(item.height, 0.4) + 0.4, item.z))
    })
    glows.count = count
    glows.frustumCulled = false
    glows.renderOrder = 4
    disposables.push(glowGeometry, glowMaterial)
    root.add(glows)

    return {
      root,
      columns,
      rings,
      glows,
      materials: { ground: ground.material, column: columnMaterial, ring: ringMaterial, glow: glowMaterial },
      attributes: { ringState, glowColor, glowParams },
      dispose() {
        disposables.forEach((item) => item.dispose())
        columns.dispose()
        rings.dispose()
        glows.dispose()
      },
    }
  }, [items, count, shared])
  useEffect(() => () => world.dispose(), [world])

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

  const extent = useMemo(() => Math.max(30, ...items.map((item) => Math.hypot(item.x, item.z) + HEX_RADIUS)), [items])
  const tallest = useMemo(() => Math.max(10, ...items.map((item) => item.height)), [items])
  const leaders = useMemo(
    () => items.map((item, i) => [item.height, i]).sort((a, b) => b[0] - a[0]).slice(0, 3).map(([, i]) => i),
    [items],
  )
  const aspectKey = Math.round((size.width / Math.max(size.height, 1)) * 20) / 20
  const heightKey = Math.round(size.height / 8) * 8
  const view = useMemo(
    () => frameView(items, extent, tallest, aspectKey, heightKey, chooseAzimuth(items, extent, tallest, aspectKey)),
    [items, extent, tallest, aspectKey, heightKey],
  )

  const live = useRef(null)
  live.current = { items, active, dark, reduced, size, dpr, view }
  const runtime = useRef({
    time: 0,
    night: dark ? 1 : 0,
    blendNight: true,
    hover: new Array(64).fill(0),
    rig: {},
    cols: [],
    order: [],
    placed: [],
    plates: new Map(),
    rect: {},
    probe: {},
    caption: {},
  })

  useEffect(() => {
    invalidate()
  }, [active, dark, items, invalidate])

  const pipelineRef = useRef(null)
  const update = (delta) => {
    const rt = runtime.current
    const input = live.current
    const dt = Math.min(Math.max(delta, 0), 0.1)
    if (!input.reduced) rt.time += dt
    const target = input.dark ? 1 : 0
    // eased, except under the theme's circular reveal (the new snapshot must already hold the new palette)
    rt.night = input.reduced || themeRevealing() ? target : rt.night + (target - rt.night) * (1 - Math.exp(-dt * 2.4))
    const n = rt.night
    shared.common.uNight.value = n
    shared.common.uTime.value = rt.time % 3600
    shared.fog.uFogColor.value.set(input.dark ? '#0b1416' : '#dfe4e2')
    gl.setClearColor(shared.fog.uFogColor.value, 1)
    shared.fog.uFogDensity.value = 0.0015
    const ground = world.materials.ground.uniforms
    ground.uBase.value.set('#cdd4d2').lerp(_c.set('#0b1416'), n)
    ground.uLine.value.set('#b1bab7').lerp(_c.set('#1d2e32'), n)
    ground.uGlow.value.set('#eaeeec').lerp(_c.set('#17292c'), n)
    ground.uExtent.value = extent * 1.2
    const nightBlend = n > 0.5
    if (nightBlend !== rt.blendNight) {
      rt.blendNight = nightBlend
      setMarkerBlending(world.materials.ring, nightBlend)
    }
    const pipeline = pipelineRef.current
    if (pipeline) {
      const grade = pipeline.grade.uniforms
      grade.uExposure.value = MathUtils.lerp(1.0, 1.15, n)
      grade.uContrast.value = MathUtils.lerp(0.18, 0.26, n)
      grade.uVignette.value = MathUtils.lerp(0.18, 0.45, n)
      grade.uVignetteColor.value.setRGB(0.16, 0.17, 0.17).lerp(_c.setRGB(0.02, 0.035, 0.04), n)
      grade.uShadowTint.value.setRGB(0, 0.006, 0.014).lerp(_c.setRGB(-0.012, 0.02, 0.03), n)
      grade.uHighlightTint.value.setRGB(0.004, 0.004, 0).lerp(_c.setRGB(0.03, 0.01, -0.02), n)
      grade.uTime.value = rt.time
      if (pipeline.bloomPass) {
        pipeline.bloomPass.strength = BLOOM.strength * MathUtils.lerp(0.4, 1, n)
        pipeline.bloomPass.threshold = MathUtils.lerp(1.5, BLOOM.threshold, n)
      }
    }

    // camera: slow orbit around the data-chosen azimuth, framing every column
    const aspect = input.size.width / Math.max(input.size.height, 1)
    const rig = pulseRig(extent, tallest, aspect, input.view.az + (input.reduced ? 0 : Math.sin(rt.time * 0.11) * SWAY), rt.rig)
    rig.dist = input.view.dist
    rig.sx = input.view.sx
    rig.sy = input.view.sy
    applyRig(camera, rig, input.reduced ? null : { el: wobble(rt.time * 0.1, 2) * 0.8 })

    // highlight: hovered / focused column, rings, cap glows
    const { ringState, glowColor, glowParams } = world.attributes
    world.materials.column.uniforms.uHover.value = input.active ?? -1
    input.items.forEach((item, i) => {
      rt.hover[i] = rt.hover[i] ?? 0
      rt.hover[i] += ((input.active === i ? 1 : 0) - rt.hover[i]) * (input.reduced ? 1 : 1 - Math.exp(-dt * 10))
      const h = rt.hover[i]
      ringState.setXYZW(i, 1, 0, h, 0.55 + h * 0.45)
      _c.set(item.color).lerp(_c2.set('#ffffff'), 0.25)
      glowColor.setXYZ(i, _c.r * 2.6, _c.g * 2.6, _c.b * 2.6)
      glowParams.setXY(i, 1.2 + h * 0.8, (0.55 + h * 0.9) * MathUtils.lerp(0.5, 1, n))
    })
    ringState.needsUpdate = true
    glowColor.needsUpdate = true
    glowParams.needsUpdate = true
    world.materials.glow.uniforms.uPixel.value = (2 * Math.tan(MathUtils.degToRad(FOV) / 2)) / Math.max(input.size.height, 1)

    layoutPlates(input, dt)
  }

  /**
   * Sign plates in screen space: the active column's plate first, then the three largest; each takes the cheapest
   * spot (short post, off other plates, columns and the caption chip). Positions and opacities ease per frame.
   */
  const layoutPlates = (input, dt) => {
    const rt = runtime.current
    const W = Math.max(input.size.width, 1)
    const H = Math.max(input.size.height, 1)
    const pixel = (2 * Math.tan(MathUtils.degToRad(camera.fov) / 2)) / H
    const scale = W < 640 ? 0.8 : 0.9
    const glide = input.reduced ? 1 : 1 - Math.exp(-dt * 12)
    const fade = input.reduced ? 1 : 1 - Math.exp(-dt * 10)
    const sinEl = Math.sin(MathUtils.degToRad(rt.rig.el))
    _right.setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize()
    const toScreen = (x, y, z, out) => {
      _ndc.set(x, y, z).project(camera)
      out.x = (_ndc.x * 0.5 + 0.5) * W
      out.y = (0.5 - _ndc.y * 0.5) * H
      out.z = _ndc.z
      return out
    }

    // columns on screen: obstacles, and each one's anchor (the top of its cap)
    const cols = rt.cols
    cols.length = input.items.length
    input.items.forEach((item, i) => {
      const c = cols[i] ?? (cols[i] = { base: {}, top: {}, edge: {} })
      const h = Math.max(item.height, 0.4)
      toScreen(item.x, 0, item.z, c.base)
      toScreen(item.x, h, item.z, c.top)
      toScreen(item.x + _right.x * HEX_RADIUS, h, item.z + _right.z * HEX_RADIUS, c.edge)
      const hw = Math.abs(c.edge.x - c.top.x)
      const cap = hw * sinEl
      c.x0 = Math.min(c.base.x, c.top.x) - hw
      c.x1 = Math.max(c.base.x, c.top.x) + hw
      c.y0 = c.top.y - cap
      c.y1 = c.base.y + cap
      c.rank = LEVEL_RANK[item.level] ?? 0
    })

    const plateOf = (key) => {
      let st = rt.plates.get(key)
      if (!st) {
        st = { alpha: 0, target: 0, spot: 0, x: 0, y: 0, fresh: true }
        rt.plates.set(key, st)
      }
      return st
    }
    const signOf = (item) => labels.slot(item.key, { text: item.label, glyph: 'dot', glyphColor: item.color })
    const widthOf = (sprite) => (sprite.userData.cssWidth - SIGN_MARGIN * 2) * scale
    const heightOf = (sprite) => (sprite.userData.cssHeight - SIGN_MARGIN * 2) * scale

    // who gets a plate, in order: the active column, then the largest (not on narrow canvases)
    const order = rt.order
    order.length = 0
    if (input.active !== null && input.items[input.active]) order.push(input.active)
    if (W >= NARROW) {
      leaders.forEach((i) => {
        if (i !== input.active && i < input.items.length) order.push(i)
      })
    }
    input.items.forEach((item) => {
      plateOf(item.key).target = 0
    })

    const placed = rt.placed
    placed.length = 0
    const caption = rt.caption
    caption.x0 = 0
    const chip = captionFor(W)
    caption.x1 = Math.min(W, chip.width)
    caption.y0 = H - chip.height
    caption.y1 = H
    const rect = rt.rect
    const probe = rt.probe
    order.forEach((i) => {
      const item = input.items[i]
      const sprite = signOf(item)
      if (!sprite.userData.cssWidth) return
      const st = plateOf(item.key)
      const isActive = i === input.active
      const w = widthOf(sprite)
      const h = heightOf(sprite)
      const c = cols[i]
      let best = 0
      let bestCost = Infinity
      let keepCost = Infinity
      SPOTS.forEach(([kind, gap], k) => {
        spotRect(kind, gap, c.top.x, c.y0, w, h, rect)
        let cost = gap * 0.03 + Math.abs(kind) * 0.6
        if (rect.x0 < SAFE || rect.x1 > W - SAFE || rect.y0 < SAFE || rect.y1 > H - SAFE) cost += 1000
        if (overlapArea(rect, caption) > 0) cost += 1000
        grow(rect, 4, probe)
        placed.forEach((other) => {
          if (overlapArea(probe, other) > 0) cost += 1000
        })
        cols.forEach((other, j) => {
          const area = overlapArea(rect, other)
          if (area > 0) cost += (30 + 15 * other.rank) * (area / (w * h)) * (j === i ? 0.5 : 1)
        })
        if (cost < bestCost) {
          bestCost = cost
          best = k
        }
        if (k === st.spot) keepCost = cost
      })
      // a little hysteresis, so plates do not hop between two equal spots as the camera sways
      if (keepCost < 1000 && keepCost <= bestCost + 1.5) {
        best = st.spot
        bestCost = keepCost
      }
      // a permanent plate with no free spot steps aside; the active one always shows
      if (bestCost >= 1000 && !isActive) return
      st.spot = best
      st.target = isActive || input.active === null ? 1 : 0.55
      const [kind, gap] = SPOTS[best]
      spotRect(kind, gap, c.top.x, c.y0, w, h, rect)
      placed.push({ x0: rect.x0, x1: rect.x1, y0: rect.y0, y1: rect.y1 })
      // its post is an obstacle too (the plates placed later keep off it)
      const above = rect.y1 <= c.y0 - 2
      const px = above ? MathUtils.clamp(c.top.x, rect.x0 + 10, rect.x1 - 10) : c.top.x < rect.x0 ? rect.x0 : rect.x1
      const py = above ? rect.y1 : MathUtils.clamp(c.y0, rect.y0, rect.y1)
      if (Math.hypot(px - c.top.x, py - c.y0) > 4) {
        placed.push({ x0: Math.min(px, c.top.x) - 3, x1: Math.max(px, c.top.x) + 3, y0: Math.min(py, c.y0), y1: Math.max(py, c.y0) })
      }
    })

    // draw: every plate eases to its spot (kept inside the frame) and fades; a post joins plate and column
    input.items.forEach((item, i) => {
      const sprite = signOf(item)
      const post = labels.leader(item.key)
      const st = plateOf(item.key)
      st.alpha += (st.target - st.alpha) * fade
      if (st.alpha < 0.01 || !sprite.userData.cssWidth) {
        if (st.target === 0) st.alpha = 0
        labels.place(sprite, _anchor, 0, 0, scale)
        labels.placeLeader(post, _anchor, 0, 0, 0, 0, SIGN_GREEN)
        return
      }
      const w = widthOf(sprite)
      const h = heightOf(sprite)
      const c = cols[i]
      const [kind, gap] = SPOTS[st.spot] ?? SPOTS[0]
      spotRect(kind, gap, c.top.x, c.y0, w, h, rect)
      const tx = (rect.x0 + rect.x1) / 2 + Math.max(SAFE - rect.x0, 0) - Math.max(rect.x1 - (W - SAFE), 0)
      const ty = rect.y1 + Math.max(SAFE - rect.y0, 0) - Math.max(rect.y1 - (H - SAFE), 0)
      if (st.fresh || st.alpha < 0.05 || input.reduced) {
        st.x = tx
        st.y = ty
        st.fresh = false
      } else {
        st.x += (tx - st.x) * glide
        st.y += (ty - st.y) * glide
      }
      const front = i === input.active
      sprite.renderOrder = front ? 12 : 10
      post.renderOrder = front ? 11 : 9
      // plate: its canvas (with the shadow margin) hangs from its bottom centre
      _anchor.set((st.x / W) * 2 - 1, 1 - ((st.y + SIGN_MARGIN * scale) / H) * 2, c.top.z).unproject(camera)
      labels.place(sprite, _anchor, st.alpha, camera.position.distanceTo(_anchor) * pixel, scale)
      // post: from the column top to the plate's bottom edge (or its near side when the plate sits beside it)
      const ax = c.top.x
      const ay = c.y0
      let px = MathUtils.clamp(ax, st.x - w / 2 + 10, st.x + w / 2 - 10)
      let py = st.y
      if (st.y > ay - 2) {
        px = ax < st.x ? st.x - w / 2 : st.x + w / 2
        py = MathUtils.clamp(ay, st.y - h, st.y)
      }
      _anchor.set((ax / W) * 2 - 1, 1 - (ay / H) * 2, c.top.z).unproject(camera)
      labels.placeLeader(
        post,
        _anchor,
        Math.hypot(px - ax, py - ay),
        Math.atan2(-(px - ax), ay - py),
        st.alpha * (input.dark ? 0.8 : 0.95),
        camera.position.distanceTo(_anchor) * pixel,
        input.dark ? '#dfe8e5' : SIGN_GREEN,
      )
    })
  }

  const settings = PULSE_SETTINGS[tier] ?? PULSE_SETTINGS.medium
  const pipeline = useMemo(
    () => createPostPipeline({ gl, scene: r3fScene, camera, settings, bloom: BLOOM }),
    [gl, r3fScene, camera, settings],
  )
  useEffect(() => () => pipeline.dispose(), [pipeline])
  pipelineRef.current = pipeline

  // Rendering starts once this world and chain are primed (compiled, linked, uploaded, drawn once off screen).
  const [primed, setPrimed] = useState(null)
  const ready = primed !== null && primed.world === world && primed.pipeline === pipeline
  usePostPipeline({
    pipeline,
    overlay: labels.scene,
    enabled: ready,
    onBeforeRender: update,
    onAfterFirstRender: () => requestAnimationFrame(() => sceneContext?.markReady?.()),
  })

  useEffect(() => {
    const controller = new AbortController()
    const input = live.current
    pipeline.setSize(input.size.width, input.size.height, input.dpr)
    const done = () => !controller.signal.aborted && setPrimed({ world, pipeline })
    primeScene({
      gl,
      camera,
      signal: controller.signal,
      groups: [{ objects: [...world.root.children, world.columns], target: pipeline.sceneTarget, samples: pipeline.samples }],
      pipeline,
      labels,
      labelSpecs: input.items.map((item) => ({ id: item.key, spec: { text: item.label, glyph: 'dot', glyphColor: item.color } })),
    }).then(done, (error) => {
      if (!isCancelled(error)) done()
    })
    return () => controller.abort()
  }, [gl, camera, world, pipeline, labels])
  useEffect(() => {
    if (ready) invalidate()
  }, [ready, invalidate])

  return (
    <>
      <primitive object={world.root} />
      <primitive
        object={world.columns}
        onPointerMove={(event) => {
          event.stopPropagation()
          if (event.instanceId !== undefined) onHover?.(event.instanceId)
        }}
        onPointerOut={() => onHover?.(null)}
        onClick={(event) => {
          event.stopPropagation()
          if (event.instanceId !== undefined) onSelect?.(event.instanceId)
        }}
      />
    </>
  )
}

