/**
 * The CivicAI district: one deterministic, procedural city shared by the 3D scene (CityScene) and the SVG still
 * (CityFallback), so both always show the same streets, blocks, lights and landmarks. Pure JS, no three.js.
 *
 * World units are metres. Streets run on a 34 m grid: "x-streets" along x at z = j * pitch, "z-streets" along z at
 * x = i * pitch. The x-street j = 0 is a four-lane avenue. Blocks between streets hold buildings (taller towards the
 * core), parks with trees, and the department headquarters (landmarks with a roof beacon). Street lamps stand on
 * both kerbs in a regular lattice (a few are broken). The hash below is bit-identical in JS and GLSL (uint32
 * lowbias32): the building shader uses it for its window pattern, the scene for lamp states, the still for both.
 *
 * Issue sites are fixed places on the carriageways where the illustrated civic issues appear; HQ slots are where
 * the department landmarks stand. Neither carries data: names and colours come from the categories prop.
 */

export const CITY = Object.freeze({
  pitch: 34,
  core: 4,
  outer: 11,
  road: 4.0,
  avenue: 7.0,
  sidewalk: 2.4,
  floor: 3.2,
  lampHeight: 7.2,
  lampArm: 1.7,
  lampInset: 0.6,
  lampSlotA: 0.27,
  lampSlotB: 0.73,
  brokenLamps: 0.035,
})

/* ---- Hash (identical in GLSL: see shaders.js HASH) ----------------------------------------------------------- */

export function hashU32(value) {
  let x = value >>> 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b) >>> 0
  x ^= x >>> 16
  return x >>> 0
}

export function hash3(a, b, c) {
  return hashU32((a >>> 0) ^ hashU32((b >>> 0) ^ hashU32(c >>> 0)))
}

/** 24-bit unit float (exactly representable in float32, so GLSL gets the same value). */
export const unit = (h) => (h >>> 8) / 16777216


/* ---- Street geometry ------------------------------------------------------------------------------------------ */

/** Half width of the carriageway of x-street j (the avenue is j = 0). */
export const xStreetHalf = (j) => (j === 0 ? CITY.avenue : CITY.road)
/** Half width of the carriageway of z-street i. */
export const zStreetHalf = () => CITY.road

/** Inner (building line) rectangle of block (bi, bj). */
export function lotRect(bi, bj) {
  const { pitch, sidewalk } = CITY
  return {
    x0: bi * pitch + zStreetHalf(bi) + sidewalk,
    x1: (bi + 1) * pitch - zStreetHalf(bi + 1) - sidewalk,
    z0: bj * pitch + xStreetHalf(bj) + sidewalk,
    z1: (bj + 1) * pitch - xStreetHalf(bj + 1) - sidewalk,
  }
}

/* ---- Landmarks: parks, HQ slots, issue sites ------------------------------------------------------------------ */

/** Blocks laid out as parks (bi, bj). */
export const PARK_BLOCKS = Object.freeze([
  [-1, 0],
  [-2, 1],
  [2, -3],
  [-3, -2],
])

/** Department headquarters: one landmark per slot, centred in its block, on a paved plaza. */
export const HQ_SLOTS = Object.freeze([
  { block: [0, -2], height: 46, size: 12.5 },
  { block: [2, -1], height: 41, size: 12 },
  { block: [1, -4], height: 44, size: 12 },
  { block: [-1, -3], height: 40, size: 11.5 },
  { block: [3, 0], height: 38, size: 11.5 },
  { block: [-2, -2], height: 39, size: 11.5 },
])

const P = CITY.pitch

/** A place in the middle of a lane: on x-street / z-street `street`, `along` pitches along it, lane side +-1. */
function onStreet(axis, street, along, lane) {
  if (axis === 'x') return Object.freeze({ x: along * P, z: street * P + lane * xStreetHalf(street) * 0.5, axis })
  return Object.freeze({ x: street * P + lane * zStreetHalf(street) * 0.5, z: along * P, axis })
}

/**
 * Places on carriageways where illustrated issues appear, in the order the scan reaches them (left to right).
 * `axis` is the direction of the street the site is on.
 */
export const ISSUE_SITES = Object.freeze([
  onStreet('x', 0, -1.45, 1),
  onStreet('z', -1, 1.4, -1),
  onStreet('x', -1, -0.4, -1),
  onStreet('x', 0, 0.45, -1),
  onStreet('z', 1, 0.5, 1),
  onStreet('x', 1, 1.3, 1),
  onStreet('z', 2, -1.35, -1),
  onStreet('x', 0, 2.4, 1),
  onStreet('z', 3, 1.3, 1),
  onStreet('x', -1, 3.35, 1),
])

/** The issue the report / analyze stages follow (index into ISSUE_SITES). */
export const PINNED_SITE = 3

const isPark = (bi, bj) => PARK_BLOCKS.some(([a, b]) => a === bi && b === bj)
const hqAt = (bi, bj) => HQ_SLOTS.findIndex(({ block: [a, b] }) => a === bi && b === bj)

/* ---- Palette (sRGB hex; the scene converts to linear) --------------------------------------------------------- */

const FACADES = ['#b9b4aa', '#a9a49b', '#c9c3b7', '#9a9a94', '#b7ad9f', '#8f9592', '#c2bbb0', '#a39a8e', '#b2aea6']
const OFFICE_FACADES = ['#7f8b8e', '#6f7c80', '#8b979a', '#76848a']
const ACCENT_FACADES = ['#a8826a', '#9c7b66', '#8e8a7c']

function pick(list, h) {
  return list[Math.floor(unit(h) * list.length) % list.length]
}

/* ---- Generator ------------------------------------------------------------------------------------------------- */

function coreFactor(x, z) {
  const dx = x - 20
  const dz = z + 8
  return Math.exp(-(dx * dx + dz * dz) / (2 * 72 * 72))
}

/**
 * @returns {{ buildings: object[], lamps: object[], trees: object[], hqs: object[], sites: object[],
 *   parks: number[][], extent: number, coreExtent: number }}
 *   building: { x, z, w, d, h, y, color, kind (0 residential | 1 office | 2 roof prop | 3 HQ), seed, ring }
 *   lamp: { id, x, z, hx, hz, dirX, dirZ, broken, cool, core, ring }
 */
function generate() {
  const { pitch, core, outer, floor } = CITY
  const buildings = []
  const trees = []
  const hqs = []

  const addBuilding = (b) => buildings.push(b)

  for (let bi = -outer; bi < outer; bi += 1) {
    for (let bj = -outer; bj < outer; bj += 1) {
      const ring = Math.max(Math.abs(bi + 0.5), Math.abs(bj + 0.5)) + 0.5
      const lot = lotRect(bi, bj)
      const seed = hash3(bi + 101, bj + 211, 17)
      const hqIndex = hqAt(bi, bj)

      if (isPark(bi, bj)) {
        // Trees on a jittered grid, leaving the two crossing paths free.
        const cx = (lot.x0 + lot.x1) / 2
        const cz = (lot.z0 + lot.z1) / 2
        for (let gx = lot.x0 + 2.4; gx < lot.x1 - 1.6; gx += 4.2) {
          for (let gz = lot.z0 + 2.4; gz < lot.z1 - 1.6; gz += 4.2) {
            const h = hash3(Math.round(gx * 10), Math.round(gz * 10), 5)
            const x = gx + (unit(h) - 0.5) * 2.2
            const z = gz + (unit(hashU32(h)) - 0.5) * 2.2
            if (Math.abs(x - cx) < 1.6 || Math.abs(z - cz) < 1.6) continue
            if (unit(hashU32(h + 7)) < 0.18) continue
            const r = 1.5 + unit(hashU32(h + 3)) * 1.3
            trees.push({ x, z, r, h: 3.6 + r * 1.6, tone: unit(hashU32(h + 9)) })
          }
        }
        continue
      }

      if (hqIndex >= 0) {
        const slot = HQ_SLOTS[hqIndex]
        const cx = (lot.x0 + lot.x1) / 2
        const cz = (lot.z0 + lot.z1) / 2
        const s = slot.size
        hqs.push({ index: hqIndex, x: cx, z: cz, size: s, height: slot.height, top: slot.height + 3.2 })
        // Podium, shaft, crown: a stepped landmark that reads at a distance.
        addBuilding({ x: cx, z: cz, w: s + 5, d: s + 5, h: 7, y: 0, color: '#9aa29f', kind: 1, seed, ring, hq: hqIndex })
        addBuilding({ x: cx, z: cz, w: s, d: s, h: slot.height, y: 0, color: '#8a989b', kind: 3, seed: seed + 1, ring, hq: hqIndex })
        addBuilding({ x: cx, z: cz, w: s * 0.62, d: s * 0.62, h: 3.2, y: slot.height, color: '#6e7a7c', kind: 2, seed, ring, hq: hqIndex })
        // Low pavilions at two corners of the plaza.
        addBuilding({ x: lot.x0 + 2.6, z: lot.z0 + 2.6, w: 4.4, d: 4.4, h: 3.6, y: 0, color: '#a7aaa3', kind: 0, seed: seed + 5, ring })
        addBuilding({ x: lot.x1 - 2.6, z: lot.z1 - 2.6, w: 4.4, d: 4.4, h: 3.6, y: 0, color: '#a7aaa3', kind: 0, seed: seed + 6, ring })
        continue
      }

      const inCore = ring <= core
      const nx = inCore ? 2 + (unit(seed) < 0.45 ? 1 : 0) : 1 + Math.floor(unit(hashU32(seed + 1)) * 2.2)
      const nz = inCore ? 2 + (unit(hashU32(seed)) < 0.45 ? 1 : 0) : 1 + Math.floor(unit(hashU32(seed + 2)) * 2.2)
      const width = lot.x1 - lot.x0
      const depth = lot.z1 - lot.z0
      // Lot boundaries with jitter, so blocks do not look stamped.
      const xs = [lot.x0]
      for (let k = 1; k < nx; k += 1) xs.push(lot.x0 + (width * k) / nx + (unit(hash3(bi, bj, 40 + k)) - 0.5) * 2.6)
      xs.push(lot.x1)
      const zs = [lot.z0]
      for (let k = 1; k < nz; k += 1) zs.push(lot.z0 + (depth * k) / nz + (unit(hash3(bi, bj, 60 + k)) - 0.5) * 2.6)
      zs.push(lot.z1)

      for (let a = 0; a < nx; a += 1) {
        for (let b = 0; b < nz; b += 1) {
          const h = hash3(bi * 7 + a, bj * 7 + b, 3)
          const interior = a > 0 && a < nx - 1 && b > 0 && b < nz - 1
          if (interior && unit(h) < 0.7) continue // courtyard
          if (unit(hashU32(h + 4)) < (inCore ? 0.1 : 0.22)) continue // open lots, parking
          const gapW = a === 0 ? 0 : 0.9
          const gapE = a === nx - 1 ? 0 : 0.9
          const gapS = b === 0 ? 0 : 0.9
          const gapN = b === nz - 1 ? 0 : 0.9
          const x0 = xs[a] + gapW
          const x1 = xs[a + 1] - gapE
          const z0 = zs[b] + gapS
          const z1 = zs[b + 1] - gapN
          const cx = (x0 + x1) / 2
          const cz = (z0 + z1) / 2
          const cf = coreFactor(cx, cz)
          const onAvenue = bj === 0 || bj === -1 ? (b === 0 && bj === 0) || (b === nz - 1 && bj === -1) : false
          const r1 = unit(hashU32(h + 11))
          const r2 = unit(hashU32(h + 12))
          let floors
          if (inCore) floors = 1.6 + cf * 4 + r1 * (1.4 + cf * 3.6) + (onAvenue ? 1 : 0)
          else floors = 1.2 + r1 * 2.6 + (r2 > 0.94 && ring < outer - 1 ? 4 + r2 * 3 : 0)
          floors = Math.max(2, Math.min(14, Math.round(floors)))
          const office = floors > 6 && r2 > 0.45
          const color = office ? pick(OFFICE_FACADES, h + 21) : r2 < 0.12 ? pick(ACCENT_FACADES, h + 22) : pick(FACADES, h + 23)
          const height = floors * floor + 0.7
          addBuilding({ x: cx, z: cz, w: x1 - x0, d: z1 - z0, h: height, y: 0, color, kind: office ? 1 : 0, seed: h, ring })

          // Setback tower on tall core buildings.
          if (inCore && floors >= 8 && r1 > 0.6) {
            const shrink = 0.6 + unit(hashU32(h + 30)) * 0.15
            const extra = (2 + Math.round(unit(hashU32(h + 31)) * 2)) * floor
            addBuilding({
              x: cx + (unit(hashU32(h + 32)) - 0.5) * (x1 - x0) * (1 - shrink) * 0.6,
              z: cz + (unit(hashU32(h + 33)) - 0.5) * (z1 - z0) * (1 - shrink) * 0.6,
              w: (x1 - x0) * shrink,
              d: (z1 - z0) * shrink,
              h: extra,
              y: height,
              color,
              kind: office ? 1 : 0,
              seed: h + 77,
              ring,
            })
          }

          // Roof props (plant rooms, water tanks) in the core.
          if (inCore && (x1 - x0) > 5 && (z1 - z0) > 5) {
            const count = Math.floor(unit(hashU32(h + 40)) * 3)
            for (let k = 0; k < count; k += 1) {
              const hp = hashU32(h + 50 + k)
              const pw = 1.4 + unit(hp) * 2.2
              const pd = 1.4 + unit(hashU32(hp)) * 2.2
              const px = x0 + pw / 2 + 0.8 + unit(hashU32(hp + 1)) * Math.max(0, x1 - x0 - pw - 1.6)
              const pz = z0 + pd / 2 + 0.8 + unit(hashU32(hp + 2)) * Math.max(0, z1 - z0 - pd - 1.6)
              const ph = 1.2 + unit(hashU32(hp + 3)) * 2.4
              addBuilding({ x: px, z: pz, w: pw, d: pd, h: ph, y: height, color: '#7d817c', kind: 2, seed: hp, ring })
            }
          }
        }
      }

      // Courtyard trees in a few core blocks.
      if (inCore && unit(hashU32(seed + 90)) < 0.35) {
        const cx = (lot.x0 + lot.x1) / 2
        const cz = (lot.z0 + lot.z1) / 2
        trees.push({ x: cx, z: cz, r: 2.1, h: 6.2, tone: unit(hashU32(seed + 91)) })
      }
    }
  }

  // Street trees on both kerbs of the avenue, between the lamps.
  for (let i = -outer; i < outer; i += 1) {
    for (const side of [-1, 1]) {
      for (const f of [0.5]) {
        const x = i * pitch + f * pitch
        const z = side * (CITY.avenue + 1.2)
        const h = hash3(i, side, 71)
        if (Math.abs(i + 0.5) > core + 2) continue
        trees.push({ x, z, r: 1.6 + unit(h) * 0.5, h: 5.2 + unit(h) * 1.4, tone: unit(hashU32(h)) })
      }
    }
  }

  return { buildings, trees, hqs, lamps: generateLamps() }
}

/**
 * Street lamps. x-streets: kerb +1 at slot A, kerb -1 at slot B of every segment (the avenue has both slots on
 * both kerbs). z-streets: kerb +1 at slot A, kerb -1 at slot B. `orient` 0 = x-street, 1 = z-street.
 */
export function lampId(orient, street, segment, side) {
  return hash3(street + 1000 * orient, segment, side)
}

export function isBrokenLamp(orient, street, segment, side) {
  return unit(lampId(orient, street, segment, side)) < CITY.brokenLamps
}

function generateLamps() {
  const { pitch, outer, core, lampInset, lampArm, lampSlotA, lampSlotB } = CITY
  const lamps = []
  for (let street = -outer; street <= outer; street += 1) {
    for (let segment = -outer; segment < outer; segment += 1) {
      // x-street `street` (along x, at z = street * pitch)
      const half = xStreetHalf(street)
      const slotsX = street === 0 ? [[1, lampSlotA], [1, lampSlotB], [-1, lampSlotA], [-1, lampSlotB]] : [[1, lampSlotA], [-1, lampSlotB]]
      for (const [side, slot] of slotsX) {
        const x = (segment + slot) * pitch
        const z = street * pitch + side * (half + lampInset)
        const ring = Math.max(Math.abs(x), Math.abs(z)) / pitch
        lamps.push({
          id: lampId(0, street, segment, side),
          x,
          z,
          hx: x,
          hz: z - side * lampArm,
          dirX: 0,
          dirZ: -side,
          broken: isBrokenLamp(0, street, segment, side),
          cool: street === 0,
          core: ring <= core + 0.5,
          ring,
        })
      }
      // z-street `street` (along z, at x = street * pitch)
      const halfZ = zStreetHalf(street)
      for (const [side, slot] of [[1, lampSlotA], [-1, lampSlotB]]) {
        const z = (segment + slot) * pitch
        const x = street * pitch + side * (halfZ + lampInset)
        const ring = Math.max(Math.abs(x), Math.abs(z)) / pitch
        lamps.push({
          id: lampId(1, street, segment, side),
          x,
          z,
          hx: x - side * lampArm,
          hz: z,
          dirX: -side,
          dirZ: 0,
          broken: isBrokenLamp(1, street, segment, side),
          cool: false,
          core: ring <= core + 0.5,
          ring,
        })
      }
    }
  }
  return lamps
}

let cachedCity = null

/** The district (generated once, then cached: it is deterministic). */
export function getCity() {
  if (!cachedCity) {
    const generated = generate()
    cachedCity = Object.freeze({
      ...generated,
      sites: ISSUE_SITES,
      parks: PARK_BLOCKS,
      extent: CITY.outer * CITY.pitch,
      coreExtent: CITY.core * CITY.pitch,
    })
  }
  return cachedCity
}
