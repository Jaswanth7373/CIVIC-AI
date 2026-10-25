/**
 * PulseStill - the City pulse as an SVG (no WebGL): the same hotspot columns, colours and labels as PulseScene,
 * projected through the same camera, for browsers without hardware WebGL, the low tier and the first paint.
 * Props: items (prepareClusters), active (index | null), theme ('dark' | 'light'), className.
 * Measured by a ResizeObserver (never forcing a layout) and composed as a transition after the page's first paint,
 * then faded in (stillMotion.js); a momentary sliver box keeps the last good composition; the aspect is clamped.
 */
import { memo, startTransition, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/utils/cn'
import { rigProjector } from '../city/rig'
import { MAX_STILL_ASPECT, MIN_STILL_ASPECT } from '../city/stillModel'
import { fadeInStill, observeBox } from '../stillMotion'
import { SvgSign } from '../SvgSign'

const HEX_RADIUS = 4.4

function shadeHex(hex, factor) {
  const v = parseInt(hex.slice(1), 16)
  const ch = (c) => Math.max(0, Math.min(255, Math.round(c * factor)))
  return `#${[ch((v >> 16) & 255), ch((v >> 8) & 255), ch(v & 255)].map((c) => c.toString(16).padStart(2, '0')).join('')}`
}

function buildPulseStill(items, aspect, height, active, dark) {
  const W = 1000 * aspect
  const H = 1000
  const extent = Math.max(30, ...items.map((item) => Math.hypot(item.x, item.z) + HEX_RADIUS))
  const tallest = Math.max(10, ...items.map((item) => item.height))
  const fov = 30
  const tan = Math.tan((fov * Math.PI) / 360)
  const fitW = (extent * 2.25) / (2 * tan * Math.max(aspect, 0.6))
  const fitH = (extent * 1.55 + tallest * 0.5) / (2 * tan)
  const rig = { tx: 0, ty: tallest * 0.28, tz: 0, dist: Math.max(fitW, fitH, 60), az: 28, el: 38, fov, sx: 0, sy: -0.04 }
  const cam = rigProjector(rig, aspect)
  const sx = (p) => Math.round((p.x + 1) * 0.5 * W * 10) / 10
  const sy = (p) => Math.round((1 - p.y) * 0.5 * H * 10) / 10
  const toPoint = (x, y, z) => {
    const p = cam.project(x, y, z)
    return p ? [sx(p), sy(p), p.depth] : null
  }

  // ground grid (stylised streets), clipped to a disc around the clusters
  const lines = []
  const R = extent * 1.25
  for (let v = -Math.floor(R / 6) * 6; v <= R; v += 6) {
    const half = Math.sqrt(Math.max(0, R * R - v * v))
    const major = Math.abs(v % 30) < 1e-6
    const a = toPoint(v, 0, -half)
    const b = toPoint(v, 0, half)
    const c = toPoint(-half, 0, v)
    const d = toPoint(half, 0, v)
    if (a && b) lines.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], major })
    if (c && d) lines.push({ x1: c[0], y1: c[1], x2: d[0], y2: d[1], major })
  }
  const centre = toPoint(0, 0, 0)
  const edge = toPoint(R, 0, 0)
  const glow = centre && edge ? { cx: centre[0], cy: centre[1], rx: Math.abs(edge[0] - centre[0]) * 1.1 + 40, ry: 0 } : null
  if (glow) {
    const far = toPoint(0, 0, -R)
    glow.ry = far ? Math.abs(centre[1] - far[1]) * 1.1 + 20 : glow.rx * 0.5
  }

  const pxPerUnit = 1000 / height
  const columns = items
    .map((item, i) => {
      const h = Math.max(item.height, 0.4)
      const top = []
      const bottom = []
      for (let k = 0; k < 6; k += 1) {
        const angle = (k / 6) * Math.PI * 2
        const x = item.x + Math.sin(angle) * HEX_RADIUS
        const z = item.z + Math.cos(angle) * HEX_RADIUS
        top.push(toPoint(x, h, z))
        bottom.push(toPoint(x, 0, z))
      }
      if (top.some((p) => !p) || bottom.some((p) => !p)) return null
      const sides = []
      for (let k = 0; k < 6; k += 1) {
        const k2 = (k + 1) % 6
        const angle = ((k + 0.5) / 6) * Math.PI * 2
        const normal = [Math.sin(angle), 0, Math.cos(angle)]
        const toCam = [cam.position[0] - item.x, cam.position[1] - h / 2, cam.position[2] - item.z]
        if (normal[0] * toCam[0] + normal[2] * toCam[2] <= 0) continue
        const light = 0.55 + 0.45 * Math.max(0, -0.4 * normal[0] + 0.45 * normal[2])
        sides.push({
          points: [bottom[k], bottom[k2], top[k2], top[k]].map((p) => `${p[0]},${p[1]}`).join(' '),
          fill: shadeHex(item.color, (dark ? 0.55 : 0.75) * light),
        })
      }
      const base = toPoint(item.x, 0, item.z)
      const cap = toPoint(item.x, h, item.z)
      return {
        key: item.key,
        depth: base ? base[2] : 0,
        sides,
        top: top.map((p) => `${p[0]},${p[1]}`).join(' '),
        topFill: item.color,
        ring: base ? { cx: base[0], cy: base[1], rx: (Math.abs(bottom[1][0] - bottom[4][0]) / 2) * 1.9 + 4 } : null,
        cap: cap ? { x: cap[0], y: cap[1] } : null,
        index: i,
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.depth - a.depth)

  const leaders = items
    .map((item, i) => [item.height, i])
    .sort((a, b) => b[0] - a[0])
    .slice(0, 3)
    .map(([, i]) => i)
  const labels = columns
    .filter((col) => col.cap && (leaders.includes(col.index) || col.index === active))
    .map((col) => {
      const item = items[col.index]
      return {
        key: col.key,
        x: col.cap.x,
        y: col.cap.y - 10,
        text: item.label,
        glyph: 'dot',
        glyphColor: item.color,
        w: (item.label.length * 8.2 + 44) * pxPerUnit * 0.9,
        h: 27 * pxPerUnit,
        font: 14 * pxPerUnit,
        dim: active !== null && active !== col.index,
      }
    })
  return { W, H, lines, glow, columns, labels }
}

const PulseSvg = memo(function PulseSvg({ model, active, dark }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const svgRef = useRef(null)
  useLayoutEffect(() => fadeInStill(svgRef.current), [])
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${model.W} ${model.H}`}
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={`${uid}glow`}>
          <stop offset="0" stopColor={dark ? '#173033' : '#ffffff'} stopOpacity="0.9" />
          <stop offset="1" stopColor={dark ? '#173033' : '#ffffff'} stopOpacity="0" />
        </radialGradient>
        <filter id={`${uid}soft`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
        <filter id={`${uid}shadow`} x="-20%" y="-40%" width="140%" height="180%">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
      </defs>
      {model.glow ? <ellipse cx={model.glow.cx} cy={model.glow.cy} rx={model.glow.rx} ry={model.glow.ry} fill={`url(#${uid}glow)`} /> : null}
      <g stroke={dark ? '#24393d' : '#aeb8b5'}>
        {model.lines.map((line, i) => (
          <line key={i} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} strokeWidth={line.major ? 1.6 : 0.7} opacity={line.major ? 0.9 : 0.5} />
        ))}
      </g>
      {model.columns.map((col) => {
        const highlighted = active === col.index
        return (
          <g key={col.key} opacity={active !== null && !highlighted ? 0.72 : 1}>
            {col.ring ? (
              <ellipse
                cx={col.ring.cx}
                cy={col.ring.cy}
                rx={col.ring.rx}
                ry={col.ring.rx * 0.62}
                fill="none"
                stroke={col.topFill}
                strokeWidth={highlighted ? 3 : 1.8}
                opacity="0.75"
              />
            ) : null}
            {col.sides.map((side, k) => (
              <polygon key={k} points={side.points} fill={side.fill} />
            ))}
            <polygon points={col.top} fill={col.topFill} />
            {col.cap ? (
              <circle cx={col.cap.x} cy={col.cap.y} r={highlighted ? 16 : 11} fill={col.topFill} opacity={dark ? 0.55 : 0.35} filter={`url(#${uid}soft)`} />
            ) : null}
          </g>
        )
      })}
      {model.labels.map((label) => (
        <SvgSign key={label.key} label={label} shadowId={`${uid}shadow`} opacity={label.dim ? 0.6 : 1} />
      ))}
    </svg>
  )
})

export function PulseStill({ items, active = null, theme = 'dark', className }) {
  const ref = useRef(null)
  const [box, setBox] = useState(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return undefined
    return observeBox(node, (width, height) => {
      const ratio = Math.round((width / height) * 20) / 20
      const aspect = Math.min(MAX_STILL_ASPECT, Math.max(MIN_STILL_ASPECT, ratio))
      const rounded = Math.max(120, Math.round(height / 40) * 40)
      startTransition(() => {
        setBox((prev) => (prev && prev.aspect === aspect && prev.height === rounded ? prev : { aspect, height: rounded }))
      })
    })
  }, [])
  const dark = theme === 'dark'
  const model = useMemo(() => (box ? buildPulseStill(items, box.aspect, box.height, active, dark) : null), [items, box, active, dark])
  return (
    <div ref={ref} aria-hidden="true" className={cn('relative h-full w-full overflow-hidden', className)} style={{ backgroundColor: dark ? '#0c1517' : '#dfe5e3' }}>
      {model ? <PulseSvg model={model} active={active} dark={dark} /> : null}
    </div>
  )
}

export default PulseStill
