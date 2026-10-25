/**
 * Closing call to action of the landing page: the road ahead at night (dark in both themes, like the app's
 * sidebar). A road recedes to a sodium-lit horizon in CSS 3D and its lane markings flow toward the viewer - the
 * citizen's report is the next thing coming down that road. Citizens and guests are invited to report; officers
 * and administrators go to their dashboard.
 *
 * The road is CSS only (styles/landing.css): one plane pivoted into a floor, its markings sliding on a composited
 * transform; the flow pauses while the band is off screen. Reduced motion: a still road.
 */
import { useInView } from 'framer-motion'
import { LayoutDashboard, MapPinPlus } from 'lucide-react'
import { useRef } from 'react'
import { RevealHeading } from '@/components/motion/MaskReveal'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/hooks/useAuth'
import { Container } from '../Section'

const INVERSE_OUTLINE = 'border-white/30 bg-white/[0.04] text-white backdrop-blur-sm hover:border-white/60 hover:bg-white/10'

export function ClosingBand() {
  const { isAuthenticated, role, homePath } = useAuth()
  const canReport = !isAuthenticated || role === 'citizen'
  const ref = useRef(null)
  const inView = useInView(ref, { margin: '120px 0px' })

  return (
    <section
      ref={ref}
      aria-labelledby="closing-title"
      className="closing-band landing-defer relative isolate overflow-hidden text-white"
      data-paused={!inView || undefined}
    >
      <div aria-hidden className="closing-sky absolute inset-0" />
      <div aria-hidden className="closing-horizon" />
      <div aria-hidden className="closing-road">
        <div className="closing-road-plane">
          <div className="closing-road-markings" />
        </div>
      </div>
      <div aria-hidden className="closing-scrim absolute inset-0" />

      <Container className="relative flex min-h-[34rem] flex-col justify-start py-16 sm:min-h-[36rem] sm:py-20 lg:min-h-[34rem] lg:justify-center lg:py-24">
        <div className="max-w-xl">
          <RevealHeading as="h2" id="closing-title" split="words" className="display-lg text-white">
            Seen something that needs fixing?
          </RevealHeading>
          <p className="mt-5 text-lg leading-relaxed text-asphalt-200">
            Take a photo, add a line about it and drop a pin. CivicAI files it with the right department, and you can follow
            every step until it is fixed.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            {canReport ? (
              <Button size="lg" variant="warning" to="/citizen/report" leftIcon={MapPinPlus}>
                Report an Issue
              </Button>
            ) : null}
            <Button size="lg" variant="outline" to={isAuthenticated ? homePath : '/login'} leftIcon={LayoutDashboard} className={INVERSE_OUTLINE}>
              Explore Dashboard
            </Button>
          </div>
        </div>
      </Container>
    </section>
  )
}

export default ClosingBand
