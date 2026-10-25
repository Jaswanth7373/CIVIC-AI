import { useId } from 'react'
import { cn } from '@/utils/cn'
import { renderIcon } from '@/utils/icons'

/*
 * Sign faces keep their real colours in both themes, as road signs do. Everything else in the drawings (ground,
 * asphalt, posts, the skyline, lamp light) is a CSS token from index.css "System additions" 3, so one drawing
 * serves the daylight and the night theme.
 */
const SIGN_GREEN = '#0B6E4F'
const MARKING = '#F5B700'
const SIGNAL_RED = '#D3341F'
const GUIDE_BLUE = '#1F5FAD'
const INK = '#142022'
const WHITE = '#FFFFFF'

const SIZES = {
  md: { viewBox: '0 0 280 160', className: 'w-[15.5rem]' },
  sm: { viewBox: '0 0 96 64', className: 'w-24' },
}

/** A lucide icon (component, element or kebab-case name) drawn in a `size` box centred on (cx, cy). */
function SignIcon({ icon, cx, cy, size, color, strokeWidth = 2.25 }) {
  if (!icon) return null
  return (
    <svg x={cx - size / 2} y={cy - size / 2} width={size} height={size} viewBox="0 0 24 24" color={color} overflow="visible">
      {renderIcon(icon, { width: 24, height: 24, strokeWidth })}
    </svg>
  )
}

/**
 * The sign face, centred on (cx, cy) with half-size `r`:
 * - guide: highway-sign green panel with an inset white border and a white pictogram (empty states);
 * - warning: road-marking yellow diamond with a black border and a black pictogram (errors, detours);
 * - noEntry: red disc with a white bar (no access);
 * - deadEnd: blue square with a white "T" topped in red (a road that ends: page not found).
 */
function SignFace({ kind, icon, cx, cy, r, shadowColor }) {
  const shadow = { fill: shadowColor }
  if (kind === 'warning') {
    const outer = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`
    const inset = r * 0.84
    const inner = `${cx},${cy - inset} ${cx + inset},${cy} ${cx},${cy + inset} ${cx - inset},${cy}`
    return (
      <g>
        <polygon points={outer} transform={`translate(${r * 0.07} ${r * 0.11})`} style={shadow} strokeLinejoin="round" />
        <polygon points={outer} fill={MARKING} stroke={MARKING} strokeWidth={r * 0.16} strokeLinejoin="round" />
        <polygon points={inner} fill="none" stroke={INK} strokeWidth={r * 0.07} strokeLinejoin="round" />
        <SignIcon icon={icon} cx={cx} cy={cy + r * 0.02} size={r * 0.8} color={INK} strokeWidth={2.5} />
      </g>
    )
  }
  if (kind === 'noEntry') {
    return (
      <g>
        <circle cx={cx + r * 0.07} cy={cy + r * 0.11} r={r} style={shadow} />
        <circle cx={cx} cy={cy} r={r} fill={WHITE} />
        <circle cx={cx} cy={cy} r={r * 0.92} fill={SIGNAL_RED} />
        <rect x={cx - r * 0.62} y={cy - r * 0.15} width={r * 1.24} height={r * 0.3} rx={r * 0.05} fill={WHITE} />
      </g>
    )
  }
  if (kind === 'deadEnd') {
    const s = r * 2
    return (
      <g>
        <rect x={cx - r + r * 0.07} y={cy - r + r * 0.11} width={s} height={s} rx={r * 0.24} style={shadow} />
        <rect x={cx - r} y={cy - r} width={s} height={s} rx={r * 0.24} fill={GUIDE_BLUE} />
        <rect x={cx - r * 0.86} y={cy - r * 0.86} width={s * 0.86} height={s * 0.86} rx={r * 0.16} fill="none" stroke={WHITE} strokeWidth={r * 0.07} />
        <rect x={cx - r * 0.14} y={cy - r * 0.32} width={r * 0.28} height={r * 0.98} fill={WHITE} />
        <rect x={cx - r * 0.56} y={cy - r * 0.58} width={r * 1.12} height={r * 0.28} fill={SIGNAL_RED} />
      </g>
    )
  }
  // guide: a landscape panel, 1.43 : 1
  const w = r * 2.86
  const h = r * 2
  const x = cx - w / 2
  const y = cy - h / 2
  const inset = r * 0.15
  return (
    <g>
      <rect x={x + r * 0.07} y={y + r * 0.11} width={w} height={h} rx={r * 0.33} style={shadow} />
      <rect x={x} y={y} width={w} height={h} rx={r * 0.33} fill={SIGN_GREEN} />
      <rect
        x={x + inset}
        y={y + inset}
        width={w - inset * 2}
        height={h - inset * 2}
        rx={r * 0.22}
        fill="none"
        stroke={WHITE}
        strokeWidth={r * 0.076}
      />
      <SignIcon icon={icon} cx={cx} cy={cy} size={r * 1.05} color={WHITE} />
    </g>
  )
}

/** Half-width of the centre line's dashes at height y (they widen toward the viewer). */
const dashHalf = (y) => 0.35 + (y - 62) * 0.03
const DASHES = [
  [68, 72],
  [79, 86],
  [96, 108],
  [122, 145],
]
/** The dash a barrier stands on (it would peek out above the board). */
const UNDER_BARRIER = 96

/* Skyline silhouettes (stepped roof lines with a mast or two) either side of the vanishing point. */
const SKYLINE_LEFT =
  'M22 62V55h7v-6h6v3h7v-9h5v-3h1.5v3H51v8h7v-5h6v7h6v-13h3v-3h1v3h4v12h7v-4h6v9h6v-5h5v7h6v3Z'
const SKYLINE_RIGHT =
  'M162 62v-7h6v-8h7v4h6v-10h4v-5h1.5v5h3v9h7v-5h7v8h6v-12h8v9h7v-3h6v8h7v-3h6v7h7v3Z'
const WINDOWS = [
  [45.2, 46],
  [45.2, 50.5],
  [72.6, 52],
  [75.6, 44],
  [80, 54],
  [99.5, 55],
  [170.5, 51],
  [184.6, 45],
  [225, 51],
  [238.5, 56],
]

function MidScene({ uid, sign, icon, barrier, cone, lamp }) {
  const fade = `${uid}-fade`
  const ground = `${uid}-ground`
  const glow = `${uid}-glow`
  const sky = `${uid}-sky`
  const stripes = `${uid}-stripes`
  return (
    <>
      <defs>
        {/* Asphalt and edge lines fade into the horizon and out at the bottom edge. */}
        <linearGradient id={fade} x1="0" y1="62" x2="0" y2="160" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={WHITE} stopOpacity="0" />
          <stop offset="0.3" stopColor={WHITE} stopOpacity="1" />
          <stop offset="0.82" stopColor={WHITE} stopOpacity="1" />
          <stop offset="1" stopColor={WHITE} stopOpacity="0" />
        </linearGradient>
        <mask id={`${fade}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="280" height="160">
          <rect x="0" y="0" width="280" height="160" fill={`url(#${fade})`} />
        </mask>
        <radialGradient id={ground} cx="140" cy="128" r="136" gradientUnits="userSpaceOnUse" gradientTransform="translate(0 96) scale(1 0.25)">
          <stop offset="0" style={{ stopColor: 'var(--ill-ground)' }} />
          <stop offset="1" style={{ stopColor: 'var(--ill-ground)', stopOpacity: 0 }} />
        </radialGradient>
        <radialGradient id={glow}>
          <stop offset="0" style={{ stopColor: 'var(--ill-glow)' }} />
          <stop offset="1" style={{ stopColor: 'var(--ill-glow)', stopOpacity: 0 }} />
        </radialGradient>
        {/* The skyline thins out toward both sides. */}
        <linearGradient id={sky} x1="20" y1="0" x2="260" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={WHITE} stopOpacity="0" />
          <stop offset="0.22" stopColor={WHITE} stopOpacity="1" />
          <stop offset="0.78" stopColor={WHITE} stopOpacity="1" />
          <stop offset="1" stopColor={WHITE} stopOpacity="0" />
        </linearGradient>
        <mask id={`${sky}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width="280" height="160">
          <rect x="0" y="0" width="280" height="160" fill={`url(#${sky})`} />
        </mask>
        <pattern id={stripes} width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
          <rect width="9" height="9" fill={WHITE} />
          <rect width="4.5" height="9" fill={SIGNAL_RED} />
        </pattern>
      </defs>

      <ellipse cx="140" cy="128" rx="136" ry="34" fill={`url(#${ground})`} />

      {/* A low skyline on the horizon (one silhouette, so it reads as a city, not as bars); at night a few
          windows are lit. */}
      <g mask={`url(#${sky}-mask)`} style={{ fill: 'var(--ill-skyline)' }}>
        <path d={SKYLINE_LEFT} />
        <path d={SKYLINE_RIGHT} />
      </g>
      <g style={{ fill: 'var(--ill-window)' }}>
        {WINDOWS.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="1.7" height="1.7" />
        ))}
      </g>

      {/* The road, its edge lines and the dashed centre line, receding to the horizon. */}
      <g mask={`url(#${fade}-mask)`}>
        <polygon points="137,62 143,62 228,160 52,160" style={{ fill: 'var(--ill-road)' }} />
        <line x1="137.7" y1="62" x2="56.5" y2="160" style={{ stroke: 'var(--ill-road-edge)' }} strokeWidth="1.5" />
        <line x1="142.3" y1="62" x2="223.5" y2="160" style={{ stroke: 'var(--ill-road-edge)' }} strokeWidth="1.5" />
        {DASHES.filter(([top]) => !(barrier && top === UNDER_BARRIER)).map(([top, bottom], index) => (
          <polygon
            key={top}
            className="ill-dash"
            style={{ '--i': DASHES.length - 1 - index, fill: 'var(--ill-lane)' }}
            points={`${140 - dashHalf(top)},${top} ${140 + dashHalf(top)},${top} ${140 + dashHalf(bottom)},${bottom} ${140 - dashHalf(bottom)},${bottom}`}
          />
        ))}
      </g>

      {lamp ? (
        <g>
          <g className="ill-glow">
            <ellipse cx="92" cy="122" rx="30" ry="6" fill={`url(#${glow})`} opacity="0.7" />
            <circle cx="84" cy="50" r="30" fill={`url(#${glow})`} />
          </g>
          <ellipse cx="62" cy="133" rx="8" ry="1.8" style={{ fill: 'var(--ill-shade)' }} />
          <path
            d="M62 133 V52 Q62 44 70 44 H80"
            fill="none"
            style={{ stroke: 'var(--ill-post)' }}
            strokeWidth="2.6"
            strokeLinecap="round"
          />
          <rect x="77" y="42" width="15" height="4.6" rx="2.3" style={{ fill: 'var(--ill-lamp-head)' }} />
        </g>
      ) : null}

      {cone ? (
        <g className="ill-drop">
          <ellipse cx="96" cy="137" rx="10" ry="2" style={{ fill: 'var(--ill-shade)' }} />
          <rect x="88" y="133.6" width="16" height="2.8" rx="1" fill="#C25C06" />
          <polygon points="91,134 101,134 97.6,117 94.4,117" fill="#E8730C" />
          <polygon points="92.4,127 99.6,127 98.9,123.6 93.1,123.6" fill={WHITE} />
        </g>
      ) : null}

      {barrier ? (
        <g className="ill-drop">
          <ellipse cx="140" cy="127.5" rx="44" ry="2.6" style={{ fill: 'var(--ill-shade)' }} />
          <g style={{ stroke: 'var(--ill-post-dark)' }} strokeWidth="2.2" strokeLinecap="round">
            <line x1="109" y1="110" x2="104.5" y2="127" />
            <line x1="109" y1="110" x2="113.5" y2="127" />
            <line x1="171" y1="110" x2="166.5" y2="127" />
            <line x1="171" y1="110" x2="175.5" y2="127" />
          </g>
          <rect x="101" y="99" width="78" height="11" rx="1.6" fill={`url(#${stripes})`} />
          <rect x="101" y="99" width="78" height="11" rx="1.6" fill="none" stroke={INK} strokeOpacity="0.28" strokeWidth="0.8" />
          <circle className="ill-glow" cx="104" cy="94" r="7" fill={`url(#${glow})`} />
          <circle className="ill-glow" cx="176" cy="94" r="7" fill={`url(#${glow})`} />
          <circle cx="104" cy="96" r="2.6" fill={MARKING} />
          <circle cx="176" cy="96" r="2.6" fill={MARKING} />
        </g>
      ) : null}

      {/* The sign on its post, on the right shoulder. */}
      <g className="ill-rise">
        <ellipse cx="214" cy="131" rx="9" ry="2" style={{ fill: 'var(--ill-shade)' }} />
        <rect x="212.4" y="58" width="3.2" height="73" rx="1" style={{ fill: 'var(--ill-post)' }} />
        <SignFace kind={sign} icon={icon} cx={214} cy={sign === 'guide' ? 45 : 42} r={sign === 'guide' ? 21 : sign === 'deadEnd' ? 22 : 24} shadowColor="var(--ill-sign-shadow)" />
      </g>
    </>
  )
}

function CompactScene({ uid, sign, icon }) {
  const ground = `${uid}-ground`
  const guide = sign === 'guide'
  return (
    <>
      <defs>
        <radialGradient id={ground} cx="48" cy="58" r="42" gradientUnits="userSpaceOnUse" gradientTransform="translate(0 43.5) scale(1 0.25)">
          <stop offset="0" style={{ stopColor: 'var(--ill-ground)' }} />
          <stop offset="1" style={{ stopColor: 'var(--ill-ground)', stopOpacity: 0 }} />
        </radialGradient>
      </defs>
      <ellipse cx="48" cy="58" rx="42" ry="10.5" fill={`url(#${ground})`} />
      {/* A dashed road marking passing behind the post. */}
      <rect className="ill-dash" style={{ '--i': 0, fill: 'var(--ill-lane)' }} x="10" y="57.2" width="11" height="1.8" rx="0.9" />
      <rect className="ill-dash" style={{ '--i': 1, fill: 'var(--ill-lane)' }} x="75" y="57.2" width="11" height="1.8" rx="0.9" />
      <g className="ill-rise">
        <ellipse cx="48" cy="58.2" rx="8" ry="1.7" style={{ fill: 'var(--ill-shade)' }} />
        <rect x="46.5" y="30" width="3" height="28.4" rx="1" style={{ fill: 'var(--ill-post)' }} />
        <SignFace kind={sign} icon={icon} cx={48} cy={guide ? 20 : 21} r={guide ? 15.5 : 17} shadowColor="var(--ill-sign-shadow)" />
      </g>
    </>
  )
}

/**
 * A road-sign scene in the CivicAI "civic signage" language, for empty and error states. Decorative
 * (aria-hidden): the text next to it says what it means. Theme-aware through CSS tokens; the parts arrive once
 * (road marks toward the viewer, the sign rising onto its post, a barrier dropping into place, the lamp
 * flickering on at night) and stay still with reduced motion.
 *
 * @param {object} props
 * @param {'guide'|'warning'|'noEntry'|'deadEnd'} [props.sign='guide'] the sign face
 * @param {import('react').ComponentType|import('react').ReactElement|string} [props.icon] pictogram on guide and warning signs
 * @param {boolean} [props.barrier] a striped barrier across the road (md only)
 * @param {boolean} [props.cone] a traffic cone (md only)
 * @param {boolean} [props.lamp] a street lamp on the left shoulder, lit at night (md only)
 * @param {'md'|'sm'} [props.size='md'] md: a road scene (~248px wide); sm: the sign on its post (~96px)
 * @param {string} [props.className]
 */
export function RoadScene({ sign = 'guide', icon, barrier = false, cone = false, lamp = false, size = 'md', className }) {
  const uid = `ill${useId().replace(/[^A-Za-z0-9]/g, '')}`
  const spec = SIZES[size] ?? SIZES.md
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={spec.viewBox}
      className={cn('block h-auto max-w-full shrink-0 overflow-visible', spec.className, className)}
    >
      {size === 'sm' ? (
        <CompactScene uid={uid} sign={sign} icon={icon} />
      ) : (
        <MidScene uid={uid} sign={sign} icon={icon} barrier={barrier} cone={cone} lamp={lamp} />
      )}
    </svg>
  )
}

export default RoadScene
