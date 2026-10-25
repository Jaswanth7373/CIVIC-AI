/**
 * DashboardScene - the illustrated city behind the dashboard hero: a skyline with lit windows, a department
 * headquarters with a roof beacon, and a road receding to the horizon with its yellow centre line flowing
 * toward the viewer. It is the same world as the landing page's 3D district, drawn in SVG + CSS 3D so a
 * dashboard never downloads WebGL. Light theme = overcast dawn, dark theme = night (styles/app.css).
 *
 * Props:
 * - beaconColor: colour of the HQ roof beacon (the officer's department colour; CivicAI sign green otherwise)
 * - intro: play the entrance - the AI survey scan sweeps across the city and the windows light up behind it
 * - className
 *
 * Decorative only (aria-hidden): every number on the dashboard is in the HTML next to it. The skyline is
 * generated from a fixed seed, so it is identical on every visit and on the server-rendered fallback.
 *
 * The roof beacon pulses for as long as the hero is on screen, so it is not part of the SVG: animating SVG
 * circles costs a style and layout pass every frame. It is two HTML dots (opacity and scale only, which the
 * compositor runs) placed over the antenna with the SVG's own `xMidYMax slice` mapping (styles/app.css,
 * .app-hero-beacons): the layer has the skyline's box, and --s is the slice scale max(width/900, height/150).
 */
import { memo } from 'react'
import { cn } from '@/utils/cn'

const VIEW_W = 900
const VIEW_H = 150
/** The headquarters stands where the road vanishes (about 54% across the art, see .app-hero-road). */
const HQ = { x: 474, w: 30, h: 132 }
/** Window light bands: lit windows are grouped by x so they can switch on in a wave behind the scan. */
const BANDS = 8

function seeded(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}

/** Buildings of one skyline layer, left to right, avoiding the HQ plot on the near layer. */
function layer(random, { minH, maxH, minW, maxW, gap, avoidHq }) {
  const buildings = []
  let x = -10
  while (x < VIEW_W + 10) {
    const w = Math.round(minW + random() * (maxW - minW))
    const h = Math.round(minH + random() * (maxH - minH))
    if (avoidHq && x + w > HQ.x - 4 && x < HQ.x + HQ.w + 4) {
      // Leave a gap around the HQ plot; the next building starts past it (strictly outside the test above).
      x = HQ.x + HQ.w + 6
      continue
    }
    buildings.push({ x, w, h })
    x += w + Math.round(1 + random() * gap)
  }
  return buildings
}

function buildSkyline() {
  const random = seeded(20261018)
  const far = layer(random, { minH: 40, maxH: 104, minW: 30, maxW: 70, gap: 2, avoidHq: false })
  const near = layer(random, { minH: 24, maxH: 92, minW: 20, maxW: 50, gap: 7, avoidHq: true })
  near.push({ x: HQ.x, w: HQ.w, h: HQ.h, hq: true })

  let dark = ''
  const lit = Array.from({ length: BANDS }, () => '')
  near.forEach((building) => {
    const top = VIEW_H - building.h
    for (let wx = building.x + 4; wx <= building.x + building.w - 7; wx += 7) {
      for (let wy = top + 8; wy <= VIEW_H - 10; wy += 9) {
        const cell = `M${wx} ${wy}h3v4h-3z`
        if (random() < (building.hq ? 0.46 : 0.2)) {
          const band = Math.min(BANDS - 1, Math.max(0, Math.floor((wx / VIEW_W) * BANDS)))
          lit[band] += cell
        } else {
          dark += cell
        }
      }
    }
  })

  const toPath = (list) =>
    list.map((b) => `M${b.x} ${VIEW_H}V${VIEW_H - b.h}h${b.w}V${VIEW_H}z`).join('')
  return { far: toPath(far), near: toPath(near), dark, lit }
}

const SKYLINE = buildSkyline()

function DashboardSceneBase({ beaconColor = '#12845f', intro = false, className }) {
  const antennaTop = VIEW_H - HQ.h - 14
  return (
    <div aria-hidden className={cn('app-hero-art', className)}>
      <svg className="app-hero-skyline" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} preserveAspectRatio="xMidYMax slice">
        {/* two depth layers: the far skyline drifts less than the near one under pointer parallax */}
        <g className="app-hero-far">
          <path className="far" d={SKYLINE.far} />
        </g>
        <g className="app-hero-near">
          <path className="near" d={SKYLINE.near} />
          <path className="win" d={SKYLINE.dark} />
          {SKYLINE.lit.map((d, band) => (
            // The wave follows the scan: each band switches on as the light passes over it.
            <path key={band} className="lit" d={d} style={intro ? { '--on': `${0.35 + band * 0.19}s` } : undefined} />
          ))}
          {/* HQ antenna; its roof beacon is the HTML layer below */}
          <rect className="near" x={HQ.x + HQ.w / 2 - 1} y={antennaTop} width="2" height="14" />
        </g>
      </svg>
      <div className="app-hero-beacons">
        <div
          className="app-hero-beacon-layer"
          style={{
            // the antenna top in the art's units: offset from the centre line and height above the bottom edge
            '--beacon-dx': HQ.x + HQ.w / 2 - VIEW_W / 2,
            '--beacon-dy': VIEW_H - antennaTop,
            '--beacon': beaconColor,
          }}
        >
          <span className="app-hero-beacon-glow" />
          <span className="app-hero-beacon" />
        </div>
      </div>
      <div className="app-hero-road">
        <div className="app-hero-road-plane">
          {/* two lanes each way: white lane lines either side of the yellow centre line */}
          <div className="app-hero-road-line" style={{ left: '26%' }} />
          <div className="app-hero-road-line" data-centre="" style={{ left: '50%' }} />
          <div className="app-hero-road-line" style={{ left: '74%' }} />
        </div>
      </div>
      <div className="app-hero-scan" />
    </div>
  )
}

export const DashboardScene = memo(DashboardSceneBase)

export default DashboardScene
