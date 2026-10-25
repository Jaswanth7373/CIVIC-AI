/**
 * GantrySign - the landing page's H1: the CivicAI highway sign hanging from an overhead gantry.
 *
 * The structure is a real one, finished in frame:
 * - Large screens: a cantilever gantry. Its steel post stands at the edge of the city, just right of the copy
 *   (between the calm copy side and the stage where the 3D story plays) and descends into the haze at the bottom
 *   of the hero; its truss arm, braced to the post, reaches left over the copy and ends in an end plate just past
 *   the sign. The post's height (`--gantry-drop`, from the arm down to the bottom of the hero) is measured by
 *   HeroSection, which also finds the arm through `data-gantry-arm`.
 * - Phones and tablets: a sign bridge crossing the whole scene band (its posts stand outside the frame). On
 *   landscape phones the sign is scaled to the window height (styles/landing.css, short landscape).
 * - The sign hangs from the arm on two hangers.
 *
 * The one orchestrated entrance of the hero: the post rises, the arm reaches across (on phones the bridge slides
 * in across the road), then the sign swings down on its hangers like a real gantry sign settling (a damped
 * pendulum about the arm), and in the night theme its two sign lamps come on. The entrance is CSS keyframes on
 * transform and opacity (styles/landing.css), run by the compositor, so it stays smooth while the page and the 3D
 * scene load; on the first visit it is held until the 3D scene cues it (HeroSection `data-opening`). After the
 * swing no transform remains, so the sign text is rasterised crisply at every width.
 *
 * Contract kept for tests and assistive technology: `h1#hero-title` whose first two `<span>`s read exactly
 * "CivicAI" and "AI-Powered Civic Issue Management"; every other element inside the heading is empty or
 * decorative, and the structure around it is aria-hidden. Reduced motion: the finished sign, lamps on, at once.
 */
import { useState } from 'react'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { cn } from '@/utils/cn'

export function GantrySign({ className }) {
  const reduced = usePrefersReducedMotion()
  const [settled, setSettled] = useState(false)
  const lit = settled || reduced

  return (
    <div className={cn('gantry pt-[calc(var(--hang)+var(--truss-h))]', className)}>
      <span aria-hidden className="gantry-beam" data-gantry-arm />
      <span aria-hidden className="gantry-post" />
      <h1
        id="hero-title"
        className="gantry-sign sign-panel relative inline-flex max-w-full flex-col px-6 pb-6 pt-5 sm:px-9 sm:pb-8 sm:pt-7"
        onAnimationEnd={(event) => {
          if (event.animationName === 'landing-gantry-swing') setSettled(true)
        }}
      >
        {/* gantry-title / -tagline / -rule: scaled to the window height on landscape phones (styles/landing.css). */}
        <span className="gantry-title font-display text-[clamp(3.25rem,1.95rem+3.7vw,5.25rem)] font-black leading-[0.92] tracking-[-0.035em]">
          CivicAI
        </span>
        <span className="gantry-tagline mt-3 font-display text-[clamp(1.25rem,0.9rem+0.8vw,1.625rem)] font-bold leading-tight tracking-[-0.005em] sm:mt-4">
          AI-Powered Civic Issue Management
        </span>
        <span aria-hidden className="gantry-rule mt-5 block h-1.5 w-14 rounded-full bg-marking-500 sm:mt-6" />
        <span aria-hidden className="gantry-lamps" data-lit={lit || undefined} />
      </h1>
    </div>
  )
}

export default GantrySign
