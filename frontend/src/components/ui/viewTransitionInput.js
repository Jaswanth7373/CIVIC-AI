/**
 * Keeps the page usable while a view transition animates (route cross-fades, the theme reveal).
 *
 * While a view transition runs, Chrome hit-tests its `::view-transition` layer as the page root: every click lands
 * on <html>, and the link or button under the pointer never receives it (`pointer-events: none` on the pseudo-
 * elements does not change that). Someone who clicks a second link while a page cross-fades (~360 ms), or a row
 * right after switching the theme (~620 ms), would simply lose the click - measured: of five sidebar links
 * clicked 120 ms apart, only two navigated.
 *
 * `keepInputLive(transition)` registers the transition the app has just started. While it runs, a click that
 * lands on <html> ends it at once (`skipTransition()`: the new state shows in full, which is what the user is
 * interacting with anyway) and is replayed on the element under the pointer: a click event with the same
 * coordinates, button and modifier keys, so React handlers, links (React Router) and native activation
 * (checkboxes, form submits) behave as if the transition had not been there. A text field is focused as well.
 */

const TEXT_ENTRY = 'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]), textarea, select, [contenteditable="true"]'

/** The view transition currently running, if the app started one. */
let current = null
let listening = false

function replayBlockedClick(event) {
  const transition = current
  if (!transition || !event.isTrusted || event.target !== document.documentElement) return
  current = null
  try {
    transition.skipTransition()
  } catch {
    // Already finished.
  }
  // With the transition layer gone, hit testing reaches the page again. A synthetic click would get through
  // `inert` (the page behind an open dialog), which a real one never does: such targets get nothing.
  const target = document.elementFromPoint(event.clientX, event.clientY)
  if (!target || target === document.documentElement || target.closest('[inert]')) return
  event.stopImmediatePropagation()
  event.preventDefault()
  if (target.matches(TEXT_ENTRY)) target.focus({ preventScroll: true })
  target.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: event.detail,
      screenX: event.screenX,
      screenY: event.screenY,
      clientX: event.clientX,
      clientY: event.clientY,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      button: event.button,
      buttons: event.buttons,
    }),
  )
}

/**
 * Let clicks reach the page while `transition` (a ViewTransition the app started) animates; see above.
 * @param {ViewTransition | null | undefined} transition
 */
export function keepInputLive(transition) {
  if (!transition || typeof document === 'undefined') return
  current = transition
  if (!listening) {
    document.addEventListener('click', replayBlockedClick, true)
    listening = true
  }
  transition.finished
    .catch(() => {})
    .finally(() => {
      if (current === transition) current = null
    })
}
