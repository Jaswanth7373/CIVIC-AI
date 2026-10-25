/**
 * Custom SVG illustrations in the road-sign language (cinematic plan 6.2), for empty, error and "road closed"
 * states: `import { Illustration, RoadworksIllustration } from '@/components/illustrations'`.
 * EmptyState and ErrorState use them by default (their `illustration` prop); RouteErrorBoundary picks one per
 * error. All are decorative (aria-hidden), theme-aware and still with reduced motion.
 */
export { RoadScene } from './RoadScene'
export {
  DeadEndIllustration,
  DetourIllustration,
  EmptyRoadIllustration,
  Illustration,
  NoEntryIllustration,
  NoResultsIllustration,
  RoadworksIllustration,
} from './presets'
