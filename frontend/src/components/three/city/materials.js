/**
 * Materials of the city scene. Every surface is a small custom ShaderMaterial (no lights, no shadow maps): the
 * look comes from procedural shading evaluated per pixel, which keeps the scene to a couple of dozen draw calls.
 *
 * Shared uniforms (`createSharedUniforms`) are spread into every material by reference, so the scene updates
 * time, theme blend, fog, scan and lamp wave once per frame for all of them.
 */
import {
  AdditiveBlending,
  BackSide,
  Color,
  CustomBlending,
  DoubleSide,
  GreaterDepth,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector2,
  Vector3,
} from 'three'
import { CITY, HQ_SLOTS, PARK_BLOCKS, lotRect } from './layout'
import { FOG, FOG_UNIFORMS, HASH, LAMP_STATE, LAMP_UNIFORMS, NOISE, SAFE, SCAN, SCAN_UNIFORMS } from './shaders'

const color = (hex) => new Color(hex)

/** Uniform objects shared by every material (mutated in place by the scene each frame). */
export function createSharedUniforms() {
  return {
    common: {
      uTime: { value: 0 },
      uNight: { value: 1 },
    },
    fog: {
      uFogColor: { value: color('#0e1617') },
      uFogHorizon: { value: color('#2a2722') },
      uFogDensity: { value: 0.0045 },
      uFogFalloff: { value: 0.018 },
      uMistColor: { value: color('#1a1f1f') },
      uMist: { value: 0.3 },
    },
    scan: {
      uScanDir: { value: new Vector2(1, 0) },
      uScanPos: { value: -400 },
      uScanAmp: { value: 0 },
      uScanColor: { value: color('#f5b700') },
    },
    lamps: {
      uPitch: { value: CITY.pitch },
      uRoad: { value: CITY.road },
      uAvenue: { value: CITY.avenue },
      uLampHeight: { value: CITY.lampHeight },
      uLampBroken: { value: CITY.brokenLamps },
      uOuter: { value: CITY.outer },
      uWaveOrigin: { value: new Vector2(18, -6) },
      uWaveRadius: { value: 2000 },
      uLampsOn: { value: 1 },
      uLampPower: { value: 1 },
      uSodium: { value: color('#ffae54').multiplyScalar(5.2) },
      uLed: { value: color('#e6efff').multiplyScalar(4.4) },
    },
    light: {
      uAmbSky: { value: color('#1d2b2f') },
      uAmbGround: { value: color('#0a0d0d') },
      uKeyColor: { value: color('#3a4a52') },
      uKeyDir: { value: new Vector3(-0.45, 0.62, 0.35).normalize() },
      uStreetGlow: { value: color('#ff9a44').multiplyScalar(0.16) },
      uSkyRefl: { value: color('#1d2629') },
      uWindowPower: { value: 1 },
      uLitWindows: { value: 0.44 },
      uGlass: { value: color('#0b1418') },
    },
  }
}

const AA = /* glsl */ `
float aaStep(float edge, float x) {
  float w = max(fwidth(x), 1e-4) * 0.75;
  return smoothstep(edge - w, edge + w, x);
}
float aaBand(float x, float a, float b) { return aaStep(a, x) * (1.0 - aaStep(b, x)); }
`

/* ================================================================================================================
 * Ground: streets, markings, crossings, kerbs, sidewalks, parks, plazas; lamp pools from the baked light map (night
 * colours in RGB, the dawn subset in A); wet sheen and sky reflection; the scan line, its survey grid and its
 * mirror image in the wet road. (Lamp reflections are separate instanced streaks: see createStreakMaterial.)
 * ============================================================================================================== */

export function createGroundMaterial(shared, { lightMap, lightExtent, reflections = 2 } = {}) {
  const parks = PARK_BLOCKS.map(([a, b]) => new Vector2(a, b))
  const plazas = HQ_SLOTS.map(({ block: [a, b] }) => new Vector2(a, b))
  const plazaCenters = HQ_SLOTS.map(({ block: [a, b] }) => {
    const r = lotRect(a, b)
    return new Vector2((r.x0 + r.x1) / 2, (r.z0 + r.z1) / 2)
  })
  return new ShaderMaterial({
    defines: { REFLECTIONS: reflections, PARK_COUNT: parks.length, PLAZA_COUNT: plazas.length },
    uniforms: {
      ...shared.common,
      ...shared.fog,
      ...shared.scan,
      ...shared.lamps,
      ...shared.light,
      uAsphalt: { value: color('#272d2e') },
      uWalk: { value: color('#545a57') },
      uKerb: { value: color('#8e938e') },
      uGrass: { value: color('#203626') },
      uPlazaCol: { value: color('#6d716c') },
      uLotCol: { value: color('#2a2e2c') },
      uYellow: { value: color('#f5b700') },
      uWhite: { value: color('#e8ece9') },
      uWet: { value: 0.85 },
      uMarkGlow: { value: 0.035 },
      uPoolPower: { value: 1 },
      uSidewalk: { value: CITY.sidewalk },
      uParks: { value: parks },
      uPlazas: { value: plazas },
      uPlazaCenters: { value: plazaCenters },
      uLightMap: { value: lightMap },
      uLightExtent: { value: lightExtent },
      uDawnLamp: { value: color('#ffae54') },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      uniform float uTime;
      uniform float uNight;
      uniform vec3 uAsphalt;
      uniform vec3 uWalk;
      uniform vec3 uKerb;
      uniform vec3 uGrass;
      uniform vec3 uPlazaCol;
      uniform vec3 uLotCol;
      uniform vec3 uYellow;
      uniform vec3 uWhite;
      uniform vec3 uAmbSky;
      uniform vec3 uKeyColor;
      uniform vec3 uKeyDir;
      uniform vec3 uSkyRefl;
      uniform float uWet;
      uniform float uMarkGlow;
      uniform float uPoolPower;
      uniform float uSidewalk;
      uniform vec2 uParks[PARK_COUNT];
      uniform vec2 uPlazas[PLAZA_COUNT];
      uniform vec2 uPlazaCenters[PLAZA_COUNT];
      uniform sampler2D uLightMap;
      uniform float uLightExtent;
      uniform vec3 uDawnLamp;
      ${FOG_UNIFORMS}
      ${SCAN_UNIFORMS}
      ${LAMP_UNIFORMS}
      ${HASH}
      ${NOISE}
      ${FOG}
      ${SCAN}
      ${AA}

      void main() {
        vec3 p = vec3(vWorld.x, 0.0, vWorld.z);
        vec2 q = p.xz;
        vec3 V = normalize(cameraPosition - p);
        float dist = length(cameraPosition - p);
        float far = smoothstep(60.0, 220.0, dist);

        // ---- street geometry -------------------------------------------------------------------------------
        float P = uPitch;
        float jz = floor(q.y / P + 0.5);
        float dz = q.y - jz * P;
        float ix = floor(q.x / P + 0.5);
        float dx = q.x - ix * P;
        float hwz = (jz == 0.0) ? uAvenue : uRoad;
        float hwx = uRoad;
        float adz = abs(dz);
        float adx = abs(dx);
        float inOuter = 1.0 - step(uOuter * P + 6.0, max(abs(q.x), abs(q.y)));
        float roadZ = 1.0 - aaStep(hwz, adz);
        float roadX = 1.0 - aaStep(hwx, adx);
        float road = max(roadZ, roadX) * inOuter;
        float walkZ = 1.0 - aaStep(hwz + uSidewalk, adz);
        float walkX = 1.0 - aaStep(hwx + uSidewalk, adx);
        float walk = max(walkZ, walkX) * (1.0 - road) * inOuter;
        float lot = 1.0 - road - walk;

        vec2 blk = floor(q / P);
        bool park = false;
        bool plaza = false;
        vec2 plazaC = vec2(0.0);
        for (int k = 0; k < PARK_COUNT; k++) if (all(equal(uParks[k], blk))) park = true;
        for (int k = 0; k < PLAZA_COUNT; k++) if (all(equal(uPlazas[k], blk))) { plaza = true; plazaC = uPlazaCenters[k]; }

        // ---- materials ---------------------------------------------------------------------------------------
        float grain = (vnoise(q * 2.4) - 0.5) * (1.0 - far);
        float patches = fbm2(q * 0.12) - 0.5;
        vec3 asphalt = uAsphalt * (1.0 + patches * 0.3 + grain * 0.2);
        float lanePos = roadZ > roadX ? adz : adx;
        asphalt *= 1.0 - 0.07 * aaBand(fract(lanePos / 1.7), 0.3, 0.7) * (1.0 - far);

        vec3 walkCol = uWalk * (1.0 + grain * 0.25 + patches * 0.15);
        float joints = (1.0 - far) * max(aaBand(fract(q.x / 1.2), 0.0, 0.06), aaBand(fract(q.y / 1.2), 0.0, 0.06));
        walkCol *= 1.0 - joints * 0.22;
        float kerbDist = min(roadZ < 0.5 ? adz - hwz : 99.0, roadX < 0.5 ? adx - hwx : 99.0);
        walkCol = mix(walkCol, uKerb, (1.0 - aaStep(0.28, kerbDist)) * 0.8);
        float lineDist = min(abs(adz - hwz - uSidewalk), abs(adx - hwx - uSidewalk));
        walkCol *= mix(0.55, 1.0, smoothstep(0.0, 1.6, lineDist));

        vec3 lotCol = uLotCol * (1.0 + patches * 0.3);
        if (park) {
          vec2 c = (blk + 0.5) * P;
          float path = 1.0 - aaStep(1.15, min(abs(q.x - c.x), abs(q.y - c.y)));
          lotCol = mix(uGrass * (0.8 + 0.5 * fbm2(q * 0.45)), uWalk * 0.85, path);
        } else if (plaza) {
          float rings = aaBand(fract(length(q - plazaC) / 3.0), 0.0, 0.05) * (1.0 - far);
          float tiles = (1.0 - far) * max(aaBand(fract(q.x / 2.0), 0.0, 0.03), aaBand(fract(q.y / 2.0), 0.0, 0.03));
          lotCol = uPlazaCol * (1.0 - 0.18 * max(rings, tiles) + grain * 0.2);
        }
        vec3 albedo = asphalt * road + walkCol * walk + lotCol * lot;

        // ---- markings: centre lines, avenue lanes, zebra crossings, stop lines ------------------------------
        float mark = 0.0;
        float yellow = 0.0;
        float nearZ = 1.0 - aaStep(hwx + uSidewalk + 0.4, adx);
        float nearX = 1.0 - aaStep(hwz + uSidewalk + 0.4, adz);
        float dashX = mix(aaBand(fract(q.x / 6.0), 0.0, 0.5), 0.5, smoothstep(0.25, 0.6, fwidth(q.x / 6.0)));
        float dashZ = mix(aaBand(fract(q.y / 6.0), 0.0, 0.5), 0.5, smoothstep(0.25, 0.6, fwidth(q.y / 6.0)));
        if (jz == 0.0) {
          float doubleYellow = 1.0 - aaStep(0.09, abs(adz - 0.24));
          float lanes = (1.0 - aaStep(0.075, abs(adz - hwz * 0.5))) * dashX;
          float edge = 1.0 - aaStep(0.07, abs(adz - (hwz - 0.35)));
          yellow = max(yellow, doubleYellow * roadZ * (1.0 - nearZ));
          mark = max(mark, max(doubleYellow, max(lanes, edge) * 0.9) * roadZ * (1.0 - nearZ));
        } else {
          float centre = (1.0 - aaStep(0.085, adz)) * dashX * roadZ * (1.0 - nearZ);
          float edge = (1.0 - aaStep(0.06, abs(adz - (hwz - 0.3)))) * 0.7 * roadZ * (1.0 - nearZ);
          yellow = max(yellow, centre);
          mark = max(mark, max(centre, edge));
        }
        float centreZ = (1.0 - aaStep(0.085, adx)) * dashZ * roadX * (1.0 - nearX);
        float edgeZ = (1.0 - aaStep(0.06, abs(adx - (hwx - 0.3)))) * 0.7 * roadX * (1.0 - nearX);
        yellow = max(yellow, centreZ);
        mark = max(mark, max(centreZ, edgeZ));
        float zebraX = aaBand(adx, hwx + 0.7, hwx + 3.3) * (1.0 - aaStep(hwz - 0.45, adz)) * roadZ;
        float zebraZ = aaBand(adz, hwz + 0.7, hwz + 3.3) * (1.0 - aaStep(hwx - 0.45, adx)) * roadX;
        float zebra = max(zebraX * aaBand(fract(dz / 1.15), 0.0, 0.55), zebraZ * aaBand(fract(dx / 1.15), 0.0, 0.55));
        float stopX = aaBand(adx, hwx + 3.8, hwx + 4.15) * (1.0 - aaStep(hwz - 0.45, adz)) * roadZ * step(0.0, dz * sign(dx));
        float stopZ = aaBand(adz, hwz + 3.8, hwz + 4.15) * (1.0 - aaStep(hwx - 0.45, adx)) * roadX * step(0.0, -dx * sign(dz));
        float white = max(zebra * (1.0 - far * 0.6), max(stopX, stopZ) * 0.85);
        mark = max(mark, white) * inOuter * (0.82 + grain * 0.3);
        yellow = clamp(yellow * (1.0 - white), 0.0, 1.0);
        vec3 markCol = mix(uWhite, uYellow, yellow);
        albedo = mix(albedo, markCol * 0.62, mark);

        // ---- wetness -----------------------------------------------------------------------------------------
        float wet = uWet * (0.5 + 0.5 * smoothstep(0.35, 0.75, fbm2(q * 0.07 + 3.1)));
        float puddle = smoothstep(0.6, 0.68, vnoise(q * 0.085 + 11.3)) * road;
        float gutter = (1.0 - smoothstep(0.0, 0.9, min(hwz - adz, hwx - adx))) * road;
        wet = clamp(max(wet, uWet * max(puddle, gutter * 0.8)) * (park ? 0.25 : 1.0), 0.0, 1.0);
        wet *= 1.0 - mark * 0.5;
        albedo *= mix(1.0, 0.55, wet * (1.0 - mark));

        // ---- lighting: baked lamp pools + sky + key ------------------------------------------------------------
        vec4 lm = texture2D(uLightMap, q / (2.0 * uLightExtent) + 0.5);
        float nightLamps = smoothstep(0.08, 1.0, uLampsOn);
        float wave = smoothstep(0.0, 18.0, uWaveRadius - length(q - uWaveOrigin));
        vec3 pools = mix(uDawnLamp * lm.a, lm.rgb, nightLamps) * wave * uPoolPower * uLampPower;
        vec3 colorOut = albedo * (uAmbSky + pools);
        colorOut += albedo * uKeyColor * max(uKeyDir.y, 0.0);
        colorOut += mark * markCol * uMarkGlow * uNight;
        float fresnel = 0.02 + 0.98 * pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
        colorOut += uSkyRefl * fresnel * wet * 1.4;
        colorOut += pools * wet * fresnel * 0.6;

        // ---- AI scan -------------------------------------------------------------------------------------------
        float s = scanDist(p);
        float sLine = scanLine(s, 0.55);
        float sGlow = scanLine(s, 7.0);
        float trail = scanTrail(s, 26.0);
        float grid = (1.0 - far) * max(aaBand(fract(q.x / 3.0), 0.0, 0.035), aaBand(fract(q.y / 3.0), 0.0, 0.035));
        float district = 1.0 - smoothstep(200.0, 290.0, abs(dot(q, vec2(-uScanDir.y, uScanDir.x))));
        vec3 scanLight = uScanColor * uScanAmp * district * (sLine * 2.6 + sGlow * 0.22 + grid * trail * 0.55 * (1.0 - sLine));
        vec3 scanAdd = scanLight * mix(1.0, 0.75, road);
        float paint = clamp(sLine * uScanAmp * district * (1.0 - uNight) * 0.85, 0.0, 1.0);
        colorOut = mix(colorOut + scanAdd * mix(0.35, 1.0, uNight), uScanColor * 0.9, paint);
        #if REFLECTIONS > 0
          // Mirror image of the scan sheet in the wet road.
          vec3 r = vec3(-V.x, V.y, -V.z);
          float rd = dot(r.xz, uScanDir);
          float t = -s / (abs(rd) < 1e-3 ? 1e-3 : rd);
          if (t > 0.0) {
            float y = t * r.y;
            float sheet = exp(-y / 7.0) * 0.9 + exp(-y / 30.0) * 0.12;
            float through = 0.32 / max(abs(rd), 0.25);
            colorOut += uScanColor * uScanAmp * sheet * through * fresnel * wet * 1.6 * exp(-t * 0.02);
          }
        #endif
        #if REFLECTIONS > 1
          // Lit shopfronts mirrored in the wet street (night): follow the mirrored view ray to the nearest building
          // line and read the ground-floor band there; blurred and fading with the distance travelled.
          if (uNight > 0.05 && wet > 0.2 && dist < 260.0) {
            vec3 rr = vec3(-V.x, V.y, -V.z);
            float lineZ = jz * P + sign(rr.z) * (hwz + uSidewalk);
            float lineX = ix * P + sign(rr.x) * (hwx + uSidewalk);
            float tz = abs(rr.z) > 1e-3 ? (lineZ - p.z) / rr.z : 1e4;
            float tx = abs(rr.x) > 1e-3 ? (lineX - p.x) / rr.x : 1e4;
            tz = tz > 0.0 ? tz : 1e4;
            tx = tx > 0.0 ? tx : 1e4;
            float tt = min(tz, tx);
            vec3 hit = p + rr * tt;
            if (tt < 26.0 && hit.y < 3.4) {
              float along = tz < tx ? hit.x : hit.z;
              vec2 hitBlock = floor((hit.xz + rr.xz * 0.6) / P);
              bool open = false;
              for (int k = 0; k < PARK_COUNT; k++) if (all(equal(uParks[k], hitBlock))) open = true;
              float cell = floor(along / 3.3);
              float lit = step(hash12(vec2(cell, tz < tx ? lineZ : lineX)), 0.55) * (open ? 0.0 : 1.0);
              float pane = smoothstep(0.08, 0.2, fract(along / 3.3)) * (1.0 - smoothstep(0.8, 0.92, fract(along / 3.3)));
              float band = smoothstep(0.2, 0.7, hit.y) * (1.0 - smoothstep(2.4, 3.3, hit.y));
              float hue = hash12(vec2(cell + 7.0, lineX + lineZ));
              vec3 shop = mix(vec3(1.0, 0.62, 0.3), vec3(0.85, 0.9, 1.0), step(0.78, hue));
              colorOut += shop * lit * pane * band * fresnel * wet * uNight * 1.6 * exp(-tt * 0.09);
            }
          }
        #endif

        colorOut = applyFog(min(colorOut, vec3(40.0)), vWorld);
        gl_FragColor = vec4(colorOut, 1.0);
      }
    `,
  })
}

/* ================================================================================================================
 * Wet-street reflections of the lamps: one stretched quad per lamp at the mirror point between the lamp and the
 * camera, elongated towards the viewer, broken up by the same puddle noise as the ground and by rain ripples.
 * ============================================================================================================== */

export function createStreakMaterial(shared) {
  return new ShaderMaterial({
    uniforms: { ...shared.common, ...shared.fog, ...shared.lamps, uWetAmount: { value: 0.85 } },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aLamp;   // broken hash, dawn subset hash, base x, base z
      attribute vec3 aHead;
      attribute float aCool;
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec3 vWorld;
      varying float vFresnel;
      ${LAMP_UNIFORMS}
      ${FOG_UNIFORMS}
      ${LAMP_STATE}
      void main() {
        float on = lampStateF(aLamp.x, aLamp.y, aLamp.zw);
        // LED reflections are toned down: white streaks read as noise next to the warm sodium ones
        vec3 c = aCool > 0.5 ? uLed * 0.55 : uSodium;
        vColor = c * on * mix(vec3(1.0, 0.32, 0.1), vec3(1.0), smoothstep(0.35, 1.0, on));
        vec2 head = aHead.xz;
        vec2 toCam = cameraPosition.xz - head;
        float D = max(length(toCam), 1.0);
        vec2 dir = toCam / D;
        float mirror = D * uLampHeight / (cameraPosition.y + uLampHeight);
        vec2 centre = head + dir * mirror;
        float len = 2.6 + mirror * 1.1;
        float wid = 0.75 + D * 0.0035;
        vec2 side = vec2(-dir.y, dir.x);
        vec2 pos = centre + dir * position.y * len + side * position.x * wid;
        vWorld = vec3(pos.x, 0.035, pos.y);
        vUv = position.xy * 2.0;
        vec3 V = normalize(cameraPosition - vWorld);
        vFresnel = 0.05 + 0.95 * pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
        if (on <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vColor;
      varying vec3 vWorld;
      varying float vFresnel;
      uniform float uTime;
      uniform float uWetAmount;
      ${FOG_UNIFORMS}
      ${HASH}
      ${NOISE}
      ${FOG}
      void main() {
        float across = exp(-vUv.x * vUv.x * 5.5);
        float along = exp(-vUv.y * vUv.y * 2.2) * (1.0 - smoothstep(0.6, 1.0, abs(vUv.y)));
        vec2 q = vWorld.xz;
        float wet = 0.45 + 0.55 * smoothstep(0.35, 0.75, fbm2(q * 0.07 + 3.1));
        wet = max(wet, smoothstep(0.6, 0.68, vnoise(q * 0.085 + 11.3)));
        float ripple = 0.72 + 0.28 * vnoise(q * vec2(1.6, 0.5) + vec2(0.0, uTime * 1.7));
        float a = across * along * ripple * wet * uWetAmount * (0.3 + vFresnel * 3.0);
        float fogKeep = exp(-length(cameraPosition - vWorld) * uFogDensity * 0.6);
        gl_FragColor = vec4(min(vColor * a * 0.36 * fogKeep, vec3(12.0)), 1.0);
      }
    `,
  })
}

/* ================================================================================================================
 * Buildings: concrete / glass facades with procedural windows (lit pattern from a hash of building, face, column
 * and floor; rare toggles), storefronts, roof parapets, ambient occlusion, the street-level glow at night, the
 * scan "reading" edges and floors, HQ accents.
 * ============================================================================================================== */

export function createBuildingMaterial(shared) {
  return new ShaderMaterial({
    uniforms: {
      ...shared.common,
      ...shared.fog,
      ...shared.scan,
      ...shared.light,
      uFloor: { value: CITY.floor },
      uHQColors: { value: Array.from({ length: 6 }, () => color('#1f5fad')) },
      uHQGlow: { value: [0, 0, 0, 0, 0, 0] },
    },
    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute vec4 aData;
      varying vec3 vWorld;
      varying vec3 vLocal;
      varying vec3 vSize;
      varying vec3 vNrm;
      varying vec3 vColor;
      varying vec4 vData;
      varying float vBaseY;
      void main() {
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vLocal = position;
        vSize = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vBaseY = instanceMatrix[3].y;
        vNrm = normal;
        vColor = aColor;
        vData = aData;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vLocal;
      varying vec3 vSize;
      varying vec3 vNrm;
      varying vec3 vColor;
      varying vec4 vData;
      varying float vBaseY;
      uniform float uTime;
      uniform float uNight;
      uniform float uFloor;
      uniform vec3 uAmbSky;
      uniform vec3 uAmbGround;
      uniform vec3 uKeyColor;
      uniform vec3 uKeyDir;
      uniform vec3 uStreetGlow;
      uniform vec3 uSkyRefl;
      uniform vec3 uGlass;
      uniform float uWindowPower;
      uniform float uLitWindows;
      uniform vec3 uHQColors[6];
      uniform float uHQGlow[6];
      ${FOG_UNIFORMS}
      ${SCAN_UNIFORMS}
      ${HASH}
      ${FOG}
      ${SCAN}
      ${AA}

      void main() {
        vec3 n = normalize(vNrm);
        vec3 V = normalize(cameraPosition - vWorld);
        float dist = length(cameraPosition - vWorld);
        float kind = vData.y;
        int hq = int(vData.z + 0.5) - 1;
        float top = vBaseY + vSize.y;
        float y = vWorld.y;

        vec3 albedo = vColor;
        bool roof = n.y > 0.5;
        float u = 0.0;
        float width = 1.0;
        uint face = 0u;
        if (!roof) {
          if (abs(n.x) > 0.5) { u = (vLocal.z + 0.5) * vSize.z; width = vSize.z; face = n.x > 0.0 ? 1u : 2u; }
          else { u = (vLocal.x + 0.5) * vSize.x; width = vSize.x; face = n.z > 0.0 ? 3u : 4u; }
        }

        // ---- lighting of the wall --------------------------------------------------------------------------
        float ao = mix(0.5, 1.0, smoothstep(0.0, 7.0, y));
        vec3 amb = mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5);
        float key = max(dot(n, uKeyDir), 0.0);
        vec3 wall = albedo * (amb * ao + uKeyColor * key);
        wall += albedo * uStreetGlow * (1.0 - smoothstep(0.0, 13.0, y)) * (roof ? 0.0 : 1.0);

        vec3 outColor = wall;

        if (roof) {
          // Roof: darker membrane, light parapet rim.
          vec2 rl = vLocal.xz * vSize.xz;
          vec2 edge = vSize.xz * 0.5 - abs(rl);
          float rim = 1.0 - aaStep(0.45, min(edge.x, edge.y));
          outColor = albedo * 0.5 * (amb + uKeyColor * key) * (0.85 + 0.3 * hash12(floor(rl * 0.5) + vData.x));
          outColor = mix(outColor, wall * 1.15, rim);
        } else if (kind < 1.5 || kind > 2.5) {
          // ---- windows ----------------------------------------------------------------------------------------
          bool office = kind > 0.5;
          float cellW = office ? 2.25 : 3.3;
          float cols = max(1.0, floor(width / cellW + 0.5));
          float cu = u / (width / cols);
          float cv = y / uFloor;
          float col = floor(cu);
          float row = floor(cv);
          float fu = fract(cu);
          float fv = fract(cv);
          float fwU = fwidth(cu);
          float fwV = fwidth(cv);
          float lod = smoothstep(0.28, 0.7, max(fwU, fwV));
          // Dawn: the window grid quietens with distance (crisp near district, calm far city: focal hierarchy).
          lod = max(lod, (1.0 - uNight) * smoothstep(200.0, 410.0, dist) * 0.88);
          bool ground = row < 0.5;
          float wx0 = office ? 0.1 : 0.29;
          float wy0 = office ? 0.2 : 0.34;
          float wy1 = office ? 0.86 : 0.8;
          if (ground) { wx0 = 0.07; wy0 = 0.08; wy1 = 0.7; }
          float inside = aaBand(fu, wx0, 1.0 - wx0) * aaBand(fv, wy0, wy1);
          inside *= 1.0 - aaStep(top - 0.75, y); // parapet
          float coverage = (1.0 - 2.0 * wx0) * (wy1 - wy0);

          uint seed = uint(vData.x);
          uint hw = hash3u(int(seed), int(face) * 4099 + int(col), int(row));
          float r = toUnit(hw);
          // Whole floors tend to be lit or dark together (offices, households): bias per floor and face.
          float floorBias = toUnit(hash3u(int(seed) + 17, int(face), int(row)));
          float litP = uLitWindows * mix(0.35, 1.75, floorBias) * (office ? 0.85 : 1.0) * (hq >= 0 ? 1.35 : 1.0);
          if (ground) litP = mix(0.1, 0.58, uNight);
          float epoch = floor(uTime / 11.0 + r * 11.0);
          float flip = toUnit(hashU(hw ^ uint(epoch * 13.0 + 7.0))) < 0.025 ? 1.0 : 0.0;
          float lit = abs(step(r, litP) - flip);

          float tint = toUnit(hashU(hw + 1u));
          vec3 warm = vec3(1.0, 0.46, 0.15);
          vec3 neutral = vec3(1.0, 0.66, 0.36);
          vec3 cool = vec3(0.56, 0.74, 1.0);
          vec3 lc = tint < 0.68 ? warm : (tint < 0.9 ? neutral : cool);
          if (office) lc = mix(lc, neutral, 0.45);
          if (ground) lc = tint < 0.5 ? neutral : (tint < 0.82 ? warm : cool);
          float power = (0.14 + 0.4 * toUnit(hashU(hw + 2u))) * uWindowPower * (ground ? 1.7 : 1.0);
          float ceiling = 0.7 + 0.45 * smoothstep(wy0, wy1, fv);
          float curtain = toUnit(hashU(hw + 3u)) < 0.3 ? mix(0.4, 1.0, step(0.5, fu)) : 1.0;
          vec3 litColor = lc * power * ceiling * curtain;

          float fres = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 3.0);
          vec3 glass = mix(uGlass, uSkyRefl * 1.15, 0.18 + fres * 0.6) + albedo * 0.02;
          vec3 window = mix(glass, litColor, lit);

          // Far away the pattern is replaced by its average (no shimmer).
          vec3 avgLit = mix(glass, mix(warm, neutral, 0.45) * 0.5 * uWindowPower, min(litP, 1.0));
          vec3 facade = mix(mix(wall, window, inside), mix(wall, avgLit, coverage), lod);
          outColor = facade;

          // Floor slabs and mullions: faint structure that reads in the dark.
          float slab = (1.0 - aaStep(0.05, fv)) * (1.0 - lod);
          outColor *= 1.0 - slab * 0.25;
        }

        // ---- HQ accents: corner light strips and crown in the department colour ----------------------------------
        if (hq >= 0) {
          vec3 hqc = uHQColors[hq];
          float corner = 1.0 - aaStep(0.18, min(u, width - u));
          float crown = aaBand(y, top - 2.4, top - 1.6);
          float pulse = 0.85 + 0.15 * sin(uTime * 1.6 + float(hq));
          float accent = (roof ? 0.0 : max(corner * 0.35, crown)) * (0.3 + 0.7 * uNight);
          outColor += hqc * accent * (0.55 + uHQGlow[hq] * 2.2) * pulse;
        }

        // ---- AI scan: the sheet reads edges and floors as it passes -------------------------------------------
        float s = scanDist(vWorld);
        // Faces parallel to the sheet would light up all at once: they only get a brief, faint flash.
        float facing = roof ? 0.0 : abs(dot(n.xz, uScanDir));
        float line = scanLine(s, 0.6) * (1.0 - 0.85 * facing);
        float band = scanLine(s, 2.4) * (1.0 - 0.7 * facing);
        float edgeU = roof ? 9.0 : min(u, width - u);
        float edgeV = min(y - vBaseY, top - y);
        float edges = 1.0 - aaStep(0.28, min(edgeU, edgeV));
        if (roof) {
          vec2 rl = vLocal.xz * vSize.xz;
          vec2 e2 = vSize.xz * 0.5 - abs(rl);
          edges = 1.0 - aaStep(0.28, min(e2.x, e2.y));
        }
        float floorLines = 1.0 - aaStep(0.045, abs(fract(y / uFloor + 0.5) - 0.5));
        vec3 scan = uScanColor * uScanAmp * (line * 1.4 + band * (edges * 0.8 + floorLines * 0.1));
        float paint = clamp((line + band * edges * 0.7) * uScanAmp * (1.0 - uNight) * 0.8, 0.0, 1.0);
        outColor = mix(outColor + scan * mix(0.3, 1.0, uNight), uScanColor * 0.85, paint);

        outColor = applyFog(outColor, vWorld);
        gl_FragColor = vec4(outColor, 1.0);
      }
    `,
  })
}

/* ================================================================================================================
 * Street-lamp poles (instanced): dark metal, the head glows when the lamp is on.
 * ============================================================================================================== */

export function createPoleMaterial(shared) {
  return new ShaderMaterial({
    uniforms: { ...shared.common, ...shared.fog, ...shared.lamps, ...shared.light, ...shared.scan },
    vertexShader: /* glsl */ `
      attribute float aPart;
      attribute vec4 aLamp;   // broken hash, dawn subset hash, base x, base z
      attribute float aCool;
      varying vec3 vWorld;
      varying vec3 vNrm;
      varying float vPart;
      varying vec4 vLamp;
      varying float vCool;
      void main() {
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNrm = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        vPart = aPart;
        vLamp = aLamp;
        vCool = aCool;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNrm;
      varying float vPart;
      varying vec4 vLamp;
      varying float vCool;
      uniform float uNight;
      uniform vec3 uAmbSky;
      uniform vec3 uAmbGround;
      uniform vec3 uKeyColor;
      uniform vec3 uKeyDir;
      ${FOG_UNIFORMS}
      ${LAMP_UNIFORMS}
      ${SCAN_UNIFORMS}
      ${SAFE}
      ${FOG}
      ${SCAN}
      ${LAMP_STATE}
      void main() {
        vec3 n = safeNormalize(vNrm);
        vec3 metal = vec3(0.05, 0.06, 0.065);
        vec3 c = metal * (mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5) * 2.0 + uKeyColor * max(dot(n, uKeyDir), 0.0));
        float on = lampStateF(vLamp.x, vLamp.y, vLamp.zw);
        vec3 lampCol = vCool > 0.5 ? uLed : uSodium;
        vec3 warm = mix(vec3(1.0, 0.32, 0.1), vec3(1.0), smoothstep(0.35, 1.0, on));
        if (vPart > 0.5) c = mix(c * 1.5, lampCol * warm * 0.9, on * step(n.y, -0.2) + on * 0.25);
        float s = scanDist(vWorld);
        c += uScanColor * uScanAmp * scanLine(s, 0.8) * 1.2;
        gl_FragColor = vec4(applyFog(c, vWorld), 1.0);
      }
    `,
  })
}

/* ================================================================================================================
 * Billboard glows (instanced quads facing the camera). Lamp glows read the lamp lattice state; generic glows
 * (beacons, routing packets, the report pin) use per-instance colour and amplitude.
 * ============================================================================================================== */

const BILLBOARD_VERTEX = /* glsl */ `
  vec3 billboard(vec3 center, vec2 corner, float size) {
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    return center + (right * corner.x + up * corner.y) * size;
  }
`

export function createLampGlowMaterial(shared) {
  return new ShaderMaterial({
    uniforms: { ...shared.common, ...shared.fog, ...shared.lamps, uPixel: { value: 0.0025 } },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aLamp;   // broken hash, dawn subset hash, base x, base z
      attribute vec3 aHead;   // head x, (unused), head z
      attribute float aCool;
      varying vec2 vUv;
      varying float vOn;
      varying vec3 vColor;
      varying float vFog;
      uniform float uPixel;
      ${LAMP_UNIFORMS}
      ${FOG_UNIFORMS}
      ${BILLBOARD_VERTEX}
      ${LAMP_STATE}
      void main() {
        vUv = position.xy * 2.0;
        float on = lampStateF(aLamp.x, aLamp.y, aLamp.zw);
        vOn = on;
        vec3 lampCol = aCool > 0.5 ? uLed : uSodium;
        vColor = lampCol * mix(vec3(1.0, 0.32, 0.1), vec3(1.0), smoothstep(0.35, 1.0, on));
        vec3 head = vec3(aHead.x, uLampHeight - 0.05, aHead.z);
        float d = length(cameraPosition - head);
        float size = max(1.25, d * uPixel * 3.2);
        vec3 world = billboard(head, position.xy, size * 2.0);
        // fog attenuation of the glow itself
        vFog = exp(-d * uFogDensity * 0.55);
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        if (on <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying float vOn;
      varying vec3 vColor;
      varying float vFog;
      void main() {
        float r = length(vUv);
        float core = exp(-r * r * 30.0);
        float halo = exp(-r * r * 4.5) * 0.12;
        float a = (core * 0.9 + halo) * vOn * vFog;
        gl_FragColor = vec4(vColor * a, 1.0);
      }
    `,
  })
}

export function createGlowMaterial(shared) {
  return new ShaderMaterial({
    uniforms: { ...shared.common, ...shared.fog, uPixel: { value: 0.0025 } },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aGlowColor;
      attribute vec2 aGlow; // x = size (world), y = amplitude
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vAmp;
      uniform float uPixel;
      ${FOG_UNIFORMS}
      ${BILLBOARD_VERTEX}
      void main() {
        vUv = position.xy * 2.0;
        vec3 center = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float d = length(cameraPosition - center);
        float size = max(aGlow.x, d * uPixel * 5.0);
        vColor = aGlowColor;
        vAmp = aGlow.y * exp(-d * uFogDensity * 0.35);
        gl_Position = projectionMatrix * viewMatrix * vec4(billboard(center, position.xy, size * 2.0), 1.0);
        if (aGlow.y <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vAmp;
      void main() {
        float r = length(vUv);
        float core = exp(-r * r * 30.0);
        float halo = exp(-r * r * 5.0) * 0.22;
        gl_FragColor = vec4(vColor * (core * 1.3 + halo) * vAmp, 1.0);
      }
    `,
  })
}

/* ================================================================================================================
 * Volumetric-looking light cones under the lamps (additive, brightest through the thick middle, fading towards
 * the ground and the silhouette, with slow drifting dust).
 * ============================================================================================================== */

export function createConeMaterial(shared) {
  return new ShaderMaterial({
    uniforms: { ...shared.common, ...shared.fog, ...shared.lamps, uConeStrength: { value: 0.06 } },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aLamp;
      attribute float aCool;
      varying vec3 vWorld;
      varying vec3 vNrm;
      varying float vH;
      varying float vOn;
      varying float vCool;
      ${LAMP_UNIFORMS}
      ${LAMP_STATE}
      void main() {
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNrm = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        vH = clamp(world.y / uLampHeight, 0.0, 1.0);
        vOn = lampStateF(aLamp.x, aLamp.y, aLamp.zw);
        vCool = aCool;
        gl_Position = projectionMatrix * viewMatrix * world;
        if (vOn <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNrm;
      varying float vH;
      varying float vOn;
      varying float vCool;
      uniform float uTime;
      uniform float uConeStrength;
      ${LAMP_UNIFORMS}
      ${FOG_UNIFORMS}
      ${HASH}
      ${SAFE}
      ${NOISE}
      ${FOG}
      void main() {
        vec3 V = safeNormalize(cameraPosition - vWorld);
        float facing = clamp(abs(dot(safeNormalize(vNrm), V)), 0.0, 1.0);
        float body = pow(facing, 1.6);
        float h = clamp(vH, 0.0, 1.0);
        float vertical = smoothstep(0.0, 0.35, h) * pow(h, 0.6);
        float dust = 0.75 + 0.5 * vnoise(vWorld.xz * 0.6 + vec2(0.0, vWorld.y * 0.8) + uTime * 0.25);
        vec3 c = (vCool > 0.5 ? uLed : uSodium) * vOn * body * vertical * dust * uConeStrength;
        float fogKeep = exp(-length(cameraPosition - vWorld) * uFogDensity * 0.6);
        gl_FragColor = vec4(min(c * fogKeep, vec3(8.0)), 1.0);
      }
    `,
  })
}

/* ================================================================================================================
 * Trees (instanced low-poly crowns + trunks) with a gentle sway and the warm street glow from below.
 * ============================================================================================================== */

export function createTreeMaterial(shared) {
  return new ShaderMaterial({
    uniforms: { ...shared.common, ...shared.fog, ...shared.light, ...shared.scan },
    vertexShader: /* glsl */ `
      attribute float aPart;
      attribute float aTone;
      uniform float uTime;
      varying vec3 vWorld;
      varying vec3 vNrm;
      varying float vPart;
      varying float vTone;
      void main() {
        vec3 p = position;
        vec4 base = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        if (aPart > 0.5) {
          float sway = sin(uTime * 0.9 + base.x * 0.21 + base.z * 0.17) * 0.035;
          p.x += sway * (p.y - 0.4);
        }
        vec4 world = modelMatrix * instanceMatrix * vec4(p, 1.0);
        vWorld = world.xyz;
        vNrm = normalize(mat3(modelMatrix * instanceMatrix) * normal);
        vPart = aPart;
        vTone = aTone;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNrm;
      varying float vPart;
      varying float vTone;
      uniform float uNight;
      uniform vec3 uAmbSky;
      uniform vec3 uAmbGround;
      uniform vec3 uKeyColor;
      uniform vec3 uKeyDir;
      uniform vec3 uStreetGlow;
      ${FOG_UNIFORMS}
      ${SCAN_UNIFORMS}
      ${SAFE}
      ${FOG}
      ${SCAN}
      void main() {
        vec3 n = safeNormalize(vNrm);
        vec3 leaf = mix(vec3(0.045, 0.085, 0.05), vec3(0.09, 0.14, 0.07), vTone);
        vec3 bark = vec3(0.07, 0.055, 0.045);
        vec3 albedo = vPart > 0.5 ? leaf : bark;
        vec3 amb = mix(uAmbGround, uAmbSky, n.y * 0.5 + 0.5);
        vec3 c = albedo * (amb * 1.4 + uKeyColor * max(dot(n, uKeyDir), 0.0));
        c += albedo * uStreetGlow * 5.0 * max(-n.y + 0.45, 0.0) * (1.0 - smoothstep(0.0, 10.0, vWorld.y));
        float s = scanDist(vWorld);
        c += uScanColor * uScanAmp * (scanLine(s, 0.7) * 1.2 + scanLine(s, 6.0) * 0.08);
        gl_FragColor = vec4(applyFog(c, vWorld), 1.0);
      }
    `,
  })
}

/* ================================================================================================================
 * Sky dome: night = asphalt sky with a low sodium haze over the city; dawn = overcast concrete with soft bands.
 * ============================================================================================================== */

export function createSkyMaterial(shared) {
  return new ShaderMaterial({
    uniforms: {
      ...shared.common,
      ...shared.fog,
      uZenith: { value: color('#05090a') },
      uMid: { value: color('#0c1415') },
      uHorizon: { value: color('#2b2620') },
      uHaze: { value: color('#4a3622') },
      uCloud: { value: 0 },
    },
    side: BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vDir = world.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 uZenith;
      uniform vec3 uMid;
      uniform vec3 uHorizon;
      uniform vec3 uHaze;
      uniform float uCloud;
      uniform float uTime;
      ${FOG_UNIFORMS}
      ${HASH}
      ${NOISE}
      void main() {
        vec3 d = normalize(vDir);
        float e = d.y;
        // At and below the horizon the sky is exactly the colour fully fogged geometry reaches (no seam).
        vec3 fogTint = mix(uFogColor, uFogHorizon, pow(1.0 - min(abs(e), 1.0), 6.0));
        vec3 c = mix(uHorizon, uMid, smoothstep(0.02, 0.2, e));
        c = mix(c, uZenith, smoothstep(0.16, 0.7, e));
        float haze = exp(-max(e, 0.0) * 11.0);
        c += uHaze * haze * 0.55;
        c = mix(fogTint, c, smoothstep(-0.01, 0.12, e));
        float bands = fbm2(vec2(atan(d.z, d.x) * 2.2, e * 9.0) + vec2(uTime * 0.003, 0.0));
        c *= 1.0 + (bands - 0.5) * uCloud * smoothstep(0.0, 0.3, e);
        float dither = (hash12(gl_FragCoord.xy) - 0.5) / 255.0;
        gl_FragColor = vec4(c + dither, 1.0);
      }
    `,
  })
}

/* ================================================================================================================
 * Issue markers: severity ring on the ground (expanding detection pulse, dashed survey ring, resolve check) and a
 * light beam (cylindrical billboard). Blend mode: additive at night, premultiplied "over" at dawn.
 * ============================================================================================================== */

export function setMarkerBlending(material, night) {
  material.blending = CustomBlending
  material.blendSrc = OneFactor
  material.blendDst = night ? OneFactor : OneMinusSrcAlphaFactor
}

export function createRingMaterial(shared) {
  const material = new ShaderMaterial({
    uniforms: { ...shared.common, ...shared.fog, uResolved: { value: color('#35a17b') }, uHDR: { value: 2.2 } },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec4 aRing;   // detect, resolve, hover, alpha
      attribute vec3 aSev;
      attribute float aSeed;
      varying vec2 vUv;
      varying vec4 vRing;
      varying vec3 vSev;
      varying float vSeed;
      varying vec3 vWorld;
      void main() {
        vUv = position.xz * 2.0;
        vRing = aRing;
        vSev = aSev;
        vSeed = aSeed;
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
        if (aRing.w <= 0.001) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec4 vRing;
      varying vec3 vSev;
      varying float vSeed;
      varying vec3 vWorld;
      uniform vec3 uResolved;
      uniform float uHDR;
      uniform float uTime;
      uniform float uNight;
      ${FOG_UNIFORMS}
      ${FOG}
      float sdSeg(vec2 p, vec2 a, vec2 b) {
        vec2 pa = p - a, ba = b - a;
        float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
        return length(pa - ba * h);
      }
      void main() {
        float r = length(vUv);
        if (r > 1.0) discard;
        float detect = vRing.x;
        float resolve = vRing.y;
        float hover = vRing.z;
        vec3 c = mix(vSev, uResolved, resolve);
        float px = fwidth(r);
        float grow = smoothstep(0.0, 1.0, detect);
        float ringR = 0.34 + 0.14 * grow;
        float ring = 1.0 - smoothstep(0.035, 0.035 + px * 1.5, abs(r - ringR));
        float disc = (1.0 - smoothstep(0.0, ringR, r)) * 0.32;
        float ph = fract(uTime * 0.42 + vSeed);
        float rippleR = mix(0.36, 0.98, ph);
        float ripple = (1.0 - smoothstep(0.02, 0.02 + px * 2.0, abs(r - rippleR))) * (1.0 - ph) * 0.8 * (1.0 - resolve * 0.6);
        float ang = atan(vUv.y, vUv.x);
        float dashes = step(0.45, fract(ang / 6.28318 * 16.0 + uTime * 0.04 * (1.0 + vSeed)));
        float outer = (1.0 - smoothstep(0.012, 0.012 + px * 1.5, abs(r - 0.76))) * dashes * 0.55 * grow;
        // check mark when resolved
        vec2 q = vUv / max(ringR, 0.01);
        float chk = min(sdSeg(q, vec2(-0.42, 0.02), vec2(-0.12, -0.3)), sdSeg(q, vec2(-0.12, -0.3), vec2(0.46, 0.34)));
        float check = (1.0 - smoothstep(0.07, 0.07 + px * 4.0, chk)) * resolve;
        float shape = ring * 1.4 + disc + ripple + outer;
        shape *= grow;
        shape = mix(shape, shape * 0.6, check);
        vec3 col = c * shape * (1.0 + hover * 0.9) + vec3(1.0) * check * 1.25;
        float a = clamp(shape + check, 0.0, 1.0) * vRing.w;
        float fogKeep = exp(-length(cameraPosition - vWorld) * uFogDensity * 0.4);
        gl_FragColor = vec4(col * vRing.w * fogKeep * mix(1.0, uHDR, uNight), a * fogKeep);
      }
    `,
  })
  setMarkerBlending(material, true)
  return material
}

/**
 * Issue beams; in the prioritize stage the same instances draw as solid glass columns. Night: a light pillar (white
 * core, soft halo, additive). Dawn: an inked ribbon - a saturated severity-colour core with a crisp 1-2 px light rim -
 * so it reads against bright concrete. `ghost`: the x-ray pass of the columns (drawn only where buildings hide them,
 * at reduced strength), so every priority column reads from its base; same shader source, so it shares the program.
 */
export function createBeamMaterial(shared, { ghost = false } = {}) {
  const material = new ShaderMaterial({
    uniforms: { ...shared.common, ...shared.fog, uResolved: { value: color('#35a17b') }, uGhost: { value: ghost ? 1 : 0 } },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec4 aBeam;  // height, width, alpha, hover
      attribute vec3 aSev;
      attribute vec2 aResolve; // resolve, column
      uniform float uGhost;
      varying vec2 vUv;
      varying vec4 vBeam;
      varying vec3 vColor;
      varying vec2 vResolve;
      varying vec3 vWorld;
      void main() {
        vec3 base = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 toCam = cameraPosition - base;
        vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x));
        vec3 world = base + right * position.x * aBeam.y + vec3(0.0, (position.y + 0.5) * aBeam.x, 0.0);
        vUv = vec2(position.x * 2.0, position.y + 0.5);
        vBeam = aBeam;
        vColor = aSev;
        vResolve = aResolve;
        vWorld = world;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
        if (aBeam.z <= 0.001 || aBeam.x <= 0.01 || (uGhost > 0.5 && aResolve.y < 0.02)) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec4 vBeam;
      varying vec3 vColor;
      varying vec2 vResolve;
      varying vec3 vWorld;
      uniform vec3 uResolved;
      uniform float uTime;
      uniform float uNight;
      uniform float uGhost;
      ${FOG_UNIFORMS}
      ${FOG}
      void main() {
        // A light pillar: white-hot core, coloured body, wide soft halo; brightest at the base, pulses rising.
        float x = abs(vUv.x);
        float column = vResolve.y;
        float core = exp(-x * x * 160.0);
        // prioritize: a solid glass column (flat body, crisp edges) instead of a light beam
        float body = mix(exp(-x * x * 26.0), 1.0 - smoothstep(0.42, 0.5, x), column);
        float halo = exp(-x * x * 5.0);
        float y = clamp(vUv.y, 0.0, 1.0);
        float fade = smoothstep(0.0, 0.14, y) * (1.0 - smoothstep(0.9, 1.0, y)) * (0.75 + 0.25 * y);
        float base = 0.0;
        float pulse = smoothstep(0.82, 1.0, fract(y * 2.6 - uTime * 0.9)) * (1.0 - y);
        vec3 c = mix(vColor, uResolved, vResolve.x);
        float edge = column * (1.0 - smoothstep(0.36, 0.5, x)) * smoothstep(0.3, 0.46, x);
        float energy = (core * 1.4 * (1.0 - column * 0.6) + body * mix(0.9, 0.55, column) + edge * 1.6 + halo * 0.22)
          * fade * (1.0 + base * 1.6 + pulse * 0.9);
        vec3 col = mix(c, vec3(1.0), core * 0.55) * energy;
        float a = clamp((body * 0.8 + halo * 0.25) * fade * mix(1.6, 1.0, uNight), 0.0, 1.0) * vBeam.z;
        float fogKeep = exp(-length(cameraPosition - vWorld) * uFogDensity * 0.3);
        vec3 nightCol = min(col * vBeam.z * (1.0 + vBeam.w) * mix(1.15, 1.9, uNight) * fogKeep, vec3(16.0));
        // Dawn ink: a solid core in the severity colour (wider for columns), a crisp light rim, no glow.
        float fw = max(fwidth(x), 1e-4);
        float coreW = mix(0.3, 0.44, column);
        float rimW = coreW + fw * 2.2;
        float dayBody = 1.0 - smoothstep(coreW - fw, coreW + fw, x);
        float dayRim = smoothstep(coreW - fw, coreW + fw, x) * (1.0 - smoothstep(rimW - fw, rimW + fw, x));
        float dayFade = smoothstep(0.0, 0.05, y) * (1.0 - smoothstep(0.93, 1.0, y) * (1.0 - column));
        float glassy = mix(0.8 + 0.2 * y, 0.62 + 0.38 * y + edge * 0.5, column) * (1.0 + pulse * 0.45 + vBeam.w * 0.35);
        vec3 dayCol = (c * dayBody * glassy * 0.82 + vec3(0.96) * dayRim) * dayFade * vBeam.z * fogKeep;
        float dayA = clamp(dayBody * 0.94 + dayRim * 0.9, 0.0, 1.0) * dayFade * vBeam.z * fogKeep;
        vec4 outColor = mix(vec4(dayCol, dayA), vec4(nightCol, a * fogKeep), uNight);
        // x-ray pass: only the columns, at reduced strength (the pass itself only draws where they are hidden)
        outColor *= mix(1.0, column * mix(0.5, 0.36, uNight), uGhost);
        gl_FragColor = outColor;
      }
    `,
  })
  setMarkerBlending(material, true)
  if (ghost) material.depthFunc = GreaterDepth
  return material
}

/* ================================================================================================================
 * Routing arcs: camera-facing ribbons along cubic Béziers, drawn progressively (comet head, persistent faint
 * trace), one draw call for all arcs (per-arc uniforms).
 * ============================================================================================================== */

export function createArcMaterial(shared, count) {
  const material = new ShaderMaterial({
    defines: { ARC_COUNT: count },
    uniforms: {
      ...shared.common,
      ...shared.fog,
      uArcDraw: { value: new Array(count).fill(0) },
      uArcAlpha: { value: new Array(count).fill(0) },
      uArcColor: { value: Array.from({ length: count }, () => color('#1f5fad')) },
      uArcWidth: { value: 0.55 },
    },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    vertexShader: /* glsl */ `
      attribute vec3 aTangent;
      attribute float aT;
      attribute float aSide;
      attribute float aArc;
      uniform float uArcWidth;
      varying float vT;
      varying float vSide;
      varying float vArc;
      varying vec3 vWorld;
      void main() {
        vec3 viewDir = normalize(cameraPosition - position);
        vec3 side = normalize(cross(normalize(aTangent), viewDir));
        float d = length(cameraPosition - position);
        vec3 world = position + side * aSide * uArcWidth * (0.6 + d * 0.004);
        vT = aT;
        vSide = aSide;
        vArc = aArc;
        vWorld = world;
        gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vT;
      varying float vSide;
      varying float vArc;
      varying vec3 vWorld;
      uniform float uArcDraw[ARC_COUNT];
      uniform float uArcAlpha[ARC_COUNT];
      uniform vec3 uArcColor[ARC_COUNT];
      uniform float uNight;
      ${FOG_UNIFORMS}
      ${FOG}
      void main() {
        int k = int(vArc + 0.5);
        float draw = 0.0;
        float alpha = 0.0;
        vec3 c = vec3(0.0);
        for (int i = 0; i < ARC_COUNT; i++) {
          if (i == k) { draw = uArcDraw[i]; alpha = uArcAlpha[i]; c = uArcColor[i]; }
        }
        if (alpha <= 0.001 || vT > draw) discard;
        float x = abs(vSide);
        float core = exp(-x * x * 18.0);
        float glow = exp(-x * x * 3.0) * 0.35;
        float head = exp(-pow((draw - vT) / 0.05, 2.0));
        float trace = mix(0.35, 1.0, smoothstep(draw - 0.35, draw, vT));
        float body = (core + glow) * trace + head * core * 2.4;
        float fogKeep = exp(-length(cameraPosition - vWorld) * uFogDensity * 0.3);
        vec3 col = mix(c, vec3(1.0), head * mix(0.25, 0.5, uNight)) * body * alpha * mix(1.7, 2.6, uNight) * fogKeep;
        vec4 nightOut = vec4(col, clamp(body, 0.0, 1.0) * alpha * fogKeep);
        // Dawn ink: a saturated ribbon in the department colour with a crisp light rim; faint traces stay legible.
        float fw = max(fwidth(x), 1e-4);
        float rimW = 0.34 + fw * 2.2;
        float dayCore = 1.0 - smoothstep(0.34 - fw, 0.34 + fw, x);
        float dayRim = smoothstep(0.34 - fw, 0.34 + fw, x) * (1.0 - smoothstep(rimW - fw, rimW + fw, x));
        float dayAlpha = pow(alpha, 0.6) * mix(0.6, 1.0, smoothstep(draw - 0.35, draw, vT)) * fogKeep;
        dayRim *= smoothstep(0.2, 0.75, dayAlpha); // faint traces keep their colour, not a pale outline
        vec3 dayCol = (mix(c, vec3(1.0), head * 0.3) * dayCore * 0.86 + vec3(0.96) * dayRim) * dayAlpha;
        vec4 dayOut = vec4(dayCol, clamp(dayCore * 0.94 + dayRim * 0.9, 0.0, 1.0) * dayAlpha);
        gl_FragColor = mix(dayOut, nightOut, uNight);
      }
    `,
  })
  setMarkerBlending(material, true)
  return material
}

/* ================================================================================================================
 * Scan sheet: the vertical light curtain of the survey band (additive, soft top, faded at the district edges,
 * brighter when seen edge-on like a real thin sheet of light in haze).
 * ============================================================================================================== */

export function createCurtainMaterial(shared) {
  return new ShaderMaterial({
    uniforms: { ...shared.common, ...shared.fog, ...shared.scan, uHeight: { value: 46 }, uHalf: { value: 290 } },
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec2 vUv;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vUv = uv;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec2 vUv;
      uniform float uTime;
      uniform float uHeight;
      uniform float uNight;
      ${FOG_UNIFORMS}
      ${SCAN_UNIFORMS}
      ${HASH}
      ${NOISE}
      void main() {
        float y = max(vWorld.y, 0.0);
        float sheet = exp(-y / 7.0) * 0.9 + exp(-y / 30.0) * 0.14;
        sheet *= 1.0 - smoothstep(uHeight * 0.6, uHeight, y);
        float along = abs(vUv.x - 0.5) * 2.0;
        sheet *= 1.0 - smoothstep(0.55, 1.0, along);
        float lines = 0.86 + 0.14 * sin(y * 2.1 - uTime * 3.0);
        float haze = 0.7 + 0.6 * vnoise(vec2(vWorld.z * 0.05, y * 0.08 - uTime * 0.12));
        vec3 V = normalize(cameraPosition - vWorld);
        float edgeOn = 0.3 / max(abs(dot(V.xz, uScanDir)), 0.25);
        float fogKeep = exp(-length(cameraPosition - vWorld) * uFogDensity * 0.45);
        vec3 c = uScanColor * uScanAmp * sheet * lines * haze * edgeOn * mix(0.75, 0.85, uNight) * fogKeep;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  })
}

/* ================================================================================================================
 * Drizzle (night) / dust motes (dawn): instanced points animated entirely in the vertex shader inside a box that
 * follows the camera target, so they cost no CPU time.
 * ============================================================================================================== */

export function createParticleMaterial(shared) {
  return new ShaderMaterial({
    uniforms: {
      ...shared.common,
      ...shared.fog,
      uCenter: { value: new Vector3() },
      uBox: { value: new Vector3(220, 140, 220) },
      uPixelRatio: { value: 1 },
      uViewport: { value: 900 },
      uRainColor: { value: color('#b8c4c6') },
      uDustColor: { value: color('#f3eadb') },
    },
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aSeed;
      uniform float uTime;
      uniform float uNight;
      uniform vec3 uCenter;
      uniform vec3 uBox;
      uniform float uPixelRatio;
      uniform float uViewport;
      varying float vAlpha;
      varying float vStreak;
      void main() {
        float speed = mix(1.2, 15.0, uNight) * (0.75 + aSeed.w * 0.5);
        vec3 drift = vec3(mix(0.6, 1.4, uNight), -speed, mix(0.3, 0.5, uNight)) * uTime;
        vec3 p = mod(aSeed.xyz * uBox + drift, uBox) - uBox * 0.5 + uCenter;
        p.y = mod(aSeed.y * uBox.y - speed * uTime, uBox.y) - uBox.y * 0.5 + uCenter.y;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        float d = -mv.z;
        gl_Position = projectionMatrix * mv;
        float size = mix(2.4, 1.6, uNight) * uViewport / max(d, 1.0) * 0.55;
        gl_PointSize = clamp(size * uPixelRatio, 1.0, 14.0 * uPixelRatio);
        vAlpha = (1.0 - smoothstep(110.0, 250.0, d)) * smoothstep(22.0, 60.0, d) * step(0.5, p.y);
        vStreak = uNight;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vAlpha;
      varying float vStreak;
      uniform vec3 uRainColor;
      uniform vec3 uDustColor;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float dot_ = 1.0 - smoothstep(0.15, 0.5, length(c));
        float streak = (1.0 - smoothstep(0.03, 0.09, abs(c.x))) * (1.0 - smoothstep(0.3, 0.5, abs(c.y)));
        float shape = mix(dot_, streak, vStreak);
        vec3 col = mix(uDustColor, uRainColor, vStreak);
        float a = shape * vAlpha * mix(0.16, 0.12, vStreak);
        if (a < 0.003) discard;
        gl_FragColor = vec4(col, a);
      }
    `,
  })
}

/* ================================================================================================================
 * The citizen's report pin (report stage): glossy road-marking yellow with a fresnel rim, and its shadow.
 * ============================================================================================================== */

export function createPinMaterial(shared) {
  return new ShaderMaterial({
    uniforms: { ...shared.common, ...shared.fog, ...shared.light, uPin: { value: color('#f5b700') }, uAlpha: { value: 1 } },
    transparent: true,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNrm;
      varying vec3 vLocal;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vLocal = position;
        vNrm = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNrm;
      varying vec3 vLocal;
      uniform vec3 uPin;
      uniform float uAlpha;
      uniform vec3 uAmbSky;
      uniform vec3 uKeyDir;
      uniform float uNight;
      ${FOG_UNIFORMS}
      ${SAFE}
      ${FOG}
      void main() {
        vec3 n = safeNormalize(vNrm);
        vec3 V = safeNormalize(cameraPosition - vWorld);
        float diff = 0.45 + 0.55 * max(dot(n, normalize(vec3(-0.3, 0.9, 0.4))), 0.0);
        float rim = pow(1.0 - max(dot(n, V), 0.0), 2.5);
        vec3 h = normalize(normalize(vec3(-0.3, 0.9, 0.4)) + V);
        float spec = pow(max(dot(n, h), 0.0), 60.0);
        vec3 c = uPin * diff * mix(1.0, 1.6, uNight) + vec3(1.0) * spec * 0.9 + uPin * rim * 0.9;
        // white dot on the head
        float dotMask = 1.0 - smoothstep(0.36, 0.42, length(vLocal.xz - vec2(0.0)) + max(0.0, 2.55 - vLocal.y) * 3.0);
        c = mix(c, vec3(1.15), dotMask * step(2.3, vLocal.y));
        gl_FragColor = vec4(applyFog(c, vWorld), uAlpha);
      }
    `,
  })
}

export function createShadowMaterial() {
  return new ShaderMaterial({
    uniforms: { uAlpha: { value: 0.5 } },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = position.xz * 2.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform float uAlpha;
      void main() {
        float r = length(vUv);
        gl_FragColor = vec4(0.0, 0.0, 0.0, (1.0 - smoothstep(0.0, 1.0, r)) * uAlpha);
      }
    `,
  })
}
