// CPU-simulated particle pool drawn as one THREE.Points call.
// Premultiplied-alpha blending lets additive sparks and opaque smoke share it.
import * as THREE from 'three';

const MAX = 4096;

export class Particles {
  points: THREE.Points;
  private pos = new Float32Array(MAX * 3); private col = new Float32Array(MAX * 4); private size = new Float32Array(MAX);
  private vel = new Float32Array(MAX * 3);
  private life = new Float32Array(MAX); private maxLife = new Float32Array(MAX);
  private base = new Float32Array(MAX * 4);     // r,g,b,solidity
  private phys = new Float32Array(MAX * 4);     // gravity, drag, size0, growth
  private head = 0;
  private mat: THREE.ShaderMaterial;

  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 500 } },
      vertexShader: `attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vColor;
        void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = aSize * uScale / max(0.2, -mv.z); vColor = aColor; }`,
      fragmentShader: `varying vec4 vColor;
        void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = smoothstep(1.0, 0.0, d); a *= a;
          gl_FragColor = vec4(vColor.rgb * a, vColor.a * a); }`,
      transparent: true, depthWrite: false, fog: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false; this.points.renderOrder = 6;
  }

  /** solid = 0 -> additive glow, 1 -> opaque puff (colour then acts as albedo). */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number,
       r: number, g: number, b: number, solid = 0, gravity = 0, drag = 0, grow = 0) {
    const i = this.head; this.head = (this.head + 1) % MAX;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = this.maxLife[i] = life;
    this.base[i * 4] = r; this.base[i * 4 + 1] = g; this.base[i * 4 + 2] = b; this.base[i * 4 + 3] = solid;
    this.phys[i * 4] = gravity; this.phys[i * 4 + 1] = drag; this.phys[i * 4 + 2] = size; this.phys[i * 4 + 3] = grow;
  }

  update(dt: number, pixelH: number, fov: number) {
    this.mat.uniforms.uScale.value = pixelH * 0.5 / Math.tan((fov * Math.PI) / 360);
    const { pos, vel, life, maxLife, base, phys, col, size } = this;
    for (let i = 0; i < MAX; i++) {
      if (life[i] <= 0) { if (size[i] !== 0) { size[i] = 0; col[i * 4 + 3] = 0; col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = 0; } continue; }
      life[i] -= dt;
      const k = Math.max(0, 1 - phys[i * 4 + 1] * dt);
      vel[i * 3] *= k; vel[i * 3 + 1] = vel[i * 3 + 1] * k - phys[i * 4] * dt; vel[i * 3 + 2] *= k;
      pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
      const t = Math.max(0, life[i] / maxLife[i]), age = 1 - t;
      const fade = Math.min(1, t * 2.2) * Math.min(1, age * 12 + 0.25), solid = base[i * 4 + 3];
      const m = solid > 0 ? fade * solid : fade;
      col[i * 4] = base[i * 4] * m; col[i * 4 + 1] = base[i * 4 + 1] * m; col[i * 4 + 2] = base[i * 4 + 2] * m; col[i * 4 + 3] = solid * fade;
      size[i] = phys[i * 4 + 2] * (1 + phys[i * 4 + 3] * age);
    }
    const g = this.points.geometry;
    (g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (g.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
  }

  // ------------------------------------------------------------ canned effects
  /** Bullet impact: hot sparks plus a puff of debris tinted by the surface. */
  impact(p: THREE.Vector3, n: THREE.Vector3, r: number, g: number, b: number, sparks = true) {
    for (let i = 0; i < 6; i++) this.emit(p.x, p.y, p.z, n.x * 1.5 + rnd() * 2.2, n.y * 1.5 + rnd() * 2.2 + 1, n.z * 1.5 + rnd() * 2.2, 0.5 + Math.random() * 0.5, 0.16 + Math.random() * 0.2, r, g, b, 0.75, 5, 2.5, 2.5);
    if (sparks) for (let i = 0; i < 7; i++) this.emit(p.x, p.y, p.z, n.x * 4 + rnd() * 5, n.y * 4 + rnd() * 5 + 1.5, n.z * 4 + rnd() * 5, 0.12 + Math.random() * 0.25, 0.05, 6, 3.5, 1.2, 0, 12, 1);
  }
  splash(p: THREE.Vector3) {
    for (let i = 0; i < 10; i++) this.emit(p.x, p.y, p.z, rnd() * 1.6, 2 + Math.random() * 2.5, rnd() * 1.6, 0.5, 0.09, 0.5, 0.6, 0.6, 0.5, 10, 0.5);
  }
  /** Coloured gore burst (creature ichor). */
  goo(p: THREE.Vector3, r: number, g: number, b: number, count = 10, speed = 4) {
    for (let i = 0; i < count; i++) this.emit(p.x, p.y, p.z, rnd() * speed, rnd() * speed + 1.5, rnd() * speed, 0.35 + Math.random() * 0.5, 0.08 + Math.random() * 0.12, r, g, b, 0, 11, 1.2);
  }
  explosion(p: THREE.Vector3, s = 1, r = 8, g = 4, b = 1.2) {
    this.emit(p.x, p.y, p.z, 0, 0, 0, 0.14, 3.2 * s, r, g, b * 1.3, 0, 0, 0, 1.2);                                   // flash
    for (let i = 0; i < 26; i++) this.emit(p.x, p.y, p.z, rnd() * 5 * s, rnd() * 5 * s + 1.5, rnd() * 5 * s, 0.3 + Math.random() * 0.45, (0.7 + Math.random()) * s, r, g, b, 0, -1, 3, 1.4);
    for (let i = 0; i < 34; i++) this.emit(p.x, p.y, p.z, rnd() * 16 * s, rnd() * 16 * s + 4, rnd() * 16 * s, 0.4 + Math.random() * 0.9, 0.07, 7, 4, 1.4, 0, 14, 0.8);
    for (let i = 0; i < 16; i++) this.emit(p.x + rnd() * s, p.y + rnd() * s * 0.5, p.z + rnd() * s, rnd() * 1.8, 0.8 + Math.random() * 1.6, rnd() * 1.8, 1.6 + Math.random() * 1.6, (1.1 + Math.random()) * s, 0.05, 0.05, 0.05, 0.6, -0.5, 0.9, 1.8);
  }
  smoke(p: THREE.Vector3, s = 1, dark = 0.035) {
    this.emit(p.x + rnd() * 0.2, p.y, p.z + rnd() * 0.2, rnd() * 0.3, 0.9 + Math.random() * 0.8, rnd() * 0.3, 2.4 + Math.random() * 1.6, 0.7 * s, dark, dark, dark, 0.85, -0.25, 0.4, 2.6);
  }
}
const rnd = () => Math.random() * 2 - 1;
