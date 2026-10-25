/**
 * RoadClosedScene - the "road closed" moment of the error screens, built in CSS 3D (styles/public.css, section 4).
 *
 * A road runs from the viewer to the horizon - a true perspective ground plane: kerbs, edge lines, the dashed
 * yellow centre line and the streetlights' pools of light all vanish into the haze - past the city skyline, and
 * it is closed:
 * - `dead-end` (Page not found): a striped barrier with a "Road closed" plate across the road, two traffic cones
 *   and the blue "no through road" sign at the roadside. The camera rolls up to the barrier and stops.
 * - `checkpoint` (Access denied): a boom barrier whose striped arm lowers across the road, with the red
 *   "no entry" disc on the arm.
 * Hazard flashers blink alternately and throw warm light on the asphalt at night (dark theme); at dawn (light
 * theme) the scene is concrete-grey, the streetlights are off and the flashers are subtle.
 *
 * Depth: every object stands on the ground plane at its own distance (translateZ), so pointer parallax (fine
 * pointers) turns the world a few degrees and the barrier, poles, sign and cones shift against the road and each
 * other. Reduced motion: the final composition, lamps steadily lit, no parallax. Decorative (aria-hidden): the
 * page heading next to it says the same thing in words.
 *
 * @param {{variant?: 'dead-end'|'checkpoint', className?: string}} props
 */
import { motion, useSpring } from 'framer-motion'
import { useEffect } from 'react'
import { useFinePointer, usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE, SPRING } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { NoThroughRoadSign } from './RoadSigns'
import '@/styles/public.css'

/** Streetlights on both kerbs, at the distances of the light pools painted on the ground plane. */
const STREETLIGHTS = [70, 470, 870, 1270].flatMap((depth) => [
  { side: 'left', depth },
  { side: 'right', depth },
])

const CONES = [
  { left: '36.5%', depth: 70 },
  { left: '62%', depth: 36 },
]

/** The city on the horizon: a hazy far layer and a nearer one with a few lit windows at night. */
function Skyline() {
  return (
    <svg className="pub-road-skyline" viewBox="0 0 600 60" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path
        fill="var(--road-skyline-far)"
        d="M0 60V34h12V22h10v-8h8v8h8v12h14V12h6V4h4v8h8v48zM84 60V26h18V8h14v18h10V16h12v44zM150 60V30h10V14h20V2h8v12h10v46zM214 60V20h16V6h18v14h12v40zM276 60V28h14V12h8V4h6v8h10v48zM330 60V18h20V8h14v10h8v42zM392 60V26h12V10h22v16h12v34zM454 60V14h14V4h12v10h10v46zM508 60V24h16V12h18v12h12v8h14v-4h12v32z"
      />
      <path
        fill="var(--road-skyline)"
        d="M0 60V44h16V36h18v8h10V30h22v30zM70 60V40h14V28h20v12h12v20zM128 60V34h22v-8h16v8h10v26zM190 60V42h18V32h24v10h10v18zM252 60V36h12V24h20v12h16v24zM316 60V40h22V30h14v10h18v20zM384 60V34h16V22h18v12h14v26zM446 60V42h20V30h16v12h12v18zM508 60V36h14V26h22v10h12v-6h16v30z"
      />
      <g fill="var(--road-window)">
        <rect x="24" y="47" width="3" height="3" />
        <rect x="52" y="38" width="3" height="3" />
        <rect x="90" y="44" width="3" height="3" />
        <rect x="146" y="38" width="3" height="3" />
        <rect x="160" y="48" width="3" height="3" />
        <rect x="214" y="40" width="3" height="3" />
        <rect x="262" y="30" width="3" height="3" />
        <rect x="276" y="46" width="3" height="3" />
        <rect x="330" y="44" width="3" height="3" />
        <rect x="398" y="28" width="3" height="3" />
        <rect x="406" y="44" width="3" height="3" />
        <rect x="462" y="36" width="3" height="3" />
        <rect x="528" y="40" width="3" height="3" />
        <rect x="560" y="46" width="3" height="3" />
      </g>
    </svg>
  )
}

function Streetlight({ side, depth }) {
  return (
    <div
      className="pub-road-item pub-streetlight"
      data-side={side}
      style={{ left: side === 'left' ? '16.67%' : '83.33%', transform: `translateZ(calc(${-depth} * var(--u)))` }}
    >
      <span className="pub-streetlight-pole" />
      <span className="pub-streetlight-arm" />
      <span className="pub-streetlight-head" />
    </div>
  )
}

function Lamp({ side }) {
  return <span className="pub-lamp" data-side={side} />
}

/** The red "no entry" disc mounted on the boom (the roadside version with a post is NoEntrySign). */
function NoEntryDisc() {
  return (
    <svg viewBox="0 0 40 40" className="block h-auto w-full" aria-hidden="true" focusable="false">
      <circle cx="20" cy="20" r="19.5" fill="#ffffff" />
      <circle cx="20" cy="20" r="17.6" fill="#d3341f" />
      <rect x="7.5" y="16.6" width="25" height="6.8" rx="1.2" fill="#ffffff" />
    </svg>
  )
}

function DeadEnd() {
  return (
    <>
      <div className="pub-road-item pub-barrier">
        <span className="pub-road-pool" />
        <span className="pub-barrier-shadow" />
        <span className="pub-barrier-leg" data-leg="1" />
        <span className="pub-barrier-leg" data-leg="2" />
        <span className="pub-barrier-leg" data-leg="3" />
        <span className="pub-barrier-leg" data-leg="4" />
        <span className="pub-barrier-board" />
        <span className="pub-barrier-plate">Road closed</span>
        <Lamp side="left" />
        <Lamp side="right" />
      </div>
      <div className="pub-road-item pub-roadsign" style={{ left: '89%', transform: 'translateZ(calc(-118 * var(--u)))' }}>
        <NoThroughRoadSign />
      </div>
      {CONES.map((cone) => (
        <div
          key={cone.left}
          className="pub-road-item pub-cone"
          style={{ left: cone.left, transform: `translateZ(calc(${-cone.depth} * var(--u)))` }}
        />
      ))}
    </>
  )
}

function Checkpoint({ animate }) {
  return (
    <div className="pub-road-item pub-boom">
      <span className="pub-road-pool" />
      <span className="pub-barrier-shadow" />
      <span className="pub-boom-foot" />
      <motion.span
        className="pub-boom-arm"
        initial={animate ? { rotate: -78 } : false}
        animate={{ rotate: 0 }}
        transition={{ type: 'spring', stiffness: 120, damping: 13, mass: 1, delay: 0.55 }}
      >
        <span className="pub-boom-disc">
          <NoEntryDisc />
        </span>
      </motion.span>
      <span className="pub-boom-post" />
      <span className="pub-boom-hub" />
      <Lamp side="left" />
    </div>
  )
}

export function RoadClosedScene({ variant = 'dead-end', className }) {
  const reduced = usePrefersReducedMotion()
  const finePointer = useFinePointer()
  const turnY = useSpring(0, SPRING.tilt)
  const turnX = useSpring(0, SPRING.tilt)
  const parallax = finePointer && !reduced

  // Pointer parallax: the world turns a few degrees towards the pointer (window-wide, so it lives while the
  // visitor reads the text beside it). Values are written by framer-motion, no React render per move.
  useEffect(() => {
    if (!parallax) return undefined
    const onMove = (event) => {
      const x = event.clientX / Math.max(window.innerWidth, 1) - 0.5
      const y = event.clientY / Math.max(window.innerHeight, 1) - 0.5
      turnY.set(x * 7)
      turnX.set(-y * 3)
    }
    const onLeave = () => {
      turnY.set(0)
      turnX.set(0)
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', onLeave)
    }
  }, [parallax, turnX, turnY])

  return (
    <div aria-hidden="true" data-variant={variant} className={cn('pub-road', className)}>
      <div className="pub-road-sky">
        <Skyline />
      </div>
      <div className="pub-road-view">
        <motion.div
          className="pub-road-world"
          style={parallax ? { rotateY: turnY, rotateX: turnX } : undefined}
          // The camera rolls up the road and stops in front of the closure.
          initial={reduced ? false : { z: variant === 'dead-end' ? -170 : -110 }}
          animate={{ z: 0 }}
          transition={{ duration: 1.6, ease: EASE.enter }}
        >
          <div className="pub-road-ground">
            <span className="pub-road-lines" />
            <span className="pub-road-dashes" />
            <span className="pub-road-haze" />
          </div>
          {STREETLIGHTS.map((light) => (
            <Streetlight key={`${light.side}-${light.depth}`} side={light.side} depth={light.depth} />
          ))}
          {variant === 'checkpoint' ? <Checkpoint animate={!reduced} /> : <DeadEnd />}
        </motion.div>
      </div>
      <div className="pub-road-vignette" />
    </div>
  )
}

export default RoadClosedScene
