/**
 * The CityFallback still as one image (no three.js import).
 *
 * A still is a few thousand SVG shapes (buildings far to near, lamps, windows, markers). As DOM nodes in the page
 * they cost style, layout and memory on every page that shows one, and React builds them one by one. Serialised
 * into one SVG document and shown through an <img>, the same drawing is a single element: the browser lays it out
 * once, inside the image, and the page never sees its nodes. The pixels are the same drawing.
 *
 * Only the sign plates stay in the page (CityFallback draws them over the image): they use the page's web font,
 * which an SVG image cannot load. The live scene draws its labels after the grade as well, so they sit over the
 * vignette there too.
 *
 * - stillMarkup(model): the SVG document (string) of a stillModel.buildStill() model, without the plates.
 * - stillImageUrl(model): an object URL of that document, made once per model and kept for the most recent
 *   models (a revoked URL keeps working for an image already showing it).
 */

const esc = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/** `name="value"` pairs for the defined values. */
function attrs(map) {
  let out = ''
  for (const key in map) {
    const value = map[key]
    if (value === undefined || value === null || value === false) continue
    out += ` ${key}="${esc(value)}"`
  }
  return out
}

const el = (tag, map, children) => (children === undefined ? `<${tag}${attrs(map)}/>` : `<${tag}${attrs(map)}>${children}</${tag}>`)
const stop = (offset, color, opacity) => el('stop', { offset, 'stop-color': color, 'stop-opacity': opacity })

function defs(model) {
  const { H, sky, ground, markers, night, lights } = model
  const warm = lights.warm
  const cool = lights.cool
  let out = ''
  out += el(
    'linearGradient',
    { id: 'sky', gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: 0, y2: Math.max(model.horizonY, 1) },
    stop(0, sky.zenith) + stop(0.55, sky.mid) + stop(0.92, sky.horizon) + stop(1, sky.fog),
  )
  out += el(
    'linearGradient',
    { id: 'ground', gradientUnits: 'userSpaceOnUse', x1: 0, y1: model.horizonY, x2: 0, y2: H },
    stop(0, ground.far) + stop(0.35, ground.lot) + stop(1, ground.near),
  )
  out += el('radialGradient', { id: 'pool' }, stop(0, warm, 0.85) + stop(0.45, warm, 0.32) + stop(1, warm, 0))
  out += el('radialGradient', { id: 'poolCool' }, stop(0, cool, 0.7) + stop(0.45, cool, 0.25) + stop(1, cool, 0))
  // a lamp: a crisp point (hard stop at 30% of the radius) inside a soft halo
  out += el(
    'radialGradient',
    { id: 'head' },
    stop(0, lights.core, 1) +
      stop(0.3, lights.core, 1) +
      stop(0.31, warm, night ? 0.42 : 0.3) +
      stop(0.6, warm, night ? 0.12 : 0.08) +
      stop(1, warm, 0),
  )
  // the cone of light under a lamp head (night): brightest at the head, gone at the street
  out += el('linearGradient', { id: 'cone', x1: 0, y1: 0, x2: 0, y2: 1 }, stop(0, warm, 0.55) + stop(0.45, warm, 0.16) + stop(1, warm, 0))
  out += el('linearGradient', { id: 'coneCool', x1: 0, y1: 0, x2: 0, y2: 1 }, stop(0, cool, 0.5) + stop(0.45, cool, 0.14) + stop(1, cool, 0))
  model.windowPatterns.forEach((pattern) => {
    const cells = pattern.cells
      .map((cell) => el('rect', { x: cell.x, y: cell.y, width: cell.w, height: cell.h, fill: cell.fill, opacity: cell.o }))
      .join('')
    out += el('pattern', { id: `win${pattern.id}`, patternUnits: 'userSpaceOnUse', width: pattern.w, height: pattern.h }, cells)
  })
  const shade = night ? '#020607' : '#1a2223'
  out += el(
    'radialGradient',
    { id: 'vignette', cx: `${model.vignetteX}%`, cy: `${model.vignetteY}%`, r: '78%' },
    stop(0.45, shade, 0) + stop(1, shade, night ? 0.72 : 0.3),
  )
  if (markers.scan?.gradient) {
    const { color, gradient } = markers.scan
    out += el(
      'linearGradient',
      { id: 'scan', gradientUnits: 'userSpaceOnUse', x1: 0, y1: gradient.y1, x2: 0, y2: gradient.y2 },
      stop(0, color, night ? 0.2 : 0.16) + stop(0.3, color, night ? 0.06 : 0.05) + stop(1, color, 0),
    )
  }
  out += el('filter', { id: 'soft', x: '-50%', y: '-50%', width: '200%', height: '200%' }, el('feGaussianBlur', { stdDeviation: 4 }))
  return el('defs', {}, out)
}

function item(entry) {
  if (entry.kind === 'lamp') {
    return el('circle', { cx: entry.cx, cy: entry.cy, r: entry.r * 3, fill: 'url(#head)', opacity: entry.o })
  }
  if (entry.kind === 'beam') {
    const line = { x1: entry.x1, y1: entry.y1, x2: entry.x2, y2: entry.y2 }
    return (
      el('line', { ...line, stroke: entry.color, 'stroke-width': entry.w * 3, opacity: 0.28, filter: 'url(#soft)' }) +
      el('line', { ...line, stroke: entry.color, 'stroke-width': entry.w, opacity: 0.9 }) +
      el('line', { ...line, stroke: '#ffffff', 'stroke-width': Math.max(0.8, entry.w * 0.25), opacity: 0.75 }) +
      el('circle', { cx: entry.cap.cx, cy: entry.cap.cy, r: entry.cap.r * 2.4, fill: entry.color, opacity: 0.3, filter: 'url(#soft)' }) +
      el('circle', { cx: entry.cap.cx, cy: entry.cap.cy, r: entry.cap.r * 0.7, fill: '#ffffff' })
    )
  }
  if (entry.kind === 'silhouette') return el('path', { d: entry.d, fill: entry.fill })
  if (entry.kind === 'cone') return el('polygon', { points: entry.points, fill: `url(#${entry.cool ? 'coneCool' : 'cone'})`, opacity: entry.o })
  let out = entry.shapes.map((shape) => el('polygon', { points: shape.points, fill: shape.fill })).join('')
  entry.windows.forEach((w) => {
    out += el('rect', { y: -w.h, width: w.w, height: w.h, transform: `matrix(${w.m})`, fill: `url(#win${w.pattern})`, opacity: w.o })
  })
  return out
}

/** The still's SVG document (everything but the sign plates). */
export function stillMarkup(model) {
  const { W, H, markers } = model
  const parts = []
  parts.push(el('rect', { width: W, height: H, fill: 'url(#sky)' }))
  parts.push(el('rect', { y: model.horizonY, width: W, height: Math.max(0, H - model.horizonY), fill: 'url(#ground)' }))
  parts.push(model.streets.map((street) => el('polygon', { points: street.points, fill: street.fill })).join(''))
  const { markings } = model
  if (markings?.white) parts.push(el('path', { d: markings.white, fill: markings.whiteColor, opacity: 0.85 }))
  if (markings?.zebra) parts.push(el('path', { d: markings.zebra, fill: markings.whiteColor, opacity: 0.8 }))
  if (markings?.yellow) parts.push(el('path', { d: markings.yellow, fill: markings.yellowColor, opacity: 0.9 }))
  parts.push(
    model.pools
      .map((pool) =>
        el('ellipse', { cx: pool.cx, cy: pool.cy, rx: pool.rx, ry: pool.ry, fill: `url(#${pool.cool ? 'poolCool' : 'pool'})`, opacity: pool.o }),
      )
      .join(''),
  )
  if (markers.scan?.sheet) parts.push(el('polygon', { points: markers.scan.sheet, fill: 'url(#scan)' }))
  if (markers.scan?.line) {
    const { line, color } = markers.scan
    parts.push(
      el('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 7, opacity: 0.35, filter: 'url(#soft)' }) +
        el('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 1.6, opacity: 0.95 }),
    )
  }
  parts.push(
    markers.rings
      .map(
        (ring) =>
          el('ellipse', { cx: ring.cx, cy: ring.cy, rx: ring.rx, ry: ring.ry, fill: ring.color, opacity: 0.18 }) +
          el('ellipse', { cx: ring.cx, cy: ring.cy, rx: ring.rx, ry: ring.ry, fill: 'none', stroke: ring.color, 'stroke-width': 2, opacity: 0.95 }) +
          el('ellipse', {
            cx: ring.cx,
            cy: ring.cy,
            rx: ring.rx * 1.7,
            ry: ring.ry * 1.7,
            fill: 'none',
            stroke: ring.color,
            'stroke-width': 1.2,
            'stroke-dasharray': '4 5',
            opacity: 0.55,
          }),
      )
      .join(''),
  )
  parts.push(model.items.map(item).join(''))
  parts.push(
    el(
      'g',
      { opacity: 0.4 },
      (markers.ghosts ?? []).map((g) => el('line', { x1: g.x1, y1: g.y1, x2: g.x2, y2: g.y2, stroke: g.color, 'stroke-width': g.w })).join(''),
    ),
  )
  parts.push(
    markers.arcs
      .map((arc) =>
        el(
          'g',
          { opacity: arc.o },
          el('path', { d: arc.d, fill: 'none', stroke: arc.color, 'stroke-width': 7, opacity: 0.32, filter: 'url(#soft)' }) +
            el('path', { d: arc.d, fill: 'none', stroke: arc.color, 'stroke-width': 2.2, 'stroke-linecap': 'round' }),
        ),
      )
      .join(''),
  )
  parts.push(
    markers.beacons
      .map(
        (b) =>
          el('circle', { cx: b.cx, cy: b.cy, r: b.r * 2.2, fill: b.color, opacity: 0.4, filter: 'url(#soft)' }) +
          el('circle', { cx: b.cx, cy: b.cy, r: b.r * 0.6, fill: b.color }),
      )
      .join(''),
  )
  if (markers.pin) {
    const { pin } = markers
    parts.push(
      el(
        'g',
        { transform: `translate(${pin.x} ${pin.y}) scale(${Math.max(0.6, pin.s / 10)})` },
        el('ellipse', { cx: 0, cy: 24, rx: 9, ry: 3, fill: '#000000', opacity: 0.35 }) +
          el('path', { d: 'M0,22 C-3,14 -11,8 -11,-1 A11,11 0 0 1 11,-1 C11,8 3,14 0,22 Z', fill: pin.color }) +
          el('circle', { cx: 0, cy: -1, r: 4.2, fill: '#ffffff' }),
      ),
    )
  }
  parts.push(el('rect', { width: W, height: H, fill: 'url(#vignette)' }))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs(model)}${parts.join('')}</svg>`
}

const URL_LIMIT = 8
const urls = new Map()

/** Object URL of the model's image (made once per model; the oldest of more than URL_LIMIT is revoked). */
export function stillImageUrl(model) {
  const hit = urls.get(model)
  if (hit) {
    urls.delete(model)
    urls.set(model, hit)
    return hit
  }
  const url = URL.createObjectURL(new Blob([stillMarkup(model)], { type: 'image/svg+xml' }))
  urls.set(model, url)
  if (urls.size > URL_LIMIT) {
    const [oldest, oldUrl] = urls.entries().next().value
    urls.delete(oldest)
    URL.revokeObjectURL(oldUrl)
  }
  return url
}
