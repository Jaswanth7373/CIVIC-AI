/**
 * The cinematic side of the login and registration screens: CivicAI's district in its "calm" state (a slow
 * orbit, two resolved issues glowing softly, a survey scan passing now and then) seen through a window, with the
 * CivicAI brand sign hanging at the top and one line of copy.
 *
 * - Large screens: a tall window beside the form, sticky while the form scrolls. The camera frames the city low,
 *   so the sign and the line of copy sit on the calm sky above it (a scrim keeps them readable in both themes).
 * - Phones and tablets: a short band under the site header, the sign only; the form sheet overlaps its edge.
 *   Landscape phones (short windows): a slim strip with a compact sign, so the form starts on the first screen.
 *   The window's sizes live in styles/public.css (section 3), where the short-window mode can override them.
 * - The 3D scene comes from components/three: the SVG still is painted first and stays on devices without
 *   hardware WebGL, on the low tier and with reduced motion's single still frame; three.js loads lazily, so the
 *   form is usable before any of it arrives. Night in the dark theme, overcast dawn in the light theme.
 * - Decorative, so the whole panel is hidden from assistive technology: the canvas is an illustration, the sign
 *   repeats the logo and the line of copy is a tagline - screen readers go straight to the page heading and form.
 *
 * Props: tagline (one line of copy, large screens), className.
 */
import { useRef } from 'react'
import { CityFallback, CityScene, SceneCanvas } from '@/components/three'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/utils/cn'
import { GantrySign } from './GantrySign'
import { useReleaseScenes } from './landing/useReleaseScenes'

/** The logo's pictogram for the sign's white tile: map pin (a reported place) and one road-marking dash. */
const BRAND_PICTOGRAM = (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 18.6c-2.3-2.7-5.7-6-5.7-9.9a5.7 5.7 0 0 1 11.4 0c0 3.9-3.4 7.2-5.7 9.9Z" fill="currentColor" />
    <circle cx="12" cy="8.7" r="2.15" fill="#ffffff" />
    <rect x="7.6" y="20.4" width="8.8" height="1.9" rx="0.95" fill="#F5B700" />
  </svg>
)

export function AuthScene({ tagline, className }) {
  const { resolvedTheme } = useTheme()
  const frameRef = useRef(null)
  // Leaving the page: the 3D layer is cut out of the removed page, so a lingering renderer cannot hold it.
  useReleaseScenes(frameRef)

  return (
    <div aria-hidden="true" className={cn('pub-auth-window', className)}>
      <div ref={frameRef} className="relative isolate h-full overflow-hidden bg-sunken lg:rounded-[1.375rem] lg:ring-1 lg:ring-line">
        <SceneCanvas
          className="absolute inset-0"
          fallback={<CityFallback stage="calm" theme={resolvedTheme} framing="auto" />}
        >
          <CityScene stage="calm" theme={resolvedTheme} framing="auto" interactive />
        </SceneCanvas>
        <div aria-hidden className="pub-auth-scrim" />
        <div className="absolute inset-x-0 top-0 px-4 sm:px-6 lg:px-10 xl:px-12">
          <GantrySign tone="brand" tilt={false} delay={0.25} icon={BRAND_PICTOGRAM} className="pub-auth-sign">
            <p className="pub-auth-sign-name font-display font-black leading-none tracking-[-0.01em]">CivicAI</p>
            <p className="pub-auth-sign-tag font-semibold leading-snug text-white/85">AI-Powered Civic Issue Management</p>
          </GantrySign>
          {tagline ? (
            <p className="mt-7 hidden max-w-[26rem] font-display text-[1.375rem] font-bold leading-snug tracking-[-0.01em] text-ink lg:block xl:text-2xl">
              {tagline}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export default AuthScene
