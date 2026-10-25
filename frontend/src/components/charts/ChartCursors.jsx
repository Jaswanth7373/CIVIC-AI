/**
 * Hover marks shared by the chart wrappers (Recharts `cursor` and `activeDot` elements).
 *
 * - ScanCrosshair: the vertical cursor of line and area charts, drawn as the AI scan head of the 3D city - a
 *   thin road-marking line with a soft band of light around it - snapping from date to date with the tooltip.
 * - HoverBand: the band behind the hovered column or row of a bar chart, with rounded corners.
 * - HaloDot: the hovered point of a line, ringed by a soft halo in its series colour, with a surface-coloured
 *   rim so it separates from the line underneath.
 *
 * Recharts clones these elements with its own geometry props (`points` for line cursors; `x`, `y`, `width`,
 * `height` for bar cursors; `cx`, `cy` for dots) merged over the props given here, so the colour props use
 * names Recharts never sets (`core`, `glow`, `tint`, `color`, `rim`).
 */

/** @param {{points?: Array<{x: number, y: number}>, core: string, glow: string}} props */
export function ScanCrosshair({ points, core, glow }) {
  if (!Array.isArray(points) || points.length < 2) return null
  const [start, end] = points
  const x = Number(start?.x)
  if (!Number.isFinite(x)) return null
  const top = Math.min(start.y, end.y)
  const height = Math.abs(end.y - start.y)
  return (
    <g pointerEvents="none" className="recharts-tooltip-cursor">
      <rect x={x - 10} y={top} width={20} height={height} fill={glow} />
      <rect x={x - 3} y={top} width={6} height={height} fill={glow} />
      <line x1={x} x2={x} y1={top} y2={top + height} stroke={core} strokeWidth={1.25} />
    </g>
  )
}

/** @param {{x?: number, y?: number, width?: number, height?: number, tint: string}} props */
export function HoverBand({ x, y, width, height, tint }) {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
  const radius = Math.min(6, width / 2, height / 2)
  return (
    <rect
      pointerEvents="none"
      className="recharts-tooltip-cursor"
      x={x}
      y={y}
      width={width}
      height={height}
      rx={radius}
      fill={tint}
      fillOpacity={0.75}
    />
  )
}

/** @param {{cx?: number, cy?: number, color: string, rim: string}} props */
export function HaloDot({ cx, cy, color, rim }) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null
  return (
    <g pointerEvents="none">
      <circle cx={cx} cy={cy} r={11} fill={color} fillOpacity={0.14} />
      <circle cx={cx} cy={cy} r={4.5} fill={color} stroke={rim} strokeWidth={2} />
    </g>
  )
}
