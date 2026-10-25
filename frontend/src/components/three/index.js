/**
 * components/three - CivicAI's 3D layer.
 *
 * Importing this module never downloads three.js: every module that imports `three` / `@react-three/fiber` is
 * reached only through the lazy wrappers in lazyScenes.js, which SceneCanvas loads when a scene is about to be shown.
 *
 * - supportsWebGL() / getWebGLSupport(): hardware WebGL2 probe (software rasterisers count as "no"; synchronous,
 *   cached, remembered for the tab session). probeWebGL() / peekWebGLSupport(): the same answer asynchronously /
 *   without probing (null while unknown) - prefer these during a render.
 * - useSceneQuality({ max }): device tier ('high' | 'medium' | 'low'), DPR range and feature switches; lowered at
 *   runtime when the frame rate drops.
 * - <SceneCanvas className fallback label onReady frameloop interactive maxTier>: the only place a canvas is made.
 * - <CityScene stage categories progress interactive theme framing openingAt />: the procedural district (inside
 *   SceneCanvas). OPENING: the timing of its establishing shot (city/opening.js), for the page that cues with it.
 * - <CityFallback stage theme categories framing plates className />: the same district as an SVG still.
 * - <CityPulse3D clusters onSelect loading className />: the admin "City pulse" of real hotspot clusters.
 *
 * Start-up never produces a long main-thread task: the world is built in idle slices before the canvas mounts, the
 * WebGL context is made ready ahead, and every shader, texture and first draw is primed in small steps behind GPU
 * fences while the still is on screen (gpuTasks.js, city/prime.js). Session storage keys: `civicai.city.intro`,
 * `civicai.scene.cap`, `civicai.webgl`.
 */
export { getWebGLSupport, peekWebGLSupport, probeWebGL, supportsWebGL } from './webgl'
export { useSceneQuality } from './useSceneQuality'
export { SceneCanvas } from './SceneCanvas'
export { CityScene } from './lazyScenes'
export { OPENING } from './city/opening'
export { CityFallback } from './CityFallback'
export { CityPulse3D } from './CityPulse3D'
