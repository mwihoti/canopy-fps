// Assembles the jungle: terrain, creek water, sky, lighting, fog, vegetation
// and structures. Also owns the per-frame environment update (wind, shadow
// frustum following the player, undergrowth distance culling).
import * as THREE from 'three';
import { heightAt, SUN, WATER_Y } from './layout';
import { ColliderWorld } from './colliders';
import { makeTextures, TextureSet } from './textures';
import { buildFlora, windTime } from './flora';
import { buildStructures, Anchors } from './structures';

export const FOG_COLOR = new THREE.Color(0.30, 0.41, 0.36);
export const SUN_COLOR = new THREE.Color(1.0, 0.9, 0.7);
const v3 = (v: THREE.Vector3 | THREE.Color) => 'vec3(' + (v as any).toArray().map((n: number) => n.toFixed(4)).join(',') + ')';

/** Replace three.js' built-in fog with height-dependent, sun-tinted haze.
 *  Patching the shader chunks applies it to every standard material at once. */
export function installJungleFog() {
  const C = THREE.ShaderChunk as any;
  C.fog_pars_vertex = `#ifdef USE_FOG\n varying vec3 vFogW;\n#endif`;
  // row-vector * viewMatrix == inverse view rotation: camera-to-fragment offset in world space
  C.fog_vertex = `#ifdef USE_FOG\n vFogW = (vec4(mvPosition.xyz, 0.0) * viewMatrix).xyz;\n#endif`;
  C.fog_pars_fragment = `#ifdef USE_FOG\n uniform vec3 fogColor; uniform float fogDensity; varying vec3 vFogW;\n#endif`;
  C.fog_fragment = `#ifdef USE_FOG
    float fogDist = length(vFogW);
    vec3 fogDir = vFogW / max(fogDist, 1e-4);
    float fogH = cameraPosition.y + vFogW.y * 0.6;
    float fogD = fogDensity * (0.55 + 1.0 * exp(-max(fogH, 0.0) * 0.11));     // humidity pools near the ground
    float fogFactor = 1.0 - exp(-fogD * fogD * fogDist * fogDist);
    float fogSun = pow(max(dot(fogDir, ${v3(SUN)}), 0.0), 5.0);
    vec3 fogCol = mix(fogColor, ${v3(SUN_COLOR)} * 1.05, fogSun * 0.65);
    gl_FragColor.rgb = mix(gl_FragColor.rgb, fogCol, fogFactor);
  #endif`;
}

function makeSky(tex: TextureSet) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uNoise: { value: tex.noise }, uTime: windTime },
    vertexShader: `varying vec3 vDir;
      void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }`,
    fragmentShader: `varying vec3 vDir; uniform sampler2D uNoise; uniform float uTime;
      void main(){
        vec3 d = normalize(vDir);
        float h = max(d.y, 0.0);
        vec3 col = mix(${v3(FOG_COLOR)} * 2.6, vec3(0.20, 0.42, 0.85) * 1.5, pow(h, 0.6));
        vec2 cp = d.xz / (d.y + 0.3);
        float c = texture2D(uNoise, cp * 0.11 + uTime * 0.002).r * 0.65 + texture2D(uNoise, cp * 0.35 - uTime * 0.003).g * 0.35;
        c = smoothstep(0.48, 0.72, c) * smoothstep(0.0, 0.25, d.y);
        col = mix(col, vec3(2.1, 2.05, 1.95), c * 0.85);
        float sd = max(dot(d, ${v3(SUN)}), 0.0);
        col += ${v3(SUN_COLOR)} * (pow(sd, 1200.0) * 60.0 + pow(sd, 60.0) * 1.6 + pow(sd, 7.0) * 0.5);
        col = mix(col, ${v3(FOG_COLOR)} * 1.4, smoothstep(0.0, -0.25, d.y));     // murk below the horizon
        gl_FragColor = vec4(col, 1.0);
      }`,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(400, 24, 16), mat);
  m.frustumCulled = false; m.renderOrder = -10;
  return m;
}

function makeTerrain(tex: TextureSet, env: THREE.Texture) {
  const SIZE = 300, SEG = 190;
  const g = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i)));
  g.computeVertexNormals();
  const bump = tex.groundBump; bump.repeat.set(110, 110);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0, bumpMap: bump, bumpScale: 4, envMap: env, envMapIntensity: 0.5 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNoise = { value: tex.noise };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; uniform sampler2D uNoise; float gPuddle;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec2 gp = vWPos.xz;
        float n1 = texture2D(uNoise, gp * 0.011).r, n2 = texture2D(uNoise, gp * 0.07).g, n3 = texture2D(uNoise, gp * 0.55).b, n4 = texture2D(uNoise, gp * 0.035).a;
        vec3 mud = mix(vec3(0.07, 0.045, 0.028), vec3(0.14, 0.095, 0.06), n3);
        vec3 litter = mix(vec3(0.085, 0.06, 0.028), vec3(0.20, 0.15, 0.06), n3 * 0.6 + n2 * 0.4);
        vec3 moss = mix(vec3(0.045, 0.11, 0.025), vec3(0.13, 0.24, 0.05), n3);
        float mossMask = smoothstep(0.42, 0.6, n1 * 0.55 + n2 * 0.5);
        float mudMask = smoothstep(0.50, 0.62, n4 * 0.75 + (1.0 - n1) * 0.3);
        vec3 gcol = mix(litter, moss, mossMask);
        gcol = mix(gcol, mud, mudMask);
        float wet = 1.0 - smoothstep(${(WATER_Y + 0.05).toFixed(2)}, ${(WATER_Y + 1.5).toFixed(2)}, vWPos.y);
        gcol = mix(gcol, mud * 0.55, wet);
        float flatness = smoothstep(0.965, 0.995, dot(normalize(vNormal), normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz)));
        gPuddle = smoothstep(0.665, 0.70, n4 * 0.8 + n2 * 0.25) * flatness * mudMask;
        gcol = mix(gcol, vec3(0.05, 0.05, 0.04), gPuddle * 0.85);
        float steep = 1.0 - smoothstep(0.62, 0.86, dot(normalize(vNormal), normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz)));
        gcol = mix(gcol, mix(vec3(0.10, 0.095, 0.08), vec3(0.24, 0.23, 0.19), n3 * 0.6 + n2 * 0.4) * mix(vec3(1.0), vec3(0.5, 0.9, 0.35), mossMask * 0.7), steep);   // bare rock on cliffs
        diffuseColor.rgb = gcol;`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
        #if defined( USE_ENVMAP ) && defined( RE_IndirectDiffuse )
          iblIrradiance = vec3(0.0);       // environment map is for puddle reflections only; ambient comes from the hemisphere light
        #endif`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = mix(mix(0.95, 0.55, max(wet, mudMask * 0.5)), 0.04, gPuddle);`)
      .replace('#include <metalnessmap_fragment>', `float metalnessFactor = gPuddle * 0.85;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        normal = normalize(mix(normal, upV, gPuddle));`);
  };
  const mesh = new THREE.Mesh(g, mat);
  mesh.receiveShadow = true; mesh.castShadow = true;
  return mesh;
}

function makeWater(tex: TextureSet, env: THREE.Texture) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x0b1a14, roughness: 0.06, metalness: 0.75, envMap: env, envMapIntensity: 0.7, transparent: true, opacity: 0.86, depthWrite: false });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNoise = { value: tex.noise }; sh.uniforms.uTime = windTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; uniform sampler2D uNoise; uniform float uTime;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        vec2 wp = vWPos.xz * 0.12;
        vec2 rip = vec2(texture2D(uNoise, wp + vec2(uTime * 0.035, uTime * 0.012)).r - texture2D(uNoise, wp * 1.7 - vec2(uTime * 0.02, -uTime * 0.03)).g,
                        texture2D(uNoise, wp * 1.3 + vec2(-uTime * 0.025, uTime * 0.03)).b - texture2D(uNoise, wp * 2.1 + vec2(uTime * 0.03, uTime * 0.02)).a);
        normal = normalize((viewMatrix * vec4(normalize(vec3(rip.x * 0.55, 1.0, rip.y * 0.55)), 0.0)).xyz);`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
        #if defined( USE_ENVMAP ) && defined( RE_IndirectDiffuse )
          iblIrradiance = vec3(0.0);
        #endif`);
  };
  const g = new THREE.PlaneGeometry(300, 300, 1, 1); g.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(g, mat); mesh.position.y = WATER_Y; mesh.receiveShadow = true; mesh.renderOrder = 2;
  return mesh;
}

/** Drifting pollen / dust motes that wrap around the camera (pure vertex shader). */
function makeMotes() {
  const N = 700, pos = new Float32Array(N * 3), seed = new Float32Array(N);
  for (let i = 0; i < N; i++) { pos[i * 3] = Math.random() * 40; pos[i * 3 + 1] = Math.random() * 14; pos[i * 3 + 2] = Math.random() * 40; seed[i] = Math.random(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: windTime, uCam: { value: new THREE.Vector3() }, uScale: { value: 500 } },
    vertexShader: `attribute float aSeed; uniform float uTime; uniform vec3 uCam; uniform float uScale; varying float vA;
      void main(){
        vec3 p = position + vec3(sin(uTime * 0.3 + aSeed * 40.0) * 0.6 + uTime * 0.25, sin(uTime * 0.21 + aSeed * 17.0) * 0.5 - uTime * 0.04, cos(uTime * 0.27 + aSeed * 29.0) * 0.6);
        p.xz = mod(p.xz - uCam.xz + 20.0, 40.0) - 20.0 + uCam.xz;
        p.y = mod(p.y, 14.0) + uCam.y - 5.0;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = -mv.z;
        gl_PointSize = (0.02 + aSeed * 0.035) * uScale / max(d, 0.3);
        vA = smoothstep(20.0, 12.0, d) * smoothstep(0.4, 1.5, d) * (0.5 + 0.5 * sin(uTime * (1.0 + aSeed * 2.0) + aSeed * 60.0));
      }`,
    fragmentShader: `varying float vA;
      void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.1, d) * vA; gl_FragColor = vec4(vec3(1.0, 0.93, 0.6) * a * 0.9, 0.0); }`,
    transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, fog: false,
  });
  const pts = new THREE.Points(g, mat); pts.frustumCulled = false; pts.renderOrder = 5;
  return pts;
}

export class World {
  colliders = new ColliderWorld();
  tex: TextureSet;
  env: THREE.Texture;
  anchors: Anchors;
  sun: THREE.DirectionalLight;
  private sky: THREE.Mesh;
  private motes: THREE.Points;
  private distCulled: THREE.InstancedMesh[] = [];
  private lightRight = new THREE.Vector3(); private lightUp = new THREE.Vector3();
  private shadowHalf = 46;
  private tmp = new THREE.Vector3();

  constructor(public scene: THREE.Scene, renderer: THREE.WebGLRenderer, density: number) {
    this.tex = makeTextures();
    scene.fog = new THREE.FogExp2(FOG_COLOR, 0.0115);

    // --- sky + environment map for puddle / water / metal reflections
    this.sky = makeSky(this.tex);
    const envScene = new THREE.Scene(); envScene.add(this.sky);
    const pm = new THREE.PMREMGenerator(renderer);
    this.env = pm.fromScene(envScene, 0.02).texture; pm.dispose();
    scene.add(this.sky);

    // --- lighting: one shadow-casting sun, sky/ground hemisphere fill
    this.sun = new THREE.DirectionalLight(SUN_COLOR, 7.5);
    this.sun.castShadow = true;
    const sh = this.sun.shadow, S = this.shadowHalf;
    sh.mapSize.set(2048, 2048); sh.camera.left = -S; sh.camera.right = S; sh.camera.top = S; sh.camera.bottom = -S;
    sh.camera.near = 1; sh.camera.far = 230; sh.bias = -0.0005; sh.normalBias = 0.06; sh.radius = 1.3;
    scene.add(this.sun, this.sun.target);
    scene.add(new THREE.HemisphereLight(new THREE.Color(0.50, 0.72, 0.62), new THREE.Color(0.20, 0.19, 0.10), 1.7));
    this.lightRight.crossVectors(new THREE.Vector3(0, 1, 0), SUN).normalize();
    this.lightUp.crossVectors(SUN, this.lightRight).normalize();

    scene.add(makeTerrain(this.tex, this.env), makeWater(this.tex, this.env));
    this.anchors = buildStructures(scene, this.tex, this.colliders);
    this.distCulled = buildFlora(scene, this.tex, this.colliders, density).distCulled;
    for (const l of this.anchors.lamps) {
      const pl = new THREE.PointLight(l.color, l.intensity, l.dist, 1.6); pl.position.copy(l.pos); scene.add(pl);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(l.color).multiplyScalar(6) }));
      bulb.position.copy(l.pos); scene.add(bulb);
    }
    this.motes = makeMotes(); scene.add(this.motes);
  }

  /** 0..1 multiplier on undergrowth draw distance (graphics quality). */
  detail = 1;
  shadowEvery = 2; private frame = 0;

  setShadowQuality(size: number) {
    const sh = this.sun.shadow;
    if (sh.mapSize.x === size) return;
    sh.mapSize.set(size, size);
    if (sh.map) { sh.map.dispose(); (sh as any).map = null; }
    this.frame = 0;
  }

  update(time: number, cam: THREE.PerspectiveCamera, pixelH: number) {
    windTime.value = time;
    this.sky.position.copy(cam.position);
    (this.motes.material as THREE.ShaderMaterial).uniforms.uCam.value.copy(cam.position);
    (this.motes.material as THREE.ShaderMaterial).uniforms.uScale.value = pixelH * 0.5 / Math.tan((cam.fov * Math.PI) / 360);

    // Shadow frustum follows the player, snapped to shadow texels to avoid shimmering.
    // The world is static, so the shadow map is only re-rendered every other frame.
    this.sun.shadow.autoUpdate = false;
    if (this.frame++ % this.shadowEvery === 0) {
    this.sun.shadow.needsUpdate = true;
    const texel = (this.shadowHalf * 2) / this.sun.shadow.mapSize.x;
    const c = this.tmp.copy(cam.position);
    const r = Math.round(c.dot(this.lightRight) / texel) * texel, u = Math.round(c.dot(this.lightUp) / texel) * texel, f = c.dot(SUN);
    c.set(0, 0, 0).addScaledVector(this.lightRight, r).addScaledVector(this.lightUp, u).addScaledVector(SUN, f);
    this.sun.target.position.copy(c);
    this.sun.position.copy(c).addScaledVector(SUN, 110);
    this.sun.target.updateMatrixWorld(); this.sun.updateMatrixWorld();
    }

    // Undergrowth chunks beyond their fade distance are hidden (fog covers the pop).
    for (const m of this.distCulled) {
      const bs = m.boundingSphere!;
      m.visible = Math.hypot(bs.center.x - cam.position.x, bs.center.z - cam.position.z) < m.userData.maxDist * this.detail + bs.radius;
    }
    for (const b of this.anchors.blinkers) b.visible = time % 1.4 < 0.25;
  }
}
