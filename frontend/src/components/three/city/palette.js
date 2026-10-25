/**
 * Palettes of the city: night (dark theme: asphalt sky, teal shadows, sodium light) and overcast dawn (light theme:
 * concrete sky, low warm sun from the east, lights mostly off). Colours are sRGB hex; the 3D scene blends them in
 * linear space, the SVG still in sRGB. Pure data (no three.js), shared by CityScene and CityFallback.
 */

export const NIGHT = {
  fogColor: '#0b1517',
  fogHorizon: '#2d2419',
  mistColor: '#3a2a1b',
  ambSky: '#26363d',
  ambGround: '#0d1111',
  keyColor: '#33434c',
  streetGlow: '#ff9a44',
  skyRefl: '#1d2629',
  glass: '#0a1316',
  zenith: '#050c0f',
  mid: '#0a1417',
  horizon: '#291f16',
  haze: '#4e3218',
  asphalt: '#2a3132',
  walk: '#585e5b',
  kerb: '#8f948f',
  grass: '#1d3323',
  plaza: '#6c706b',
  lot: '#262a28',
  scan: '#f5b700',
}
export const DAWN = {
  fogColor: '#a2adaf',
  fogHorizon: '#d6d0c4',
  mistColor: '#c3c9c6',
  ambSky: '#8e9b9d',
  ambGround: '#4c5251',
  keyColor: '#d2bf9f',
  streetGlow: '#000000',
  skyRefl: '#a7b4b7',
  glass: '#46535a',
  zenith: '#7d898e',
  mid: '#a6afaf',
  horizon: '#d6cfc2',
  haze: '#e8c9a0',
  asphalt: '#323839',
  walk: '#8a908c',
  kerb: '#a9aea9',
  grass: '#55684b',
  plaza: '#9a9e98',
  lot: '#62675f',
  scan: '#d39600',
}
export const SCALARS = {
  night: {
    fogDensity: 0.0064,
    fogFalloff: 0.014,
    mist: 0.38,
    streetGlow: 0.16,
    windowPower: 1,
    litWindows: 0.3,
    wet: 0.86,
    markGlow: 0.04,
    lampsOn: 1,
    lampPower: 1,
    exposure: 1.15,
    cloud: 0,
    contrast: 0.3,
    saturation: 1.05,
    vignette: 0.64,
    bloom: 1,
  },
  // dawn: a light haze only (the light theme's district should read crisp edge to edge, not grey)
  dawn: {
    fogDensity: 0.0008,
    fogFalloff: 0.016,
    mist: 0.03,
    streetGlow: 0,
    windowPower: 0.6,
    litWindows: 0.035,
    wet: 0.5,
    markGlow: 0,
    lampsOn: 0.08,
    lampPower: 0.5,
    exposure: 0.95,
    cloud: 0.12,
    contrast: 0.5,
    saturation: 1.1,
    vignette: 0.34,
    bloom: 0.5,
  },
}
/** Haze (fog density and ground mist) of the calm stage at dawn, relative to the rest: its low, close view of the
 * auth pages would otherwise read milky under the light theme's pale sky. */
export const CALM_DAWN_FOG = 0.7
export const GRADE = {
  night: { shadow: [-0.016, 0.026, 0.036], highlight: [0.045, 0.014, -0.032], vignette: [0.018, 0.034, 0.04] },
  // Dawn: cool shadows, a warm touch in the highlights, and a vignette that darkens (it multiplies by about 0.5 at full
  // strength) rather than veiling the frame edges in grey.
  dawn: { shadow: [-0.012, 0.0, 0.02], highlight: [0.03, 0.015, -0.02], vignette: [0.118, 0.122, 0.128] },
}
