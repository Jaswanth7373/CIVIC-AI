/**
 * ImageWithBoxes - a complaint photo with the vision model's detections drawn on top.
 *
 * Props:
 * - src / alt: the photo
 * - objects: AIPrediction `detected_objects` `[{label, confidence, box: [x1, y1, x2, y2], approximate}]`
 * - boxes: AIPrediction `bounding_boxes` `[[x1, y1, x2, y2]]` - used when `objects` is empty
 * - categories: optional CategoryMini list to show category names instead of slugs
 * - showBoxes / onToggle(next): control the overlay from outside; otherwise it is local state that starts at
 *   `defaultShowBoxes` (default true)
 * - showList: numbered list of detections under the photo (default true)
 * - maxHeight: CSS max-height of the photo (default "26rem")
 * - className
 *
 * Coordinates: the engine sends boxes NORMALISED to 0..1 with (x1, y1) = top-left, so each box is placed
 * with percentages - left = x1, top = y1, width = x2 - x1, height = y2 - y1 - on a wrapper that hugs the
 * rendered image (`w-fit`), which keeps boxes aligned at any screen size without measuring. Pixel
 * coordinates (any value > 1.5) are converted with the image's natural size once it has loaded.
 * Boxes are high-visibility road-marking yellow with a dark halo so they show on bright and dark photos;
 * approximate regions (CLIP saliency instead of a detector) are dashed and say "approx.".
 *
 * Motion: the first time the photo is seen, each box closes in on its region (a short zoom from slightly
 * larger, one after another) - the same "lock-on" as the report flow's AI scan. Reduced motion: drawn at once.
 */
import { Eye, EyeOff, ImageOff, ScanSearch } from 'lucide-react'
import { useRef, useState } from 'react'
import { useInViewOnce } from '@/components/motion/hooks'
import { cn } from '@/utils/cn'
import { formatPercent } from '@/utils/format'
import { categoryFromSlug, detectionsOf, humanize, normaliseBox, toRatio } from './aiUtils'
import '@/styles/app.css'

export function ImageWithBoxes({
  src,
  alt = 'Complaint photo',
  objects,
  boxes,
  categories,
  showBoxes,
  onToggle,
  defaultShowBoxes = true,
  showList = true,
  maxHeight = '26rem',
  className,
}) {
  const frameRef = useRef(null)
  const seen = useInViewOnce(frameRef, { amount: 0.35, margin: '0px' })
  const [localShow, setLocalShow] = useState(defaultShowBoxes)
  const [natural, setNatural] = useState(null)
  const [failed, setFailed] = useState(false)
  const visible = showBoxes ?? localShow

  const detections = detectionsOf(objects, boxes).map((item) => ({ ...item, rect: normaliseBox(item.box, natural) }))

  const nameOf = (label) => (label ? (categoryFromSlug(label, categories)?.name ?? humanize(label)) : 'Detected region')

  const toggle = () => {
    const next = !visible
    if (showBoxes === undefined) setLocalShow(next)
    onToggle?.(next)
  }

  if (!src || failed) {
    return (
      <div className={cn('grid aspect-[4/3] w-full place-items-center rounded-xl bg-sunken text-ink-3', className)}>
        <span className="flex flex-col items-center gap-1.5 text-xs font-medium">
          <ImageOff aria-hidden className="size-6" />
          {src ? 'Photo unavailable' : 'No photo attached'}
        </span>
      </div>
    )
  }

  return (
    <figure className={cn('min-w-0', className)}>
      <div ref={frameRef} className="relative mx-auto w-fit max-w-full overflow-hidden rounded-xl bg-sunken">
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
          className="block h-auto w-auto max-w-full"
          style={{ maxHeight }}
        />
        {visible
          ? detections.map((item) =>
              item.rect ? (
                <div
                  key={item.number}
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute rounded-[3px] border-2 border-marking-400 shadow-[0_0_0_1px_rgb(15_22_23/0.7),inset_0_0_0_1px_rgb(15_22_23/0.45)]',
                    item.approximate && 'border-dashed',
                    seen ? 'app-box-in' : 'opacity-0',
                  )}
                  style={{
                    left: `${item.rect.x * 100}%`,
                    top: `${item.rect.y * 100}%`,
                    width: `${item.rect.w * 100}%`,
                    height: `${item.rect.h * 100}%`,
                    animationDelay: `${0.15 + (item.number - 1) * 0.12}s`,
                  }}
                >
                  <span
                    className={cn(
                      'absolute left-[-2px] max-w-[calc(100%+4px)] truncate whitespace-nowrap rounded-[3px] bg-marking-400 px-1.5 py-px text-[11px] font-bold leading-4 text-asphalt-950',
                      item.rect.y < 0.08 ? 'top-0' : '-top-[18px]',
                    )}
                  >
                    {item.number}. {nameOf(item.label)}
                    {toRatio(item.confidence) != null ? ` ${formatPercent(toRatio(item.confidence))}` : ''}
                    {item.approximate ? ' approx.' : ''}
                  </span>
                </div>
              ) : null,
            )
          : null}
      </div>

      {detections.length ? (
        <figcaption className="mt-2 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          {showList ? (
            <ol className="min-w-0 space-y-0.5 text-xs text-ink-2">
              {detections.map((item) => (
                <li key={item.number} className="flex items-baseline gap-1.5">
                  <span className="font-bold text-ink tabular">{item.number}.</span>
                  <span>
                    {nameOf(item.label)}
                    {toRatio(item.confidence) != null ? (
                      <span className="tabular"> {formatPercent(toRatio(item.confidence))} confidence</span>
                    ) : null}
                    {item.approximate ? <span className="text-ink-3"> (approximate region)</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={toggle}
            aria-pressed={visible}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-ink-2 ring-1 ring-inset ring-line transition-colors hover:bg-surface-2 hover:text-ink pointer-coarse:min-h-11"
          >
            {visible ? <EyeOff aria-hidden className="size-3.5" /> : <Eye aria-hidden className="size-3.5" />}
            {visible ? 'Hide detections' : 'Show detections'}
          </button>
        </figcaption>
      ) : (
        <figcaption className="mt-2 flex items-center gap-1.5 text-xs text-ink-3">
          <ScanSearch aria-hidden className="size-3.5" />
          No regions were marked on this photo.
        </figcaption>
      )}
    </figure>
  )
}

export default ImageWithBoxes
