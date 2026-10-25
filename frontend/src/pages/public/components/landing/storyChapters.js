/**
 * The "How CivicAI Works" scroll story: the fifteen lifecycle stops (landingContent.LIFECYCLE_STOPS, unchanged and
 * still numbered 1-15) grouped into five chapters, one per stage of the 3D city (components/three CityScene):
 * report -> analyze -> prioritize -> route -> verify.
 *
 * A chapter starts at the stop index `from` and runs to the next chapter's start (the last one to the end of the
 * lifecycle), so every stop is shown exactly once and in order, whatever the lifecycle list contains.
 */
import { LIFECYCLE_STOPS } from './landingContent'

const CHAPTERS = [
  { key: 'report', stage: 'report', title: 'A citizen reports it', from: 0 },
  { key: 'analyze', stage: 'analyze', title: 'The AI reads it', from: 2 },
  { key: 'prioritize', stage: 'prioritize', title: 'It gets a priority', from: 6 },
  { key: 'route', stage: 'route', title: 'The right department gets it', from: 8 },
  { key: 'verify', stage: 'verify', title: 'The fix is checked', from: 10 },
]

export const STORY_CHAPTERS = Object.freeze(
  CHAPTERS.map((chapter, index) => {
    const end = CHAPTERS[index + 1]?.from ?? LIFECYCLE_STOPS.length
    const stops = []
    for (let stop = chapter.from; stop < end; stop += 1) stops.push(stop)
    return Object.freeze({ ...chapter, stops: Object.freeze(stops) })
  }),
)
