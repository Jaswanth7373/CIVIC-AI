/**
 * Lazy entry points of the modules that import three.js / @react-three/fiber.
 *
 * Importing `@/components/three` must never pull the `three` chunk into a page bundle: everything that touches
 * three is reached through these wrappers, which load their module on first render (React.lazy) or earlier through
 * `Component.preload()`. SceneCanvas preloads the canvas host and the scene components it is given in parallel, so
 * the R3F tree never suspends; once a module has loaded, the wrapper renders it directly (no Suspense round trip).
 *
 * `preload({ props, quality })` also lets a scene get ready for the canvas it is about to be shown in: when the
 * loaded component has a static `prepare(props, { quality })`, it runs before the promise resolves (CityScene
 * builds its district there, in idle slices). A failed prepare is not fatal: the scene then prepares on mount.
 */
import { createElement, lazy } from 'react'

function lazyComponent(load, name) {
  let Loaded = null
  let pending = null

  const loadModule = () => {
    if (Loaded) return Promise.resolve(Loaded)
    if (!pending) {
      pending = load().then(
        (module) => {
          Loaded = module.default
          return Loaded
        },
        (error) => {
          pending = null
          throw error
        },
      )
    }
    return pending
  }

  /** Starts (or joins) the chunk download; resolves to the component. A failed download can be retried. */
  const preload = (options) =>
    loadModule().then((component) => {
      if (!options || typeof component.prepare !== 'function') return component
      return Promise.resolve()
        .then(() => component.prepare(options.props ?? {}, options))
        .catch(() => undefined)
        .then(() => component)
    })

  const Suspending = lazy(() => loadModule().then((component) => ({ default: component })))

  function LazyScene(props) {
    return createElement(Loaded ?? Suspending, props)
  }
  LazyScene.displayName = name
  LazyScene.preload = preload
  return LazyScene
}

/** The R3F <Canvas> host used by SceneCanvas (renderer, frame monitor, scene context). */
export const SceneCanvasHost = lazyComponent(() => import('./SceneCanvasHost.jsx'), 'SceneCanvasHost')

/** The procedural district (render inside SceneCanvas). */
export const CityScene = lazyComponent(() => import('./city/CityScene.jsx'), 'CityScene')

/** The admin "City pulse" columns scene (rendered by CityPulse3D). */
export const PulseScene = lazyComponent(() => import('./pulse/PulseScene.jsx'), 'PulseScene')
