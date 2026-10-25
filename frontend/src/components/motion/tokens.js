/**
 * CivicAI motion vocabulary: ONE set of durations, easings and springs for the whole app.
 *
 * Everything that moves - framer-motion components and the CSS micro-interactions in index.css (which mirror
 * these values as `--dur-*` / `--ease-*` custom properties) - takes its timing from here, so a menu, a toast,
 * a tab marker and a route change feel like parts of one product rather than a collection of effects.
 *
 * Principles (cinematic plan, sections 1 and 6.2):
 * - UI motion lives between 120 and 600 ms. Only the display-heading reveal and the number counters run
 *   longer, and only on the landing / public pages or on first view.
 * - Entrances decelerate (they arrive), exits accelerate (they leave) and are shorter than entrances.
 * - Indicators (tab underline, sidebar marker, tab-bar dot) move on a short spring with a whisper of bounce:
 *   fast, and finished when they look finished (duration-bounded springs, no long creeping tail).
 * - Floating layers (menus, popovers, toasts) use a light spring with a whisper of overshoot, so they feel
 *   physical without bouncing.
 * - Reduced motion: every consumer renders its final state (see hooks.js `usePrefersReducedMotion`).
 */

/** Durations in seconds (framer-motion units). CSS twins: --dur-instant ... --dur-slower in index.css. */
export const DURATION = Object.freeze({
  /** Press feedback, colour flips. */
  instant: 0.09,
  /** Hover states, tooltips, check marks. */
  fast: 0.15,
  /** Menus, popovers, toast exit. */
  base: 0.22,
  /** Route entrance. The contract caps it at 280 ms so navigation never feels slow. */
  route: 0.28,
  /** Modal / drawer entrance, list entrances. */
  slow: 0.36,
  /** Larger content blocks. */
  slower: 0.5,
  /** Display-heading line reveal (landing and public pages only). */
  reveal: 0.8,
  /** CountUp: long enough to read as counting, short enough not to make anyone wait for a number. */
  count: 1.1,
})

/** Cubic-bezier easings (framer-motion arrays). CSS twins: --ease-standard, --ease-enter, --ease-exit. */
export const EASE = Object.freeze({
  /** House curve (same as the original --ease-out-soft token): quick start, long gentle landing. */
  standard: [0.22, 1, 0.36, 1],
  /** Entrances of larger things (expo-out): content glides in and settles. */
  enter: [0.16, 1, 0.3, 1],
  /** Exits: accelerate away, no lingering. */
  exit: [0.4, 0, 1, 1],
  /** Symmetric moves between two resting states (sheens, loops). */
  inOut: [0.65, 0, 0.35, 1],
  /** Number counters: fast start, long readable tail. */
  count: [0.12, 0.8, 0.2, 1],
})

/** Springs (framer-motion transition objects). */
export const SPRING = Object.freeze({
  /** Active indicators that slide between items (tabs, sidebar, mobile tab bar, nav underline). */
  indicator: Object.freeze({ type: 'spring', duration: 0.34, bounce: 0.12 }),
  /** Menus, popovers, toasts: a light spring with a hint of overshoot. */
  pop: Object.freeze({ type: 'spring', stiffness: 480, damping: 32, mass: 0.8 }),
  /**
   * Dialogs and side panels: a duration-bounded spring with no bounce. (A stiffness/damping spring that is
   * critically damped creeps over its last few pixels for a long time - an edge-anchored drawer would look
   * like it is still drifting in.)
   */
  panel: Object.freeze({ type: 'spring', duration: 0.42, bounce: 0 }),
  /** Small delights: a check chip, an icon swap. */
  bouncy: Object.freeze({ type: 'spring', stiffness: 600, damping: 22, mass: 0.7 }),
  /** Pointer-tracked tilt (useSpring options). */
  tilt: Object.freeze({ stiffness: 240, damping: 24, mass: 0.6 }),
  /** Scroll-linked smoothing (useSpring options). */
  scroll: Object.freeze({ stiffness: 220, damping: 40, restDelta: 0.0005 }),
})

/** List entrances: delay between items and how many items animate at most (the rest appear with the last). */
export const STAGGER = Object.freeze({ step: 0.045, max: 8 })

/** Common transitions, ready to spread into `transition` props. */
export const TRANSITION = Object.freeze({
  fade: Object.freeze({ duration: DURATION.base, ease: EASE.standard }),
  route: Object.freeze({ duration: DURATION.route, ease: EASE.standard }),
  exit: Object.freeze({ duration: DURATION.fast, ease: EASE.exit }),
})
