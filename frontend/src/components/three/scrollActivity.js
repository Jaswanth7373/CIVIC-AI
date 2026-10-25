/**
 * Page scroll activity for the render loops (no three.js import): one passive listener for every scene.
 *
 * `isScrolling()` is true while the page scrolls and for SETTLE_MS after its last scroll event. The scenes then
 * draw every other frame (usePostPipeline): the picture stays on screen between draws, and the GPU time saved
 * goes to rastering the page tiles that scroll in, which is what made the landing's scroll uneven.
 */
const SETTLE_MS = 250

let until = 0
let listening = false

function onScroll() {
  until = performance.now() + SETTLE_MS
}

/** Starts listening (once per page); called by every SceneCanvas host. */
export function watchScroll() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('scroll', onScroll, { passive: true, capture: true })
}

export function isScrolling() {
  return listening && performance.now() < until
}
