/**
 * BeforeAfterSlider - compare the "before" and "after" photo of a resolution with a draggable divider.
 *
 * Props:
 * - before / after: image URLs (both required for the comparison)
 * - beforeLabel / afterLabel: corner tags (default "Before" / "After")
 * - alt: description of the scene, used for both images ("Pothole on Road No. 12")
 * - initial: starting divider position in percent (default 50)
 * - fit: 'contain' (default - evidence is never cropped) | 'cover'
 * - aspect: CSS aspect-ratio of the frame (default "4 / 3")
 * - reveal: the wipe played the first time the slider is seen - 'quick' (default; `true` means the same): one
 *   decisive 0.9 s sweep from the right edge to `initial`, for the work screens officers open again and again |
 *   'showcase': the landing's two-leg sweep (right edge -> 7% -> `initial`, about 1.95 s) | false: no wipe
 * - className
 *
 * Technique: both photos fill the same frame; the after photo sits on top and is clipped with
 * `clip-path: inset(0 0 0 X%)`, so moving the divider reveals more of one or the other without re-laying
 * out anything. The divider position is a motion value (no React render per frame while dragging or while
 * the wipe plays). Pointer input uses Pointer Events with pointer capture (mouse, pen and touch in one code
 * path; `touch-action: pan-y` keeps vertical page scrolling working on phones). The divider handle is a
 * WAI-ARIA slider: Left / Right move it by 5%, Page Up / Page Down by 20%, Home / End jump to the edges.
 *
 * Motion: the first time the photos come into view, the divider starts at the far right (only the "before"
 * photo) and sweeps left so the repaired site wipes in across the frame, settling at `initial` - the fix,
 * revealed ('showcase' first overshoots to 7%, then comes back). Any touch, drag or key press takes over at
 * once. Reduced motion: the divider simply rests at `initial`.
 */
import { animate, motion, useMotionValue, useMotionValueEvent, useTransform } from 'framer-motion'
import { ChevronsLeftRight, ImageOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useInViewOnce, usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import '@/styles/app.css'

function clamp(value) {
  return Math.min(100, Math.max(0, value))
}

function Photo({ src, alt, fit, onError, failed }) {
  if (failed || !src) {
    return (
      <div className="absolute inset-0 grid place-items-center bg-sunken text-ink-3">
        <span className="flex flex-col items-center gap-1.5 text-xs font-medium">
          <ImageOff aria-hidden className="size-6" />
          Photo unavailable
        </span>
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      draggable={false}
      loading="lazy"
      decoding="async"
      onError={onError}
      className={cn('absolute inset-0 size-full select-none', fit === 'cover' ? 'object-cover' : 'object-contain')}
    />
  )
}

export function BeforeAfterSlider({
  before,
  after,
  beforeLabel = 'Before',
  afterLabel = 'After',
  alt = 'Issue location',
  initial = 50,
  fit = 'contain',
  aspect = '4 / 3',
  reveal = 'quick',
  className,
}) {
  const start = clamp(Number(initial) || 50)
  const reduced = usePrefersReducedMotion()
  const frameRef = useRef(null)
  const draggingRef = useRef(false)
  const wipeRef = useRef(null)
  const [failed, setFailed] = useState({ before: false, after: false })
  const seen = useInViewOnce(frameRef, { amount: 0.4, margin: '0px' })
  const willWipe = Boolean(reveal) && !reduced
  const showcase = reveal === 'showcase'
  const position = useMotionValue(willWipe ? 100 : start)
  const [rounded, setRounded] = useState(() => Math.round(willWipe ? 100 : start))
  const [wiping, setWiping] = useState(false)
  const clipPath = useTransform(position, (value) => `inset(0 0 0 ${value}%)`)
  const left = useTransform(position, (value) => `${value}%`)

  useMotionValueEvent(position, 'change', (value) => {
    const next = Math.round(value)
    setRounded((current) => (current === next ? current : next))
  })

  // The reveal: once, the first time the photos are in view.
  const playedRef = useRef(false)
  useEffect(() => {
    if (!willWipe || !seen || playedRef.current) return undefined
    playedRef.current = true
    setWiping(true)
    const controls = showcase
      ? animate(position, [100, 7, start], {
          duration: 1.7,
          times: [0, 0.58, 1],
          ease: [EASE.inOut, EASE.standard],
          delay: 0.25,
          onComplete: () => setWiping(false),
        })
      : animate(position, [100, start], {
          duration: 0.9,
          ease: EASE.enter,
          delay: 0.15,
          onComplete: () => setWiping(false),
        })
    wipeRef.current = controls
    return () => controls.stop()
  }, [willWipe, showcase, seen, position, start])

  /** The user takes over: stop the reveal where it is. */
  const takeOver = () => {
    if (wipeRef.current) {
      wipeRef.current.stop()
      wipeRef.current = null
      setWiping(false)
    }
  }

  const moveTo = (clientX) => {
    const rect = frameRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    position.set(clamp(((clientX - rect.left) / rect.width) * 100))
  }

  const handlePointerDown = (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return
    takeOver()
    draggingRef.current = true
    event.currentTarget.setPointerCapture?.(event.pointerId)
    moveTo(event.clientX)
  }
  const handlePointerMove = (event) => {
    if (draggingRef.current) moveTo(event.clientX)
  }
  const stopDragging = (event) => {
    draggingRef.current = false
    event.currentTarget.releasePointerCapture?.(event.pointerId)
  }

  const handleKeyDown = (event) => {
    const steps = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5, PageDown: -20, PageUp: 20 }
    if (event.key in steps) {
      event.preventDefault()
      takeOver()
      position.set(clamp(position.get() + steps[event.key]))
    } else if (event.key === 'Home') {
      event.preventDefault()
      takeOver()
      position.set(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      takeOver()
      position.set(100)
    }
  }

  return (
    <div className={cn('min-w-0', className)}>
      <div
        ref={frameRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        data-wiping={wiping ? '' : undefined}
        className="app-compare relative w-full cursor-ew-resize touch-pan-y overflow-hidden rounded-xl bg-sunken select-none"
        style={{ aspectRatio: aspect }}
      >
        <Photo
          src={before}
          alt={`${beforeLabel}: ${alt}`}
          fit={fit}
          failed={failed.before}
          onError={() => setFailed((current) => ({ ...current, before: true }))}
        />
        <motion.div className="absolute inset-0" style={{ clipPath }}>
          <Photo
            src={after}
            alt={`${afterLabel}: ${alt}`}
            fit={fit}
            failed={failed.after}
            onError={() => setFailed((current) => ({ ...current, after: true }))}
          />
        </motion.div>

        <span className="pointer-events-none absolute left-2 top-2 rounded-md bg-asphalt-950/75 px-2 py-0.5 text-xs font-semibold text-white">
          {beforeLabel}
        </span>
        <span className="pointer-events-none absolute right-2 top-2 rounded-md bg-sign-700/90 px-2 py-0.5 text-xs font-semibold text-white">
          {afterLabel}
        </span>

        <motion.div aria-hidden className="app-compare-divider pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2" style={{ left }} />
        <motion.div
          role="slider"
          tabIndex={0}
          aria-label={`Comparison divider: ${beforeLabel.toLowerCase()} photo on the left, ${afterLabel.toLowerCase()} photo on the right`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={rounded}
          aria-valuetext={`${rounded}% of the ${beforeLabel.toLowerCase()} photo shown`}
          aria-orientation="horizontal"
          onKeyDown={handleKeyDown}
          className="absolute top-1/2 grid size-10 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white text-asphalt-900 shadow-[var(--shadow-overlay)] ring-2 ring-asphalt-900/15 transition-[box-shadow] duration-300 pointer-coarse:size-11"
          style={{ left }}
        >
          <ChevronsLeftRight aria-hidden className="size-5" />
        </motion.div>
      </div>
      <p className="mt-1.5 text-xs text-ink-3">Drag the divider, or focus it and use the arrow keys, to compare the photos.</p>
    </div>
  )
}

export default BeforeAfterSlider
