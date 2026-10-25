/**
 * Highway-sign labels for the 3D scenes, drawn on canvases in the brand's `sign-panel` style: a sign-green field
 * (#0B6E4F), an inset white border, white Overpass text, and an optional glyph (severity dot, check, pin).
 *
 * The labels live in an overlay scene that is rendered after post-processing, so they stay crisp, keep their exact
 * colours (no bloom, grade or grain) and always read on top. Each sprite keeps a constant on-screen size.
 * Text is rendered only once the web font is ready (document.fonts), falling back to the system stack after 2.5 s.
 *
 * Start-up cost: the sign canvases are CPU-backed (`willReadFrequently`). A GPU-backed 2D canvas would make the
 * browser rasterise the sign with its GPU canvas pipeline and copy it into the WebGL texture on first upload, which
 * stalls the GPU process for tens to hundreds of milliseconds per new pipeline on integrated GPUs. Drawn canvases
 * are shared by every scene on the page (cache by content). Textures are made ahead of time by the start-up primer
 * (`prepare` + an upload per step); a sign needed later (new categories) is drawn and uploaded in an idle period,
 * and its sprite keeps showing the previous sign until then - never inside a frame.
 */
import { CanvasTexture, DataTexture, LinearMipmapLinearFilter, Scene, SRGBColorSpace, Sprite, SpriteMaterial, Vector3 } from 'three'
import { gpuQueue, nextIdle, waitForGpu } from '../gpuTasks'
import { SIGN_GREEN } from './cast'

const FONT_STACK = '"Overpass", "Public Sans", system-ui, -apple-system, "Segoe UI", sans-serif'
const TEXT_PX = 15
const SCALE = 3 // canvas pixels per CSS pixel (crisp on 2x screens and when slightly enlarged)
/** Transparent margin (CSS px) around each drawn sign, for its drop shadow: the visible plate is inset by this. */
export const SIGN_MARGIN = 6
const CANVAS_CACHE_LIMIT = 64

const _screen = new Vector3()

let fontsPromise = null
let fontsSettled = false
/** Sign canvases drawn after the fonts settled, by content key (shared by all label layers). */
const signCanvases = new Map()

/** Resolves when Overpass 800 is available (or after a timeout); safe to call often. */
export function whenFontsReady() {
  if (fontsPromise) return fontsPromise
  if (typeof document === 'undefined' || !document.fonts) {
    fontsSettled = true
    fontsPromise = Promise.resolve()
    return fontsPromise
  }
  const load = Promise.all([
    document.fonts.load(`800 ${TEXT_PX}px Overpass`).catch(() => null),
    document.fonts.ready.catch(() => null),
  ])
  const timeout = new Promise((resolve) => setTimeout(resolve, 2500))
  fontsPromise = Promise.race([load, timeout]).then(() => {
    fontsSettled = true
  })
  return fontsPromise
}

/** Content key of a label spec ({ text, glyph, glyphColor }). */
export const labelKey = (spec) => `${spec.text}|${spec.glyph ?? ''}|${spec.glyphColor ?? ''}`

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function drawGlyph(ctx, glyph, color, cx, cy, s) {
  if (glyph === 'dot') {
    ctx.beginPath()
    ctx.arc(cx, cy, 5.2 * s, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(cx, cy, 3.7 * s, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
  } else if (glyph === 'check') {
    ctx.beginPath()
    ctx.arc(cx, cy, 6 * s, 0, Math.PI * 2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(cx - 3 * s, cy + 0.2 * s)
    ctx.lineTo(cx - 0.8 * s, cy + 2.4 * s)
    ctx.lineTo(cx + 3.2 * s, cy - 2.2 * s)
    ctx.lineWidth = 1.8 * s
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = SIGN_GREEN
    ctx.stroke()
  } else if (glyph === 'pin') {
    ctx.beginPath()
    ctx.arc(cx, cy - 1.2 * s, 4.6 * s, Math.PI, 0)
    ctx.lineTo(cx, cy + 5.4 * s)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.beginPath()
    ctx.arc(cx, cy - 1.3 * s, 1.7 * s, 0, Math.PI * 2)
    ctx.fillStyle = SIGN_GREEN
    ctx.fill()
  } else if (glyph === 'hq') {
    ctx.fillStyle = color
    ctx.fillRect(cx - 4.6 * s, cy - 4.6 * s, 9.2 * s, 9.2 * s)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.4 * s
    ctx.strokeRect(cx - 4.6 * s, cy - 4.6 * s, 9.2 * s, 9.2 * s)
  }
}

/** Draws one sign on a CPU-backed canvas; returns { canvas, cssWidth, cssHeight }. */
export function drawSign({ text, glyph = null, glyphColor = '#ffffff' }) {
  const s = SCALE
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const font = `800 ${TEXT_PX * s}px ${FONT_STACK}`
  ctx.font = font
  const label = String(text ?? '').slice(0, 40)
  const textWidth = Math.ceil(ctx.measureText(label).width)
  const padX = 11 * s
  const glyphW = glyph ? 13 * s : 0
  const gap = glyph ? 7 * s : 0
  const w = Math.ceil(padX * 2 + glyphW + gap + textWidth)
  const h = Math.ceil((TEXT_PX + 15) * s)
  const margin = SIGN_MARGIN * s
  canvas.width = w + margin * 2
  canvas.height = h + margin * 2
  ctx.font = font
  // soft drop shadow for separation from the scene
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
  ctx.shadowBlur = 5 * s
  ctx.shadowOffsetY = 1.5 * s
  roundRect(ctx, margin, margin, w, h, 7 * s)
  ctx.fillStyle = SIGN_GREEN
  ctx.fill()
  ctx.restore()
  // inset white border (sign-panel: 4px field, 2px white -> scaled to label size)
  const inset = 2.6 * s
  roundRect(ctx, margin + inset, margin + inset, w - inset * 2, h - inset * 2, 5 * s)
  ctx.lineWidth = 1.5 * s
  ctx.strokeStyle = '#ffffff'
  ctx.stroke()
  let x = margin + padX
  const cy = margin + h / 2
  if (glyph) {
    drawGlyph(ctx, glyph, glyphColor, x + glyphW / 2, cy, s)
    x += glyphW + gap
  }
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, x, cy + 1.2 * s)
  return { canvas, cssWidth: canvas.width / s, cssHeight: canvas.height / s }
}

/** A drawn sign for `spec`, from the shared cache when the fonts had settled when it was drawn. */
function signCanvas(spec) {
  const key = labelKey(spec)
  const hit = signCanvases.get(key)
  if (hit) {
    // keep recently used signs at the end (LRU)
    signCanvases.delete(key)
    signCanvases.set(key, hit)
    return hit
  }
  const drawn = drawSign(spec)
  if (fontsSettled) {
    signCanvases.set(key, drawn)
    if (signCanvases.size > CANVAS_CACHE_LIMIT) signCanvases.delete(signCanvases.keys().next().value)
  }
  return drawn
}

/**
 * Overlay of label sprites. `slot(id, spec)` returns the sprite of one logical label (its sign follows `spec`);
 * `place(sprite, position, opacity, worldPerPixel, size)` positions it at a constant on-screen size.
 * `leader(id)` / `placeLeader(...)`: a thin post from an anchor to a sign that was moved off its anchor (same sprite
 * program as the signs, a 1x1 white texture, so it costs no shader compile).
 */
export class LabelLayer {
  constructor() {
    this.scene = new Scene()
    this.textures = new Map()
    this.sprites = new Map()
    this.leaders = new Map()
    this.leaderTexture = null
    this.ready = false
    this.disposed = false
    /** Renderer used to upload signs needed after start-up (set by the primer). */
    this.renderer = null
    this.queue = new Map()
    this.pumping = false
    this.onReady = null
    this.onUpdate = null
    whenFontsReady().then(() => {
      if (this.disposed) return
      this.ready = true
      // Drop textures drawn before the font arrived.
      this.textures.forEach((entry) => entry.texture.dispose())
      this.textures.clear()
      this.sprites.forEach((sprite) => {
        sprite.userData.key = null
      })
      this.onReady?.()
    })
  }

  /** The texture entry of `spec`, created now if needed (draws the sign; the upload happens on first use). */
  prepare(spec) {
    const key = labelKey(spec)
    let entry = this.textures.get(key)
    if (!entry) {
      const drawn = signCanvas(spec)
      const texture = new CanvasTexture(drawn.canvas)
      texture.colorSpace = SRGBColorSpace
      texture.minFilter = LinearMipmapLinearFilter
      // No anisotropic filtering: sprites always face the camera (it would change nothing on screen), and three
      // would query the GPU's maximum on the first upload, a synchronous round trip.
      texture.generateMipmaps = true
      entry = { texture, cssWidth: drawn.cssWidth, cssHeight: drawn.cssHeight, key }
      this.textures.set(key, entry)
    }
    return entry
  }

  /** A sprite slot (one per logical label); its content follows `spec`. */
  slot(id, spec) {
    let sprite = this.sprites.get(id)
    if (!sprite) {
      const material = new SpriteMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        opacity: 0,
      })
      sprite = new Sprite(material)
      sprite.center.set(0.5, 0)
      sprite.renderOrder = 10
      sprite.visible = false
      this.scene.add(sprite)
      this.sprites.set(id, sprite)
    }
    if (this.ready && spec) {
      const key = labelKey(spec)
      if (sprite.userData.key !== key) {
        const entry = this.textures.get(key)
        if (entry) this.assign(sprite, entry)
        else if (this.renderer) this.request(key, spec)
        else this.assign(sprite, this.prepare(spec))
      }
    }
    return sprite
  }

  assign(sprite, entry) {
    sprite.material.map = entry.texture
    sprite.material.needsUpdate = true
    sprite.userData.key = entry.key
    sprite.userData.cssWidth = entry.cssWidth
    sprite.userData.cssHeight = entry.cssHeight
  }

  /** Queues a sign for drawing and upload in an idle period (one per period). */
  request(key, spec) {
    if (this.queue.has(key) || this.disposed) return
    this.queue.set(key, spec)
    if (!this.pumping) this.pump()
  }

  async pump() {
    this.pumping = true
    try {
      while (this.queue.size && !this.disposed) {
        await nextIdle({ timeout: 250 })
        const [key, spec] = this.queue.entries().next().value
        this.queue.delete(key)
        if (this.disposed || this.textures.has(key)) continue
        const entry = this.prepare(spec)
        const gl = this.renderer
        if (gl) {
          await gpuQueue(async () => {
            if (this.disposed) return
            gl.initTexture(entry.texture)
            await waitForGpu(gl.getContext(), { timeout: 2000 })
          })
        }
        this.onUpdate?.()
      }
    } catch {
      // A lost context or a disposed layer: the remaining signs are drawn on demand instead.
    } finally {
      this.pumping = false
    }
  }

  /**
   * @param {Sprite} sprite
   * @param {import('three').Vector3} position anchor (bottom centre of the sign)
   * @param {number} opacity 0..1
   * @param {number} worldPerPixel world units per CSS pixel at the anchor distance
   * @param {number} [size=1] scale factor (pop animation, phones)
   */
  place(sprite, position, opacity, worldPerPixel, size = 1) {
    const visible = this.ready && opacity > 0.01 && sprite.userData.key
    sprite.visible = Boolean(visible)
    if (!visible) return
    sprite.position.copy(position)
    sprite.material.opacity = Math.min(1, opacity)
    const w = sprite.userData.cssWidth * worldPerPixel * size
    const h = sprite.userData.cssHeight * worldPerPixel * size
    sprite.scale.set(w, h, 1)
  }

  /**
   * Moves a sign's anchor (bottom centre) sideways, or down from the top edge, in screen space so that the sign stays
   * inside the frame with a `safe` margin (CSS px; the sign canvas adds its own shadow margin). Mutates `position`.
   * @param {Sprite} sprite
   * @param {import('three').Vector3} position
   * @param {import('three').Camera} camera
   * @param {{ width: number, height: number }} viewport CSS px
   * @param {number} [size=1] the scale factor passed to `place`
   * @param {number} [safe=6]
   */
  keepInView(sprite, position, camera, viewport, size = 1, safe = 6) {
    if (!sprite.userData.cssWidth || !viewport.width || !viewport.height) return position
    const w = sprite.userData.cssWidth * size
    const h = sprite.userData.cssHeight * size
    _screen.copy(position).project(camera)
    if (_screen.z > 1) return position
    const x = (_screen.x * 0.5 + 0.5) * viewport.width
    const y = (0.5 - _screen.y * 0.5) * viewport.height
    const dx = Math.max(safe - (x - w / 2), 0) - Math.max(x + w / 2 - (viewport.width - safe), 0)
    const dy = Math.max(safe - (y - h), 0)
    if (!dx && !dy) return position
    _screen.x = ((x + dx) / viewport.width) * 2 - 1
    _screen.y = 1 - ((y + dy) / viewport.height) * 2
    return position.copy(_screen.unproject(camera))
  }

  /** A leader-line sprite (one per logical label), anchored at its bottom centre. */
  leader(id) {
    let sprite = this.leaders.get(id)
    if (!sprite) {
      if (!this.leaderTexture) {
        this.leaderTexture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
        this.leaderTexture.colorSpace = SRGBColorSpace
        this.leaderTexture.needsUpdate = true
      }
      const material = new SpriteMaterial({
        map: this.leaderTexture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        opacity: 0,
      })
      sprite = new Sprite(material)
      sprite.center.set(0.5, 0)
      sprite.renderOrder = 9
      sprite.visible = false
      this.scene.add(sprite)
      this.leaders.set(id, sprite)
    }
    return sprite
  }

  /**
   * @param {Sprite} sprite from `leader(id)`
   * @param {import('three').Vector3} position the anchor (where the line starts)
   * @param {number} lengthPx on-screen length (CSS px)
   * @param {number} angle screen-space direction (radians, 0 = straight up, counter-clockwise)
   * @param {number} opacity 0..1
   * @param {number} worldPerPixel world units per CSS pixel at the anchor distance
   * @param {string} color CSS colour
   * @param {number} [widthPx=2] line width (CSS px)
   */
  placeLeader(sprite, position, lengthPx, angle, opacity, worldPerPixel, color, widthPx = 2) {
    const visible = this.ready && opacity > 0.01 && lengthPx > 2
    sprite.visible = visible
    if (!visible) return
    sprite.position.copy(position)
    sprite.material.opacity = Math.min(1, opacity)
    sprite.material.rotation = angle
    sprite.material.color.set(color)
    sprite.scale.set(widthPx * worldPerPixel, lengthPx * worldPerPixel, 1)
  }

  hideAll() {
    this.sprites.forEach((sprite) => {
      sprite.visible = false
    })
    this.leaders.forEach((sprite) => {
      sprite.visible = false
    })
  }

  /** Makes a disposed layer usable again (React StrictMode re-runs effects after a simulated unmount). */
  revive() {
    this.disposed = false
  }

  dispose() {
    // three's sprites all share one module-level geometry, never disposed by three itself: every renderer that drew a
    // sign keeps a dispose listener on it, so a torn-down scene's renderer, canvas and context stayed reachable
    // through it. Disposing it releases them; a renderer still in use simply uploads it again on its next draw.
    const shared = [...this.sprites.values(), ...this.leaders.values()].find((sprite) => sprite.geometry)?.geometry
    this.disposed = true
    this.queue.clear()
    this.textures.forEach((entry) => entry.texture.dispose())
    this.textures.clear()
    this.sprites.forEach((sprite) => sprite.material.dispose())
    this.sprites.clear()
    this.leaders.forEach((sprite) => {
      this.scene.remove(sprite)
      sprite.material.dispose()
    })
    this.leaders.clear()
    this.leaderTexture?.dispose()
    this.leaderTexture = null
    shared?.dispose()
  }
}
