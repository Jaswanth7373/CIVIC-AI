/**
 * AIScanOverlay - the citizen's photo (or, for a text-only report, the description) under the AI's survey
 * scan while the complaint is analysed, then locked onto what the vision model found.
 *
 * Props:
 * - src: photo URL (the object URL of the file being submitted); without it the description is scanned
 * - alt: description of the photo
 * - text: the report's description (text-only reports, and the keyword highlights)
 * - phase: 'scanning' (request running / replay before the image step) | 'locked' (result known)
 * - prediction: AIPrediction of the result (`detected_objects`, `bounding_boxes`, `keywords`,
 *   `final_category`, `multimodal_confidence`, `processing_time_ms`, `is_demo`) - only real values are drawn
 * - categories: CategoryMini list, to name detection labels
 * - startedAt / endedAt: epoch ms when the request started / answered (the clock is the real elapsed time)
 * - className
 *
 * What happens: while scanning, a road-marking yellow light sheet sweeps the photo over a faint survey grid,
 * between four corner brackets, and a clock counts the real elapsed seconds. When the result arrives, the
 * brackets travel from the photo's corners onto the detected region, the region's outline draws itself side
 * by side, the rest of the photo dims, and a sign-style label pops above the region with the category and
 * the detector's confidence. Without a detection the brackets settle on the whole photo and say so. A
 * text-only report gets the same scan over its description, then the keywords the text model extracted
 * are marked in it.
 *
 * Accessibility: the visual is decorative for screen readers except the status line, which is a polite live
 * region ("Scanning the photo", "Issue located: Roads / Potholes"). Reduced motion: no sweep or travel - the
 * scan shows a still frame, and the result is shown in its final position at once.
 */
import { AnimatePresence, motion } from 'framer-motion'
import { ScanSearch } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { usePrefersReducedMotion } from '@/components/motion/hooks'
import { EASE } from '@/components/motion/tokens'
import { cn } from '@/utils/cn'
import { formatNumber, formatPercent } from '@/utils/format'
import { categoryFromSlug, detectionsOf, humanize, normaliseBox, toRatio } from './aiUtils'
import '@/styles/app.css'

const FULL = { x: 0, y: 0, w: 1, h: 1 }
const LOCK = { duration: 0.75, ease: EASE.enter }

/** Real elapsed seconds since `startedAt`: ticks every 100 ms until `endedAt` is known, then holds. */
function useElapsed(startedAt, endedAt) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!startedAt || endedAt) return undefined
    const timer = window.setInterval(() => setNow(Date.now()), 100)
    return () => window.clearInterval(timer)
  }, [startedAt, endedAt])
  if (!startedAt) return null
  return Math.max(0, ((endedAt ?? now) - startedAt) / 1000)
}

/** The four corner brackets, framing `rect` (fractions of the image). */
function Brackets({ rect, locked, reduced }) {
  const target = { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }
  return (
    <motion.div
      aria-hidden
      className="app-scan-brackets pointer-events-none absolute"
      data-locked={locked ? '' : undefined}
      initial={reduced ? false : { left: '0%', top: '0%', width: '100%', height: '100%' }}
      animate={target}
      transition={reduced ? { duration: 0 } : LOCK}
    >
      <span className="app-scan-corner" data-corner="tl" />
      <span className="app-scan-corner" data-corner="tr" />
      <span className="app-scan-corner" data-corner="bl" />
      <span className="app-scan-corner" data-corner="br" />
    </motion.div>
  )
}

/** Outline of a detected region, drawn side by side (top, right, bottom, left), then its label. */
const EDGES = [
  { edge: 'top', axis: 'scaleX', origin: { originX: 0 } },
  { edge: 'right', axis: 'scaleY', origin: { originY: 0 } },
  { edge: 'bottom', axis: 'scaleX', origin: { originX: 1 } },
  { edge: 'left', axis: 'scaleY', origin: { originY: 1 } },
]

function DetectionBox({ rect, label, primary, delay, reduced, approximate }) {
  // The label hangs from the side of the region that leaves it room inside the photo.
  const anchor = rect.x + rect.w / 2 > 0.6 ? 'end' : 'start'
  return (
    <div
      aria-hidden
      className={cn('app-scan-box pointer-events-none absolute', primary && 'app-scan-box-primary', approximate && 'app-scan-box-approx')}
      style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
    >
      {primary ? (
        <motion.span
          className="app-scan-spotlight"
          initial={reduced ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay }}
        />
      ) : null}
      {EDGES.map(({ edge, axis, origin }, index) => (
        <motion.span
          key={edge}
          className="app-scan-edge"
          data-edge={edge}
          style={origin}
          initial={reduced ? false : { [axis]: 0 }}
          animate={{ [axis]: 1 }}
          transition={{ duration: 0.16, ease: 'linear', delay: delay + index * 0.16 }}
        />
      ))}
      {label ? (
        <motion.span
          className={cn('app-scan-label', rect.y < 0.14 && 'app-scan-label-inside')}
          data-anchor={anchor}
          style={{ originX: anchor === 'end' ? 1 : 0, originY: 1 }}
          initial={reduced ? false : { opacity: 0, y: 6, scale: 0.85 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 520, damping: 26, delay: delay + 0.66 }}
        >
          {rect.y < 0.14 ? null : <span aria-hidden className="app-scan-post" data-anchor={anchor} />}
          <span className="app-scan-label-text">{label}</span>
        </motion.span>
      ) : null}
    </div>
  )
}

/** The description with the extracted keywords marked (text-only reports). */
function MarkedText({ text, keywords, locked }) {
  const parts = useMemo(() => {
    const words = (keywords ?? []).filter((word) => word && word.length > 2)
    if (!locked || !words.length) return [{ text, mark: false }]
    const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length)
    const pattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi')
    const out = []
    let last = 0
    for (const match of text.matchAll(pattern)) {
      if (match.index > last) out.push({ text: text.slice(last, match.index), mark: false })
      out.push({ text: match[0], mark: true })
      last = match.index + match[0].length
    }
    if (last < text.length) out.push({ text: text.slice(last), mark: false })
    return out
  }, [text, keywords, locked])
  let marks = 0
  return (
    <p className="line-clamp-9 whitespace-pre-line break-words text-[15px] leading-7 text-asphalt-100">
      {parts.map((part, index) =>
        part.mark ? (
          <mark key={index} className="app-scan-mark" style={{ '--mark-delay': `${0.15 + marks++ * 0.12}s` }}>
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  )
}

export function AIScanOverlay({
  src,
  alt = 'Your photo',
  text = '',
  phase = 'scanning',
  prediction,
  categories,
  startedAt,
  endedAt,
  className,
}) {
  const reduced = usePrefersReducedMotion()
  const [natural, setNatural] = useState(null)
  // The photo fades in once it is decoded (never an empty frame, then a pop), and the scan starts with it.
  const [loadedSrc, setLoadedSrc] = useState(null)
  const loaded = Boolean(src) && loadedSrc === src
  const locked = phase === 'locked'
  const elapsed = useElapsed(startedAt, endedAt)
  const photo = Boolean(src)

  const detections = useMemo(
    () =>
      detectionsOf(prediction?.detected_objects, prediction?.bounding_boxes)
        .map((item) => ({ ...item, rect: normaliseBox(item.box, natural), ratio: toRatio(item.confidence) }))
        .filter((item) => item.rect),
    [prediction, natural],
  )
  // Lock onto the most confident region; the others are outlined only.
  const primary = useMemo(
    () => detections.reduce((best, item) => (best && (best.ratio ?? 0) >= (item.ratio ?? 0) ? best : item), null),
    [detections],
  )
  const finalCategory = prediction?.final_category ?? null
  const nameOf = (label) => (label ? (categoryFromSlug(label, categories, finalCategory)?.name ?? humanize(label)) : finalCategory?.name)
  const labelOf = (item) => {
    const name = nameOf(item.label) ?? 'Detected region'
    return item.ratio != null ? `${name} ${formatPercent(item.ratio)}` : name
  }
  const keywords = (Array.isArray(prediction?.keywords) ? prediction.keywords : [])
    .map((keyword) => (typeof keyword === 'string' ? keyword : (keyword?.keyword ?? keyword?.text ?? '')))
    .filter(Boolean)

  const status = !locked
    ? photo
      ? 'Scanning the photo'
      : 'Reading the description'
    : photo
      ? primary
        ? `Issue located: ${nameOf(primary.label) ?? 'detected region'}`
        : 'Classified from the whole photo, no single region marked'
      : keywords.length
        ? `${keywords.length === 1 ? '1 keyword' : `${keywords.length} keywords`} read from the description`
        : 'Description classified'
  const clock = locked
    ? prediction?.processing_time_ms != null
      ? `Analysed in ${formatNumber(prediction.processing_time_ms)} ms`
      : null
    : elapsed != null
      ? `${elapsed.toFixed(1)} s`
      : null

  return (
    <figure
      className={cn('app-scan relative isolate overflow-hidden rounded-2xl', className)}
      data-phase={locked ? 'locked' : 'scanning'}
      data-mode={photo ? 'photo' : 'text'}
    >
      <div className="relative grid min-h-56 place-items-center px-3 pb-14 pt-11 sm:px-5">
        {photo ? (
          <div className="relative w-fit max-w-full overflow-hidden rounded-lg">
            <img
              src={src}
              alt={alt}
              decoding="async"
              onLoad={(event) => {
                setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })
                setLoadedSrc(src)
              }}
              className={cn(
                'block h-auto max-h-[min(46svh,24rem)] w-auto max-w-full select-none transition-opacity duration-200 ease-out motion-reduce:transition-none',
                loaded ? 'opacity-100' : 'opacity-0',
              )}
              draggable={false}
            />
            <span aria-hidden className="app-scan-grid" />
            {!locked && !reduced && loaded ? <span aria-hidden className="app-scan-beam" /> : null}
            <Brackets rect={locked && primary ? primary.rect : locked ? { x: 0.04, y: 0.04, w: 0.92, h: 0.92 } : FULL} locked={locked} reduced={reduced} />
            {locked
              ? detections.map((item) => (
                  <DetectionBox
                    key={item.number}
                    rect={item.rect}
                    primary={item === primary}
                    approximate={item.approximate}
                    label={item === primary ? labelOf(item) : null}
                    delay={reduced ? 0 : item === primary ? 0.55 : 0.9}
                    reduced={reduced}
                  />
                ))
              : null}
          </div>
        ) : (
          <div className="relative w-full max-w-xl overflow-hidden rounded-lg border border-white/10 bg-white/[0.04] px-4 py-4 sm:px-5">
            <MarkedText text={text} keywords={keywords} locked={locked} />
            {!locked && !reduced ? <span aria-hidden className="app-scan-beam" /> : null}
          </div>
        )}
      </div>

      {/* HUD: what the scan is doing (top), the live status and the real clock (bottom). */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 px-3.5 py-3 sm:px-5">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-asphalt-200">
          <ScanSearch className="size-4 text-marking-400" />
          AI scan
        </span>
        <AnimatePresence>
          {locked && prediction?.is_demo ? (
            <motion.span
              initial={reduced ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              className="rounded-md bg-marking-500/15 px-2 py-0.5 text-[11px] font-semibold text-marking-300 ring-1 ring-inset ring-marking-500/30"
            >
              Demo AI Mode
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>
      <figcaption className="absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3.5 pb-3 pt-6 sm:px-5">
        <span className="inline-flex min-w-0 items-center gap-2 text-sm font-semibold text-white" aria-live="polite">
          <span aria-hidden className={cn('app-scan-dot size-2 shrink-0 rounded-full', locked ? 'bg-sign-400' : 'bg-marking-400')} />
          <span className="min-w-0">{status}</span>
        </span>
        {clock ? <span className="shrink-0 text-xs font-medium text-asphalt-300 tabular">{clock}</span> : null}
      </figcaption>
    </figure>
  )
}

export default AIScanOverlay
