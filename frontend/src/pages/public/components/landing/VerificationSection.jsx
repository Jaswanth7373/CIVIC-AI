/**
 * "Resolution Verification" - a before / after pair of the same spot in the BeforeAfterSlider, and the four
 * steps the verification engine runs on an officer's after photo, ending in one of the real verification
 * outcomes (VERIFICATION_META) with the engine's disclaimer.
 *
 * Choreography: the pair first shows only the problem (the open manhole). The first time it is on screen the
 * divider wipes across to reveal the fix, then settles where the slider starts (55%), and the interactive slider
 * takes over without a visible change (the intro layer is pixel-identical to it). The four check steps then
 * light up in order. Touching the slider or focusing it ends the intro at once. Reduced motion: the slider and
 * the finished steps, no wipe.
 */
import { animate, motion, useMotionValue, useTransform } from 'framer-motion'
import { ChevronsLeftRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { BeforeAfterSlider } from '@/components/complaints/BeforeAfterSlider'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE } from '@/components/motion/tokens'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/utils/cn'
import { VERIFICATION_DISCLAIMER, VERIFICATION_META } from '@/utils/constants'
import { LandingHeading, LandingSection } from './LandingSection'

const BEFORE = '/samples/open-manhole.jpg'
const AFTER = '/samples/open-manhole-after.jpg'
const ALT = 'Open manhole on a road edge, and the same spot with a new cover fitted'
/** Where the interactive slider starts (percent of the "before" photo shown). */
const START = 55

const STEPS = [
  {
    title: 'Line the photos up',
    text: 'ORB keypoints and a RANSAC homography align the after photo with the before photo, so a slightly different angle does not count as change.',
  },
  {
    title: 'Measure the change',
    text: 'Structural similarity (SSIM), histogram correlation, edge density and colour change are measured, most of all inside the box where the issue was detected.',
  },
  {
    title: 'Look for the issue again',
    text: 'The vision model runs on the after photo. If it still sees an open manhole, the job is not done.',
  },
  {
    title: 'Decide, and let people overrule',
    text: 'The scores become one of four outcomes. Officers and administrators can verify manually and override the AI.',
  },
]

/**
 * The opening wipe, drawn over the slider frame (same photos, same crop, same divider). Position 100 = only the
 * "before" photo, 0 = only the "after" photo - the slider's own convention.
 */
function WipeIntro({ play, onDone }) {
  const position = useMotionValue(100)
  const clipPath = useTransform(position, (value) => `inset(0 0 0 ${value}%)`)
  const left = useTransform(position, (value) => `${value}%`)
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onDoneRef.current = onDone
  })

  useEffect(() => {
    if (!play) return undefined
    const controls = animate(position, [100, 0, START], {
      duration: 2.3,
      times: [0, 0.56, 1],
      ease: [EASE.inOut, EASE.standard],
      delay: 0.25,
      onComplete: () => onDoneRef.current?.(),
    })
    return () => controls.stop()
  }, [play, position])

  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 aspect-[4/3] overflow-hidden rounded-xl bg-sunken">
      <img src={BEFORE} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 size-full select-none object-cover" />
      <motion.div className="absolute inset-0" style={{ clipPath }}>
        <img src={AFTER} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 size-full select-none object-cover" />
      </motion.div>
      <span className="absolute left-2 top-2 rounded-md bg-asphalt-950/75 px-2 py-0.5 text-xs font-semibold text-white">Before</span>
      <span className="absolute right-2 top-2 rounded-md bg-sign-700/90 px-2 py-0.5 text-xs font-semibold text-white">After</span>
      <motion.div className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgb(15_22_23/0.35)]" style={{ left }} />
      <motion.div
        className="absolute top-1/2 grid size-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-asphalt-900 shadow-[var(--shadow-overlay)] ring-2 ring-asphalt-900/15 pointer-coarse:size-11"
        style={{ left }}
      >
        <ChevronsLeftRight className="size-5" />
      </motion.div>
    </div>
  )
}

export function VerificationSection() {
  const reduced = usePrefersReducedMotion()
  const frameRef = useRef(null)
  const seen = useInViewOnce(frameRef, { margin: '0px 0px -30% 0px' })
  const [intro, setIntro] = useState(true)
  const [checked, setChecked] = useState(false)
  const showIntro = intro && !reduced
  const lit = checked || reduced

  const finish = () => {
    setIntro(false)
    setChecked(true)
  }

  return (
    <LandingSection id="resolution-verification" labelledBy="verification-title" tone="surface">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:items-start lg:gap-16">
        <div
          ref={frameRef}
          className="relative min-w-0 lg:sticky lg:top-24"
          onPointerDownCapture={showIntro ? finish : undefined}
          onKeyDownCapture={showIntro ? finish : undefined}
          onFocusCapture={showIntro ? finish : undefined}
        >
          <BeforeAfterSlider before={BEFORE} after={AFTER} alt={ALT} fit="cover" initial={START} reveal="showcase" />
          {showIntro ? <WipeIntro play={seen} onDone={finish} /> : null}
        </div>

        <div className="min-w-0">
          <LandingHeading
            id="verification-title"
            title="Resolution Verification"
            lead="“Resolved” should mean fixed. When an officer uploads an after photo, the AI checks it against the photo the citizen took."
          />
          <ol className="mt-10 space-y-6">
            {STEPS.map((step, index) => (
              <li key={step.title} className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-3.5">
                <span
                  className={cn(
                    'grid size-9 place-items-center rounded-full font-display text-sm font-extrabold text-white tabular transition-[background-color,box-shadow] duration-500 ease-standard',
                    lit
                      ? 'bg-sign-600 shadow-[0_0_0_4px_rgb(18_132_95/0.18)]'
                      : 'bg-asphalt-800 dark:bg-asphalt-700',
                  )}
                  style={{ transitionDelay: lit && !reduced ? `${index * 220}ms` : undefined }}
                >
                  {index + 1}
                </span>
                <div>
                  <h3 className="font-display text-base font-bold text-ink sm:text-[17px]">{step.title}</h3>
                  <p className="mt-1 text-[15px] leading-relaxed text-ink-2">{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <ul className="mt-8 flex flex-wrap gap-2" aria-label="Possible outcomes">
            {Object.values(VERIFICATION_META).map((meta) => (
              <li key={meta.value}>
                <Badge tone={meta.tone} icon={meta.icon}>
                  {meta.label}
                </Badge>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-ink-3">{VERIFICATION_DISCLAIMER}</p>
        </div>
      </div>
    </LandingSection>
  )
}

export default VerificationSection
