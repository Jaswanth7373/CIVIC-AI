import { useEffect } from 'react'

/**
 * When the component unmounts (the visitor leaves the page), cut every 3D scene layer inside `ref`'s element out
 * of the removed page: each canvas's topmost wrapper below that element is detached from it.
 *
 * Why: a WebGL renderer can outlive its page - three.js keeps a `dispose` listener on every geometry, material
 * and texture a renderer has drawn, and a resource shared at module level (never disposed) keeps those listeners,
 * and through them the renderer, its context and its canvas. A canvas still in its page holds the whole detached
 * page through its parent links (thousands of nodes per visit). Detached from it, a lingering renderer holds only
 * its own canvas and wrappers. Runs after React has removed the page (and does nothing while the element is still
 * in the document), so React never touches these nodes again.
 *
 * @param {import('react').RefObject<HTMLElement>} ref
 */
export function useReleaseScenes(ref) {
  useEffect(() => {
    const root = ref.current
    if (!root) return undefined
    return () => {
      // Still in the document: not a real unmount (Strict Mode's rehearsal in development) - leave it alone.
      if (root.isConnected) return
      root.querySelectorAll('canvas').forEach((canvas) => {
        let layer = canvas
        while (layer.parentElement && layer.parentElement !== root) layer = layer.parentElement
        if (layer.parentElement === root) layer.remove()
      })
    }
  }, [ref])
}

export default useReleaseScenes
