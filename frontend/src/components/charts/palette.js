/**
 * Colour helpers shared by the charts, the map pins and the entity badges.
 *
 * 1. CHART_PALETTE - the default categorical palette, used when a series has no colour of its own.
 *    It follows the data-visualisation method used for every CivicAI chart:
 *    - eight hues in a FIXED order (blue, orange, teal, yellow, magenta, green, violet, red). Series take the
 *      slots in sequence and never cycle: a ninth series is folded into "All others" (see chartUtils.foldSeries);
 *    - each value is a step of the CivicAI ramps (guide / hazard / marking / sign / signal in index.css, plus
 *      teal, fuchsia and violet), chosen to stay clear of the status colours that carry meaning
 *      (low #35A17B, medium #F5B700, high #E8730C, critical #D3341F), so a series never impersonates a level;
 *    - light and dark are SELECTED separately, not inverted, and both were checked with the dataviz palette
 *      validator (OKLCH lightness band, chroma floor, colour-vision-deficiency separation simulated with
 *      Machado et al. 2009, normal-vision floor, contrast against the chart surface):
 *        light vs #ffffff: worst adjacent CVD dE 14.0, normal-vision dE 22.2; yellow #cc9600 is 2.65:1 on white,
 *                          so charts always ship a legend and a table view as the required relief channel;
 *        dark  vs #172022: worst adjacent CVD dE 13.6, normal-vision dE 17.5, every slot >= 3:1.
 * 2. Entity colours (category / department colours stored in the database) are DATA: "colour follows the
 *    entity", so a category is drawn in its own colour everywhere (badge, map pin, chart). Because admins pick
 *    those colours freely, every chart that uses them also carries labels, a legend and a table view.
 * 3. Contrast maths (WCAG 2.x relative luminance) to pick readable ink on a coloured fill, and `safeColor`,
 *    which only lets real hex colours through - admin-entered values are inserted into SVG and map-marker
 *    HTML, so anything else is replaced by a fallback instead of being trusted.
 */

/** Default categorical palette per theme (fixed slot order - never re-ordered or cycled). */
export const CHART_PALETTE = Object.freeze({
  light: Object.freeze(['#1f5fad', '#c25c06', '#0d9488', '#cc9600', '#c026d3', '#12845f', '#7c3aed', '#b52817']),
  dark: Object.freeze(['#3d7fcd', '#c25c06', '#0d9488', '#9c7200', '#c026d3', '#12845f', '#8b5cf6', '#e45539']),
})

/**
 * De-emphasis grey for the folded "All others" series (asphalt-300 light / asphalt-600 dark). It is
 * deliberately NOT one of the greys that carry meaning elsewhere - #8C9A96 (status "Closed", sentiment
 * "Neutral"), #6B7C85 (category "Other"), #64748B (status "Submitted") - so a folded slice never looks like
 * the "Closed" slice next to it.
 */
export const OTHER_SERIES_COLOR = Object.freeze({ light: '#b4bfbb', dark: '#52615f' })

/**
 * Magnitude colour: one neutral asphalt for bars whose length is their only message, e.g. complaints per
 * category. A category's own colour then stays on its chip (axis label, badge), and the hues that carry
 * meaning - red, orange, yellow, green for severity, status and sentiment - are never borrowed by a ranking.
 * light #52615f is 6.4:1 on white, dark #9aaba7 6.9:1 on the dark surface (#172022).
 */
export const MAGNITUDE_COLOR = Object.freeze({ light: '#52615f', dark: '#9aaba7' })

/** Ink colours used on coloured fills (white, or asphalt-950 for light fills such as road-marking yellow). */
export const INK_ON_DARK = '#ffffff'
export const INK_ON_LIGHT = '#0f1617'

/** WCAG AA contrast for normal-size text. */
const AA_TEXT = 4.5

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** True for "#abc" / "#aabbcc". */
export function isHexColor(value) {
  return typeof value === 'string' && HEX_COLOR.test(value.trim())
}

/** `value` when it is a hex colour, otherwise `fallback` (protects SVG / HTML built from stored data). */
export function safeColor(value, fallback = '#6a7a77') {
  return isHexColor(value) ? value.trim() : fallback
}

/** "#abc" or "#aabbcc" -> [r, g, b] in 0..255, or null. */
export function parseHex(hex) {
  if (!isHexColor(hex)) return null
  let digits = hex.trim().slice(1)
  if (digits.length === 3) digits = digits.replace(/./g, (char) => char + char)
  return [0, 2, 4].map((index) => parseInt(digits.slice(index, index + 2), 16))
}

/** WCAG relative luminance (0 = black, 1 = white) of a hex colour; null when it is not a colour. */
export function relativeLuminance(hex) {
  const rgb = parseHex(hex)
  if (!rgb) return null
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio between two hex colours (1..21); null if either is not a colour. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  if (la == null || lb == null) return null
  const [light, dark] = la > lb ? [la, lb] : [lb, la]
  return (light + 0.05) / (dark + 0.05)
}

/**
 * Ink (text / icon colour) that reads best on `background`: white or near-black, whichever has the higher
 * WCAG contrast. Road-marking yellow gets dark ink, highway green gets white - like real signs.
 * Mid-tone fills (e.g. guide-400 #3d7fcd, marking-700 #9c7200) reach 4.5:1 with neither white nor the asphalt
 * near-black; pure black is used for those, because white-or-black always reaches at least 4.58:1, so small
 * labels on any fill stay WCAG AA.
 */
export function readableInk(background, { light = INK_ON_DARK, dark = INK_ON_LIGHT } = {}) {
  const onLight = contrastRatio(background, dark)
  const onDark = contrastRatio(background, light)
  if (onLight == null || onDark == null) return light
  const best = onLight >= onDark ? dark : light
  if (Math.max(onLight, onDark) >= AA_TEXT) return best
  return (contrastRatio(background, '#000000') ?? 0) > onDark ? '#000000' : light
}

/** "#aabbcc" + 0.2 -> "rgb(170 187 204 / 0.2)" (falls back to the colour itself when it cannot be parsed). */
export function withAlpha(hex, alpha) {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  const clamped = Math.min(1, Math.max(0, Number(alpha) || 0))
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / ${clamped})`
}

/** Palette slot `index` for a theme mode ('light' | 'dark'); indexes past the end return the "other" grey. */
export function paletteColor(index, mode = 'light') {
  const palette = CHART_PALETTE[mode] ?? CHART_PALETTE.light
  return index >= 0 && index < palette.length ? palette[index] : (OTHER_SERIES_COLOR[mode] ?? OTHER_SERIES_COLOR.light)
}
