/**
 * Camera rig: a long lens (fov 30-35) orbiting a target, described by distance, azimuth and elevation, plus a
 * lens shift that moves the subject inside the frame without tilting the camera (verticals stay vertical).
 * Pure JS (no three.js import): the SVG still (CityFallback) projects the district through the same rig.
 *
 * - Stage presets frame each moment of the story; `frameRig` adapts them to the viewport: on wide screens the
 *   subject sits right of centre (calm area for the hero copy on the left), on tall/phone frames it sits low
 *   (calm sky at the top), and the distance grows so narrow frames still see enough of the district.
 * - The establishing shot flies from a high aerial view down into the hero framing on eased curves (distance
 *   falls first, the tilt follows), while the lamps switch on in a wave.
 * - Living idle: slow crane drift, a little handheld noise and damped pointer parallax.
 */

const DEG = Math.PI / 180
const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const lerp = (a, b, t) => a + (b - a) * t
const smoothstep = (x, a, b) => {
  const t = clamp((x - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

export const RIGS = Object.freeze({
  aerial: { target: [22, 0, -6], dist: 660, az: -14, el: 80, fov: 34, minWidth: 0, shift: [0, 0] },
  hero: { target: [24, 8, -10], dist: 262, az: 26, el: 22.5, fov: 30, minWidth: 150, shift: [0.22, -0.16] },
  report: { target: [15.3, 2.6, -3.5], dist: 64, az: 84, el: 13, fov: 33, minWidth: 40, shift: [0.06, -0.1] },
  analyze: { target: [12, 3, -3.5], dist: 104, az: 87, el: 15, fov: 32, minWidth: 62, shift: [0.05, -0.08] },
  prioritize: { target: [17, 21, 2], dist: 170, az: 104, el: 47, fov: 32, minWidth: 112, shift: [0.02, -0.15] },
  route: { target: [22, 14, -24], dist: 296, az: 30, el: 30, fov: 32, minWidth: 220, shift: [0.02, -0.12] },
  // verify: back over the avenue where the issue was reported, looking west along it and its parallel streets
  // (three of the five story sites, both 'Resolved' plates among them, stand on these, so no block hides their
  // rings), close enough for the green ribbons, check rings and plates to read
  verify: { target: [18, 4, -14], dist: 200, az: 86, el: 40, fov: 32, minWidth: 100, shift: [0.02, -0.06] },
  // calm (auth pages): low, down the street of the one resolved issue (site 6, on a north-south street), so the
  // line of sight to it runs along the carriageway instead of over the roofs
  calm: { target: [66, 4, -45.9], dist: 160, az: 0.7, el: 22, fov: 32, minWidth: 88, shift: [0.12, -0.18] },
})

/** Rig params as a flat mutable object. */
export function createRig(preset = RIGS.hero) {
  return {
    tx: preset.target[0],
    ty: preset.target[1],
    tz: preset.target[2],
    dist: preset.dist,
    az: preset.az,
    el: preset.el,
    fov: preset.fov,
    sx: preset.shift[0],
    sy: preset.shift[1],
  }
}

const COMPOSITION = /^\s*(-?\d*\.?\d+)\s+(-?\d*\.?\d+)(?:\s+(\d*\.?\d+))?\s*$/

/** An explicit composition: `{ x, y, zoom }`, or the same as the string "x y zoom" (value-typed: safe in memo
 * dependencies and cache keys). Null for the named framings. */
function composition(framing) {
  if (framing && typeof framing === 'object') return framing
  const match = typeof framing === 'string' ? COMPOSITION.exec(framing) : null
  return match ? { x: Number(match[1]), y: Number(match[2]), zoom: match[3] === undefined ? 1 : Number(match[3]) } : null
}

/**
 * Preset adapted to the frame. `framing`: 'auto' (left-calm on wide frames, top-calm on tall ones), 'left', 'top',
 * 'center', or an explicit composition for pages that lay their own content over the scene (the landing hero):
 * "x y zoom" (or `{ x, y, zoom }`) - the stage's subject sits at (x, y) in normalised device coordinates (-1..1,
 * y up; applied as a lens shift, so verticals stay vertical) and the camera distance is scaled by `zoom` (> 1
 * pulls back). Writes into `out`.
 */
export function frameRig(stage, aspect, framing, out) {
  const preset = RIGS[stage] ?? RIGS.hero
  const wide = aspect >= 1.15
  const custom = composition(framing)
  const mode = custom ? 'custom' : framing === 'auto' || !framing ? (wide ? 'left' : 'top') : framing
  const tan = Math.tan((preset.fov * DEG) / 2)
  const fit = preset.minWidth ? preset.minWidth / (2 * tan * Math.max(aspect, 0.3)) : 0
  out.tx = preset.target[0]
  out.ty = preset.target[1]
  out.tz = preset.target[2]
  out.dist = Math.max(preset.dist, fit) * (custom && Number.isFinite(custom.zoom) ? clamp(custom.zoom, 0.6, 2) : 1)
  out.az = preset.az
  // tall frames: a slightly lower camera brings the horizon haze into the top of the frame (calm area)
  out.el = preset.el - (wide ? 0 : 2.5)
  out.fov = preset.fov
  if (custom) {
    out.sx = clamp(Number(custom.x) || 0, -0.9, 0.9)
    out.sy = clamp(Number(custom.y) || 0, -0.9, 0.9)
  } else if (mode === 'left') {
    out.sx = preset.shift[0] * Math.min(1, (aspect - 0.9) / 0.9)
    out.sy = preset.shift[1]
  } else if (mode === 'top') {
    out.sx = 0
    out.sy = Math.min(preset.shift[1], -0.24)
  } else {
    out.sx = 0
    out.sy = 0
  }
  return out
}

export function copyRig(from, to) {
  to.tx = from.tx
  to.ty = from.ty
  to.tz = from.tz
  to.dist = from.dist
  to.az = from.az
  to.el = from.el
  to.fov = from.fov
  to.sx = from.sx
  to.sy = from.sy
  return to
}

/** Critically damped approach of `rig` towards `target` (k = 1 - exp(-dt * rate)). */
export function dampRig(rig, target, dt, rate = 2.6) {
  const k = 1 - Math.exp(-dt * rate)
  rig.tx += (target.tx - rig.tx) * k
  rig.ty += (target.ty - rig.ty) * k
  rig.tz += (target.tz - rig.tz) * k
  rig.dist += (target.dist - rig.dist) * k
  rig.az += (target.az - rig.az) * k
  rig.el += (target.el - rig.el) * k
  rig.fov += (target.fov - rig.fov) * k
  rig.sx += (target.sx - rig.sx) * k
  rig.sy += (target.sy - rig.sy) * k
}

const easeOutQuart = (t) => 1 - (1 - t) ** 4
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2

/** Establishing shot: interpolate aerial -> hero at t in [0, 1] (each parameter on its own curve). */
export function establishing(t, aerial, hero, out) {
  const d = easeOutQuart(t)
  const tilt = easeInOutCubic(clamp((t - 0.08) / 0.92, 0, 1))
  const turn = easeInOutSine(t)
  out.tx = lerp(aerial.tx, hero.tx, turn)
  out.ty = lerp(aerial.ty, hero.ty, turn)
  out.tz = lerp(aerial.tz, hero.tz, turn)
  out.dist = lerp(aerial.dist, hero.dist, d)
  out.el = lerp(aerial.el, hero.el, tilt)
  out.az = lerp(aerial.az, hero.az, turn)
  out.fov = lerp(aerial.fov, hero.fov, t)
  const shift = smoothstep(t, 0.35, 1)
  out.sx = lerp(aerial.sx, hero.sx, shift)
  out.sy = lerp(aerial.sy, hero.sy, shift)
  return out
}

/** World position of the rig's camera (idle offsets in degrees: { az, el, distScale }). */
export function rigPosition(rig, idle) {
  const az = (rig.az + (idle?.az ?? 0)) * DEG
  const el = clamp(rig.el + (idle?.el ?? 0), 2, 88) * DEG
  const dist = rig.dist * (idle?.distScale ?? 1)
  return [
    rig.tx + Math.sin(az) * Math.cos(el) * dist,
    rig.ty + Math.sin(el) * dist,
    rig.tz + Math.cos(az) * Math.cos(el) * dist,
  ]
}

/**
 * Apply a rig to a PerspectiveCamera (position, look-at, fov, lens shift). `idle` adds drift / handheld / parallax
 * offsets in degrees: { az, el, roll, pitch, distScale }.
 */
export function applyRig(camera, rig, idle) {
  const [x, y, z] = rigPosition(rig, idle)
  camera.position.set(x, y, z)
  camera.up.set(0, 1, 0)
  camera.lookAt(rig.tx, rig.ty, rig.tz)
  if (idle?.roll) camera.rotateZ(idle.roll * DEG)
  if (idle?.pitch) camera.rotateX(idle.pitch * DEG)
  if (Math.abs(camera.fov - rig.fov) > 1e-3) camera.fov = rig.fov
  camera.updateProjectionMatrix()
  // Lens shift: offset the projection centre (subject moves by +sx / +sy in NDC).
  camera.projectionMatrix.elements[8] = -rig.sx
  camera.projectionMatrix.elements[9] = -rig.sy
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
  camera.updateMatrixWorld()
}

/**
 * Pure pinhole projection matching applyRig (no idle offsets): returns `project(x, y, z)` ->
 * { x, y (NDC, y up), depth } or null behind the near plane, plus the camera position and basis.
 */
export function rigProjector(rig, aspect) {
  const pos = rigPosition(rig)
  const f = [rig.tx - pos[0], rig.ty - pos[1], rig.tz - pos[2]]
  const fl = Math.hypot(...f)
  f[0] /= fl
  f[1] /= fl
  f[2] /= fl
  // right = forward x up, up' = right x forward
  let r = [-f[2], 0, f[0]]
  const rl = Math.hypot(...r) || 1
  r = [r[0] / rl, 0, r[2] / rl]
  const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]]
  const tanHalf = Math.tan((rig.fov * DEG) / 2)
  const near = 1
  const toCamera = (x, y, z) => {
    const dx = x - pos[0]
    const dy = y - pos[1]
    const dz = z - pos[2]
    return [dx * r[0] + dy * r[1] + dz * r[2], dx * u[0] + dy * u[1] + dz * u[2], dx * f[0] + dy * f[1] + dz * f[2]]
  }
  const toNdc = ([cx, cy, cz]) => ({ x: cx / (cz * tanHalf * aspect) + rig.sx, y: cy / (cz * tanHalf) + rig.sy, depth: cz })
  return {
    position: pos,
    forward: f,
    near,
    toCamera,
    toNdc,
    project(x, y, z) {
      const c = toCamera(x, y, z)
      return c[2] < near ? null : toNdc(c)
    },
  }
}

/** Smooth pseudo-random signal in [-1, 1] (sum of incommensurate sines) for drift and handheld shake. */
export function wobble(t, seed) {
  return (
    Math.sin(t * 0.63 + seed * 1.7) * 0.5 +
    Math.sin(t * 1.37 + seed * 3.1) * 0.3 +
    Math.sin(t * 2.71 + seed * 5.3) * 0.2
  )
}
