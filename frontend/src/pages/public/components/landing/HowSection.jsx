/**
 * "How CivicAI Works" - a pinned scroll story. The fifteen stops of a complaint's life (landingContent) are read in
 * five chapters while a 3D city beside them follows along: a citizen's pin drops onto a street, the AI scan
 * crosses it, issues rise as priority columns, routing arcs fly to the departments, and the fixed issues turn
 * green. The reader's scroll drives the scene (no timers).
 *
 * Layout
 * - Large screens and landscape phones: the chapters on the left, the scene pinned on the right (sticky, the full
 *   window height). The track runs on past the last chapter (bottom padding on the list), so the scene stays
 *   pinned until chapter 5 has been read - the payoff, every issue verified - and then fades out as the reader
 *   moves on, instead of sliding away under the header mid-chapter.
 * - Phones and tablets: the scene is a band pinned under the header; the chapters scroll beneath it, each sized
 *   to its content (no tall empty stops).
 * - Each chapter is a numbered list of its stops on a lane line, which fills with road-marking yellow as that
 *   chapter is read. The stops keep their numbers 1-15 (the sequence is real).
 *
 * One passive scroll listener measures the five chapters against a reading line once per frame and writes
 * MotionValues (stage progress, rail, lane fills, the outro fade) - React only re-renders when the chapter changes.
 *
 * Props: categories (CategoryOut[] | null) - real category and department names for the scene's signs.
 */
import { motion, motionValue } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { BREAKPOINTS, useMediaQuery } from '@/hooks/useMediaQuery'
import { cn } from '@/utils/cn'
import { Container } from '../Section'
import { LIFECYCLE_STOPS } from './landingContent'
import { LandingHeading } from './LandingSection'
import { STORY_CHAPTERS } from './storyChapters'
import { StoryScene } from './StoryScene'

const clamp01 = (value) => Math.min(1, Math.max(0, value))
/** A stage plays over the first 80% of its chapter and holds its final state for the rest. */
const STAGE_SPAN = 0.8
/**
 * Side by side (large screens, landscape phones): once the last chapter has been read (its end passes the reading
 * line), the pinned scene fades out over this share of the window height of scrolling. The list's bottom padding
 * (62svh) keeps the scene pinned until the fade is over.
 */
const OUTRO_SPAN = 0.1
/** Landscape phones: too short for a band over the chapters, so the story uses the side-by-side layout. */
const SHORT_LANDSCAPE = '(orientation: landscape) and (max-height: 32rem) and (max-width: 63.98rem)'

/**
 * Where the reader's eye is, in px from the top of the window: the middle of the window when the scene is beside
 * the chapters, and on phones a third of the way down the space left under the pinned scene band.
 */
function readingLine(sideBySide, rem) {
  const height = window.innerHeight
  if (sideBySide) return height * 0.5
  const header = 4 * rem // --public-header-h
  const band = Math.min(height * 0.38, 22 * rem) // the pinned band: min(38svh, 22rem)
  return header + band + (height - header - band) * 0.32
}

/** Root font size in px (read once per layout change, never per scroll frame). */
const rootRem = () => parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16

function useStoryScroll(chapterRefs, sideBySide) {
  const [active, setActive] = useState(0)
  const [values] = useState(() => ({
    stage: motionValue(0),
    chapters: STORY_CHAPTERS.map(() => motionValue(0)),
    outro: motionValue(1),
  }))
  const activeRef = useRef(0)

  useEffect(() => {
    let frame = 0
    let rem = rootRem()
    const measure = () => {
      frame = 0
      const line = readingLine(sideBySide, rem)
      let current = 0
      let lastBottom = null
      chapterRefs.current.forEach((node, index) => {
        if (!node) return
        const rect = node.getBoundingClientRect()
        const value = clamp01((line - rect.top) / Math.max(rect.height, 1))
        values.chapters[index].set(value)
        if (rect.top <= line) current = index
        lastBottom = rect.bottom
      })
      values.stage.set(clamp01(values.chapters[current].get() / STAGE_SPAN))
      values.outro.set(
        sideBySide && lastBottom !== null ? 1 - clamp01((line - lastBottom) / (window.innerHeight * OUTRO_SPAN)) : 1,
      )
      if (current !== activeRef.current) {
        activeRef.current = current
        setActive(current)
      }
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure)
    }
    const onResize = () => {
      rem = rootRem()
      schedule()
    }
    measure()
    window.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', onResize)
    }
  }, [chapterRefs, sideBySide, values])

  return { active, values }
}

function Chapter({ chapter, index, active, fill, chapterRef }) {
  const titleId = `how-chapter-${chapter.key}`
  return (
    // Phones and tablets: sized to the content, from the top (the band above already holds the eye). Large
    // screens: a tall stop per chapter, centred - except the first, which starts level with the pinned scene.
    <li
      ref={chapterRef}
      aria-labelledby={titleId}
      className="relative flex min-h-[min(46svh,24rem)] flex-col justify-start pb-10 pt-8 lg:min-h-[min(80svh,52rem)] lg:justify-center lg:py-14 lg:first:justify-start"
    >
      <div className="flex items-baseline gap-4">
        {/* The "you are here" numeral: marking-700 on concrete (3.8:1), road yellow at night; the others ~3:1. */}
        <span
          aria-hidden
          className={cn(
            'font-display text-[2.75rem] font-black leading-none tracking-tight tabular transition-colors duration-500 ease-standard',
            active ? 'text-marking-700 dark:text-marking-500' : 'text-ink-3/70 dark:text-ink-3/60',
          )}
        >
          {String(index + 1).padStart(2, '0')}
        </span>
        <h3 id={titleId} className="display-sm text-ink">
          {chapter.title}
        </h3>
      </div>

      <div className="relative mt-7 pl-1">
        {/* The chapter's stretch of road: a grey lane line that fills with yellow as the chapter is read. */}
        <span aria-hidden className="absolute bottom-5 left-[1.375rem] top-5 w-[3px] -translate-x-1/2 overflow-hidden rounded-full">
          <span className="absolute inset-0 bg-[repeating-linear-gradient(to_bottom,var(--c-line-strong)_0_10px,transparent_10px_18px)]" />
          <motion.span className="lane-line absolute inset-0 origin-top" style={{ scaleY: fill }} />
        </span>
        <ol className="relative space-y-6">
          {chapter.stops.map((stopIndex) => {
            const stop = LIFECYCLE_STOPS[stopIndex]
            return (
              <li key={stop.title} className="grid grid-cols-[2.75rem_minmax(0,1fr)] items-start gap-x-3.5">
                <span className="relative grid size-9 place-items-center justify-self-center rounded-full bg-white font-display text-[15px] font-extrabold text-asphalt-900 shadow-[0_0_0_3px_var(--color-asphalt-900)] tabular dark:shadow-[0_0_0_3px_var(--color-asphalt-600)]">
                  <span className="sr-only">Stop </span>
                  {stopIndex + 1}
                </span>
                <div className="min-w-0 pt-1">
                  <h4 className="font-display text-base font-bold leading-snug text-ink sm:text-[17px]">{stop.title}</h4>
                  <p className="mt-1 text-[15px] leading-relaxed text-ink-2">{stop.detail}</p>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </li>
  )
}

export function HowSection({ categories = null }) {
  const desktop = useMediaQuery(BREAKPOINTS.lg)
  const shortLandscape = useMediaQuery(SHORT_LANDSCAPE)
  const chapterRefs = useRef([])
  const { active, values } = useStoryScroll(chapterRefs, desktop || shortLandscape)

  return (
    <section id="how-civicai-works" aria-labelledby="how-title" className="relative scroll-mt-16 bg-bg">
      <Container className="pt-16 sm:pt-20 lg:pt-24">
        <LandingHeading
          id="how-title"
          title="How CivicAI Works"
          lead={`Every report travels the same road: ${LIFECYCLE_STOPS.length} stops from a citizen's phone to the city's dashboards. Each stop is a real step of the platform, and the citizen can follow the complaint along the way.`}
          actions={
            <Button variant="outline" to="/how-it-works">
              Read the technical walkthrough
            </Button>
          }
        />
      </Container>

      {/* story-grid / story-panel / story-chapters: the side-by-side layout on landscape phones (landing.css). */}
      <Container className="story-grid relative mt-10 pb-8 sm:mt-12 lg:mt-6 lg:grid lg:grid-cols-[minmax(0,25rem)_minmax(0,1fr)] lg:gap-x-14 lg:pb-24 xl:grid-cols-[minmax(0,28rem)_minmax(0,1fr)] xl:gap-x-20">
        <motion.div
          className="story-panel sticky top-[var(--public-header-h)] z-10 -mx-4 h-[min(38svh,22rem)] border-b border-line shadow-[0_14px_24px_-18px_rgb(15_22_23/0.5)] sm:-mx-6 lg:order-2 lg:top-[calc(var(--public-header-h)+1.5rem)] lg:mx-0 lg:mt-14 lg:h-[min(calc(100svh-var(--public-header-h)-3rem),72rem)] lg:self-start lg:border-0 lg:shadow-none"
          style={{ opacity: values.outro }}
        >
          <StoryScene
            chapter={active}
            progress={values.stage}
            chapterProgress={values.chapters}
            categories={categories}
            className="lg:rounded-2xl lg:border lg:border-line-strong/50 lg:elev-raised"
          />
        </motion.div>

        <ol className="story-chapters lg:order-1 lg:pb-[62svh]">
          {STORY_CHAPTERS.map((chapter, index) => (
            <Chapter
              key={chapter.key}
              chapter={chapter}
              index={index}
              active={index === active}
              fill={values.chapters[index]}
              chapterRef={(node) => {
                chapterRefs.current[index] = node
              }}
            />
          ))}
        </ol>
      </Container>
    </section>
  )
}

export default HowSection
