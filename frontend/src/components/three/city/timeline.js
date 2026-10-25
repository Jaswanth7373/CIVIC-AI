/**
 * Choreography of the city: what is happening at a given moment of each stage, as plain numbers.
 *
 * Every function writes a target "frame state" (scan position, per-site detection / resolve / beam height / arc
 * draw / labels, HQ flares, the report pin); the scene eases its visuals towards it. Being a pure function of time
 * (hero, calm) or of progress u in [0, 1] (story stages), the same code yields the scroll-scrubbed story, the
 * looping hero and the single poster frame used with prefers-reduced-motion.
 */
import { ISSUE_SITES, PINNED_SITE } from './layout'

export const HERO_CYCLE = 15
export const SCAN_START = -118
export const SCAN_SPEED = 30
// Featured sites (sign labels, department labels) stand in the middle and back of the district, where their signs
// stay clear of the landing hero's dispatch card, which floats over the front-right corner of the district.
const SETS = [
  { sites: [0, 2, 3, 5, 7, 9], featured: [3, 7] },
  { sites: [1, 3, 4, 6, 8], featured: [4, 6] },
]
/** Sites that the story stages (route / verify) follow, pinned issue first. */
export const STORY_SITES = [PINNED_SITE, 2, 4, 6, 0]
/**
 * The prioritize stage ranks four issues, one per severity level of the cast (sites 5 critical, 3 high - the reported
 * issue - 2 medium, 4 low). They stand almost on one line across the camera's view, so no column hides another.
 */
export const PRIORITY_SITES = [5, PINNED_SITE, 2, 4]
/** Seconds a story stage takes when no scroll progress drives it (then it holds its final state). */
export const STAGE_DURATION = Object.freeze({ report: 2.6, analyze: 3.6, prioritize: 2.8, route: 3.8, verify: 3.4 })
/** Beam height per illustrative severity (metres); columns in the prioritize stage are taller. */
export const BEAM_HEIGHT = Object.freeze({ low: 20, medium: 26, high: 32, critical: 40 })
export const COLUMN_HEIGHT = Object.freeze({ low: 14, medium: 26, high: 38, critical: 52 })
/** Hero poster moment (reduced motion): scan mid-district, a label and an arc on screen. */
export const HERO_POSTER_TIME = (ISSUE_SITES[PINNED_SITE].x - SCAN_START) / SCAN_SPEED + 2.05

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
export const smooth = (a, b, v) => {
  const t = clamp01((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const easeOutBack = (t) => {
  const c = 1.4
  const x = t - 1
  return 1 + (c + 1) * x * x * x + c * x * x
}

export function createFrameState(siteCount, hqCount) {
  return {
    scanPos: -400,
    scanAmp: 0,
    sites: Array.from({ length: siteCount }, () => ({
      detect: 0,
      resolve: 0,
      height: 0,
      column: 0,
      alpha: 0,
      report: 0,
      arcDraw: 0,
      arcAlpha: 0,
      packet: 0,
      labelDetect: 0,
      labelResolve: 0,
      labelReport: 0,
    })),
    hqFlare: new Array(hqCount).fill(0),
    hqLabel: new Array(hqCount).fill(0),
    pin: { alpha: 0, drop: 1, land: 1 },
  }
}

function reset(state) {
  state.scanAmp = 0
  state.sites.forEach((s) => {
    s.detect = 0
    s.resolve = 0
    s.height = 0
    s.column = 0
    s.alpha = 0
    s.report = 0
    s.arcDraw = 0
    s.arcAlpha = 0
    s.packet = 0
    s.labelDetect = 0
    s.labelResolve = 0
    s.labelReport = 0
  })
  state.hqFlare.fill(0)
  state.hqLabel.fill(0)
  state.pin.alpha = 0
  state.pin.drop = 1
  state.pin.land = 1
}

/** Routing: arc draw, the packet riding its head, the HQ flare on arrival. */
function route(state, siteState, hq, lt, start, duration, withLabel) {
  const draw = clamp01((lt - start) / duration)
  const since = lt - start - duration
  siteState.arcDraw = easeInOut(draw)
  siteState.arcAlpha = lt > start ? 1 - 0.8 * smooth(0.3, 1.8, since) : 0
  siteState.packet = draw > 0 && draw < 1 ? 1 : draw >= 1 ? Math.max(0, 1 - since * 4) : 0
  if (draw >= 1) {
    state.hqFlare[hq] = Math.max(state.hqFlare[hq], Math.exp(-since * 1.6))
    if (withLabel) state.hqLabel[hq] = Math.max(state.hqLabel[hq], smooth(0, 0.3, since) * (1 - smooth(1.6, 2.0, since)))
  }
}

/** Hero: a fixed issue keeps most of its beam (green, standing above the roofs) and a trace of its route. */
const HERO_FIXED_BEAM = 0.7
const HERO_FIXED_ARC = 0.35

/**
 * The looping hero: the scan sweeps the district; each site it crosses is detected, routed and resolved. The issues
 * fixed on the previous pass stay on the map (green beams, a trace of their routes) until this pass's scan reaches
 * and clears them, so the city never empties between two passes: at every moment of the loop some beam, sign or
 * arc is telling the story.
 */
export function heroState(state, t, sites) {
  reset(state)
  const cycle = Math.floor(t / HERO_CYCLE)
  const ct = t - cycle * HERO_CYCLE
  const set = SETS[cycle % SETS.length]
  const previous = SETS[(cycle + SETS.length - 1) % SETS.length]
  state.scanPos = SCAN_START + ct * SCAN_SPEED
  state.scanAmp = smooth(0, 0.8, ct) * (1 - smooth(9.4, 10.6, ct))
  sites.forEach((site, index) => {
    const s = state.sites[index]
    const lt = ct - (site.x - SCAN_START) / SCAN_SPEED
    if (lt >= 0 && set.sites.includes(index)) {
      const featured = set.featured.includes(index)
      s.detect = smooth(0, 0.6, lt)
      s.alpha = 1
      s.resolve = smooth(4.1, 4.9, lt)
      s.height = BEAM_HEIGHT[site.severity] * (1 - (1 - HERO_FIXED_BEAM) * s.resolve)
      route(state, s, site.hq, lt, 0.9, 1.5, featured)
      if (s.arcAlpha > 0) s.arcAlpha = Math.max(s.arcAlpha, HERO_FIXED_ARC)
      s.labelDetect = featured ? smooth(0.15, 0.5, lt) * (1 - smooth(3.1, 3.5, lt)) : 0
      s.labelResolve = featured ? smooth(4.5, 4.9, lt) * (1 - smooth(6.8, 7.2, lt)) : 0
    } else if (previous.sites.includes(index)) {
      // Fixed on the previous pass (the same end state as above), cleared as this pass's scan arrives.
      const clear = smooth(-0.4, 0.2, lt)
      s.detect = 1
      s.resolve = 1
      s.alpha = 1 - clear
      s.height = BEAM_HEIGHT[site.severity] * HERO_FIXED_BEAM
      s.arcDraw = 1
      s.arcAlpha = HERO_FIXED_ARC * (1 - clear)
    }
  })
}

/** The one resolved issue the calm stage (auth pages) frames; the calm camera (rig.js) looks down its street. */
export const CALM_SITE = 6

/** Background for the auth pages: one resolved site glowing softly, a slow survey pass every 20 s. */
export function calmState(state, t, sites) {
  reset(state)
  const period = 20
  const ct = t % period
  state.scanPos = SCAN_START - 20 + ct * 16
  state.scanAmp = 0.42 * smooth(0, 1.5, ct) * (1 - smooth(14, 17, ct))
  const s = state.sites[CALM_SITE]
  s.detect = 1
  s.resolve = 1
  s.alpha = 0.85
  s.height = BEAM_HEIGHT[sites[CALM_SITE].severity] * 0.45
}

export function reportState(state, u) {
  reset(state)
  const s = state.sites[PINNED_SITE]
  state.pin.alpha = 1
  state.pin.drop = clamp01(u / 0.55)
  state.pin.land = smooth(0.5, 0.62, u)
  s.report = smooth(0.52, 0.75, u)
  s.alpha = s.report
  s.labelReport = smooth(0.62, 0.86, u)
}

export function analyzeState(state, u, sites) {
  reset(state)
  const site = sites[PINNED_SITE]
  const s = state.sites[PINNED_SITE]
  state.pin.alpha = 1
  state.scanPos = site.x - 52 + u * 104
  state.scanAmp = smooth(0, 0.12, u) * (1 - smooth(0.88, 1, u))
  const lt = (u - 0.5) * 7
  s.report = 1 - smooth(0, 0.5, lt)
  s.detect = smooth(0, 0.6, lt)
  s.alpha = Math.max(s.report, s.detect)
  s.height = BEAM_HEIGHT[site.severity] * 0.42 * s.detect
  s.labelDetect = smooth(0.25, 0.7, lt)
}

/** Columns rise one after another in rank order (critical first), so the ranking is the motion. */
export function prioritizeState(state, u, sites) {
  reset(state)
  const ranked = [...PRIORITY_SITES].sort((a, b) => COLUMN_HEIGHT[sites[b].severity] - COLUMN_HEIGHT[sites[a].severity])
  ranked.forEach((index, rank) => {
    const s = state.sites[index]
    const grow = easeOutBack(clamp01(u * 1.6 - rank * 0.15))
    s.detect = 1
    s.alpha = 1
    s.column = 1
    s.height = COLUMN_HEIGHT[sites[index].severity] * Math.max(0.04, grow)
    s.labelDetect = rank < 2 ? smooth(0.6, 0.85, u) : 0
  })
}

export function routeState(state, u, sites) {
  reset(state)
  STORY_SITES.forEach((index, k) => {
    const s = state.sites[index]
    s.detect = 1
    s.alpha = 1
    s.height = BEAM_HEIGHT[sites[index].severity]
    // u -> pseudo time: each arc starts a little later than the previous one.
    const lt = u * 4.2
    route(state, s, sites[index].hq, lt, k * 0.42, 1.5, k < 3)
  })
}

export function verifyState(state, u, sites) {
  reset(state)
  STORY_SITES.forEach((index, k) => {
    const s = state.sites[index]
    s.detect = 1
    s.alpha = 1
    s.resolve = smooth(k * 0.12, k * 0.12 + 0.3, u)
    s.height = BEAM_HEIGHT[sites[index].severity] * (1 - 0.55 * s.resolve)
    s.arcDraw = 1
    s.arcAlpha = 0.45 * (1 - smooth(0.6, 1, u))
    s.labelResolve = k < 2 ? smooth(k * 0.12 + 0.25, k * 0.12 + 0.45, u) : 0
  })
}

/** Dispatch by stage. `u` is the stage progress (0..1), `t` the scene time (s). */
export function stageState(state, stage, { t, u, sites }) {
  switch (stage) {
    case 'report':
      return reportState(state, u)
    case 'analyze':
      return analyzeState(state, u, sites)
    case 'prioritize':
      return prioritizeState(state, u, sites)
    case 'route':
      return routeState(state, u, sites)
    case 'verify':
      return verifyState(state, u, sites)
    case 'calm':
      return calmState(state, t, sites)
    default:
      return heroState(state, t, sites)
  }
}

/** Progress used for the reduced-motion still of each story stage. */
export const STILL_PROGRESS = Object.freeze({ report: 1, analyze: 0.66, prioritize: 1, route: 0.62, verify: 1 })
