/**
 * Shared GLSL for the city materials (GLSL ES 3.00 through three's ShaderMaterial prefix).
 *
 * - HASH: uint32 lowbias32, bit-identical to `hashU32` / `hash3` / `unit` in layout.js.
 * - NOISE: cheap value noise for asphalt grain, wet patches and puddles.
 * - FOG: layered analytic height fog (exponential density falling off with height) tinted towards the horizon,
 *   plus a ground-hugging mist layer. Every material applies the same function, so depth reads consistently.
 * - SCAN: the AI survey band (a light sheet perpendicular to uScanDir, at uScanPos).
 * - LAMP_STATE: whether a lamp is lit (broken lamps stay dark, the switch-on wave of the establishing shot, the small
 *   subset that stays on at dawn), from the per-instance hashes computed in world.js.
 */

export const HASH = /* glsl */ `
uint hashU(uint x) {
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}
uint hash3u(int a, int b, int c) {
  return hashU(uint(a) ^ hashU(uint(b) ^ hashU(uint(c))));
}
float toUnit(uint h) { return float(h >> 8u) / 16777216.0; }
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`

/**
 * MSAA samples outside thin triangles extrapolate varyings; an interpolated normal can pass through zero there,
 * and a single NaN pixel would be spread over the whole frame by the bloom. Every interpolated normal goes through
 * safeNormalize, and additive outputs are clamped to a finite range.
 */
export const SAFE = /* glsl */ `
vec3 safeNormalize(vec3 v) {
  float l = length(v);
  return l > 1e-5 ? v / l : vec3(0.0, 1.0, 0.0);
}
`

export const NOISE = /* glsl */ `
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm2(vec2 p) {
  return vnoise(p) * 0.62 + vnoise(p * 2.13 + 7.1) * 0.38;
}
`

export const FOG_UNIFORMS = /* glsl */ `
uniform vec3 uFogColor;
uniform vec3 uFogHorizon;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform vec3 uMistColor;
uniform float uMist;
`

export const FOG = /* glsl */ `
vec3 applyFog(vec3 color, vec3 worldPos) {
  vec3 ray = worldPos - cameraPosition;
  float dist = length(ray);
  vec3 rd = ray / max(dist, 1e-4);
  float b = uFogFalloff;
  float a = uFogDensity;
  float ry = rd.y;
  float optical = abs(ry) < 1e-3
    ? a * exp(-cameraPosition.y * b) * dist
    : (a / b) * exp(-cameraPosition.y * b) * (1.0 - exp(-dist * ry * b)) / ry;
  float fog = 1.0 - exp(-max(optical, 0.0));
  vec3 tint = mix(uFogColor, uFogHorizon, pow(1.0 - min(abs(ry), 1.0), 6.0));
  // Ground mist: a thin layer below ~8 m, strongest far from the camera.
  float mist = uMist * (1.0 - smoothstep(0.0, 8.0, worldPos.y)) * smoothstep(40.0, 240.0, dist) * (1.0 - smoothstep(520.0, 1100.0, dist));
  vec3 outColor = mix(color, tint, clamp(fog, 0.0, 1.0));
  return mix(outColor, uMistColor, clamp(mist, 0.0, 1.0));
}
`

export const SCAN_UNIFORMS = /* glsl */ `
uniform vec2 uScanDir;
uniform float uScanPos;
uniform float uScanAmp;
uniform vec3 uScanColor;
`

/** Signed distance to the scan sheet (positive = not yet scanned). */
export const SCAN = /* glsl */ `
float scanDist(vec3 p) { return dot(p.xz, uScanDir) - uScanPos; }
float scanLine(float s, float width) { return exp(-(s * s) / (width * width)); }
float scanTrail(float s, float len) { return s < 0.0 ? exp(s / len) : exp(-s * 2.5); }
`

export const LAMP_UNIFORMS = /* glsl */ `
uniform float uPitch;
uniform float uRoad;
uniform float uAvenue;
uniform float uLampHeight;
uniform float uLampBroken;
uniform float uOuter;
uniform vec2 uWaveOrigin;
uniform float uWaveRadius;
uniform float uLampsOn;
uniform float uLampPower;
uniform vec3 uSodium;
uniform vec3 uLed;
`

/**
 * Lamp state: 0 = dark, 1 = fully on. `r` / `subset` are the lamp's hashes (lampAttribute in world.js), `pos` its xz.
 * Night: every working lamp switches on when the wave passes. Dawn: only a small hashed subset stays on.
 */
export const LAMP_STATE = /* glsl */ `
float lampStateF(float r, float subset, vec2 pos) {
  if (r < uLampBroken) return 0.0;
  float keep = step(subset, uLampsOn);
  float wave = smoothstep(0.0, 14.0, uWaveRadius - length(pos - uWaveOrigin));
  return keep * wave;
}
`
