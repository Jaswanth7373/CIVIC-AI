/**
 * CityPulseMap - the "Map" view of the admin dashboard's City pulse: the hotspot clusters as circles with count
 * badges on the city map (HotspotLayer), fitted to the clusters, with the severity legend.
 *
 * Its own module so that CityPulseCard can load it lazily: the card opens on the 3D view (the list on phones),
 * and the dashboard should not download and parse Leaflet until someone picks "Map".
 *
 * Props: clusters (hotspot clusters from GET /analytics/hotspots/), categories (CategoryOut list for popups).
 */
import { MapPinOff } from 'lucide-react'
import { BaseMap, FitBounds, HotspotLayer, MapLegend } from '@/components/maps'

export function CityPulseMap({ clusters = [], categories }) {
  return (
    <BaseMap
      height={380}
      label="Hotspot clusters"
      overlay={
        clusters.length ? null : (
          <p className="flex items-center gap-2 rounded-lg border border-line bg-surface/95 px-3 py-2 text-sm font-medium text-ink-2 shadow-[var(--shadow-overlay)]">
            <MapPinOff aria-hidden className="size-4 text-ink-3" />
            No hotspots for these filters
          </p>
        )
      }
    >
      <HotspotLayer clusters={clusters} categories={categories} />
      <FitBounds points={clusters} padding={36} maxZoom={14} />
      {clusters.length ? <MapLegend levels title="Hotspot severity" position="bottomleft" /> : null}
    </BaseMap>
  )
}

export default CityPulseMap
