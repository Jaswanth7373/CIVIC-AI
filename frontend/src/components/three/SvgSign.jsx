/**
 * Highway-sign label for the SVG stills (CityFallback, the City pulse still): the brand's sign-panel look - a
 * sign-green field, an inset white border, white Overpass text and an optional glyph (severity dot, check, pin,
 * department square). Anchored at its bottom centre (`x`, `y`); `h` is its height in the SVG's units.
 */
const FONT = '"Overpass", "Public Sans", system-ui, -apple-system, "Segoe UI", sans-serif'
const SIGN_GREEN = '#0B6E4F'

function Glyph({ glyph, color, x, y, s }) {
  if (glyph === 'check') {
    return (
      <g>
        <circle cx={x} cy={y} r={6 * s} fill="#ffffff" />
        <path
          d={`M${x - 3 * s},${y + 0.2 * s} L${x - 0.8 * s},${y + 2.4 * s} L${x + 3.2 * s},${y - 2.2 * s}`}
          fill="none"
          stroke={SIGN_GREEN}
          strokeWidth={1.8 * s}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    )
  }
  if (glyph === 'pin') {
    return (
      <g>
        <path
          d={`M${x - 4.6 * s},${y - 1.2 * s} A${4.6 * s},${4.6 * s} 0 0 1 ${x + 4.6 * s},${y - 1.2 * s} L${x},${y + 5.4 * s} Z`}
          fill={color}
        />
        <circle cx={x} cy={y - 1.3 * s} r={1.7 * s} fill={SIGN_GREEN} />
      </g>
    )
  }
  if (glyph === 'hq') {
    return <rect x={x - 4.6 * s} y={y - 4.6 * s} width={9.2 * s} height={9.2 * s} fill={color} stroke="#ffffff" strokeWidth={1.4 * s} />
  }
  return (
    <g>
      <circle cx={x} cy={y} r={5.2 * s} fill="#ffffff" />
      <circle cx={x} cy={y} r={3.7 * s} fill={color} />
    </g>
  )
}

/**
 * @param {object} props
 * @param {{x:number, y:number, w:number, h:number, font:number, text:string, glyph?:string, glyphColor?:string}} props.label
 * @param {string} [props.shadowId] id of a blur filter for the soft drop shadow
 * @param {number} [props.opacity]
 */
export function SvgSign({ label, shadowId, opacity = 1 }) {
  const s = label.h / 29
  const x = label.x - label.w / 2
  const y = label.y - label.h - 4 * s
  return (
    <g opacity={opacity}>
      {shadowId ? (
        <rect x={x} y={y + 1.5 * s} width={label.w} height={label.h} rx={7 * s} fill="#000000" opacity="0.35" filter={`url(#${shadowId})`} />
      ) : null}
      <rect x={x} y={y} width={label.w} height={label.h} rx={7 * s} fill={SIGN_GREEN} />
      <rect
        x={x + 2.6 * s}
        y={y + 2.6 * s}
        width={label.w - 5.2 * s}
        height={label.h - 5.2 * s}
        rx={5 * s}
        fill="none"
        stroke="#ffffff"
        strokeWidth={1.5 * s}
      />
      {label.glyph ? <Glyph glyph={label.glyph} color={label.glyphColor} x={x + 17 * s} y={y + label.h / 2} s={s} /> : null}
      <text
        x={x + (label.glyph ? 30 : 11) * s}
        y={y + label.h / 2 + 1 * s}
        fill="#ffffff"
        fontFamily={FONT}
        fontWeight="800"
        fontSize={label.font}
        dominantBaseline="middle"
      >
        {label.text}
      </text>
    </g>
  )
}

export default SvgSign
