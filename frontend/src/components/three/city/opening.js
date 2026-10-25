/**
 * Timing of the landing's establishing shot (pure JS, no three.js): shared by CityScene, which plays it, and the
 * hero that cues its live figures with it (pages/public/components/landing/HeroScene.jsx).
 *
 * The opening starts when the hero is committed (`openingAt`, a performance.now() time). The hero's copy never
 * waits for the 3D, so the shot is a layer that fades up behind it from the opening sky. It is decided on the
 * scene's first real frame: a frame by `deadline` gets a flight that ends within `budget` (the full one when it
 * comes early, a little shorter when late), a later one settles in. The flight's clock then starts once frames
 * arrive on time (at most `hold` later), so its first second never skips. The scene marks its decision on its
 * canvas as `data-opening` ('flight' | 'settle', then 'done' when the flight has landed), so the hero can tell a
 * first frame that is already on its way from one that is not.
 *
 * Measured on the production build on the target laptop (Intel UHD, cold browser): the first frame lands 1.3-1.7 s
 * after the hero commit, so with a 3 s deadline the full flight is the normal first visit.
 */
export const OPENING = Object.freeze({
  /** Length of the full flight (s). */
  flight: 3.4,
  /** The shortest flight still worth playing (s). */
  minFlight: 2.6,
  /** From the opening's start to the end of the flight, at most (s). */
  budget: 5.6,
  /** The first frame must be on screen this soon after the opening's start for the flight to play (s). */
  deadline: 3,
  /** The flight waits at most this long (s) after the first frame for frames to arrive on time. */
  hold: 0.6,
})

/** Seconds of flight left for a first frame drawn at `now` (ms) of an opening that started at `openingAt` (ms). */
export function flightFor(openingAt, now) {
  const left = OPENING.budget - Math.max(0, now - openingAt) / 1000
  return left >= OPENING.minFlight ? Math.min(OPENING.flight, left) : 0
}
