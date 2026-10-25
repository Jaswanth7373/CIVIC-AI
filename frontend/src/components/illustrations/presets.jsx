import { Inbox, RefreshCw, SearchX, TriangleAlert } from 'lucide-react'
import { RoadScene } from './RoadScene'

/**
 * Ready-made scenes. Each takes `size` ('md' | 'sm'), `className` and, where a pictogram is shown, `icon`.
 *
 * - EmptyRoadIllustration: an empty road at dusk with a green guide sign carrying the page's own icon - "nothing
 *   here yet" (the default of EmptyState).
 * - NoResultsIllustration: the same road, the sign showing a crossed-out magnifier - a search or filter found
 *   nothing.
 * - RoadworksIllustration: a striped barrier, a cone and a yellow warning sign - something failed and can be
 *   retried (the default of ErrorState).
 * - DetourIllustration: a warning sign with a turning arrow by a cone - take another way round (reload for a new
 *   version).
 * - DeadEndIllustration: a barrier and the blue dead-end sign - the road (page) does not continue.
 * - NoEntryIllustration: a barrier and the red no-entry sign - this way is not open to you.
 */
export function EmptyRoadIllustration({ icon = Inbox, size = 'md', className }) {
  return <RoadScene sign="guide" icon={icon} lamp size={size} className={className} />
}

export function NoResultsIllustration({ icon = SearchX, size = 'md', className }) {
  return <RoadScene sign="guide" icon={icon} lamp size={size} className={className} />
}

export function RoadworksIllustration({ icon = TriangleAlert, size = 'md', className }) {
  return <RoadScene sign="warning" icon={icon} barrier cone size={size} className={className} />
}

export function DetourIllustration({ icon = RefreshCw, size = 'md', className }) {
  return <RoadScene sign="warning" icon={icon} cone lamp size={size} className={className} />
}

export function DeadEndIllustration({ size = 'md', className }) {
  return <RoadScene sign="deadEnd" barrier lamp size={size} className={className} />
}

export function NoEntryIllustration({ size = 'md', className }) {
  return <RoadScene sign="noEntry" barrier size={size} className={className} />
}

const PRESETS = {
  road: EmptyRoadIllustration,
  empty: EmptyRoadIllustration,
  search: NoResultsIllustration,
  roadworks: RoadworksIllustration,
  error: RoadworksIllustration,
  detour: DetourIllustration,
  deadEnd: DeadEndIllustration,
  noEntry: NoEntryIllustration,
}

/**
 * A scene by name: `<Illustration name="search" size="sm" />`. Names: road (alias empty), search, roadworks
 * (alias error), detour, deadEnd, noEntry. `icon` replaces the pictogram where the scene has one. Unknown names
 * fall back to the empty road.
 */
export function Illustration({ name = 'road', icon, size = 'md', className }) {
  const Scene = PRESETS[name] ?? EmptyRoadIllustration
  return <Scene icon={icon ?? undefined} size={size} className={className} />
}

export default Illustration
