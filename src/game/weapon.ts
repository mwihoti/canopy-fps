// The carbine: procedural view-model, hitscan firing, recoil, muzzle flash,
// tracers, reload and aim-down-sights.
import * as THREE from 'three';
import { damp, lerp, clamp } from '../core/math';
import type { Input } from '../core/input';
import type { Game } from './game';

const MAG = 30, FIRE_INTERVAL = 0.098, RELOAD_TIME = 1.9, DAMAGE = 14;
const HIP = new THREE.Vector3(0.15, -0.16, -0.27), ADS = new THREE.Vector3(0, -0.0865 * 0.85, -0.17), MUZZLE = new THREE.Vector3(0, 0, -0.74);

export class Weapon {
  group = new THREE.Group();
  mag = MAG; reserve = 120;
  reloading = 0; private reloadStage = 0;
  private fireT = 0; private kick = 0; heat = 0;
  private swayX = 0; private swayY = 0; private sprintBlend = 0;
  private magMesh!: THREE.Mesh; private flash: THREE.Mesh[] = []; private flashLight: THREE.PointLight; private flashT = 0;
  private tracers: THREE.LineSegments; private tracerLife = new Float32Array(12); private tracerNext = 0;
  private dryLatch = false;
  shots = 0;

  constructor(camera: THREE.Camera, scene: THREE.Scene, env: THREE.Texture, glow: THREE.Texture) {
    const metal = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.48, metalness: 0.6, envMap: env, envMapIntensity: 0.35 });
    const poly = new THREE.MeshStandardMaterial({ color: 0x1c1f22, roughness: 0.7, metalness: 0.1 });
    const tan = new THREE.MeshStandardMaterial({ color: 0x3a3d2e, roughness: 0.7 });
    const glove = new THREE.MeshStandardMaterial({ color: 0x1b1f1a, roughness: 0.9 });
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x34422a, roughness: 0.95 });
    const g = this.group;
    const box = (m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, rz = 0) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); mesh.position.set(x, y, z); mesh.rotation.set(rx, 0, rz); mesh.receiveShadow = true; g.add(mesh); return mesh;
    };
    const cyl = (m: THREE.Material, r: number, len: number, x: number, y: number, z: number, r2 = r) => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, len, 10), m); mesh.rotation.x = Math.PI / 2; mesh.position.set(x, y, z); mesh.receiveShadow = true; g.add(mesh); return mesh;
    };
    box(metal, 0.056, 0.085, 0.36, 0, 0, -0.04);                 // receiver
    box(metal, 0.03, 0.014, 0.34, 0, 0.049, -0.1);               // top rail
    box(tan, 0.062, 0.07, 0.27, 0, -0.004, -0.35);               // handguard
    for (let i = 0; i < 4; i++) box(poly, 0.064, 0.018, 0.028, 0, 0.012, -0.25 - i * 0.06);   // vents
    cyl(metal, 0.012, 0.26, 0, 0.004, -0.58);                    // barrel
    cyl(metal, 0.02, 0.07, 0, 0.004, -0.705, 0.017);             // muzzle brake
    box(poly, 0.044, 0.1, 0.05, 0, -0.085, 0.1, 0.32);           // grip
    box(tan, 0.05, 0.075, 0.24, 0, -0.012, 0.25);                // stock
    box(poly, 0.054, 0.11, 0.035, 0, -0.03, 0.375);              // butt pad
    box(metal, 0.02, 0.03, 0.05, 0, -0.05, 0.04);                // trigger guard
    this.magMesh = box(poly, 0.04, 0.17, 0.065, 0, -0.115, -0.03, -0.16);
    // red-dot optic
    box(metal, 0.044, 0.012, 0.07, 0, 0.06, 0.0);
    box(metal, 0.004, 0.04, 0.05, -0.02, 0.083, 0.0); box(metal, 0.004, 0.04, 0.05, 0.02, 0.083, 0.0); box(metal, 0.044, 0.004, 0.05, 0, 0.104, 0.0);
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0022, 6, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(8, 0.6, 0.3) })); dot.position.set(0, 0.0865, 0.0); g.add(dot);
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.036, 0.036), new THREE.MeshBasicMaterial({ color: 0x66ffee, transparent: true, opacity: 0.035, depthWrite: false })); lens.position.set(0, 0.084, -0.02); g.add(lens);
    box(metal, 0.006, 0.03, 0.006, 0, 0.066, -0.46);             // front post
    // hands + forearms (just enough to sell the pose)
    box(glove, 0.072, 0.05, 0.1, -0.008, -0.055, -0.33, 0, 0.15);
    box(glove, 0.058, 0.09, 0.07, 0.004, -0.088, 0.105, 0.32);
    const ra = box(sleeve, 0.085, 0.085, 0.42, 0.045, -0.2, 0.32); ra.rotation.set(0.55, 0.2, 0);

    // muzzle flash: crossed additive quads + a short-lived point light
    const fm = new THREE.MeshBasicMaterial({ map: glow, color: new THREE.Color(3.2, 2.3, 1.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
    for (let i = 0; i < 3; i++) {
      const q = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.26), fm); q.position.copy(MUZZLE); q.position.z -= 0.04;
      if (i === 1) q.rotation.y = Math.PI / 2; if (i === 2) { q.rotation.x = Math.PI / 2; }
      q.visible = false; q.renderOrder = 8; g.add(q); this.flash.push(q);
    }
    this.flashLight = new THREE.PointLight(0xffb060, 0, 14, 1.8); this.flashLight.position.set(0.15, 0, -0.9); g.add(this.flashLight);
    g.position.copy(HIP); g.scale.set(0.85, 0.85, 0.55);      // squash depth: mimics the narrow view-model FOV of shooters
    camera.add(g);

    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12 * 6), 3)); tg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(12 * 6), 3));
    this.tracers = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.tracers.frustumCulled = false; this.tracers.renderOrder = 7; scene.add(this.tracers);
  }

  reset() { this.mag = MAG; this.reserve = 120; this.reloading = 0; this.heat = 0; this.fireT = 0; this.shots = 0; }

  /** Current cone half-angle (radians). */
  spread(g: Game) {
    const p = g.player;
    return lerp(0.011, 0.0015, p.ads) + (p.moveSpeed / 7) * lerp(0.016, 0.005, p.ads) + (p.onGround ? 0 : 0.03) + this.heat * lerp(0.016, 0.006, p.ads) - p.crouch * 0.003;
  }

  update(dt: number, input: Input, g: Game, cam: THREE.PerspectiveCamera) {
    const p = g.player;
    this.fireT -= dt; this.heat = Math.max(0, this.heat - dt * 1.8);
    const canAct = !p.dead;
    // ---- aim down sights
    const wantAds = canAct && input.rmb && this.reloading <= 0 && !p.sprinting;
    p.ads = damp(p.ads, wantAds ? 1 : 0, 14, dt);
    cam.fov = damp(cam.fov, lerp(74, 50, p.ads) + (p.sprinting ? 5 : 0), 10, dt); cam.updateProjectionMatrix();

    // ---- reload
    if (canAct && this.reloading <= 0 && this.reserve > 0 && this.mag < MAG && (input.hit('KeyR') || (this.mag === 0 && this.fireT <= -0.25))) { this.reloading = RELOAD_TIME; this.reloadStage = 0; }
    if (this.reloading > 0) {
      this.reloading -= dt;
      const t = 1 - this.reloading / RELOAD_TIME;
      if (this.reloadStage === 0 && t > 0.14) { g.audio.reload(0); this.reloadStage = 1; }
      if (this.reloadStage === 1 && t > 0.58) { g.audio.reload(1); this.reloadStage = 2; const n = Math.min(MAG - this.mag, this.reserve); this.mag += n; this.reserve -= n; }
      if (this.reloadStage === 2 && t > 0.84) { g.audio.reload(2); this.reloadStage = 3; }
    }

    // ---- fire
    // on touch screens the carbine also fires by itself while the sights rest on a hostile
    const trigger = input.lmb || (input.touch && this.mag > 0 && g.targetInSights());
    if (!trigger) this.dryLatch = false;
    if (canAct && trigger && this.reloading <= 0 && this.fireT <= 0 && this.sprintBlend < 0.5) {
      if (this.mag > 0) this.shoot(g, cam);
      else if (!this.dryLatch) { g.audio.dryFire(); this.dryLatch = true; this.fireT = 0.2; }
    }

    // ---- view-model animation
    this.swayX = damp(this.swayX, clamp(-input.mouseDX * 0.0006, -0.04, 0.04), 8, dt);
    this.swayY = damp(this.swayY, clamp(input.mouseDY * 0.0006, -0.04, 0.04), 8, dt);
    this.kick = damp(this.kick, 0, 16, dt);
    this.sprintBlend = damp(this.sprintBlend, p.sprinting && this.reloading <= 0 ? 1 : 0, 9, dt);
    const bob = p.bobAmt * (1 - p.ads * 0.85), ph = p.bobPhase;
    const gp = this.group.position.lerpVectors(HIP, ADS, p.ads);
    gp.x += this.swayX + Math.cos(ph) * 0.007 * bob + this.sprintBlend * -0.04;
    gp.y += this.swayY + Math.abs(Math.sin(ph)) * -0.008 * bob - this.sprintBlend * 0.06 - (p.onGround ? 0 : 0.012) + p.vel.y * -0.0015;
    gp.z += this.kick * 0.055;
    let rx = this.kick * 0.07 - this.swayY * 1.2 - this.sprintBlend * 0.28, ry = -this.swayX * 1.6 + this.sprintBlend * 0.75, rz = -this.swayX * 1.2 + Math.cos(ph) * 0.012 * bob;
    let magDrop = 0;
    if (this.reloading > 0) {
      const t = 1 - this.reloading / RELOAD_TIME, e = Math.sin(Math.min(1, t * 1.15) * Math.PI);
      gp.y -= e * 0.09; gp.x += e * 0.03; rx += e * 0.55; rz += e * 0.6;
      magDrop = t < 0.14 ? 0 : t < 0.36 ? (t - 0.14) / 0.22 : t < 0.46 ? 1 : t < 0.58 ? 1 - (t - 0.46) / 0.12 : 0;
    }
    this.group.rotation.set(rx, ry, rz);
    this.magMesh.position.y = -0.115 - magDrop * 0.3; this.magMesh.visible = magDrop < 0.98;

    // ---- muzzle flash & tracers
    this.flashT -= dt;
    const on = this.flashT > 0;
    for (const f of this.flash) f.visible = on;
    this.flashLight.intensity = on ? 3.5 : 0;
    const col = this.tracers.geometry.attributes.color as THREE.BufferAttribute;
    for (let i = 0; i < 12; i++) {
      if (this.tracerLife[i] <= 0) continue;
      this.tracerLife[i] -= dt;
      const k = Math.max(0, this.tracerLife[i] / 0.07);
      col.setXYZ(i * 2, 2.5 * k, 1.9 * k, 0.9 * k); col.setXYZ(i * 2 + 1, 0.6 * k, 0.4 * k, 0.15 * k);
    }
    col.needsUpdate = true;
  }

  private shoot(g: Game, cam: THREE.PerspectiveCamera) {
    const p = g.player;
    this.mag--; this.fireT = FIRE_INTERVAL; this.shots++;
    // random direction inside the spread cone around the view direction
    const s = this.spread(g), a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * s;
    const dir = new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, -1).normalize().applyQuaternion(cam.quaternion);
    const origin = cam.getWorldPosition(new THREE.Vector3());
    const end = g.hitscan(origin, dir, DAMAGE);

    // tracer from the muzzle to the impact
    const mz = this.group.localToWorld(MUZZLE.clone());
    const i = this.tracerNext; this.tracerNext = (i + 1) % 12; this.tracerLife[i] = 0.07;
    const pos = this.tracers.geometry.attributes.position as THREE.BufferAttribute;
    const start = mz.clone().lerp(end, Math.min(0.5, 2.5 / Math.max(1, mz.distanceTo(end))));
    pos.setXYZ(i * 2, end.x, end.y, end.z); pos.setXYZ(i * 2 + 1, start.x, start.y, start.z); pos.needsUpdate = true;

    // feedback
    this.heat = Math.min(1, this.heat + 0.13); this.kick = 1;
    p.recoilPitch += lerp(0.021, 0.012, p.ads) * (0.8 + Math.random() * 0.4) * (1 - p.crouch * 0.25);
    p.recoilYaw += (Math.random() - 0.5) * lerp(0.02, 0.009, p.ads);
    p.shake = Math.max(p.shake, 0.28);
    this.flashT = 0.045;
    for (const f of this.flash) { f.rotation.z = Math.random() * 6.28; const sc = 0.7 + Math.random() * 0.7; f.scale.set(sc, sc, sc); }
    g.particles.emit(mz.x, mz.y, mz.z, dir.x * 1.5, dir.y * 1.5 + 0.4, dir.z * 1.5, 0.5, 0.12, 0.25, 0.25, 0.25, 0.25, -0.4, 2, 3);
    g.audio.gunshot();
    g.onGunshot(origin);
  }
}
