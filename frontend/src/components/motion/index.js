/**
 * Motion system (cinematic plan section 3): `import { CountUp, TiltCard, DURATION } from '@/components/motion'`.
 *
 * Vocabulary: DURATION, EASE, SPRING, STAGGER, TRANSITION (tokens.js) - the CSS twins live in index.css
 * ("Cinematic additions": --dur-*, --ease-*, elevation and fluid type utilities).
 *
 * Components
 * - CountUp            number that counts up once when first seen (one text node; final value with reduced motion)
 * - TiltCard           pointer-tracked 3D tilt + sodium glare for large interactive cards (mouse only)
 * - DrawPath           SVG stroke that draws itself once in view
 * - Stagger/StaggerItem  capped, first-load-only list entrance
 * - RouteTransition    page entrance on pathname change + RouteProgress (lane-line loading bar)
 * - ScrollProgress     lane-line reading progress (landing)
 * - MaskReveal / RevealHeading  display-heading line reveals (landing and public pages only)
 *
 * Hooks: usePrefersReducedMotion, useFinePointer, useInViewOnce, useScrolled, useElementScrollProgress, useLatestLocation,
 * useRouteLoading.
 */
export { CountUp } from './CountUp'
export { DrawPath } from './DrawPath'
export { MaskReveal, RevealHeading } from './MaskReveal'
export { RouteProgress, RouteTransition } from './RouteTransition'
export { ScrollProgress } from './ScrollProgress'
export { Stagger, StaggerItem } from './Stagger'
export { TiltCard } from './TiltCard'
export {
  useElementScrollProgress,
  useFinePointer,
  useInViewOnce,
  useLatestLocation,
  usePrefersReducedMotion,
  useRouteLoading,
  useScrolled,
} from './hooks'
export { DURATION, EASE, SPRING, STAGGER, TRANSITION } from './tokens'
