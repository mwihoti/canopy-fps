// Post-processing chain (all HDR until the grade pass):
//   scene -> [half-res SSAO + shadow-mapped volumetric light shafts]
//         -> composite -> bloom -> ACES tone map / grade -> FXAA -> screen
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { SUN } from '../world/layout';
import { SUN_COLOR } from '../world/world';

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export interface PostQuality { ao: number; vol: number; }

export class PostFX {
  rtScene!: THREE.WebGLRenderTarget; private rtHalf!: THREE.WebGLRenderTarget; private rtComp!: THREE.WebGLRenderTarget; private rtLDR!: THREE.WebGLRenderTarget;
  private quad = new FullScreenQuad();
  private halfMat: THREE.ShaderMaterial; private compMat: THREE.ShaderMaterial; private gradeMat: THREE.ShaderMaterial; private fxaaMat: THREE.ShaderMaterial;
  private bloom: UnrealBloomPass;
  width = 1; height = 1;
  /** gameplay-driven grade inputs */
  damage = 0; lowHealth = 0; flash = 0; fade = 0; fadeColor = new THREE.Color(0, 0, 0);

  constructor(private renderer: THREE.WebGLRenderer, q: PostQuality) {
    this.halfMat = this.makeHalfMat(q);
    this.compMat = new THREE.ShaderMaterial({
      uniforms: { tScene: { value: null }, tHalf: { value: null }, tDepth: { value: null }, uHalfTexel: { value: new THREE.Vector2() }, uNear: { value: 0.1 }, uFar: { value: 500 } },
      vertexShader: VERT,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tScene, tHalf, tDepth; uniform vec2 uHalfTexel; uniform float uNear, uFar;
        void main(){
          vec3 col = texture2D(tScene, vUv).rgb;
          if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);            // one bad texel would poison the bloom chain
          col = min(col, vec3(80.0));
          // 4 bilinear taps ~ 4x4 tent blur: hides the dither pattern of the half-res pass
          vec2 h = (texture2D(tHalf, vUv + uHalfTexel * vec2(-1.0, -1.0)).rg + texture2D(tHalf, vUv + uHalfTexel * vec2(1.0, -1.0)).rg
                  + texture2D(tHalf, vUv + uHalfTexel * vec2(-1.0, 1.0)).rg + texture2D(tHalf, vUv + uHalfTexel * vec2(1.0, 1.0)).rg) * 0.25;
          float d = texture2D(tDepth, vUv).x;
          float z = uNear * uFar / (uFar - d * (uFar - uNear));               // linear view depth
          float ao = mix(1.0, mix(h.r, 1.0, smoothstep(25.0, 55.0, z)), smoothstep(0.7, 1.6, z));   // skip the view-model
          col *= ao;
          col += ${glsl(SUN_COLOR)} * h.g;
          gl_FragColor = vec4(col, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.gradeMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uExposure: { value: 1.0 }, uTime: { value: 0 }, uDamage: { value: 0 }, uLow: { value: 0 }, uFlash: { value: 0 }, uFade: { value: 0 }, uFadeColor: { value: this.fadeColor } },
      vertexShader: VERT,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tDiffuse; uniform float uExposure, uTime, uDamage, uLow, uFlash, uFade; uniform vec3 uFadeColor;
        vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
        float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main(){
          vec2 c = vUv - 0.5;
          vec3 col = texture2D(tDiffuse, vUv).rgb * uExposure;
          col *= 1.0 + uFlash;
          // grade: lifted green-teal shadows, warm highlights, a touch more saturation
          float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
          col = mix(vec3(l), col, 1.12);
          col *= mix(vec3(0.90, 1.02, 1.0), vec3(1.06, 1.0, 0.9), smoothstep(0.0, 0.9, l));
          col = aces(col);
          col = pow(col, vec3(1.06));
          // vignette + hit / low-health feedback
          float v = dot(c, c);
          col *= 1.0 - v * 0.75;
          float pulse = 0.6 + 0.4 * sin(uTime * 5.0);
          col = mix(col, vec3(0.55, 0.02, 0.0), clamp(v * 2.4 * (uDamage + uLow * pulse * 0.6), 0.0, 0.85));
          col = mix(col, vec3(dot(col, vec3(0.3, 0.6, 0.1))), uLow * 0.45);
          col += (hash(vUv * 913.0 + uTime) - 0.5) * 0.022;                    // film grain / dither
          col = mix(col, uFadeColor, uFade);
          gl_FragColor = vec4(pow(max(col, 0.0), vec3(1.0 / 2.2)), 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.fxaaMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms), vertexShader: FXAAShader.vertexShader, fragmentShader: FXAAShader.fragmentShader,
      depthTest: false, depthWrite: false,
    });
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.42, 0.75, 1.05);
    this.setSize(2, 2);
  }

  private makeHalfMat(q: PostQuality) {
    return new THREE.ShaderMaterial({
      defines: { AO_N: q.ao, VOL_N: q.vol },
      uniforms: {
        tDepth: { value: null }, tShadow: { value: null }, uHasShadow: { value: 0 },
        uProj: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
        uShadowMat: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() }, uAspect: { value: 1 }, uFrame: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: `precision highp float; precision highp sampler2DShadow;
        varying vec2 vUv; uniform sampler2D tDepth; uniform sampler2DShadow tShadow; uniform float uHasShadow, uAspect, uFrame;
        uniform mat4 uProj, uProjInv, uCamWorld, uShadowMat; uniform vec3 uCamPos;
        vec3 viewPos(vec2 uv){ float d = texture2D(tDepth, uv).x; vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return v.xyz / v.w; }
        // 4x4 ordered dither: the composite pass' 4x4 blur cancels it exactly, so no temporal flicker
        float bayer(vec2 p){ ivec2 i = ivec2(mod(p, 4.0)); const float m[16] = float[16](0., 8., 2., 10., 12., 4., 14., 6., 3., 11., 1., 9., 15., 7., 13., 5.); return (m[i.x + i.y * 4] + 0.5) / 16.0; }
        void main(){
          float d = texture2D(tDepth, vUv).x;
          vec3 P = viewPos(vUv);
          float noise = bayer(gl_FragCoord.xy);
          // ---- screen-space ambient occlusion (normals reconstructed from depth)
          float ao = 1.0;
          #if AO_N > 0
          if (d < 1.0 && -P.z < 55.0) {
            vec3 N = normalize(cross(dFdx(P), dFdy(P)));
            float radius = 0.75, rUv = radius * uProj[1][1] * 0.5 / -P.z, occ = 0.0;
            for (int i = 0; i < AO_N; i++) {
              float a = (float(i) + noise) * 2.39996, r = sqrt((float(i) + 0.5) / float(AO_N)) * rUv;
              vec3 v = viewPos(vUv + vec2(cos(a) / uAspect, sin(a)) * r) - P;
              float l = length(v);
              occ += max(0.0, dot(N, v) / (l + 1e-4) - 0.12) * (1.0 - smoothstep(radius * 0.5, radius * 1.6, l));
            }
            ao = clamp(1.0 - occ / float(AO_N) * 2.1, 0.0, 1.0);
          }
          #endif
          // ---- volumetric sun shafts: march the view ray through the sun's shadow map
          float sc = 0.0;
          #if VOL_N > 0
          if (uHasShadow > 0.5) {
            vec3 wP = (uCamWorld * vec4(P, 1.0)).xyz, rv = wP - uCamPos;
            float dist = min(length(rv), 46.0);
            vec3 rd = normalize(rv);
            float stepL = dist / float(VOL_N), t = stepL * noise;
            for (int i = 0; i < VOL_N; i++) {
              vec3 p = uCamPos + rd * t;
              vec4 s = uShadowMat * vec4(p, 1.0);
              float lit = 0.25;
              if (s.x > 0.0 && s.x < 1.0 && s.y > 0.0 && s.y < 1.0 && s.z < 1.0) lit = texture(tShadow, vec3(s.xy, s.z - 0.0015));
              sc += lit * exp(-max(p.y, 0.0) * 0.045) * exp(-t * 0.035) * stepL;
              t += stepL;
            }
            float cosT = dot(rd, ${glsl(SUN)});
            sc *= 0.0040 * (0.6 + 2.2 * pow(max(cosT, 0.0), 4.0) + 0.5 * cosT * cosT);
            sc = sc / (1.0 + sc * 1.6);                                          // soft clip so clearings do not white out
          }
          #endif
          gl_FragColor = vec4(ao, sc, 0.0, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
  }

  setQuality(q: PostQuality) { this.halfMat.dispose(); this.halfMat = this.makeHalfMat(q); }

  setSize(w: number, h: number) {
    w = Math.max(2, Math.floor(w)); h = Math.max(2, Math.floor(h));
    if (w === this.width && h === this.height) return;
    this.width = w; this.height = h;
    for (const rt of [this.rtScene, this.rtHalf, this.rtComp, this.rtLDR]) rt?.dispose();
    const depth = new THREE.DepthTexture(w, h); depth.type = THREE.UnsignedIntType;
    this.rtScene = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthTexture: depth, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
    this.rtHalf = new THREE.WebGLRenderTarget(w >> 1, h >> 1, { type: THREE.HalfFloatType, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter, depthBuffer: false });
    this.rtComp = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
    this.rtLDR = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    this.bloom.setSize(w, h);
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, sun: THREE.DirectionalLight, time: number, dt: number) {
    const r = this.renderer, q = this.quad;
    r.setRenderTarget(this.rtScene); r.clear(); r.render(scene, camera);

    const hu = this.halfMat.uniforms;
    hu.tDepth.value = this.rtScene.depthTexture;
    hu.uProj.value.copy(camera.projectionMatrix); hu.uProjInv.value.copy(camera.projectionMatrixInverse); hu.uCamWorld.value.copy(camera.matrixWorld);
    hu.uCamPos.value.setFromMatrixPosition(camera.matrixWorld); hu.uAspect.value = this.width / this.height; hu.uFrame.value = (hu.uFrame.value + 1) % 8;
    const sm = sun.shadow.map as any;
    if (sm && sm.depthTexture) { hu.tShadow.value = sm.depthTexture; hu.uShadowMat.value.copy(sun.shadow.matrix); hu.uHasShadow.value = 1; } else hu.uHasShadow.value = 0;
    q.material = this.halfMat; r.setRenderTarget(this.rtHalf); q.render(r);

    const cu = this.compMat.uniforms;
    cu.tScene.value = this.rtScene.texture; cu.tHalf.value = this.rtHalf.texture; cu.tDepth.value = this.rtScene.depthTexture;
    cu.uHalfTexel.value.set(1 / this.rtHalf.width, 1 / this.rtHalf.height); cu.uNear.value = camera.near; cu.uFar.value = camera.far;
    q.material = this.compMat; r.setRenderTarget(this.rtComp); q.render(r);

    this.bloom.render(r, null as any, this.rtComp, dt, false);         // adds bloom into rtComp in place

    const gu = this.gradeMat.uniforms;
    gu.tDiffuse.value = this.rtComp.texture; gu.uTime.value = time; gu.uDamage.value = this.damage; gu.uLow.value = this.lowHealth; gu.uFlash.value = this.flash; gu.uFade.value = this.fade;
    q.material = this.gradeMat; r.setRenderTarget(this.rtLDR); q.render(r);

    this.fxaaMat.uniforms.tDiffuse.value = this.rtLDR.texture;
    this.fxaaMat.uniforms.resolution.value.set(1 / this.width, 1 / this.height);
    q.material = this.fxaaMat; r.setRenderTarget(null); q.render(r);
  }
}

function glsl(v: THREE.Vector3 | THREE.Color) { return 'vec3(' + (v as any).toArray().map((n: number) => n.toFixed(4)).join(',') + ')'; }
