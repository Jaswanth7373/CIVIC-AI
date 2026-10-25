/**
 * DashboardHero - the opening band of the citizen and officer dashboards: today's date, the greeting (the
 * page's only h1), one sentence that sums up where the user stands, the next action, and the city scene
 * (DashboardScene) on the right - or across the top on phones.
 *
 * Props:
 * - title: the h1 (the greeting); `documentTitle` sets the browser tab title
 * - kicker: small line above the title (today's date)
 * - description: the live summary sentence
 * - meta: extra row under the description (e.g. the officer's department and zone)
 * - actions: buttons (the next action first)
 * - loading: the live summary is still on its way. Its lines are held (skeleton bars once the load is slow)
 *   instead of showing different copy, so nothing below moves when the sentence arrives. The description
 *   always reserves three lines on phones and two from sm, the usual length of the live sentence there.
 * - beaconColor: HQ roof beacon colour (the officer's department colour)
 * - sceneKey: remembers per session that the entrance has played ("citizen" / "officer"), so coming back to
 *   the dashboard does not replay it
 * - children: content that overlaps the bottom edge of the band (the key-number tiles), which gives the
 *   tiles real depth: they float above the scene on the floating elevation
 *
 * Motion: on the first visit of the session (and never with reduced motion) the AI survey scan sweeps the
 * skyline once and the windows light up behind it; afterwards only the centre line keeps flowing, and it
 * pauses while the hero is scrolled out of view. With a mouse, the scene answers the pointer with a gentle
 * parallax - the far skyline, the near skyline and the road move by different amounts - and settles back
 * when the pointer leaves (never on touch screens or with reduced motion).
 */
import { useEffect, useRef, useState } from 'react'
import { useFinePointer, usePrefersReducedMotion } from '@/components/motion/hooks'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { Skeleton } from '@/components/ui/Skeleton'
import { cn } from '@/utils/cn'
import { DashboardScene } from './DashboardScene'
import '@/styles/app.css'

const SESSION_PREFIX = 'civicai.hero.'
/** Shared by the summary and its placeholder, so `lh` (the line height) is the same in both. */
const DESCRIPTION_CLASS = 'mt-2.5 min-h-[3lh] text-[15px] leading-relaxed sm:min-h-[2lh] sm:text-base'

/**
 * True the first time this hero is shown in the browser session. The initializer only reads (it may run twice
 * under StrictMode); the flag is written after the first render.
 */
function useFirstVisit(key) {
  const storageKey = `${SESSION_PREFIX}${key}`
  const [first] = useState(() => {
    try {
      return !window.sessionStorage.getItem(storageKey)
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      window.sessionStorage.setItem(storageKey, '1')
    } catch {
      // storage unavailable (private mode): nothing to remember, and the initializer above skips the entrance
    }
  }, [storageKey])
  return first
}

export function DashboardHero({
  title,
  documentTitle,
  kicker,
  description,
  meta,
  actions,
  loading = false,
  beaconColor,
  sceneKey = 'dashboard',
  children,
  className,
}) {
  useDocumentTitle(documentTitle ?? (typeof title === 'string' ? title : undefined))
  const reduced = usePrefersReducedMotion()
  const firstVisit = useFirstVisit(sceneKey)
  const intro = firstVisit && !reduced
  const heroRef = useRef(null)
  const finePointer = useFinePointer()
  const parallax = finePointer && !reduced
  const frameRef = useRef(0)

  // Pointer parallax: write the pointer's offset from the centre (-0.5..0.5) as CSS variables, once per frame.
  const moveParallax = (event) => {
    const node = heroRef.current
    if (!parallax || !node || event.pointerType === 'touch') return
    const { clientX, clientY } = event
    if (frameRef.current) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0
      const rect = node.getBoundingClientRect()
      node.style.setProperty('--px', ((clientX - rect.left) / rect.width - 0.5).toFixed(3))
      node.style.setProperty('--py', ((clientY - rect.top) / rect.height - 0.5).toFixed(3))
    })
  }
  const resetParallax = () => {
    const node = heroRef.current
    if (frameRef.current) window.cancelAnimationFrame(frameRef.current)
    frameRef.current = 0
    node?.style.removeProperty('--px')
    node?.style.removeProperty('--py')
  }
  useEffect(() => () => window.cancelAnimationFrame(frameRef.current), [])

  // Pause the flowing centre line while the hero is off screen.
  useEffect(() => {
    const node = heroRef.current
    if (!node || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) node.removeAttribute('data-paused')
      else node.setAttribute('data-paused', '')
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <div className={cn('mb-6', className)}>
      <header
        ref={heroRef}
        data-intro={intro ? '' : undefined}
        onPointerMove={parallax ? moveParallax : undefined}
        onPointerLeave={parallax ? resetParallax : undefined}
        className={cn(
          'app-hero px-5 pt-[9.5rem] sm:min-h-[19rem] sm:px-8 sm:pt-9 lg:min-h-[20.5rem] lg:px-10 lg:pt-11',
          children ? 'pb-20 sm:pb-24' : 'pb-7 sm:pb-9',
        )}
      >
        <DashboardScene beaconColor={beaconColor} intro={intro} />
        <div className="relative max-w-[34rem] sm:max-w-[min(34rem,57%)] xl:max-w-[min(36rem,48%)]">
          {kicker ? <p className="text-sm font-medium text-ink-2">{kicker}</p> : null}
          <h1 className="mt-1 font-display text-[clamp(1.75rem,1.25rem+1.5vw,2.625rem)] font-extrabold leading-[1.06] tracking-[-0.025em] text-ink">
            {title}
          </h1>
          {loading ? (
            <div aria-hidden className={cn(DESCRIPTION_CLASS, 'app-hero-pending')}>
              <div className="flex h-[1lh] items-center">
                <Skeleton className="h-3.5 w-full max-w-[26rem]" />
              </div>
              <div className="flex h-[1lh] items-center">
                <Skeleton className="h-3.5 w-2/3 max-w-[18rem]" />
              </div>
            </div>
          ) : description ? (
            <p className={cn(DESCRIPTION_CLASS, 'text-ink-2')}>{description}</p>
          ) : null}
          {meta}
          {actions ? <div className="mt-5 flex flex-wrap items-center gap-2.5">{actions}</div> : null}
        </div>
      </header>
      {children ? <div className="relative -mt-14 px-2 sm:-mt-16 sm:px-5 lg:px-6">{children}</div> : null}
    </div>
  )
}

export default DashboardHero
