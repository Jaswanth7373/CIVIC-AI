/**
 * The hero's opening decision, shared by HeroSection (which holds its entrance) and HeroScene (which cues it).
 *
 * On the first visit of a tab session, with motion allowed and the 3D on this device, the hero opens with the
 * scene's establishing shot (the camera flies down from an aerial view while the lamps switch on) and the gantry,
 * sign and copy enter with it. `civicai.city.intro` is the session key the 3D scene reads when it mounts (and sets
 * once its flight has played): when the scene is late, HeroScene sets it first, so the scene settles in instead of
 * flying away from the still the visitor is already looking at.
 */
import { useState } from 'react'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { supportsWebGL, useSceneQuality } from '@/components/three'

const INTRO_KEY = 'civicai.city.intro'

function introPending() {
  try {
    return window.sessionStorage.getItem(INTRO_KEY) !== '1'
  } catch {
    return false
  }
}

/** The scene that mounts after this settles into the composition instead of playing its flight. */
export function skipIntro() {
  try {
    window.sessionStorage.setItem(INTRO_KEY, '1')
  } catch {
    // Storage blocked: the flight may still play late; the entrance has been cued either way.
  }
}

/**
 * Decided once per mount: will the hero open with the establishing shot? Only then does HeroSection hold its
 * entrance until the scene cues it.
 */
export function useHeroOpening() {
  const reduced = usePrefersReducedMotion()
  const quality = useSceneQuality()
  const [opening] = useState(() => !reduced && quality.render3D && supportsWebGL() && introPending())
  return opening
}
