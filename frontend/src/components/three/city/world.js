/**
 * Builds the city's meshes from the layout: one draw call per kind of thing, all instanced.
 *
 * sky dome (1) . ground (1) . buildings + roof plant + HQ landmarks (1) . lamp poles (1) . lamp glows (1)
 * wet-street lamp reflections (1, high/medium) . light cones (1, high/medium) . trees (1) . scan sheet (1)
 * issue rings (1) . issue beams (1) . routing arcs (1) . beacons / packets / pin glow / beam caps (1)
 * drizzle or dawn dust (1, high/medium) . report pin + shadow (2) - about 18 draw calls before post-processing.
 * The lamp light pools are baked once on the GPU into a half-float light map that the ground samples.
 *
 * `buildWorld()` is a generator that yields between sections (sky, ground, buildings in batches, lamps, trees,
 * markers...), so the district can be built in idle slices before its canvas mounts (gpuTasks.runSliced);
 * `createWorld()` runs it to completion synchronously. The result holds its own scene, shared uniforms and tier
 * settings, and a `dispose()` that frees geometries, materials and attributes.
 */
import {
  BoxGeometry,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  ConeGeometry,
  CustomBlending,
  CylinderGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  HalfFloatType,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  OneFactor,
  OrthographicCamera,
  PlaneGeometry,
  Points,
  Quaternion,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  WebGLRenderTarget,
} from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { CITY, hashU32, unit } from './layout'
import { SCALARS } from './palette'
import {
  createArcMaterial,
  createBeamMaterial,
  createBuildingMaterial,
  createConeMaterial,
  createCurtainMaterial,
  createGlowMaterial,
  createGroundMaterial,
  createLampGlowMaterial,
  createParticleMaterial,
  createPinMaterial,
  createPoleMaterial,
  createRingMaterial,
  createShadowMaterial,
  createSkyMaterial,
  createStreakMaterial,
  createTreeMaterial,
} from './materials'

const _m = new Matrix4()
const _q = new Quaternion()
const _p = new Vector3()
const _s = new Vector3()
const _c = new Color()
const UP = new Vector3(0, 1, 0)

/** Non-indexed copy tagged with a per-vertex part id (mergeGeometries needs uniform indexing). */
function withPart(geometry, part) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry.clone()
  const count = flat.attributes.position.count
  flat.setAttribute('aPart', new Float32BufferAttribute(new Float32Array(count).fill(part), 1))
  return flat
}

function mergeParts(parts) {
  const tagged = parts.map(([geometry, part]) => withPart(geometry, part))
  const merged = mergeGeometries(tagged)
  parts.forEach(([geometry]) => geometry.dispose())
  tagged.forEach((geometry) => geometry.dispose())
  return merged
}

function poleGeometry() {
  const h = CITY.lampHeight
  const arm = CITY.lampArm
  const pole = new BoxGeometry(0.16, h, 0.16).translate(0, h / 2, 0)
  const armGeo = new BoxGeometry(arm + 0.08, 0.09, 0.09).translate(arm / 2, h - 0.06, 0)
  const head = new BoxGeometry(0.66, 0.15, 0.34).translate(arm - 0.18, h - 0.17, 0)
  return mergeParts([
    [pole, 0],
    [armGeo, 0],
    [head, 1],
  ])
}

function treeGeometry() {
  const trunk = new CylinderGeometry(0.06, 0.09, 0.34, 6, 1).translate(0, 0.17, 0)
  const crown = new IcosahedronGeometry(0.5, 1)
  // Organic crowns: jitter the vertices a little (deterministic), then flat-shade for a low-poly read.
  const pos = crown.attributes.position
  for (let i = 0; i < pos.count; i += 1) {
    const j = 1 + (unit(hashU32(Math.round(pos.getX(i) * 997 + pos.getY(i) * 131 + pos.getZ(i) * 71) + 5)) - 0.5) * 0.22
    pos.setXYZ(i, pos.getX(i) * j, pos.getY(i) * j * 0.92, pos.getZ(i) * j)
  }
  crown.computeVertexNormals()
  crown.translate(0, 0.62, 0)
  return mergeParts([
    [trunk, 0],
    [crown, 1],
  ])
}

function pinGeometry() {
  const head = new SphereGeometry(1.25, 28, 18).translate(0, 3.05, 0)
  const tip = new ConeGeometry(0.86, 2.4, 28, 1, true).rotateX(Math.PI).translate(0, 1.2 + 0.55, 0)
  return mergeParts([
    [head, 0],
    [tip, 0],
  ])
}

/** Camera-facing ribbon strips along cubic Béziers from each site to its HQ beacon. */
export function buildArcGeometry(sites, hqs) {
  const SEG = 64
  const positions = []
  const tangents = []
  const ts = []
  const sides = []
  const arcs = []
  const indices = []
  const curves = []
  const a = new Vector3()
  const b = new Vector3()
  const c1 = new Vector3()
  const c2 = new Vector3()
  const p = new Vector3()
  const d = new Vector3()
  sites.forEach((site, k) => {
    const hq = hqs.find((h) => h.index === site.hq) ?? hqs[0]
    a.set(site.x, 1.2, site.z)
    b.set(hq.x, hq.top + 2.2, hq.z)
    const span = Math.hypot(b.x - a.x, b.z - a.z)
    const lift = Math.max(a.y, b.y) + span * 0.24 + 10
    c1.set(a.x + (b.x - a.x) * 0.2, lift, a.z + (b.z - a.z) * 0.2)
    c2.set(a.x + (b.x - a.x) * 0.72, lift + 4, a.z + (b.z - a.z) * 0.72)
    curves.push({ a: a.clone(), b: b.clone(), c1: c1.clone(), c2: c2.clone() })
    const base = positions.length / 3
    for (let i = 0; i <= SEG; i += 1) {
      const t = i / SEG
      const u = 1 - t
      p.set(0, 0, 0)
        .addScaledVector(a, u * u * u)
        .addScaledVector(c1, 3 * u * u * t)
        .addScaledVector(c2, 3 * u * t * t)
        .addScaledVector(b, t * t * t)
      d.set(0, 0, 0)
        .addScaledVector(c1.clone().sub(a), 3 * u * u)
        .addScaledVector(c2.clone().sub(c1), 6 * u * t)
        .addScaledVector(b.clone().sub(c2), 3 * t * t)
      for (const side of [-1, 1]) {
        positions.push(p.x, p.y, p.z)
        tangents.push(d.x, d.y, d.z)
        ts.push(t)
        sides.push(side)
        arcs.push(k)
      }
      if (i < SEG) {
        const v = base + i * 2
        indices.push(v, v + 1, v + 2, v + 1, v + 3, v + 2)
      }
    }
  })
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aTangent', new Float32BufferAttribute(tangents, 3))
  geometry.setAttribute('aT', new Float32BufferAttribute(ts, 1))
  geometry.setAttribute('aSide', new Float32BufferAttribute(sides, 1))
  geometry.setAttribute('aArc', new Float32BufferAttribute(arcs, 1))
  geometry.setIndex(indices)
  return { geometry, curves }
}

/** Point on arc `curve` at t (cubic Bézier), written into `out`. */
export function arcPoint(curve, t, out) {
  const u = 1 - t
  return out
    .set(0, 0, 0)
    .addScaledVector(curve.a, u * u * u)
    .addScaledVector(curve.c1, 3 * u * u * t)
    .addScaledVector(curve.c2, 3 * u * t * t)
    .addScaledVector(curve.b, t * t * t)
}

const POOL_RADIUS = 15.5
const SODIUM_LINEAR = new Color('#ffae54').multiplyScalar(5.2)
const LED_LINEAR = new Color('#f1eee6').multiplyScalar(2.9)
/** Share of lamps that stay on at dawn. */
const DAWN_LAMPS = SCALARS.dawn.lampsOn

/**
 * Light pools of every working lamp, rendered once on the GPU (instanced additive quads) into a half-float target
 * covering [-extent, extent]^2: RGB = night (sodium / LED colours), A = the dawn subset. No main-thread cost.
 * `bake(gl)` must run before the first frame (once per renderer); `scene` / `camera` / `target` let the start-up
 * primer compile the bake program asynchronously first. After a bake the GPU copies of the bake geometry and
 * material are released (the objects stay, so another renderer can bake the same world).
 */
function createLightMap(lamps, extent, size) {
  const target = new WebGLRenderTarget(size, size, {
    type: HalfFloatType,
    depthBuffer: false,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    generateMipmaps: false,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
  })
  const working = lamps.filter((lamp) => !lamp.broken)
  const geometry = new PlaneGeometry(1, 1)
  geometry.setAttribute('aHead', new InstancedBufferAttribute(new Float32Array(working.flatMap((l) => [l.hx, 0, l.hz])), 3))
  geometry.setAttribute(
    'aInfo',
    new InstancedBufferAttribute(
      new Float32Array(working.flatMap((l) => [l.cool ? 1 : 0, unit(hashU32(l.id + 99)) <= DAWN_LAMPS ? 1 : 0])),
      2,
    ),
  )
  const material = new ShaderMaterial({
    uniforms: {
      uExtent: { value: extent },
      uRadius: { value: POOL_RADIUS },
      uHeight: { value: CITY.lampHeight },
      uSodium: { value: SODIUM_LINEAR },
      uLed: { value: LED_LINEAR },
    },
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneFactor,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    vertexShader: /* glsl */ `
      attribute vec3 aHead;
      attribute vec2 aInfo;
      uniform float uExtent;
      uniform float uRadius;
      varying vec2 vOffset;
      varying vec2 vInfo;
      void main() {
        vOffset = position.xy * 2.0 * uRadius;
        vInfo = aInfo;
        gl_Position = vec4((aHead.xz + vOffset) / uExtent, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vOffset;
      varying vec2 vInfo;
      uniform float uRadius;
      uniform float uHeight;
      uniform vec3 uSodium;
      uniform vec3 uLed;
      void main() {
        float horiz2 = dot(vOffset, vOffset);
        if (horiz2 > uRadius * uRadius) discard;
        float d2 = horiz2 + uHeight * uHeight;
        float e = (uHeight * inversesqrt(d2)) / (1.0 + d2 * 0.055) * (1.0 - smoothstep(7.0, uRadius, sqrt(horiz2)));
        vec3 c = vInfo.x > 0.5 ? uLed : uSodium;
        gl_FragColor = vec4(c * e, vInfo.y * 5.2 * e);
      }
    `,
  })
  const mesh = new InstancedMesh(geometry, material, working.length)
  mesh.frustumCulled = false
  const scene = new Scene()
  scene.add(mesh)
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const bakedOn = new WeakSet()
  const release = () => {
    geometry.dispose()
    material.dispose()
  }
  return {
    texture: target.texture,
    extent,
    target,
    scene,
    camera,
    isBaked: (gl) => bakedOn.has(gl),
    bake(gl) {
      if (bakedOn.has(gl)) return
      bakedOn.add(gl)
      const previous = gl.getRenderTarget()
      const clear = gl.getClearColor(new Color())
      const alpha = gl.getClearAlpha()
      gl.setRenderTarget(target)
      gl.setClearColor(0x000000, 0)
      gl.clear(true, false, false)
      gl.render(scene, camera)
      gl.setRenderTarget(previous)
      gl.setClearColor(clear, alpha)
      release()
    },
    dispose() {
      target.dispose()
      release()
      mesh.dispose()
    },
  }
}

function lampAttribute(lamps) {
  const data = new Float32Array(lamps.length * 4)
  lamps.forEach((lamp, k) => {
    data[k * 4] = lamp.broken ? 0 : Math.max(unit(lamp.id), CITY.brokenLamps + 1e-4)
    data[k * 4 + 1] = unit(hashU32(lamp.id + 99))
    data[k * 4 + 2] = lamp.x
    data[k * 4 + 3] = lamp.z
  })
  return data
}

/** Buildings per slice step (instance matrices and attributes). */
const BUILDING_BATCH = 400

/**
 * The district's meshes, built step by step: a generator that yields between sections, to be driven by
 * gpuTasks.runSliced (idle slices) or run at once by createWorld. Pure object construction (no GPU work).
 * @param {object} city getCity()
 * @param {object} settings tier settings (TIER_SETTINGS[tier])
 * @param {object} shared createSharedUniforms()
 */
export function* buildWorld(city, settings, shared) {
  const root = new Group()
  root.name = 'civicai-city'
  const disposables = []
  const track = (...items) => {
    disposables.push(...items)
    return items[0]
  }

  /* ---- sky ---- */
  const skyMaterial = track(createSkyMaterial(shared))
  const sky = new Mesh(track(new SphereGeometry(1500, 32, 16)), skyMaterial)
  sky.renderOrder = -10
  sky.frustumCulled = false
  root.add(sky)

  /* ---- ground ---- */
  const lightMap = track(createLightMap(city.lamps, (CITY.outer + 1) * CITY.pitch, settings.lightMap))
  const groundMaterial = track(
    createGroundMaterial(shared, { lightMap: lightMap.texture, lightExtent: lightMap.extent, reflections: settings.reflections }),
  )
  const ground = new Mesh(track(new PlaneGeometry(2600, 2600).rotateX(-Math.PI / 2)), groundMaterial)
  ground.frustumCulled = false
  root.add(ground)
  yield

  /* ---- buildings ---- */
  const buildings = city.buildings
  const boxGeometry = track(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0))
  const buildingMaterial = track(createBuildingMaterial(shared))
  const buildingMesh = new InstancedMesh(boxGeometry, buildingMaterial, buildings.length)
  const colors = new Float32Array(buildings.length * 3)
  const data = new Float32Array(buildings.length * 4)
  for (let k = 0; k < buildings.length; k += 1) {
    const b = buildings[k]
    _p.set(b.x, b.y, b.z)
    _s.set(b.w, b.h, b.d)
    _m.compose(_p, _q.identity(), _s)
    buildingMesh.setMatrixAt(k, _m)
    _c.set(b.color)
    colors[k * 3] = _c.r
    colors[k * 3 + 1] = _c.g
    colors[k * 3 + 2] = _c.b
    data[k * 4] = b.seed % 16777216
    data[k * 4 + 1] = b.kind
    data[k * 4 + 2] = b.hq === undefined ? 0 : b.hq + 1
    if (k % BUILDING_BATCH === BUILDING_BATCH - 1) yield
  }
  boxGeometry.setAttribute('aColor', new InstancedBufferAttribute(colors, 3))
  boxGeometry.setAttribute('aData', new InstancedBufferAttribute(data, 4))
  buildingMesh.frustumCulled = false
  root.add(buildingMesh)
  yield

  /* ---- lamps ---- */
  const coreLamps = city.lamps.filter((l) => l.core)
  const poleGeo = track(poleGeometry())
  const poleMaterial = track(createPoleMaterial(shared))
  const poles = new InstancedMesh(poleGeo, poleMaterial, coreLamps.length)
  coreLamps.forEach((lamp, k) => {
    _q.setFromAxisAngle(UP, Math.atan2(-lamp.dirZ, lamp.dirX))
    _m.compose(_p.set(lamp.x, 0, lamp.z), _q, _s.set(1, 1, 1))
    poles.setMatrixAt(k, _m)
  })
  poleGeo.setAttribute('aLamp', new InstancedBufferAttribute(lampAttribute(coreLamps), 4))
  poleGeo.setAttribute('aCool', new InstancedBufferAttribute(new Float32Array(coreLamps.map((l) => (l.cool ? 1 : 0))), 1))
  poles.frustumCulled = false
  root.add(poles)
  yield

  // Glows for every lamp (the outskirts read as a sea of lights in the haze).
  const glowLamps = city.lamps.filter((l) => !l.broken)
  const quad = track(new PlaneGeometry(1, 1))
  const lampGlowGeo = track(quad.clone())
  const lampGlowMaterial = track(createLampGlowMaterial(shared))
  const lampGlows = new InstancedMesh(lampGlowGeo, lampGlowMaterial, glowLamps.length)
  lampGlowGeo.setAttribute('aLamp', new InstancedBufferAttribute(lampAttribute(glowLamps), 4))
  lampGlowGeo.setAttribute(
    'aHead',
    new InstancedBufferAttribute(new Float32Array(glowLamps.flatMap((l) => [l.hx, 0, l.hz])), 3),
  )
  lampGlowGeo.setAttribute('aCool', new InstancedBufferAttribute(new Float32Array(glowLamps.map((l) => (l.cool ? 1 : 0))), 1))
  lampGlows.frustumCulled = false
  lampGlows.renderOrder = 6
  root.add(lampGlows)
  yield

  // Wet-street reflections of the lamps (one stretched quad per lamp).
  let streaks = null
  if (settings.reflections > 0) {
    const streakLamps = city.lamps.filter((l) => !l.broken && l.ring <= CITY.core + 3)
    const streakGeo = track(quad.clone())
    const streakMaterial = track(createStreakMaterial(shared))
    streaks = new InstancedMesh(streakGeo, streakMaterial, streakLamps.length)
    streakGeo.setAttribute('aLamp', new InstancedBufferAttribute(lampAttribute(streakLamps), 4))
    streakGeo.setAttribute('aHead', new InstancedBufferAttribute(new Float32Array(streakLamps.flatMap((l) => [l.hx, 0, l.hz])), 3))
    streakGeo.setAttribute('aCool', new InstancedBufferAttribute(new Float32Array(streakLamps.map((l) => (l.cool ? 1 : 0))), 1))
    streaks.frustumCulled = false
    streaks.renderOrder = 1
    root.add(streaks)
    yield
  }

  let cones = null
  if (settings.cones) {
    const focus = new Vector3(18, 0, -6)
    const coneLamps = coreLamps
      .filter((l) => !l.broken && Math.hypot(l.x - focus.x, l.z - focus.z) < 150)
      .slice(0, 220)
    const coneGeo = track(new ConeGeometry(3.1, CITY.lampHeight - 0.3, 18, 1, true).translate(0, (CITY.lampHeight - 0.3) / 2, 0))
    const coneMaterial = track(createConeMaterial(shared))
    cones = new InstancedMesh(coneGeo, coneMaterial, coneLamps.length)
    coneLamps.forEach((lamp, k) => {
      _m.compose(_p.set(lamp.hx, 0, lamp.hz), _q.identity(), _s.set(1, 1, 1))
      cones.setMatrixAt(k, _m)
    })
    coneGeo.setAttribute('aLamp', new InstancedBufferAttribute(lampAttribute(coneLamps), 4))
    coneGeo.setAttribute('aCool', new InstancedBufferAttribute(new Float32Array(coneLamps.map((l) => (l.cool ? 1 : 0))), 1))
    cones.frustumCulled = false
    cones.renderOrder = 4
    root.add(cones)
    yield
  }

  /* ---- trees ---- */
  const treeGeo = track(treeGeometry())
  const treeMaterial = track(createTreeMaterial(shared))
  const trees = new InstancedMesh(treeGeo, treeMaterial, city.trees.length)
  city.trees.forEach((tree, k) => {
    _m.compose(_p.set(tree.x, 0, tree.z), _q.identity(), _s.set(tree.r * 2, tree.h, tree.r * 2))
    trees.setMatrixAt(k, _m)
  })
  treeGeo.setAttribute('aTone', new InstancedBufferAttribute(new Float32Array(city.trees.map((t) => t.tone)), 1))
  trees.frustumCulled = false
  root.add(trees)
  yield

  /* ---- scan sheet ---- */
  const curtainMaterial = track(createCurtainMaterial(shared))
  const curtain = new Mesh(track(new PlaneGeometry(1, 1).rotateY(Math.PI / 2)), curtainMaterial)
  const curtainHeight = curtainMaterial.uniforms.uHeight.value
  curtain.scale.set(1, curtainHeight, curtainMaterial.uniforms.uHalf.value * 2)
  curtain.position.set(0, curtainHeight / 2, 0)
  curtain.frustumCulled = false
  curtain.renderOrder = 5
  root.add(curtain)

  /* ---- issue markers ---- */
  const siteCount = city.sites.length
  const ringGeo = track(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2))
  const ringMaterial = track(createRingMaterial(shared))
  const rings = new InstancedMesh(ringGeo, ringMaterial, siteCount)
  const ringState = new InstancedBufferAttribute(new Float32Array(siteCount * 4), 4).setUsage(DynamicDrawUsage)
  const ringColor = new InstancedBufferAttribute(new Float32Array(siteCount * 3), 3).setUsage(DynamicDrawUsage)
  ringGeo.setAttribute('aRing', ringState)
  ringGeo.setAttribute('aSev', ringColor)
  ringGeo.setAttribute('aSeed', new InstancedBufferAttribute(new Float32Array(city.sites.map((_, k) => (k * 0.37) % 1)), 1))
  city.sites.forEach((site, k) => {
    _m.compose(_p.set(site.x, 0.07, site.z), _q.identity(), _s.set(9, 1, 9))
    rings.setMatrixAt(k, _m)
  })
  rings.frustumCulled = false
  rings.renderOrder = 3
  root.add(rings)

  const beamGeo = track(quad.clone())
  const beamMaterial = track(createBeamMaterial(shared))
  const beams = new InstancedMesh(beamGeo, beamMaterial, siteCount)
  const beamState = new InstancedBufferAttribute(new Float32Array(siteCount * 4), 4).setUsage(DynamicDrawUsage)
  const beamColor = new InstancedBufferAttribute(new Float32Array(siteCount * 3), 3).setUsage(DynamicDrawUsage)
  const beamResolve = new InstancedBufferAttribute(new Float32Array(siteCount * 2), 2).setUsage(DynamicDrawUsage)
  beamGeo.setAttribute('aBeam', beamState)
  beamGeo.setAttribute('aSev', beamColor)
  beamGeo.setAttribute('aResolve', beamResolve)
  city.sites.forEach((site, k) => {
    _m.compose(_p.set(site.x, 0, site.z), _q.identity(), _s.set(1, 1, 1))
    beams.setMatrixAt(k, _m)
  })
  beams.frustumCulled = false
  beams.renderOrder = 7
  root.add(beams)
  // x-ray of the priority columns: the same instances, drawn only where buildings hide them (depth test 'greater').
  const beamGhosts = new InstancedMesh(beamGeo, track(createBeamMaterial(shared, { ghost: true })), siteCount)
  beamGhosts.instanceMatrix = beams.instanceMatrix
  beamGhosts.frustumCulled = false
  beamGhosts.renderOrder = 7
  root.add(beamGhosts)
  yield

  /* ---- routing arcs ---- */
  const arcMaterial = track(createArcMaterial(shared, siteCount))
  const arcBuild = buildArcGeometry(city.sites, city.hqs)
  const arcs = new Mesh(arcBuild.geometry, arcMaterial)
  disposables.push({ dispose: () => arcs.geometry.dispose() })
  arcs.frustumCulled = false
  arcs.renderOrder = 8
  root.add(arcs)

  /* ---- glows: packets (one per site), HQ beacons, pin ---- */
  // packets (one per site), HQ beacons, the report pin, beam caps (one per site)
  const glowCount = siteCount + city.hqs.length + 1 + siteCount
  const glowGeo = track(quad.clone())
  const glowMaterial = track(createGlowMaterial(shared))
  const glows = new InstancedMesh(glowGeo, glowMaterial, glowCount)
  const glowColor = new InstancedBufferAttribute(new Float32Array(glowCount * 3), 3).setUsage(DynamicDrawUsage)
  const glowParams = new InstancedBufferAttribute(new Float32Array(glowCount * 2), 2).setUsage(DynamicDrawUsage)
  glowGeo.setAttribute('aGlowColor', glowColor)
  glowGeo.setAttribute('aGlow', glowParams)
  glows.instanceMatrix.setUsage(DynamicDrawUsage)
  glows.frustumCulled = false
  glows.renderOrder = 9
  root.add(glows)
  yield

  /* ---- drizzle / dust ---- */
  let particles = null
  if (settings.particles > 0) {
    const count = settings.particles
    const geo = track(new BufferGeometry())
    const seeds = new Float32Array(count * 4)
    for (let i = 0; i < count; i += 1) {
      seeds[i * 4] = unit(hashU32(i * 4 + 1))
      seeds[i * 4 + 1] = unit(hashU32(i * 4 + 2))
      seeds[i * 4 + 2] = unit(hashU32(i * 4 + 3))
      seeds[i * 4 + 3] = unit(hashU32(i * 4 + 4))
    }
    geo.setAttribute('position', new Float32BufferAttribute(new Float32Array(count * 3), 3))
    geo.setAttribute('aSeed', new Float32BufferAttribute(seeds, 4))
    const material = track(createParticleMaterial(shared))
    particles = new Points(geo, material)
    particles.frustumCulled = false
    particles.renderOrder = 11
    root.add(particles)
  }

  /* ---- report pin ---- */
  const pinMaterial = track(createPinMaterial(shared))
  const pin = new Mesh(track(pinGeometry()), pinMaterial)
  pin.visible = false
  pin.renderOrder = 2
  root.add(pin)
  const shadowMaterial = track(createShadowMaterial())
  const pinShadow = new Mesh(track(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)), shadowMaterial)
  pinShadow.visible = false
  pinShadow.renderOrder = 2
  root.add(pinShadow)

  // The district renders through its own scene (CityScene's post chain), not R3F's.
  const scene = new Scene()
  scene.add(root)

  return {
    root,
    scene,
    shared,
    settings,
    lightMap,
    materials: {
      sky: skyMaterial,
      ground: groundMaterial,
      streak: streaks?.material ?? null,
      building: buildingMaterial,
      ring: ringMaterial,
      beam: beamMaterial,
      beamGhost: beamGhosts.material,
      arc: arcMaterial,
      glow: glowMaterial,
      lampGlow: lampGlowMaterial,
      curtain: curtainMaterial,
      pin: pinMaterial,
      shadow: shadowMaterial,
      particles: particles?.material ?? null,
    },
    meshes: { curtain, rings, beams, arcs, glows, pin, pinShadow, particles, cones, streaks },
    attributes: { ringState, ringColor, beamState, beamColor, beamResolve, glowColor, glowParams },
    arcCurves: arcBuild.curves,
    /** Renders the lamp light map (once per renderer, before the first frame). */
    bake(gl) {
      lightMap.bake(gl)
    },
    rebuildArcs(sites, hqs) {
      const next = buildArcGeometry(sites, hqs)
      arcs.geometry.dispose()
      arcs.geometry = next.geometry
      this.arcCurves = next.curves
    },
    dispose() {
      disposables.forEach((item) => item?.dispose?.())
      buildingMesh.dispose()
      poles.dispose()
      lampGlows.dispose()
      streaks?.dispose()
      cones?.dispose()
      trees.dispose()
      rings.dispose()
      beams.dispose()
      beamGhosts.dispose()
      glows.dispose()
    },
  }
}

/** Builds the whole district at once (synchronous `buildWorld`). */
export function createWorld(city, settings, shared) {
  const steps = buildWorld(city, settings, shared)
  let step = steps.next()
  while (!step.done) step = steps.next()
  return step.value
}
