/**
 * Hotspot clusters -> drawable items for the City pulse (pure JS, shared by the 3D scene, the SVG still and the
 * accessible list).
 *
 * - Only real clusters with a finite latitude / longitude and a positive count are kept, largest first.
 * - Projection: local metres around the clusters' centre with the cos(latitude) correction on longitude
 *   (x = east, z = south), fitted to a plane of radius ~60 units; north is up the screen (-z).
 * - Columns that would overlap are nudged apart a little (a few relaxation steps), so every hotspot stays visible.
 * - Height is proportional to the complaint count (tallest = 36 units); colour is the LEVEL_META colour of the
 *   cluster's severity level.
 */
import { LEVEL_META } from '@/utils/constants'

const METRES_PER_DEGREE_LAT = 110540
const METRES_PER_DEGREE_LNG = 111320
const PLANE_RADIUS = 60
const MIN_GAP = 10
const MAX_HEIGHT = 36

export function prepareClusters(clusters) {
  const valid = (Array.isArray(clusters) ? clusters : [])
    .map((cluster) => ({
      cluster,
      lat: Number(cluster?.latitude),
      lng: Number(cluster?.longitude),
      count: Number(cluster?.count),
    }))
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng) && Number.isFinite(c.count) && c.count > 0)
    .sort((a, b) => b.count - a.count)
  if (!valid.length) return []

  const lat0 = valid.reduce((sum, c) => sum + c.lat, 0) / valid.length
  const lng0 = valid.reduce((sum, c) => sum + c.lng, 0) / valid.length
  const cos = Math.cos((lat0 * Math.PI) / 180)
  const metres = valid.map((c) => [(c.lng - lng0) * cos * METRES_PER_DEGREE_LNG, -(c.lat - lat0) * METRES_PER_DEGREE_LAT])
  const reach = Math.max(1, ...metres.map(([x, z]) => Math.hypot(x, z)))
  const scale = valid.length > 1 ? PLANE_RADIUS / reach : 1
  const points = metres.map(([x, z]) => [x * scale, z * scale])

  // Gentle relaxation so neighbouring hotspots do not merge into one column.
  for (let step = 0; step < 24; step += 1) {
    let moved = false
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const dx = points[j][0] - points[i][0]
        const dz = points[j][1] - points[i][1]
        const d = Math.hypot(dx, dz)
        if (d >= MIN_GAP) continue
        const push = (MIN_GAP - d) / 2 + 0.01
        const ux = d > 1e-6 ? dx / d : Math.cos(i + j)
        const uz = d > 1e-6 ? dz / d : Math.sin(i + j)
        points[i][0] -= ux * push
        points[i][1] -= uz * push
        points[j][0] += ux * push
        points[j][1] += uz * push
        moved = true
      }
    }
    if (!moved) break
  }

  const maxCount = valid[0].count
  return valid.map((c, i) => {
    const level = LEVEL_META[c.cluster?.severity_level] ? c.cluster.severity_level : null
    const name = typeof c.cluster?.area_name === 'string' && c.cluster.area_name.trim() ? c.cluster.area_name.trim() : null
    return {
      key: String(c.cluster?.cluster_id ?? `${c.lat},${c.lng}`),
      x: points[i][0],
      z: points[i][1],
      height: (MAX_HEIGHT * c.count) / maxCount,
      count: c.count,
      level,
      color: level ? LEVEL_META[level].color : '#8C9A96',
      label: name ?? (typeof c.cluster?.dominant_category_name === 'string' ? c.cluster.dominant_category_name : 'Hotspot'),
      name,
      cluster: c.cluster,
    }
  })
}
