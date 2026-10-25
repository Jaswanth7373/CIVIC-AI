/**
 * Leaflet setup shared by every map component. ES modules are evaluated once, so importing this file from
 * several components still runs the setup a single time.
 *
 * - Stylesheets: Leaflet core plus the two markercluster sheets. main.jsx imports the same files before
 *   index.css (so CivicAI's map overrides - themed popups, dark tiles - win the cascade); importing them here
 *   keeps the maps folder self-contained, and the bundler includes each stylesheet only once.
 * - `leaflet.markercluster` is a side-effect module: it extends the global `L` object (which Leaflet's UMD
 *   build assigns to `window.L`) with `L.markerClusterGroup`. It must be imported after `leaflet`, which ES
 *   module evaluation order guarantees here.
 * - Default marker icons: Leaflet locates its marker PNGs by reading an image URL out of its CSS at runtime,
 *   which breaks once a bundler fingerprints and moves the files. Deleting `_getIconUrl` and passing the
 *   bundled URLs explicitly makes plain <Marker>s work (CivicAI's own pins are SVG divIcons, see mapIcons.js).
 * - Tiles: OpenStreetMap's standard tile server with the attribution its usage policy requires. basemap.css
 *   grades the tile pane with CSS filters - a quiet grey plan in light, night asphalt in dark - so the same
 *   tiles work in both themes and the data on top (badges, rings, pins, popups) keeps its real colours and
 *   leads.
 */
import 'leaflet/dist/leaflet.css'
import 'leaflet.markercluster/dist/MarkerCluster.css'
import 'leaflet.markercluster/dist/MarkerCluster.Default.css'
import './basemap.css'
import L from 'leaflet'
import 'leaflet.markercluster'
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png'
import iconUrl from 'leaflet/dist/images/marker-icon.png'
import shadowUrl from 'leaflet/dist/images/marker-shadow.png'

delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({ iconRetinaUrl, iconUrl, shadowUrl })

export const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
export const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
export const MAX_ZOOM = 19

/** Round to 6 decimals (about 0.1 m) - the precision of the backend's Decimal(9, 6) coordinates. */
export function round6(value) {
  return Math.round(Number(value) * 1e6) / 1e6
}

/** True for a usable latitude / longitude pair. */
export function isValidLatLng(lat, lng) {
  const a = Number(lat)
  const b = Number(lng)
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0)
}

/** `[lat, lng]` of an API point (`latitude` / `longitude`) or a `{lat, lng}` value, or null. */
export function toLatLng(point) {
  if (!point) return null
  const lat = point.latitude ?? point.lat
  const lng = point.longitude ?? point.lng
  return isValidLatLng(lat, lng) ? [Number(lat), Number(lng)] : null
}

export { L }
export default L
