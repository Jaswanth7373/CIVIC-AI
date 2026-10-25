/**
 * Opening block of the inner public pages (About, Features, How it works, Contact): the page title (h1) on a
 * guide-blue gantry sign that hangs from the site header, a lead paragraph, optional extra content and an
 * aside, closed by the lane-line road marking. It also sets the browser tab title ("About CivicAI | CivicAI"),
 * like PageHeader does for the dashboard screens.
 *
 * Depth and motion (cinematic plan 4, "PUBLIC"): the sign swings in on its hinge once and tilts back as the
 * intro scrolls away (GantrySign); the lane marking under the band is painted on and then travels with the
 * scroll (LaneDivider). Body copy does not animate. Reduced motion: everything in its final place.
 *
 * Visual anchor (`scene`): the band is a view of the CivicAI district - the SVG still of the 3D city
 * (CityFallback; no three.js is loaded) at the given story stage, under a page-colour scrim that is strongest
 * behind the sign and the lead (styles/public.css), so the sign hangs over the city like the landing's.
 * Decorative and hidden from assistive technology.
 *
 * Props: title (string or node), documentTitle, lead, aside, icon (lucide component: the sign's pictogram),
 * scene (CityFallback stage, e.g. 'calm' | 'analyze' | 'route' | 'verify'), className, children (rendered under
 * the lead, e.g. a call to action).
 */
import { useRef } from 'react'
import { CityFallback } from '@/components/three'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { cn } from '@/utils/cn'
import { GantrySign } from './GantrySign'
import { LaneDivider } from './LaneDivider'
import { Container, PAGE_TITLE_CLASS } from './Section'

export function PageIntro({ title, documentTitle, lead, aside, icon, scene, className, children }) {
  useDocumentTitle(documentTitle ?? (typeof title === 'string' ? title : undefined))
  const introRef = useRef(null)

  return (
    <header ref={introRef} className={cn('relative isolate bg-surface', className)}>
      {scene ? (
        <div aria-hidden="true" className="pub-intro-scene">
          <CityFallback stage={scene} framing="auto" plates={false} className="absolute inset-0" />
          <div className="pub-intro-scrim" />
        </div>
      ) : null}
      <Container className="grid gap-10 pb-12 sm:pb-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-start lg:gap-16 lg:pb-20">
        <div className="min-w-0 max-w-3xl">
          <GantrySign icon={icon} scrollTarget={introRef}>
            <h1 className={cn(PAGE_TITLE_CLASS, 'text-white')}>{title}</h1>
          </GantrySign>
          {lead ? <p className="lead-fluid mt-8 max-w-[44rem] text-ink-2 sm:mt-10">{lead}</p> : null}
          {children}
        </div>
        {aside ? <div className="min-w-0 lg:pt-11">{aside}</div> : null}
      </Container>
      <LaneDivider />
    </header>
  )
}

export default PageIntro
