/**
 * Level gauge icons for Low / Medium / High (Critical uses lucide's Siren).
 *
 * Three bars of rising height in the current text colour: the bars up to the level are solid, the rest stay
 * visible as a faint track. Lucide's SignalLow / SignalMedium / SignalHigh draw only the bars that are "on",
 * which at badge size (12px) reads as stray punctuation (".ı", ".ıl"); with the track the glyph always reads
 * as a 1-of-3 / 2-of-3 / 3-of-3 gauge, so the level is repeated by shape and not only by colour or text.
 *
 * The components take the same props as lucide icons (className, size, aria-hidden, ...), so they work with
 * renderIcon() and anywhere a lucide component is expected.
 */
import { createElement } from 'react'

const BARS = [
  { x: 2.5, y: 13.5, height: 8 },
  { x: 9.75, y: 8.5, height: 13 },
  { x: 17, y: 3.5, height: 18 },
]
const TRACK_OPACITY = 0.3

function createLevelIcon(filled, displayName) {
  // `strokeWidth` / `absoluteStrokeWidth` are lucide props that do not apply to filled bars.
  function LevelIcon({ size = 24, strokeWidth, absoluteStrokeWidth, ...props }) {
    return createElement(
      'svg',
      { xmlns: 'http://www.w3.org/2000/svg', width: size, height: size, viewBox: '0 0 24 24', fill: 'currentColor', ...props },
      BARS.map((bar, index) =>
        createElement('rect', {
          key: index,
          x: bar.x,
          y: bar.y,
          width: 4.5,
          height: bar.height,
          rx: 1.25,
          opacity: index < filled ? 1 : TRACK_OPACITY,
        }),
      ),
    )
  }
  LevelIcon.displayName = displayName
  return LevelIcon
}

export const LevelLowIcon = createLevelIcon(1, 'LevelLowIcon')
export const LevelMediumIcon = createLevelIcon(2, 'LevelMediumIcon')
export const LevelHighIcon = createLevelIcon(3, 'LevelHighIcon')
