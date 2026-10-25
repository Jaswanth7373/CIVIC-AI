/**
 * Frame of the login and registration screens: a cinematic split.
 *
 * - Large screens: the form column (title, lead, the form card, a footer link, then the side content: demo
 *   accounts or help on the login page, what an account is for on the registration page) beside a tall window
 *   onto CivicAI's district at night / dawn with the CivicAI sign and one line of copy (AuthScene), sticky while
 *   the column scrolls. The split sits on the site grid: the form column starts on the header's left edge at
 *   every width (the Container's 80rem column and gutters, as grid tracks) and only the scene window runs on
 *   to the right edge of the window.
 * - Phones and tablets: the city is a short band under the header and the form column rises over its lower edge
 *   as a sheet, its content on the Container's gutters like the header's logo. Landscape phones get a slim band
 *   (styles/public.css), so the title and the first field are on the first screen. The form card itself is
 *   crisp and opaque - it never sits on the 3D scene.
 * - Form feedback that means something: while the form is sent (`busy`), a lane strip runs along the card's top
 *   edge and the AI scan - the yellow light sheet of the city - passes over the card; when a submit fails
 *   (`attempt` increases), the card gives a short sideways jolt, so the failure registers at a glance, before the
 *   message is read. The title rises from a mask once. Reduced motion: no scan, no jolt, a still title (the
 *   spinner in the button and the messages remain).
 *
 * Sets the browser tab title. Props: title, documentTitle, lead, aside, footer, tagline, busy, attempt, children
 * (the form).
 */
import { useAnimate } from 'framer-motion'
import { useEffect } from 'react'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { RevealHeading } from '@/components/motion/MaskReveal'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { cn } from '@/utils/cn'
import { AuthScene } from './AuthScene'
import { MUTED_TEXT_AA } from './contrast'
import { Container, PAGE_TITLE_CLASS } from './Section'
import '@/styles/public.css'

const DEFAULT_TAGLINE = 'Every report is read by AI and routed to the people who fix it.'

export function AuthShell({
  title,
  documentTitle,
  lead,
  aside,
  footer,
  tagline = DEFAULT_TAGLINE,
  busy = false,
  attempt = 0,
  children,
}) {
  useDocumentTitle(documentTitle ?? title)
  const reduced = usePrefersReducedMotion()
  const [cardRef, animateCard] = useAnimate()

  // A failed submit jolts the card sideways once (a short, decaying shake), never with reduced motion.
  useEffect(() => {
    if (!attempt || reduced || !cardRef.current) return undefined
    const controls = animateCard(cardRef.current, { x: [0, -9, 8, -5, 3, 0] }, { duration: 0.46, ease: 'easeOut' })
    return () => controls.stop()
  }, [attempt, reduced, animateCard, cardRef])

  return (
    <div className={cn('relative bg-bg', MUTED_TEXT_AA)}>
      {/* Large screens: [gutter | form 36rem | scene 40rem | gutter]. The middle tracks are the Container's 80rem
          column less its 2rem gutters and the side tracks absorb the rest, like its auto margins. */}
      <div className="lg:grid lg:min-h-[calc(100svh-var(--public-header-h))] lg:grid-cols-[minmax(2rem,1fr)_minmax(0,36rem)_minmax(0,40rem)_minmax(2rem,1fr)]">
        <AuthScene tagline={tagline} className="lg:col-[3/-1] lg:row-start-1" />
        <div className="pub-auth-sheet relative z-10 bg-bg lg:col-start-2 lg:row-start-1">
          <Container className="pb-14 pt-8 sm:pt-10 lg:px-0 lg:pb-20 lg:pr-12 lg:pt-14 xl:pr-16 xl:pt-20 [@media(max-height:32rem)]:pt-5">
            <div className="max-w-xl lg:max-w-[34rem]">
              <RevealHeading
                as="h1"
                split="words"
                className={cn(PAGE_TITLE_CLASS, 'text-ink [@media(max-height:32rem)]:text-[2rem]')}
              >
                {title}
              </RevealHeading>
              {lead ? <div className="mt-3 text-base leading-relaxed text-ink-2 sm:text-[17px]">{lead}</div> : null}
              <div
                ref={cardRef}
                aria-busy={busy || undefined}
                className="relative mt-7 rounded-2xl border border-line bg-surface p-5 sm:mt-8 sm:p-7 [@media(max-height:32rem)]:mt-5 [@media(max-height:32rem)]:p-5"
              >
                {busy ? (
                  <span aria-hidden className="pub-scan">
                    <span className="pub-busy-lane" />
                  </span>
                ) : null}
                {children}
              </div>
              {footer ? <div className="mt-5 text-sm text-ink-2">{footer}</div> : null}
              {aside ? <aside className="mt-10 border-t border-line pt-8">{aside}</aside> : null}
            </div>
          </Container>
        </div>
      </div>
    </div>
  )
}

export default AuthShell
