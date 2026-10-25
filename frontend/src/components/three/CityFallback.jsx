/**
 * CityFallback - the CivicAI district as a still SVG illustration (no WebGL, no three.js).
 *
 * The same streets, buildings, street lamps, department landmarks and story moment as the live CityScene,
 * projected through the same camera framing (stillModel.js), so it reads as a frame of the film rather than a
 * placeholder: it is painted first while the 3D loads (and cross-fades into it), and it is what phones on the low
 * tier and browsers without hardware WebGL keep seeing.
 *
 * Props: stage ('hero' | 'report' | 'analyze' | 'prioritize' | 'route' | 'verify' | 'calm'), theme ('dark' |
 * 'light'; defaults to the app theme), categories (real names for the sign labels, optional), framing ('auto' |
 * 'left' | 'top' | 'center'), plates (default true; false leaves out the sign plates, e.g. under a page title),
 * className. Decorative: aria-hidden.
 *
 * Craft: every colour carries the live grade (stillModel.js); lamps are crisp points inside a soft halo (one
 * gradient circle each, hard-stopped at the core); facades get the window pattern of their height class (a few
 * shared <pattern>s, one overlay per facade); the sign plates are drawn over the picture, like the live scene's
 * labels over its graded frame, and left out when `plates` is false.
 *
 * Composition and cost:
 * - It follows the box it is measured in, by a ResizeObserver (never forcing a layout). Browsers can lay a page out
 *   at a sliver for a moment (a full-page capture resizes the window, a panel collapses): a box under 16 px cannot
 *   frame the district, so the last good composition is kept (nothing is drawn before the first one), and the
 *   aspect ratio is clamped.
 * - The model is built as a React transition after the page's own first paint. The drawing (a few thousand shapes)
 *   is one SVG document (stillImage.js), rasterised once in the background into a bitmap the size of the box and
 *   shown on one canvas: a single node instead of thousands, and nothing to rasterise again while the page
 *   scrolls. It then fades in (instantly with reduced motion); the box keeps its background colour meanwhile. Only
 *   the sign plates (a handful of nodes) are page SVG, for the web font.
 * - Models and their images are cached (stillModel.getStill, stillImage.stillImageUrl): a still shown twice costs one
 *   build.
 */
import { startTransition, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ThemeContext } from '@/context/contexts'
import { cn } from '@/utils/cn'
import { getCity } from './city/layout'
import { MAX_STILL_ASPECT, MIN_STILL_ASPECT, getStill } from './city/stillModel'
import { nextIdle } from './gpuTasks'
import { stillImageUrl } from './stillImage'
import { fadeInStill, observeBox } from './stillMotion'
import { SvgSign } from './SvgSign'

let cityReady = null
/** Generates the district layout (once per page) in its own idle period, apart from the first still's build. */
function whenCityReady() {
  if (!cityReady) cityReady = nextIdle().then(() => void getCity())
  return cityReady
}

/** Device pixels for a box `height` CSS px tall (at most 2x: the still is soft by design, and memory matters). */
const pixelHeight = (height) => Math.round(height * Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2))

function resolveTheme(theme, context) {
  if (theme === 'dark' || theme === 'light') return theme
  if (context?.resolvedTheme) return context.resolvedTheme
  if (typeof document !== 'undefined' && document.documentElement.classList.contains('dark')) return 'dark'
  return 'light'
}

/**
 * The still: the drawing (stillImage.js) rasterised once, in the background, into a bitmap the size of the box
 * (createImageBitmap), shown on a canvas: the compositor then only moves a texture - an SVG image would be
 * rasterised again by the GPU whenever it scrolls into view (a 1-2 s stall on the landing's first scroll). Without
 * createImageBitmap the SVG image itself is shown. The sign plates go on top, in the page's font. A new model is
 * prepared off screen and swapped in when ready (the previous picture stays meanwhile); the first one fades in.
 */
function StillPicture({ model, plates, pixelHeight }) {
  const url = useMemo(() => stillImageUrl(model), [model])
  const [shown, setShown] = useState(null)
  const pictureRef = useRef(null)
  const firstRef = useRef(true)
  const shadowId = `still-shadow-${useId().replace(/[^a-zA-Z0-9]/g, '')}`

  useEffect(() => {
    let alive = true
    const image = new Image()
    image.src = url
    const height = Math.max(1, pixelHeight)
    const width = Math.max(1, Math.round((height * model.W) / model.H))
    image
      .decode()
      .then(() =>
        typeof createImageBitmap === 'function'
          ? createImageBitmap(image, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' })
          : null,
      )
      .catch(() => null)
      .then((bitmap) => {
        if (alive) setShown({ url, bitmap })
        else bitmap?.close()
      })
    return () => {
      alive = false
    }
  }, [url, pixelHeight, model])

  useLayoutEffect(() => {
    const node = pictureRef.current
    if (!shown || !node) return
    if (shown.bitmap && node.tagName === 'CANVAS') {
      try {
        node.width = shown.bitmap.width
        node.height = shown.bitmap.height
        node.getContext('bitmaprenderer').transferFromImageBitmap(shown.bitmap)
      } catch {
        // Already transferred (a repeated effect): the canvas holds it.
      }
    }
    if (firstRef.current) {
      firstRef.current = false
      fadeInStill(node)
    }
  }, [shown])

  if (!shown) return null
  const { W, H, markers } = model
  const labels = plates && shown.url === url ? markers.labels : []
  const pictureClass = 'absolute inset-0 h-full w-full select-none object-cover'
  return (
    <>
      {shown.bitmap ? (
        <canvas ref={pictureRef} className={pictureClass} />
      ) : (
        <img ref={pictureRef} src={shown.url} alt="" decoding="async" draggable={false} className={pictureClass} />
      )}
      {labels.length ? (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid slice"
          className="absolute inset-0 h-full w-full"
          focusable="false"
          aria-hidden="true"
        >
          <defs>
            <filter id={shadowId} x="-20%" y="-40%" width="140%" height="180%">
              <feGaussianBlur stdDeviation="2.5" />
            </filter>
          </defs>
          {labels.map((label, i) => (
            <SvgSign key={i} label={label} shadowId={shadowId} />
          ))}
        </svg>
      ) : null}
    </>
  )
}

export function CityFallback({ stage = 'hero', theme, categories, framing = 'auto', plates = true, className }) {
  const themeContext = useContext(ThemeContext)
  const resolved = resolveTheme(theme, themeContext)
  const ref = useRef(null)
  const [box, setBox] = useState(null)

  // Composed for the real box (no layout shift: the box is sized by its container); built as a transition.
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return undefined
    return observeBox(node, (width, height) => {
      const ratio = Math.round((width / height) * 20) / 20
      const aspect = Math.min(MAX_STILL_ASPECT, Math.max(MIN_STILL_ASPECT, ratio))
      const rounded = Math.max(120, Math.round(height / 40) * 40)
      whenCityReady().then(() =>
        startTransition(() => {
          setBox((prev) => (prev && prev.aspect === aspect && prev.height === rounded ? prev : { aspect, height: rounded }))
        }),
      )
    })
  }, [])

  const model = useMemo(
    () =>
      box ? getStill({ stage, theme: resolved, aspect: box.aspect, framing, categories, pxPerUnit: 1000 / box.height }) : null,
    [stage, resolved, box, framing, categories],
  )

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={cn('relative h-full w-full overflow-hidden', className)}
      style={{ backgroundColor: resolved === 'dark' ? '#0b1416' : '#b9c1bf' }}
    >
      {model ? <StillPicture model={model} plates={plates} pixelHeight={pixelHeight(box.height)} /> : null}
    </div>
  )
}

export default CityFallback
