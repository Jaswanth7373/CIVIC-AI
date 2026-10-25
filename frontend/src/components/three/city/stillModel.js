/**
 * The SVG still of the district (CityFallback): the same streets, buildings, lamps, landmarks and story moment as
 * the 3D scene's reduced-motion poster frame, projected through the same camera rig. Pure JS (no three.js).
 *
 * `buildStill()` returns plain drawable primitives in a viewBox of (1000 * aspect) x 1000; CityFallback renders
 * them. Distance haze is baked into every colour (same analytic height fog as the shaders), so the still reads with
 * the same depth as the live scene, and every colour - the lights, markers and arcs included - goes through the
 * live grade (tone curve, contrast, split tone, saturation). Windows are one patterned overlay per facade: an
 * affine map from the facade's metres to the frame, filled with the window pattern of the building's height class
 * (`windowPatterns`, a few variants each), instead of a line per floor. `getStill()` is the same with a small cache (a still is often shown twice: as a
 * canvas fallback and as the cover above it, or again after a theme toggle).
 */
import { castCity, GENERIC_LABELS, MARKING_YELLOW, RESOLVED_GREEN } from './cast'
import { CITY, getCity, hashU32, unit, xStreetHalf } from './layout'
import { CALM_DAWN_FOG, DAWN, GRADE, NIGHT, SCALARS } from './palette'
import { createRig, frameRig, rigProjector } from './rig'
import { HERO_POSTER_TIME, STILL_PROGRESS, createFrameState, stageState } from './timeline'

/* ---- colour helpers (linear-light mixing) ---------------------------------------------------------------------- */

const toLin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)

function hexToLinear(hex) {
  const v = parseInt(hex.slice(1), 16)
  return [toLin(((v >> 16) & 255) / 255), toLin(((v >> 8) & 255) / 255), toLin((v & 255) / 255)]
}

/**
 * Display-space colour after the 3D's grade pass (post.js): filmic contrast, split tone, saturation - so the still
 * carries the graded palette of the live scene, not the raw one. `rgb`: tone-mapped linear (display()).
 */
function gradedHex(rgb, grade) {
  let c = rgb.map((v) => Math.min(1, Math.max(0, toSrgb(v))))
  c = c.map((v) => v + (v * v * (3 - 2 * v) - v) * grade.contrast)
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  c = c.map((v, k) => v + grade.shadow[k] * (1 - l) * (1 - l) + grade.highlight[k] * l * l)
  c = c.map((v) => l + (v - l) * grade.saturation)
  return `#${c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`
}

const mixLin = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const mulLin = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
const addLin = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scaleLin = (a, s) => [a[0] * s, a[1] * s, a[2] * s]

/** ACES-like display compression so mixed light values map like the live grade. */
function display(rgb, exposure) {
  return rgb.map((c) => {
    const x = Math.max(0, c * exposure * 1.6)
    return (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)
  })
}

/* ---- geometry helpers ---------------------------------------------------------------------------------------------- */

/** Clip a polygon (camera-space points) against the near plane, then project. */
function clipProject(cam, points) {
  const cs = points.map(([x, y, z]) => cam.toCamera(x, y, z))
  const out = []
  for (let i = 0; i < cs.length; i += 1) {
    const a = cs[i]
    const b = cs[(i + 1) % cs.length]
    const ina = a[2] >= cam.near
    const inb = b[2] >= cam.near
    if (ina) out.push(a)
    if (ina !== inb) {
      const t = (cam.near - a[2]) / (b[2] - a[2])
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, cam.near])
    }
  }
  return out.length >= 3 ? out.map((c) => cam.toNdc(c)) : null
}

const r1 = (v) => Math.round(v * 10) / 10

/** 2D convex hull (monotone chain) of [x, y] points. */
function hull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower = []
  p.forEach((q) => {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  })
  const upper = []
  for (let i = p.length - 1; i >= 0; i -= 1) {
    const q = p[i]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  upper.pop()
  lower.pop()
  return lower.concat(upper)
}

/** Quantise a hex colour so neighbouring far silhouettes share fills (and merge into one path). */
function quantise(hex, step = 4) {
  const v = parseInt(hex.slice(1), 16)
  const q = (c) => Math.min(255, Math.round(c / step) * step)
  return `#${[q((v >> 16) & 255), q((v >> 8) & 255), q(v & 255)].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

/**
 * Window rhythm per height class, in facade metres: a cell per window (w x one floor), the window inside it
 * (x, y, w, h from the cell's top-left) and the tile it repeats in (cols x rows cells).
 */
const WINDOW_CLASSES = Object.freeze({
  low: { cell: 3.3, win: [0.95, 0.85, 1.4, 1.45], cols: 5, rows: 3 },
  mid: { cell: 2.8, win: [0.6, 0.75, 1.6, 1.7], cols: 6, rows: 4 },
  tall: { cell: 2.25, win: [0.2, 0.55, 1.85, 2.05], cols: 8, rows: 5 },
})
const WINDOW_VARIANTS = 3

/**
 * The still's flat shading (no light map, reflections or bloom) lands lighter than the live frame at dawn: this
 * exposure trim, measured on matching live and still frames (story 'report', landing hero), brings their mean
 * luminance together, so a still hands over to the live scene without a jump. Night needs none overall; its
 * close-ups get their light from the lamp cones instead.
 */
const STILL_EXPOSURE = Object.freeze({ night: 1, dawn: 0.8 })

/** Light the markers carry into the grade (linear gain on their colour), so they land where the live ones do. */
const MARKER_GAIN = Object.freeze({ night: 1.1, dawn: 0.62 })

const windowClass = (b) => (b.h >= 28 || b.kind === 3 ? 'tall' : b.h >= 13 ? 'mid' : 'low')

/** The window patterns of a theme: per class and variant, the lit / dark windows of one tile (graded colours). */
function windowPatterns(night, colors) {
  const patterns = []
  Object.entries(WINDOW_CLASSES).forEach(([cls, spec]) => {
    for (let variant = 0; variant < WINDOW_VARIANTS; variant += 1) {
      const cells = []
      for (let row = 0; row < spec.rows; row += 1) {
        for (let col = 0; col < spec.cols; col += 1) {
          const h = hashU32(((cls.length * 97 + variant) * 131 + row) * 251 + col)
          // the bottom row of a tile is the ground floor of the facade (tiles repeat up from the street)
          const lit = unit(h) < (night ? (row === spec.rows - 1 ? 0.5 : 0.3) : 0.06)
          const fill = lit ? (unit(hashU32(h + 7)) < 0.7 ? colors.warm : colors.pale) : colors.glass
          if (!lit && night && unit(hashU32(h + 3)) < 0.5) continue
          cells.push({
            x: r1(col * spec.cell + spec.win[0]),
            y: r1(row * CITY.floor + spec.win[1]),
            w: spec.win[2],
            h: spec.win[3],
            fill,
            o: lit ? 1 : night ? 0.55 : 0.9,
          })
        }
      }
      patterns.push({ id: `${cls}${variant}`, w: r1(spec.cols * spec.cell), h: r1(spec.rows * CITY.floor), cells })
    }
  })
  return patterns
}

/** Aspect ratios (width / height) the still is composed for; boxes outside are composed at the limit. */
export const MIN_STILL_ASPECT = 0.05
export const MAX_STILL_ASPECT = 20

export function buildStill({ stage = 'hero', theme = 'dark', aspect: requestedAspect = 16 / 9, framing = 'auto', categories, pxPerUnit = 1 }) {
  const aspect = Number.isFinite(requestedAspect)
    ? Math.min(MAX_STILL_ASPECT, Math.max(MIN_STILL_ASPECT, requestedAspect))
    : 16 / 9
  const night = theme === 'dark'
  const pal = night ? NIGHT : DAWN
  const sc = night ? SCALARS.night : SCALARS.dawn
  const L = Object.fromEntries(Object.entries(pal).map(([k, v]) => [k, hexToLinear(v)]))
  const grade = { contrast: sc.contrast, saturation: sc.saturation, ...(night ? GRADE.night : GRADE.dawn) }
  const toHex = (rgbLin) => gradedHex(display(rgbLin, sc.exposure * STILL_EXPOSURE[night ? 'night' : 'dawn']), grade)
  // lights and markers through the same tone curve and grade as the live scene's emissive surfaces
  const glow = (hex, k = 1) => toHex(scaleLin(hexToLinear(hex), k))
  // markers (rings, beams, arcs, beacons, the scan): night lights them, dawn inks them
  const markerCache = new Map()
  const markerColor = (hex) => {
    if (!markerCache.has(hex)) markerCache.set(hex, glow(hex, night ? MARKER_GAIN.night : MARKER_GAIN.dawn))
    return markerCache.get(hex)
  }
  const lightColors = {
    warm: glow(night ? '#ffb45e' : '#ffcf8a', 1.25),
    cool: glow(night ? '#f4f1ea' : '#fff7e8', 1.1),
    core: glow('#fff4dc', 1.6),
  }
  const windowColors = {
    warm: glow('#e9a35a', 1.15),
    pale: glow('#f2d6a2', 1.1),
    glass: night ? glow('#1d2a2e') : toHex(mixLin(L.glass, L.skyRefl, 0.55)),
  }
  const city = getCity()
  const cast = castCity(categories)
  const sites = city.sites.map((site, k) => ({ ...site, ...cast.sites[k] }))
  const hqs = city.hqs.map((hq) => ({ ...hq, ...cast.hqs[hq.index] }))

  const W = 1000 * aspect
  const H = 1000
  // Exactly the live stage's camera (no lift for the close-ups): the story's still hands over to the live scene, so
  // the two must line up - same pose, same signs in the same places.
  const rig = frameRig(stage, aspect, framing, createRig())
  const cam = rigProjector(rig, aspect)
  const [cx, cy, cz] = cam.position
  const sx = (p) => r1((p.x + 1) * 0.5 * W)
  const sy = (p) => r1((1 - p.y) * 0.5 * H)
  const pts = (list) => list.map((p) => `${sx(p)},${sy(p)}`).join(' ')
  const unitScale = (depth) => (H / 2) / (depth * Math.tan(((rig.fov * Math.PI) / 180) / 2)) // svg units per metre

  /* ---- fog (same analytic height fog as the shaders) ---- */
  const density = sc.fogDensity * (stage === 'calm' && !night ? CALM_DAWN_FOG : 1)
  const falloff = sc.fogFalloff
  const fogTint = (ry) => mixLin(L.fogColor, L.fogHorizon, (1 - Math.min(Math.abs(ry), 1)) ** 6)
  const fogAt = (x, y, z) => {
    const dx = x - cx
    const dy = y - cy
    const dz = z - cz
    const dist = Math.hypot(dx, dy, dz)
    const ry = dy / Math.max(dist, 1e-4)
    const optical =
      Math.abs(ry) < 1e-3
        ? density * Math.exp(-cy * falloff) * dist
        : (density / falloff) * Math.exp(-cy * falloff) * (1 - Math.exp(-dist * ry * falloff)) / ry
    return { f: 1 - Math.exp(-Math.max(optical, 0)), tint: fogTint(ry), dist }
  }
  const shade = (rgbLin, x, y, z) => {
    const { f, tint } = fogAt(x, y, z)
    return toHex(mixLin(rgbLin, tint, Math.min(1, f)))
  }

  /* ---- horizon ---- */
  const fwd = [cam.forward[0], 0, cam.forward[2]]
  const fl = Math.hypot(fwd[0], fwd[2]) || 1
  const horizon = cam.project(cx + (fwd[0] / fl) * 9000, 0, cz + (fwd[2] / fl) * 9000)
  const horizonY = horizon ? Math.max(-50, Math.min(H, sy(horizon))) : 0

  const sky = {
    zenith: toHex(L.zenith),
    mid: toHex(L.mid),
    horizon: toHex(mixLin(L.horizon, L.haze, 0.35)),
    fog: toHex(fogTint(-0.02)),
  }

  /* ---- ground and streets ---- */
  const E = (CITY.outer + 0.5) * CITY.pitch
  const ambient = addLin(L.ambSky, scaleLin(L.keyColor, night ? 0.6 : 0.35))
  const lotColor = mulLin(L.lot, ambient)
  const streets = []
  // At night the live streets read wet grey under mixed sodium and LED light, not orange: a neutral sheen with only a
  // trace of the sodium glow (the warm pools and cones are drawn on top).
  const streetLight = night ? addLin([0.028, 0.03, 0.032], scaleLin(L.streetGlow, 0.01)) : [0, 0, 0]
  const addStreet = (corners, color, mid) => {
    const poly = clipProject(cam, corners)
    if (poly) streets.push({ points: pts(poly), fill: shade(color, ...mid) })
  }
  for (let j = -CITY.outer; j <= CITY.outer; j += 1) {
    const half = (j === 0 ? CITY.avenue : CITY.road) + CITY.sidewalk * 0.4
    const z = j * CITY.pitch
    const road = addLin(mulLin(L.asphalt, ambient), streetLight)
    // one fill per street, hazed as at the subject's distance (not under the camera), so crossings far down the
    // view match the street they cross
    addStreet([[-E, 0, z - half], [E, 0, z - half], [E, 0, z + half], [-E, 0, z + half]], road, [rig.tx, 0, z])
  }
  for (let i = -CITY.outer; i <= CITY.outer; i += 1) {
    const half = CITY.road + CITY.sidewalk * 0.4
    const x = i * CITY.pitch
    const road = addLin(mulLin(L.asphalt, ambient), streetLight)
    addStreet([[x - half, 0, -E], [x + half, 0, -E], [x + half, 0, E], [x - half, 0, E]], road, [x, 0, rig.tz])
  }
  const groundNear = shade(lotColor, cx + fwd[0] * 40, 0, cz + fwd[2] * 40)
  const groundFar = sky.fog

  /* ---- road markings, as the ground shader paints them: centre lines, avenue lanes, edges, zebra crossings ---- */
  // Within reach of the subject (beyond it they are below a pixel); each kind is one path of quads in the image.
  const reach = Math.min(300, rig.dist * 1.4)
  const zebraReach = Math.min(170, rig.dist * 1.2)
  const marks = { white: [], yellow: [], zebra: [] }
  const quad = (list, x0, z0, x1, z1) => {
    const poly = clipProject(cam, [[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]])
    if (!poly) return
    const xs = poly.map(sx)
    const ys = poly.map(sy)
    if (Math.max(...xs) < 0 || Math.min(...xs) > W || Math.max(...ys) < 0 || Math.min(...ys) > H) return
    list.push(`M${poly.map((p, i) => `${xs[i]},${ys[i]}`).join('L')}Z`)
  }
  const inReach = (x, z, range) => Math.hypot(x - rig.tx, z - rig.tz) < range
  const gap = CITY.road + CITY.sidewalk + 0.4 // marking-free square around each crossing
  for (let a = -CITY.core - 3; a <= CITY.core + 3; a += 1) {
    for (let b = -CITY.core - 3; b < CITY.core + 3; b += 1) {
      // segment of the x-street a (z = a P) between crossings b and b + 1, and of the z-street a (x = a P) likewise
      const lo = b * CITY.pitch + gap
      const hi = (b + 1) * CITY.pitch - gap
      const mid = (lo + hi) / 2
      const hwz = xStreetHalf(a)
      const along = (put, at, half, dashed, list) => {
        if (!dashed) return put(list, lo, at - half, hi, at + half)
        for (let d = Math.ceil(lo / 6) * 6; d < hi; d += 6) put(list, d, at - half, Math.min(d + 3, hi), at + half)
      }
      const z0 = a * CITY.pitch
      if (inReach(mid, z0, reach)) {
        const putX = (list, x0, za, x1, zb) => quad(list, x0, za, x1, zb)
        if (a === 0) {
          along(putX, z0 - 0.24, 0.09, false, marks.yellow)
          along(putX, z0 + 0.24, 0.09, false, marks.yellow)
          ;[-1, 1].forEach((side) => {
            along(putX, z0 + side * hwz * 0.5, 0.075, true, marks.white)
            along(putX, z0 + side * (hwz - 0.35), 0.07, false, marks.white)
          })
        } else {
          along(putX, z0, 0.085, true, marks.yellow)
          ;[-1, 1].forEach((side) => along(putX, z0 + side * (hwz - 0.3), 0.06, false, marks.white))
        }
      }
      const x0 = a * CITY.pitch
      if (inReach(x0, mid, reach)) {
        const putZ = (list, za, xa, zb, xb) => quad(list, xa, za, xb, zb)
        along(putZ, x0, 0.085, true, marks.yellow)
        ;[-1, 1].forEach((side) => along(putZ, x0 + side * (CITY.road - 0.3), 0.06, false, marks.white))
      }
    }
  }
  // zebra crossings on every arm of the crossings near the subject (stripes 0.63 m in every 1.15 m)
  for (let i = -CITY.core - 2; i <= CITY.core + 2; i += 1) {
    for (let j = -CITY.core - 2; j <= CITY.core + 2; j += 1) {
      const xc = i * CITY.pitch
      const zc = j * CITY.pitch
      if (!inReach(xc, zc, zebraReach)) continue
      const hwx = CITY.road
      const hwz = xStreetHalf(j)
      ;[-1, 1].forEach((side) => {
        // across the x-street, either side of the crossing
        const xa = xc + side * (hwx + 0.7)
        const xb = xc + side * (hwx + 3.3)
        for (let d = -(hwz - 0.45); d < hwz - 0.45; d += 1.15) quad(marks.zebra, Math.min(xa, xb), zc + d, Math.max(xa, xb), zc + Math.min(d + 0.63, hwz - 0.45))
        // across the z-street
        const za = zc + side * (hwz + 0.7)
        const zb = zc + side * (hwz + 3.3)
        for (let d = -(hwx - 0.45); d < hwx - 0.45; d += 1.15) quad(marks.zebra, xc + d, Math.min(za, zb), xc + Math.min(d + 0.63, hwx - 0.45), Math.max(za, zb))
      })
    }
  }
  const paint = (hex) => {
    let light = addLin(L.ambSky, scaleLin(L.keyColor, night ? 0.6 : 0.35))
    // at night the paint catches the mixed lamp light: near white, as in the live scene
    if (night) light = addLin(light, [0.3, 0.29, 0.27])
    return shade(mulLin(scaleLin(hexToLinear(hex), 0.62), light), rig.tx, 0, rig.tz)
  }
  const markings = {
    white: marks.white.join(''),
    yellow: marks.yellow.join(''),
    zebra: marks.zebra.join(''),
    whiteColor: paint('#e8ece9'),
    yellowColor: paint('#f5b700'),
  }

  /* ---- lamps: pools on the ground, glowing heads ---- */
  const pools = []
  const heads = []
  const nightLamps = night ? 1 : 0
  city.lamps.forEach((lamp) => {
    if (lamp.broken) return
    const dawnOn = unit(hashU32(lamp.id + 99)) <= SCALARS.dawn.lampsOn
    if (!night && !dawnOn) return
    const head = cam.project(lamp.hx, CITY.lampHeight, lamp.hz)
    const base = cam.project(lamp.hx, 0, lamp.hz)
    if (!head || !base) return
    if (base.x < -1.15 || base.x > 1.15 || base.y < -1.15 || base.y > 1.2) return
    const { f, dist } = fogAt(lamp.hx, 0, lamp.hz)
    if (f > 0.86) return
    const k = unitScale(base.depth)
    if (k < 0.9) return
    // the pool of light on the street (about 9 m across, as the baked light map) and, at night near the camera, the
    // cone of light under the head (the live scene's volumetric cones)
    const rx = 9 * k
    const elevation = Math.max(0.12, (cy - 0) / Math.max(dist, 1))
    const strength = (1 - f) * (night ? 1 : 0.45)
    if (rx > 4 && lamp.ring <= CITY.core + 4) {
      pools.push({ cx: sx(base), cy: sy(base), rx: r1(rx), ry: r1(rx * Math.min(1, elevation)), o: +((night ? 0.2 : 0.55) * strength).toFixed(3), cool: lamp.cool })
    }
    if (night && dist < 170 && k > 2) {
      const right = [-cam.forward[2], cam.forward[0]]
      const rl = Math.hypot(right[0], right[1]) || 1
      const spread = 3.4 / rl
      const apex = cam.project(lamp.hx, CITY.lampHeight - 0.3, lamp.hz)
      const left = cam.project(lamp.hx - right[0] * spread, 0, lamp.hz - right[1] * spread)
      const rightFoot = cam.project(lamp.hx + right[0] * spread, 0, lamp.hz + right[1] * spread)
      if (apex && left && rightFoot) {
        heads.push({
          kind: 'cone',
          depth: head.depth + 0.01,
          points: pts([apex, left, rightFoot]),
          o: +Math.min(1, 0.85 * strength).toFixed(3),
          cool: lamp.cool,
        })
      }
    }
    heads.push({
      kind: 'lamp',
      depth: head.depth,
      cx: sx(head),
      cy: sy(head),
      r: r1(Math.max(0.9, 0.42 * k)),
      o: +(Math.min(1, 0.35 + strength) * (0.55 + 0.45 * nightLamps)).toFixed(3),
    })
  })

  /* ---- buildings (painter's order: far to near) ---- */
  const keyDir = night ? [-0.45, 0.62, 0.35] : [0.72, 0.42, 0.3]
  const kl = Math.hypot(...keyDir)
  const key = keyDir.map((v) => v / kl)
  const buildings = []
  let windowCount = 0
  const order = city.buildings
    .map((b) => ({ b, d: Math.hypot(b.x - cx, b.y + b.h * 0.5 - cy, b.z - cz) }))
    .sort((a, c) => c.d - a.d)
  order.forEach(({ b, d }) => {
    const top = b.y + b.h
    const centre = cam.project(b.x, b.y + b.h * 0.5, b.z)
    if (!centre || centre.x < -1.6 || centre.x > 1.6 || centre.y < -1.6 || centre.y > 1.8) return
    const { f } = fogAt(b.x, b.y + b.h * 0.5, b.z)
    if (f > 0.93) return
    if (b.kind === 2 && d > 220) return
    if (Math.max(b.w, b.h, b.d) * unitScale(centre.depth) < 2.5) return
    const x0 = b.x - b.w / 2
    const x1 = b.x + b.w / 2
    const z0 = b.z - b.d / 2
    const z1 = b.z + b.d / 2
    const albedo = hexToLinear(b.color)
    if (f > 0.55) {
      const corners = []
      for (const x of [x0, x1]) for (const y of [b.y, top]) for (const z of [z0, z1]) corners.push(cam.project(x, y, z))
      if (corners.every(Boolean)) {
        const outline = hull(corners.map((c) => [sx(c), sy(c)]))
        let light = addLin(mixLin(L.ambGround, L.ambSky, 0.5), scaleLin(L.keyColor, 0.35))
        if (night) light = addLin(light, scaleLin(L.streetGlow, 0.05))
        const fill = quantise(shade(mulLin(albedo, light), b.x, b.y + b.h * 0.5, b.z))
        buildings.push({ kind: 'silhouette', depth: d, d: `M${outline.map((q) => q.join(',')).join('L')}Z`, fill })
        return
      }
    }
    const faces = []
    const win = []
    if (cx > x1) faces.push({ n: [1, 0, 0], q: [[x1, b.y, z1], [x1, b.y, z0], [x1, top, z0], [x1, top, z1]], w: b.d })
    if (cx < x0) faces.push({ n: [-1, 0, 0], q: [[x0, b.y, z0], [x0, b.y, z1], [x0, top, z1], [x0, top, z0]], w: b.d })
    if (cz > z1) faces.push({ n: [0, 0, 1], q: [[x0, b.y, z1], [x1, b.y, z1], [x1, top, z1], [x0, top, z1]], w: b.w })
    if (cz < z0) faces.push({ n: [0, 0, -1], q: [[x1, b.y, z0], [x0, b.y, z0], [x0, top, z0], [x1, top, z0]], w: b.w })
    const shapes = []
    faces.forEach((face) => {
      const poly = clipProject(cam, face.q)
      if (!poly) return
      const ndl = Math.max(0, face.n[0] * key[0] + face.n[1] * key[1] + face.n[2] * key[2])
      let light = addLin(mixLin(L.ambGround, L.ambSky, 0.5), scaleLin(L.keyColor, ndl))
      if (night) light = addLin(light, scaleLin(L.streetGlow, 0.05))
      const fill = shade(mulLin(albedo, light), b.x, b.y + b.h * 0.5, b.z)
      shapes.push({ points: pts(poly), fill })
      // windows: one overlay per facade, filled with its height class's pattern through an affine map from the
      // facade's metres (u along the bottom edge, y up from the street as -y) to the frame
      if (b.kind === 2 || d > (night ? 430 : 330) || f > 0.6) return
      const p0 = cam.project(...face.q[0])
      const p1 = cam.project(...face.q[1])
      const p3 = cam.project(...face.q[3])
      if (!p0 || !p1 || !p3) return
      const ax = (sx(p1) - sx(p0)) / face.w
      const ay = (sy(p1) - sy(p0)) / face.w
      if (Math.hypot(ax, ay) * face.w < 10) return
      const bx = (sx(p0) - sx(p3)) / b.h
      const by = (sy(p0) - sy(p3)) / b.h
      const cls = windowClass(b)
      const variant = hashU32(b.seed + face.n[0] * 7 + face.n[2] * 13) % WINDOW_VARIANTS
      windowCount += 1
      win.push({
        m: [ax, ay, bx, by, sx(p0), sy(p0)].map((v) => Math.round(v * 1000) / 1000).join(' '),
        w: r1(face.w),
        h: r1(Math.max(0, b.h - 0.6)),
        pattern: `${cls}${variant}`,
        o: +(night ? (1 - f) * 0.9 : (1 - f) * 0.55).toFixed(3),
      })
    })
    if (top < cy) {
      const roof = clipProject(cam, [[x0, top, z0], [x1, top, z0], [x1, top, z1], [x0, top, z1]])
      if (roof) shapes.push({ points: pts(roof), fill: shade(mulLin(albedo, scaleLin(addLin(L.ambSky, scaleLin(L.keyColor, key[1])), 0.55)), b.x, top, b.z) })
    }
    if (shapes.length) buildings.push({ kind: 'building', depth: d, shapes, windows: win })
  })

  /* ---- story moment (the same poster state as the reduced-motion 3D still) ---- */
  const state = createFrameState(city.sites.length, city.hqs.length)
  const t = HERO_POSTER_TIME
  const u = STILL_PROGRESS[stage] ?? 1
  stageState(state, stage, { t: stage === 'hero' ? t : 6, u, sites })

  const markers = { rings: [], beams: [], ghosts: [], caps: [], arcs: [], beacons: [], labels: [], pin: null, scan: null }
  const label = (text, glyph, glyphColor, world, opacity) => {
    const p = cam.project(...world)
    if (!p || opacity < 0.3 || p.x < -1.05 || p.x > 1.05 || p.y < -0.9 || p.y > 0.92) return
    const textPx = 15 * pxPerUnit
    const width = (text.length * 8.6 + (glyph ? 22 : 0) + 22) * pxPerUnit
    const height = 29 * pxPerUnit
    // kept inside the frame like the live scene's signs (sideways, or down from the top edge)
    const safe = 12 * pxPerUnit
    const x = Math.min(Math.max(sx(p), width / 2 + safe), W - width / 2 - safe)
    const y = Math.max(sy(p), height + safe)
    markers.labels.push({ x: r1(x), y: r1(y), text, glyph, glyphColor, w: r1(width), h: r1(height), font: r1(textPx) })
  }
  sites.forEach((site, i) => {
    const s = state.sites[i]
    if (s.alpha < 0.05) return
    const color = s.report > s.detect ? MARKING_YELLOW : s.resolve > 0.5 ? RESOLVED_GREEN : site.severityColor
    const base = cam.project(site.x, 0, site.z)
    if (base) {
      const k = unitScale(base.depth)
      const { dist } = fogAt(site.x, 0, site.z)
      markers.rings.push({ cx: sx(base), cy: sy(base), rx: r1(4.2 * k), ry: r1(4.2 * k * Math.max(0.12, cy / Math.max(dist, 1))), color: markerColor(color) })
    }
    if (s.height > 1 && s.detect > 0.3) {
      const top = cam.project(site.x, s.height, site.z)
      if (base && top) {
        const k = unitScale(base.depth)
        const beam = {
          kind: 'beam',
          depth: Math.hypot(site.x - cx, s.height * 0.5 - cy, site.z - cz),
          x1: sx(base),
          y1: sy(base),
          x2: sx(top),
          y2: sy(top),
          w: r1(Math.max(2, 2.2 * k * (s.column ? 2 : 1))),
          color: markerColor(color),
          cap: { cx: sx(top), cy: sy(top), r: r1(Math.max(3, 2.6 * k)) },
        }
        markers.beams.push(beam)
        // priority columns show through the buildings in front of them, as in the live scene's x-ray pass
        if (s.column > 0.5) markers.ghosts.push(beam)
      }
    }
    if (s.arcAlpha > 0.05 && s.arcDraw > 0.02) {
      const hq = hqs.find((h) => h.index === site.hq) ?? hqs[0]
      const a = [site.x, 1.2, site.z]
      const bpt = [hq.x, hq.top + 2.2, hq.z]
      const span = Math.hypot(bpt[0] - a[0], bpt[2] - a[2])
      const lift = Math.max(a[1], bpt[1]) + span * 0.24 + 10
      const c1 = [a[0] + (bpt[0] - a[0]) * 0.2, lift, a[2] + (bpt[2] - a[2]) * 0.2]
      const c2 = [a[0] + (bpt[0] - a[0]) * 0.72, lift + 4, a[2] + (bpt[2] - a[2]) * 0.72]
      const path = []
      const steps = 28
      for (let k = 0; k <= steps; k += 1) {
        const tt = (k / steps) * Math.min(1, s.arcDraw)
        const v = 1 - tt
        const p = cam.project(
          a[0] * v * v * v + 3 * c1[0] * v * v * tt + 3 * c2[0] * v * tt * tt + bpt[0] * tt * tt * tt,
          a[1] * v * v * v + 3 * c1[1] * v * v * tt + 3 * c2[1] * v * tt * tt + bpt[1] * tt * tt * tt,
          a[2] * v * v * v + 3 * c1[2] * v * v * tt + 3 * c2[2] * v * tt * tt + bpt[2] * tt * tt * tt,
        )
        if (p) path.push(`${sx(p)},${sy(p)}`)
      }
      if (path.length > 2) markers.arcs.push({ d: `M${path.join('L')}`, color: markerColor(hq.color), o: +Math.min(1, s.arcAlpha + 0.25).toFixed(2) })
    }
    const anchor = [site.x, Math.max(s.height, 6) + 2.4, site.z]
    if (s.labelResolve > 0.5) label(GENERIC_LABELS.resolved, 'check', RESOLVED_GREEN, anchor, s.labelResolve)
    else if (s.labelDetect > 0.5) label(site.label, 'dot', site.severityColor, anchor, s.labelDetect)
    if (s.labelReport > 0.5) label(GENERIC_LABELS.report, 'pin', MARKING_YELLOW, [site.x, 7.8, site.z], s.labelReport)
  })
  hqs.forEach((hq) => {
    const p = cam.project(hq.x, hq.top + 1.4, hq.z)
    if (p) markers.beacons.push({ cx: sx(p), cy: sy(p), r: r1(Math.max(3, unitScale(p.depth) * 2.2)), color: markerColor(hq.color) })
    if ((state.hqLabel[hq.index] ?? 0) > 0.5) label(hq.name ?? GENERIC_LABELS.department, 'hq', hq.color, [hq.x, hq.top + 6, hq.z], 1)
  })
  if (state.pin.alpha > 0.5) {
    const site = sites.find((s) => s.index === 3) ?? sites[0]
    const p = cam.project(site.x, 2.4, site.z)
    if (p) markers.pin = { x: sx(p), y: sy(p), s: r1(unitScale(p.depth) * 1.6), color: markerColor(MARKING_YELLOW) }
  }
  if (state.scanAmp > 0.05) {
    const x = state.scanPos
    const sheet = clipProject(cam, [[x, 0, -250], [x, 0, 250], [x, 40, 250], [x, 40, -250]])
    const line = []
    for (let k = -10; k <= 10; k += 1) {
      const p = cam.project(x, 0.2, k * 25)
      if (p) line.push(`${sx(p)},${sy(p)}`)
    }
    const top = cam.project(x, 40, 0)
    const bottom = cam.project(x, 0, 0)
    markers.scan = {
      sheet: sheet ? pts(sheet) : null,
      line: line.length > 1 ? `M${line.join('L')}` : null,
      gradient: top && bottom ? { y1: sy(bottom), y2: sy(top) } : null,
      color: markerColor(night ? NIGHT.scan : DAWN.scan),
    }
  }

  // Buildings, lamp heads and beams in one far-to-near list, so nearer buildings hide what is behind them.
  const sorted = [...buildings, ...heads, ...markers.beams].sort((a, b) => b.depth - a.depth)
  const items = []
  sorted.forEach((item) => {
    const last = items[items.length - 1]
    if (item.kind === 'silhouette' && last?.kind === 'silhouette' && last.fill === item.fill) last.d += item.d
    else items.push(item.kind === 'silhouette' ? { ...item } : item)
  })

  return {
    W: r1(W),
    H,
    night,
    horizonY,
    sky,
    ground: { near: groundNear, far: groundFar, lot: shade(lotColor, rig.tx, 0, rig.tz) },
    streets,
    pools,
    items,
    windowCount,
    windowPatterns: windowPatterns(night, windowColors),
    markings,
    lights: lightColors,
    markers,
    vignetteX: r1((0.5 + rig.sx * 0.42) * 100),
    vignetteY: r1((0.5 - rig.sy * 0.3) * 100),
  }
}

const STILL_CACHE_LIMIT = 8
const stills = new Map()

/** What castCity reads from the categories, as a string (the API returns a new array on every fetch). */
function categoriesKey(categories) {
  if (!Array.isArray(categories)) return ''
  return categories
    .map((c) => [c?.is_active !== false, c?.name, c?.department_detail?.id, c?.department_detail?.name, c?.department_detail?.color].join('~'))
    .join('|')
}

/** buildStill() with a small LRU cache keyed by everything the model depends on. */
export function getStill(options) {
  const { stage = 'hero', theme = 'dark', aspect = 16 / 9, framing = 'auto', categories, pxPerUnit = 1 } = options
  // `framing` is a name, an "x y zoom" string or a { x, y, zoom } composition (rig.js): keyed by value.
  const framingKey = framing && typeof framing === 'object' ? JSON.stringify(framing) : String(framing)
  const key = [stage, theme, aspect, framingKey, pxPerUnit, categoriesKey(categories)].join('#')
  const hit = stills.get(key)
  if (hit) {
    stills.delete(key)
    stills.set(key, hit)
    return hit
  }
  const model = buildStill(options)
  stills.set(key, model)
  if (stills.size > STILL_CACHE_LIMIT) stills.delete(stills.keys().next().value)
  return model
}
