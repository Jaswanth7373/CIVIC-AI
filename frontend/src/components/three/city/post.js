/**
 * Post-processing for the 3D scenes (three/addons EffectComposer), rendered from useFrame at priority 1.
 *
 * Chain: scene pass (half-float; on the high tier into its own 4x MSAA target, then resolved into the composer
 * buffer) -> UnrealBloomPass with a high threshold (only lamps, beacons, the scan line and markers exceed it; full
 * resolution on high, half on medium, off on low) -> one grade pass that does ACES filmic tone mapping + sRGB
 * encoding and then grades in display space: filmic contrast, split tone (teal shadows / sodium highlights at
 * night, cool-neutral at dawn), a vignette centred on the lens-shifted subject, fine animated grain and edge-only
 * chromatic aberration (high tier), and a near-field defocus that softens the nearest rooftops at the bottom of the
 * frame (high / medium) so the eye settles on the mid-ground.
 * After the chain an overlay scene (the sign labels) is drawn straight to the screen, untouched by bloom and grade.
 *
 * Why a separate MSAA target: three invalidates a multisampled colour buffer right after resolving it, so the
 * bloom pass (which blends back into its input) must work on a regular buffer.
 *
 * `createPostPipeline` builds the chain (plain objects; GPU memory is allocated on first use or by the start-up
 * primer) and lists what the primer must prepare: every render target, and every pass material with the target
 * it draws into (`primeList`). `usePostPipeline` sizes a pipeline with the canvas and renders it each frame; the
 * owner disposes the pipeline (`pipeline.dispose()`).
 */
import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { Color, HalfFloatType, ShaderMaterial, UniformsUtils, Vector2, WebGLRenderTarget } from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { CopyShader } from 'three/addons/shaders/CopyShader.js'
import { isScrolling } from '../scrollActivity'

/** Renders the scene into a private multisampled target and copies the resolved image into the read buffer. */
class MultisampleRenderPass extends Pass {
  constructor(scene, camera, samples) {
    super()
    this.scene = scene
    this.camera = camera
    this.needsSwap = false
    this.target = new WebGLRenderTarget(2, 2, { type: HalfFloatType, samples, depthBuffer: true })
    // Only colour is needed downstream; resolving depth too makes the blit fail on some ANGLE/D3D11 drivers
    // (the whole resolve is then dropped and the image stays black).
    this.target.resolveDepthBuffer = false
    this.copyMaterial = new ShaderMaterial({
      uniforms: UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader,
      fragmentShader: CopyShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    })
    this.quad = new FullScreenQuad(this.copyMaterial)
  }

  setSize(width, height) {
    this.target.setSize(width, height)
  }

  render(renderer, writeBuffer, readBuffer) {
    renderer.setRenderTarget(this.target)
    renderer.clear()
    renderer.render(this.scene, this.camera)
    this.copyMaterial.uniforms.tDiffuse.value = this.target.texture
    renderer.setRenderTarget(this.renderToScreen ? null : readBuffer)
    this.quad.render(renderer)
  }

  dispose() {
    this.target.dispose()
    this.copyMaterial.dispose()
    this.quad.dispose()
  }
}

/** Bloom whose internal buffers run at a fraction of the canvas resolution (medium tier). */
class ScaledBloomPass extends UnrealBloomPass {
  constructor(resolution, strength, radius, threshold, scale) {
    super(resolution, strength, radius, threshold)
    this.scale = scale
  }

  setSize(width, height) {
    super.setSize(Math.max(2, Math.round(width * this.scale)), Math.max(2, Math.round(height * this.scale)))
  }
}

export function createGradeMaterial({ aberration, grain }) {
  return new ShaderMaterial({
    defines: { ABERRATION: aberration ? 1 : 0, GRAIN: grain ? 1 : 0 },
    uniforms: {
      tDiffuse: { value: null },
      uResolution: { value: new Vector2(1, 1) },
      uTime: { value: 0 },
      uExposure: { value: 1 },
      uContrast: { value: 0.32 },
      uSaturation: { value: 1.04 },
      uShadowTint: { value: new Color(-0.012, 0.022, 0.03) },
      uHighlightTint: { value: new Color(0.04, 0.012, -0.03) },
      uVignette: { value: 0.62 },
      uVignetteCenter: { value: new Vector2(0.5, 0.5) },
      uVignetteColor: { value: new Color(0.02, 0.035, 0.04) },
      uGrain: { value: 0.035 },
      uAberration: { value: 0.00035 },
      uFade: { value: 1 },
      uFadeColor: { value: new Color(0.05, 0.07, 0.075) },
      uNearBlur: { value: 0 },
    },
    toneMapped: false,
    depthTest: false,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec2 uResolution;
      uniform float uTime;
      uniform float uExposure;
      uniform float uContrast;
      uniform float uSaturation;
      uniform vec3 uShadowTint;
      uniform vec3 uHighlightTint;
      uniform float uVignette;
      uniform vec2 uVignetteCenter;
      uniform vec3 uVignetteColor;
      uniform float uGrain;
      uniform float uAberration;
      uniform float uFade;
      uniform vec3 uFadeColor;
      uniform float uNearBlur;
      varying vec2 vUv;

      vec3 RRTAndODTFit(vec3 v) {
        vec3 a = v * (v + 0.0245786) - 0.000090537;
        vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
        return a / b;
      }
      vec3 acesFilmic(vec3 color) {
        const mat3 inputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
        const mat3 outputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
        color *= uExposure / 0.6;
        color = inputMat * color;
        color = RRTAndODTFit(color);
        color = outputMat * color;
        return clamp(color, 0.0, 1.0);
      }
      vec3 srgb(vec3 c) {
        return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
      }
      float hash(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
      }

      void main() {
        vec2 d = vUv - 0.5;
        #if ABERRATION
          // edge-only: grows with the square of the distance from the centre, invisible in the middle third
          vec2 off = d * smoothstep(0.08, 0.5, dot(d, d)) * uAberration * 6.0;
          vec3 hdr = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
        #else
          vec3 hdr = texture2D(tDiffuse, vUv).rgb;
        #endif
        // Near-field defocus: the nearest rooftops (bottom of the frame) fall softly out of focus, so the eye stays
        // on the mid-ground subject. 12-tap Vogel disc, only in the bottom band.
        float near = uNearBlur * smoothstep(0.3, 0.0, vUv.y);
        if (near > 0.02) {
          vec2 texel = 1.0 / uResolution;
          float radius = near * 7.5;
          vec3 sum = hdr;
          for (int i = 0; i < 12; i++) {
            float fi = float(i) + 0.5;
            float r = sqrt(fi / 12.0) * radius;
            float a = fi * 2.39996;
            sum += texture2D(tDiffuse, vUv + vec2(cos(a), sin(a)) * r * texel).rgb;
          }
          hdr = sum / 13.0;
        }
        vec3 c = srgb(acesFilmic(hdr));
        // filmic contrast around the mid tones
        c = mix(c, c * c * (3.0 - 2.0 * c), uContrast);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c += uShadowTint * (1.0 - l) * (1.0 - l) + uHighlightTint * l * l;
        c = mix(vec3(l), c, uSaturation);
        // centred on the subject (the lens-shifted composition), so the copy side falls off into the dark
        vec2 v = (vUv - uVignetteCenter) * vec2(uResolution.x / uResolution.y, 1.0);
        float vig = smoothstep(0.38, 1.18, length(v) * 1.02);
        c = mix(c, c * uVignetteColor * 4.0, vig * uVignette);
        #if GRAIN
          float g = hash(gl_FragCoord.xy + fract(uTime * 7.31) * 913.0) - 0.5;
          c += g * uGrain * (0.55 + 0.45 * (1.0 - l));
        #endif
        c += (hash(gl_FragCoord.xy * 1.37 + 3.1) - 0.5) / 255.0;
        c = mix(uFadeColor, c, uFade);
        gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
      }
    `,
  })
}

/** Every pass material of `pass` (own properties: materials and arrays of materials). */
function passMaterials(pass) {
  const found = new Set()
  Object.values(pass).forEach((value) => {
    const list = Array.isArray(value) ? value : [value]
    list.forEach((item) => {
      if (item?.isMaterial) found.add(item)
    })
  })
  return [...found]
}

/**
 * Builds the post chain for `scene` seen by `camera` (no GPU work yet).
 * @param {object} options
 * @param {import('three').WebGLRenderer} options.gl
 * @param {import('three').Scene} options.scene the scene the first pass renders
 * @param {import('three').Camera} options.camera
 * @param {object} options.settings tier settings (msaa, bloom, bloomScale, grain, aberration)
 * @param {{strength:number, radius:number, threshold:number}} options.bloom
 * @returns {{ composer, scenePass, bloomPass, grade, gradeMaterial, samples: number, sceneTarget: object,
 *   renderTargets: object[], primeList: {material: object, target: object|null}[], setSize: Function,
 *   dispose: Function }}
 */
export function createPostPipeline({ gl, scene, camera, settings, bloom }) {
  const samples = Math.min(settings.msaa, gl.capabilities.maxSamples || 0)
  const composer = new EffectComposer(gl)
  const scenePass = samples > 0 ? new MultisampleRenderPass(scene, camera, samples) : new RenderPass(scene, camera)
  composer.addPass(scenePass)
  let bloomPass = null
  if (settings.bloom) {
    bloomPass = new ScaledBloomPass(new Vector2(2, 2), bloom.strength, bloom.radius, bloom.threshold, settings.bloomScale)
    composer.addPass(bloomPass)
  }
  const gradeMaterial = createGradeMaterial({ aberration: settings.aberration, grain: settings.grain })
  const grade = new ShaderPass(gradeMaterial)
  composer.addPass(grade)

  // What the scene pass draws into (the MSAA target on high, the composer's read buffer otherwise).
  const sceneTarget = scenePass.target ?? composer.renderTarget1
  const renderTargets = [composer.renderTarget1, composer.renderTarget2]
  if (scenePass.target) renderTargets.push(scenePass.target)
  if (bloomPass) {
    renderTargets.push(bloomPass.renderTargetBright, ...bloomPass.renderTargetsHorizontal, ...bloomPass.renderTargetsVertical)
  }
  // Pass materials with the target state they really draw in: three keys programs on it (tone mapping and output
  // colour space differ between the screen and a render target). The grade pass draws to the screen.
  const primeList = []
  composer.passes.forEach((pass) => {
    passMaterials(pass).forEach((material) => {
      // UnrealBloomPass' `basic` material only draws when the pass renders to the screen (never here).
      if (material.isMeshBasicMaterial) return
      primeList.push({ material, target: pass === grade ? null : composer.renderTarget1 })
    })
  })

  return {
    composer,
    scenePass,
    bloomPass,
    grade,
    gradeMaterial,
    samples,
    sceneTarget,
    renderTargets,
    primeList,
    setSize(width, height, dpr) {
      composer.setPixelRatio(dpr)
      composer.setSize(width, height)
      grade.uniforms.uResolution.value.set(width * dpr, height * dpr)
    },
    dispose() {
      scenePass.dispose()
      bloomPass?.dispose()
      grade.dispose()
      gradeMaterial.dispose()
      composer.dispose()
    },
  }
}

/**
 * Keeps `pipeline` sized with the canvas and renders it every frame at useFrame priority 1 (R3F then leaves the
 * rendering to it), followed by the `overlay` scene (labels) straight to the screen. While the page scrolls
 * (scrollActivity.js) it draws every other frame: the last picture stays on screen in between, the skipped time is
 * handed to the next update (animations keep their pace), and the GPU time saved goes to the page's own raster.
 * Nothing is resized or switched for it (a resize reallocates every target, which itself stalls).
 * @param {object} options
 * @param {object|null} options.pipeline createPostPipeline() result (nothing renders while it is null)
 * @param {import('three').Scene|null} options.overlay scene drawn after the chain (labels)
 * @param {(delta:number) => void} [options.onBeforeRender] per-frame update, runs right before rendering
 * @param {() => void} [options.onAfterFirstRender] after the first frame this pipeline rendered
 * @param {boolean} [options.enabled=true] false: render nothing (e.g. while the scene is still being primed)
 */
export function usePostPipeline({ pipeline, overlay, onBeforeRender, onAfterFirstRender, enabled = true }) {
  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera)
  const size = useThree((state) => state.size)
  const dpr = useThree((state) => state.viewport.dpr)
  const invalidate = useThree((state) => state.invalidate)
  const frameloop = useThree((state) => state.frameloop)
  const firstRef = useRef(null)
  const skipRef = useRef({ skipped: false, delta: 0 })
  const callbacks = useRef({ onBeforeRender, onAfterFirstRender })
  useEffect(() => {
    callbacks.current = { onBeforeRender, onAfterFirstRender }
  })

  useEffect(() => {
    if (!pipeline) return
    pipeline.setSize(size.width, size.height, dpr)
    invalidate()
  }, [pipeline, size.width, size.height, dpr, invalidate])

  useFrame((_, frameDelta) => {
    if (!enabled || !pipeline) return
    const skip = skipRef.current
    // (a demand-mode frame is never skipped: nothing would ask for it again)
    if (frameloop === 'always' && firstRef.current === pipeline && !skip.skipped && isScrolling()) {
      skip.skipped = true
      skip.delta += frameDelta
      return
    }
    skip.skipped = false
    const delta = frameDelta + skip.delta
    skip.delta = 0
    callbacks.current.onBeforeRender?.(delta)
    pipeline.composer.render(delta)
    if (overlay) {
      const autoClear = gl.autoClear
      gl.autoClear = false
      gl.setRenderTarget(null)
      gl.render(overlay, camera)
      gl.autoClear = autoClear
    }
    if (firstRef.current !== pipeline) {
      firstRef.current = pipeline
      callbacks.current.onAfterFirstRender?.()
    }
  }, 1)
}
