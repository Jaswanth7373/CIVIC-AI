/**
 * Building blocks shared by the model playground's tools (PlaygroundTab, PipelinePanel, VerifyPanel).
 *
 * - ToolLayout({form, runKey, children}): the inputs card on the left (26rem wide from xl) and the engine's answer
 *   on the right; stacked on smaller screens. Whenever `runKey` changes (a tool increments it when a run starts),
 *   the answer column is scrolled into view if its top is off screen - on phones it sits below a long form, and on
 *   desktops the run button is below the fold - smoothly unless the user prefers reduced motion.
 * - RunningCard({title, children}): an honest "working" state while a request is in flight - what the engine is
 *   doing and the moving lane line, no invented progress.
 */
import { useReducedMotion } from 'framer-motion'
import { useEffect, useRef } from 'react'
import { Card, CardBody } from '@/components/ui/Card'

/** Height of the sticky top bar plus a little air (px): an answer top hidden under it counts as off screen. */
const TOP_OFFSET = 96

export function ToolLayout({ form, runKey = 0, children }) {
  const answerRef = useRef(null)
  const reducedMotion = useReducedMotion()

  useEffect(() => {
    const element = answerRef.current
    if (!runKey || !element) return
    const { top } = element.getBoundingClientRect()
    if (top < TOP_OFFSET || top > window.innerHeight - TOP_OFFSET) {
      element.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' })
    }
  }, [runKey, reducedMotion])

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      {form}
      <div ref={answerRef} className="min-w-0 scroll-mt-24 space-y-5">
        {children}
      </div>
    </div>
  )
}

export function RunningCard({ title, children }) {
  return (
    <Card>
      <CardBody role="status">
        <p className="font-display text-base font-bold text-ink">{title}</p>
        {children ? <p className="mt-1 text-sm text-ink-2">{children}</p> : null}
        <span aria-hidden className="mt-4 block h-1.5 w-full overflow-hidden rounded-full bg-sunken">
          <span className="lane-line-x animate-lane block h-full w-full" />
        </span>
      </CardBody>
    </Card>
  )
}
