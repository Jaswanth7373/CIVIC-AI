/**
 * `useSceneQuality()` - how much 3D this device should get (no three.js import).
 *
 * Three tiers, chosen from what the browser tells us about the device:
 * - `high`: laptops and desktops with 8+ logical cores and 8 GB+ memory. Full post-processing (bloom at full
 *   resolution, grade, vignette, grain, edge chromatic aberration, near-field defocus), 4x MSAA, wet-street
 *   reflections, light cones, drizzle particles. Device pixel ratio capped at 1.5.
 * - `medium`: other laptops, tablets and capable phones. Bloom at half resolution + grade + vignette, lighter
 *   reflections and fewer particles. DPR capped at 1.25 on desktops, 1.5 on touch screens.
 * - `low`: phones with little memory or cores, Save-Data, two-core machines. These get the still `CityFallback`
 *   (no three.js download at all). A scene that was started on a higher tier can also drop to `low` at runtime,
 *   then it keeps rendering with grade + vignette only at DPR 1.
 *
 * Runtime: `SceneCanvas` samples the frame rate. Below 40 fps for 2 s the tier drops one step (high -> medium ->
 * low); below 30 fps for 3 s on `low` the 3D is switched off for the session and the still is shown. The drop is
 * shared by every scene of the tab (and remembered in sessionStorage), so the next page starts at the lower tier.
 *
 * Returns `{ tier, render3D, dpr: [min, max], baseTier, coarse, ...settings }`; the object is stable while the
 * inputs do not change. `max` (optional) caps the tier for a lighter scene (e.g. a dashboard card).
 */
import { useMemo, useSyncExternalStore } from 'react'

export const SCENE_TIERS = Object.freeze(['low', 'medium', 'high'])

/** Feature switches per tier. Scenes read them through SceneContext; nothing outside components/three needs them. */
export const TIER_SETTINGS = Object.freeze({
  high: Object.freeze({
    dpr: [1, 1.5],
    msaa: 4,
    bloom: true,
    bloomScale: 1,
    grain: true,
    aberration: true,
    particles: 1300,
    cones: true,
    reflections: 2,
    defocus: true,
    lightMap: 1024,
  }),
  medium: Object.freeze({
    dpr: [1, 1.25],
    msaa: 0,
    bloom: true,
    bloomScale: 0.5,
    grain: false,
    aberration: false,
    particles: 520,
    cones: true,
    reflections: 1,
    defocus: true,
    lightMap: 1024,
  }),
  low: Object.freeze({
    dpr: [1, 1],
    msaa: 0,
    bloom: false,
    bloomScale: 0.5,
    grain: false,
    aberration: false,
    particles: 0,
    cones: false,
    reflections: 0,
    defocus: false,
    lightMap: 512,
  }),
})

const CAP_KEY = 'civicai.scene.cap'
/** Runtime cap, lowest first. `none` = 3D switched off for this session. */
const CAP_ORDER = ['none', 'low', 'medium', 'high']
const rankOf = (value) => Math.max(0, CAP_ORDER.indexOf(value))

function readStoredCap() {
  try {
    const value = window.sessionStorage.getItem(CAP_KEY)
    return CAP_ORDER.includes(value) ? value : 'high'
  } catch {
    return 'high'
  }
}

let runtimeCap = typeof window === 'undefined' ? 'high' : readStoredCap()
const capListeners = new Set()

function subscribeCap(listener) {
  capListeners.add(listener)
  return () => capListeners.delete(listener)
}

const getCap = () => runtimeCap

/**
 * Lower the runtime tier one step below `fromTier` (called by the frame-rate monitor). Never raises it. Passing
 * `low` switches the 3D off for the rest of the session.
 */
export function lowerSceneTier(fromTier) {
  const next = CAP_ORDER[Math.max(0, rankOf(fromTier) - 1)]
  if (rankOf(next) >= rankOf(runtimeCap)) return
  runtimeCap = next
  try {
    window.sessionStorage.setItem(CAP_KEY, next)
  } catch {
    // Storage blocked: the cap still holds for this tab.
  }
  capListeners.forEach((listener) => listener())
}

/* ---- Device signals ------------------------------------------------------------------------------------------ */

const COARSE_QUERY = '(pointer: coarse)'

function widthBucket(width) {
  if (width < 640) return 'phone'
  if (width < 1024) return 'tablet'
  return 'desktop'
}

function subscribeEnvironment(onChange) {
  if (typeof window === 'undefined') return () => {}
  const media = window.matchMedia?.(COARSE_QUERY)
  window.addEventListener('resize', onChange, { passive: true })
  media?.addEventListener?.('change', onChange)
  return () => {
    window.removeEventListener('resize', onChange)
    media?.removeEventListener?.('change', onChange)
  }
}

function getEnvironment() {
  if (typeof window === 'undefined') return 'desktop|0'
  const coarse = Boolean(window.matchMedia?.(COARSE_QUERY).matches)
  return `${widthBucket(window.innerWidth)}|${coarse ? 1 : 0}`
}

/** Static tier from hardware hints. Unknown values (Safari hides memory) are treated generously. */
export function detectBaseTier(environment = getEnvironment()) {
  if (typeof window === 'undefined') return 'medium'
  const [bucket, coarseFlag] = environment.split('|')
  const coarse = coarseFlag === '1'
  const nav = window.navigator ?? {}
  const memory = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null
  const cores = Number(nav.hardwareConcurrency) || 4
  if (nav.connection?.saveData) return 'low'
  if (cores <= 2) return 'low'
  if (memory !== null && memory <= 2) return 'low'
  if (coarse) {
    // Touch-first devices: capable phones and tablets get the medium scene, small ones the still.
    if (memory !== null && memory < 4) return 'low'
    if (bucket === 'phone' && cores < 6) return 'low'
    return 'medium'
  }
  if (cores >= 8 && (memory === null || memory >= 8)) return 'high'
  return 'medium'
}

function minTier(...tiers) {
  return tiers.filter(Boolean).reduce((low, tier) => (SCENE_TIERS.indexOf(tier) < SCENE_TIERS.indexOf(low) ? tier : low))
}

/**
 * @param {object} [options]
 * @param {'high'|'medium'|'low'} [options.max] upper bound for the tier (a lighter scene)
 */
export function useSceneQuality({ max } = {}) {
  const environment = useSyncExternalStore(subscribeEnvironment, getEnvironment, () => 'desktop|0')
  const cap = useSyncExternalStore(subscribeCap, getCap, () => 'high')

  return useMemo(() => {
    const baseTier = detectBaseTier(environment)
    const coarse = environment.endsWith('|1')
    const capTier = cap === 'none' ? 'low' : cap
    const tier = minTier(baseTier, capTier, SCENE_TIERS.includes(max) ? max : 'high')
    const settings = TIER_SETTINGS[tier]
    const dpr = coarse && tier === 'medium' ? [1, 1.5] : settings.dpr
    return Object.freeze({
      ...settings,
      tier,
      baseTier,
      coarse,
      dpr,
      // The still is used when the device is low-tier from the start or the runtime monitor gave up on 3D.
      render3D: baseTier !== 'low' && cap !== 'none',
    })
  }, [environment, cap, max])
}

export default useSceneQuality
