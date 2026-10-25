/**
 * Runtime information that `SceneCanvas` hands to the scene rendered inside it (no three.js import).
 *
 * - `quality`: the `useSceneQuality()` result (tier + feature switches + DPR range).
 * - `reducedMotion`: prefers-reduced-motion. Scenes then render one composed still frame (no loop, no fly-in,
 *   no parallax); the canvas runs with `frameloop="demand"`.
 * - `interactive`: the canvas receives pointer events (otherwise it is a background and never blocks clicks).
 * - `claimReady()` / `markReady()`: a scene that composes its own first frame (post-processing, shader priming)
 *   calls `claimReady()` while rendering and `markReady()` after that frame is on screen. SceneCanvas then
 *   cross-fades from the fallback. Scenes that do not claim it are revealed after the first R3F frame. The
 *   adaptive-quality monitor only samples frame times once the scene is ready (start-up frames never count).
 */
import { createContext } from 'react'

export const SceneContext = createContext(null)
SceneContext.displayName = 'SceneContext'
