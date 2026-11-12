// Two enemy archetypes, both modelled procedurally:
//   Drone   – hovering machine: patrols, orbits the player and fires plasma bolts.
//   Stalker – six-legged jungle predator: wanders, charges and lunges in melee.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, damp, raySphere } from '../core/math';
import { heightAt, WORLD_R } from '../world/layout';
import type { Game } from './game';

type RGB = [number, number, number];
/** Merge primitive parts into one vertex-coloured geometry (1 draw call per model). */
export function mergeParts(parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4; c: RGB }[]): THREE.BufferGeometry {
  const list = parts.map(({ g, m, c }) => {
    const n = g.index ? g.toNonIndexed() : g.clone();
    n.deleteAttribute('uv'); if (m) n.applyMatrix4(m);
    const col = new Float32Array(n.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) { col[i] = c[0]; col[i + 1] = c[1]; col[i + 2] = c[2]; }
    n.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return n;
  });
  return mergeGeometries(list)!;
}
const M = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
/** Tapered limb segment between two points. */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number): { g: THREE.BufferGeometry; m: THREE.Matrix4 } {
  const d = b.clone().sub(a), len = d.length();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  return { g: new THREE.CylinderGeometry(r1, r0, len, 6), m: new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1)) };
}

export abstract class Enemy {
  group = new THREE.Group();
  pos = this.group.position; vel = new THREE.Vector3();
  hp = 1; dead = false; remove = false; aggro = false;
  abstract kind: 'drone' | 'stalker';
  abstract radius: number;
  protected flashT = 0; protected glowMat!: THREE.MeshBasicMaterial; protected glowBase = new THREE.Color();
  protected losT = Math.random() * 0.3; protected hasLos = false;

  abstract update(dt: number, g: Game): void;
  /** Ray test: returns distance and whether it was a critical (head / eye) hit. */
  abstract rayHit(o: THREE.Vector3, d: THREE.Vector3): { t: number; crit: boolean } | null;
  abstract die(g: Game): void;
  abstract center(out: THREE.Vector3): THREE.Vector3;

  damage(n: number, g: Game) {
    if (this.dead) return false;
    this.hp -= n; this.flashT = 0.09;
    if (!this.aggro) this.alert(g);
    if (this.hp <= 0) { this.dead = true; this.die(g); return true; }
    return false;
  }
  alert(_g: Game) { this.aggro = true; }
  protected updateFlash(dt: number) {
    if (this.flashT > 0) { this.flashT -= dt; this.glowMat.color.setRGB(9, 9, 9); } else this.glowMat.color.copy(this.glowBase);
  }
  protected checkLos(dt: number, g: Game, eyeY: number) {
    this.losT -= dt;
    if (this.losT <= 0) { this.losT = 0.28 + Math.random() * 0.1; const e = g.player.eye; this.hasLos = g.world.colliders.los(this.pos.x, this.pos.y + eyeY, this.pos.z, e.x, e.y - 0.15, e.z); }
    return this.hasLos;
  }
}

// ================================================================ Drone
let droneBody: THREE.BufferGeometry, droneGlow: THREE.BufferGeometry, droneRotor: THREE.BufferGeometry;
let droneMat: THREE.MeshStandardMaterial, rotorMat: THREE.MeshBasicMaterial;
function buildDroneAssets(env: THREE.Texture) {
  const dark: RGB = [0.15, 0.16, 0.18], mid: RGB = [0.28, 0.29, 0.31], warn: RGB = [0.75, 0.42, 0.05];
  const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4; c: RGB }[] = [
    { g: new THREE.SphereGeometry(0.42, 16, 10), m: M(0, 0, 0, 0, 0, 0, 1, 0.6, 1.15), c: dark },
    { g: new THREE.SphereGeometry(0.26, 12, 8), m: M(0, 0.17, -0.05, 0, 0, 0, 1, 0.55, 1), c: mid },
    { g: new THREE.CylinderGeometry(0.2, 0.24, 0.12, 12), m: M(0, 0, 0.44, Math.PI / 2), c: [0.06, 0.06, 0.07] },
    { g: new THREE.CylinderGeometry(0.035, 0.045, 0.5, 8), m: M(0, -0.2, 0.32, Math.PI / 2), c: mid },
    { g: new THREE.BoxGeometry(0.16, 0.1, 0.3), m: M(0, -0.2, 0.1), c: warn },
    { g: new THREE.CylinderGeometry(0.008, 0.008, 0.45, 4), m: M(-0.15, 0.4, -0.2, 0.2), c: mid },
  ];
  const rot: THREE.BufferGeometry[] = [];
  for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    parts.push({ g: new THREE.BoxGeometry(0.07, 0.05, 0.62), m: M(sx * 0.36, 0.03, sz * 0.36, 0, sx * sz * Math.PI / 4), c: mid });
    parts.push({ g: new THREE.CylinderGeometry(0.085, 0.07, 0.14, 8), m: M(sx * 0.58, 0.05, sz * 0.58), c: dark });
    parts.push({ g: new THREE.TorusGeometry(0.31, 0.018, 5, 18), m: M(sx * 0.58, 0.13, sz * 0.58, Math.PI / 2), c: warn });
    rot.push(new THREE.CircleGeometry(0.3, 14).applyMatrix4(M(sx * 0.58, 0.13, sz * 0.58, -Math.PI / 2)));
  }
  droneBody = mergeParts(parts);
  droneGlow = mergeParts([
    { g: new THREE.SphereGeometry(0.13, 12, 8), m: M(0, 0, 0.47), c: [1, 1, 1] },
    { g: new THREE.BoxGeometry(0.03, 0.03, 0.4), m: M(0.36, 0.06, 0), c: [1, 1, 1] }, { g: new THREE.BoxGeometry(0.03, 0.03, 0.4), m: M(-0.36, 0.06, 0), c: [1, 1, 1] },
  ]);
  droneRotor = mergeGeometries(rot)!;
  droneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.7, envMap: env, envMapIntensity: 0.4 });
  rotorMat = new THREE.MeshBasicMaterial({ color: 0x9aa4a8, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
}

export class Drone extends Enemy {
  kind = 'drone' as const; radius = 0.8;
  private home = new THREE.Vector3(); private orbit = Math.random() * 6.28; private orbitDir = Math.random() < 0.5 ? -1 : 1; private ring = 9 + Math.random() * 6;
  private patrolR = 7 + Math.random() * 8; private fireT = 1 + Math.random() * 2; private charge = -1; private phase = Math.random() * 10;
  private hum: (p: any) => void; private burstLeft = 0;
  private target = new THREE.Vector3(); private tmp = new THREE.Vector3();

  constructor(g: Game, x: number, z: number) {
    super();
    if (!droneBody) buildDroneAssets(g.world.env);
    this.hp = 45;
    this.glowBase.setRGB(5, 0.35, 0.15); this.glowMat = new THREE.MeshBasicMaterial({ color: this.glowBase.clone(), vertexColors: true });
    const body = new THREE.Mesh(droneBody, droneMat); body.castShadow = true;
    this.group.add(body, new THREE.Mesh(droneGlow, this.glowMat), new THREE.Mesh(droneRotor, rotorMat));
    this.group.scale.setScalar(1.25);
    this.home.set(x, heightAt(x, z) + 6, z); this.pos.copy(this.home);
    g.scene.add(this.group);
    this.hum = g.audio.hum(92 + Math.random() * 30, 0.6, 0.11);
  }
  center(out: THREE.Vector3) { return out.copy(this.pos); }
  rayHit(o: THREE.Vector3, d: THREE.Vector3) {
    const t = raySphere(o.x, o.y, o.z, d.x, d.y, d.z, this.pos.x, this.pos.y, this.pos.z, this.radius);
    return t < 0 ? null : { t, crit: false };
  }
  alert(g: Game) { if (!this.aggro) { this.aggro = true; g.audio.droneAlert(this.pos); this.fireT = 0.7 + Math.random() * 0.8; } }

  update(dt: number, g: Game) {
    const p = g.player, e = p.eye;
    this.phase += dt; this.updateFlash(dt);
    const dist = this.pos.distanceTo(e);
    if (!this.aggro) {
      this.orbit += dt * 0.32 * this.orbitDir;
      this.target.set(this.home.x + Math.cos(this.orbit) * this.patrolR, 0, this.home.z + Math.sin(this.orbit) * this.patrolR);
      this.target.y = heightAt(this.target.x, this.target.z) + 5.5 + Math.sin(this.phase * 0.7) * 1.2;
      if (!p.dead && dist < 42 && this.checkLos(dt, g, 0) || dist < 12) this.alert(g);
    } else {
      this.orbit += dt * 0.42 * this.orbitDir * (dist < 7 ? 2.2 : 1);
      this.target.set(p.pos.x + Math.cos(this.orbit) * this.ring, 0, p.pos.z + Math.sin(this.orbit) * this.ring);
      const tr = Math.hypot(this.target.x, this.target.z); if (tr > WORLD_R + 6) { this.target.x *= (WORLD_R + 6) / tr; this.target.z *= (WORLD_R + 6) / tr; }
      this.target.y = Math.max(heightAt(this.target.x, this.target.z) + 3.2, e.y + 2.2 + Math.sin(this.phase * 0.9) * 1.3);
      // ---- weapon: telegraphed charge, then a short burst of bolts
      const los = this.checkLos(dt, g, -0.2);
      this.fireT -= dt;
      if (this.charge < 0 && this.fireT <= 0 && los && dist < 48 && !p.dead) { this.charge = 0.5; this.burstLeft = 2; }
      if (this.charge >= 0) {
        this.charge -= dt;
        const k = 1 - clamp(this.charge / 0.5, 0, 1);
        this.glowMat.color.setRGB(5 + k * 14, 0.35 + k * 3, 0.15 + k);
        if (this.charge <= 0) {
          const from = this.tmp.set(0, -0.25, 0.7).applyQuaternion(this.group.quaternion).add(this.pos);
          const lead = dist / 36 * 0.55;
          const aim = new THREE.Vector3(e.x + p.vel.x * lead + (Math.random() - 0.5) * dist * 0.05, e.y - 0.25 + (Math.random() - 0.5) * dist * 0.04, e.z + p.vel.z * lead + (Math.random() - 0.5) * dist * 0.05);
          g.bolts.fire(from, aim.sub(from).normalize(), g);
          g.audio.droneShot(this.pos);
          this.burstLeft--;
          if (this.burstLeft > 0) this.charge = 0.16; else { this.charge = -1; this.fireT = 1.9 + Math.random() * 1.6; }
        }
      }
    }
    // ---- spring-damper flight towards the target point
    const acc = this.tmp.subVectors(this.target, this.pos).multiplyScalar(this.aggro ? 2.6 : 1.4).addScaledVector(this.vel, -1.9);
    this.vel.addScaledVector(acc, dt);
    const sp = this.vel.length(), max = this.aggro ? 10 : 4; if (sp > max) this.vel.multiplyScalar(max / sp);
    this.pos.addScaledVector(this.vel, dt);
    this.pos.y = Math.max(this.pos.y, heightAt(this.pos.x, this.pos.z) + 1.6);
    g.world.colliders.resolve(this.pos, 0.7, this.pos.y - 0.4, this.pos.y + 0.4);
    // ---- orientation: face the player (or travel direction) and bank into motion
    const look = this.aggro ? this.tmp.copy(e) : this.tmp.copy(this.pos).add(this.vel.lengthSq() > 0.05 ? this.vel : this.group.getWorldDirection(new THREE.Vector3()));
    const yawT = Math.atan2(look.x - this.pos.x, look.z - this.pos.z), pitchT = this.aggro ? -Math.atan2(look.y - this.pos.y, Math.hypot(look.x - this.pos.x, look.z - this.pos.z)) : 0;
    let dy = yawT - this.group.rotation.y; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    this.group.rotation.order = 'YXZ';
    this.group.rotation.y += dy * Math.min(1, dt * 6);
    this.group.rotation.x = damp(this.group.rotation.x, clamp(pitchT, -0.9, 0.9), 6, dt);
    this.group.rotation.z = damp(this.group.rotation.z, clamp(-(this.vel.x * Math.cos(this.group.rotation.y) - this.vel.z * Math.sin(this.group.rotation.y)) * 0.05, -0.5, 0.5), 5, dt);
    this.hum(this.pos);
    if (this.hp < 20 && Math.random() < dt * 14) g.particles.smoke(this.pos, 0.8);
  }

  die(g: Game) {
    this.hum(null);
    g.particles.explosion(this.pos, 0.9); g.audio.explosion(this.pos);
    g.scene.remove(this.group); this.glowMat.dispose(); this.remove = true;
  }
}

// ================================================================ Stalker
let stBody: THREE.BufferGeometry, stGlow: THREE.BufferGeometry, stLeg: THREE.BufferGeometry, stMat: THREE.MeshStandardMaterial;
function buildStalkerAssets(env: THREE.Texture) {
  const shell: RGB = [0.055, 0.035, 0.07], shell2: RGB = [0.09, 0.05, 0.08], bone: RGB = [0.30, 0.26, 0.19];
  const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4; c: RGB }[] = [
    { g: new THREE.SphereGeometry(0.5, 14, 10), m: M(0, 0.74, -0.78, 0.12, 0, 0, 0.9, 0.72, 1.5), c: shell },
    { g: new THREE.SphereGeometry(0.42, 12, 9), m: M(0, 0.66, 0.05, 0, 0, 0, 1.0, 0.8, 1.1), c: shell2 },
    { g: new THREE.SphereGeometry(0.3, 12, 8), m: M(0, 0.62, 0.72, 0.15, 0, 0, 1.0, 0.75, 1.25), c: shell },
    { g: new THREE.ConeGeometry(0.13, 0.95, 6), m: M(0, 0.9, -1.75, -1.25), c: bone },                        // tail spike
    { g: new THREE.ConeGeometry(0.05, 0.5, 5), m: M(0.14, 0.5, 1.12, 1.45, 0, 0.28), c: bone },              // mandibles
    { g: new THREE.ConeGeometry(0.05, 0.5, 5), m: M(-0.14, 0.5, 1.12, 1.45, 0, -0.28), c: bone },
  ];
  for (let i = 0; i < 6; i++) parts.push({ g: new THREE.ConeGeometry(0.07, 0.38 + (i % 3) * 0.1, 5), m: M(0, 1.02 + Math.sin(i * 0.6) * 0.1, 0.25 - i * 0.3, -0.45), c: bone });
  stBody = mergeParts(parts);
  const glow: { g: THREE.BufferGeometry; m?: THREE.Matrix4; c: RGB }[] = [];
  for (const sx of [-1, 1]) {
    glow.push({ g: new THREE.SphereGeometry(0.055, 8, 6), m: M(sx * 0.13, 0.7, 0.98), c: [1, 1, 1] }, { g: new THREE.SphereGeometry(0.04, 8, 6), m: M(sx * 0.22, 0.66, 0.86), c: [1, 1, 1] });
    for (let i = 0; i < 5; i++) glow.push({ g: new THREE.SphereGeometry(0.05, 6, 5), m: M(sx * (0.36 + Math.sin(i * 0.8) * 0.07), 0.78, -0.3 - i * 0.24), c: [1, 1, 1] });
  }
  stGlow = mergeParts(glow);
  const hip = new THREE.Vector3(0, 0, 0), knee = new THREE.Vector3(0.62, 0.42, 0), foot = new THREE.Vector3(1.02, -0.64, 0);
  stLeg = mergeParts([{ ...limb(hip, knee, 0.075, 0.05), c: shell2 }, { ...limb(knee, foot, 0.05, 0.012), c: shell }, { g: new THREE.SphereGeometry(0.07, 6, 5), m: M(knee.x, knee.y, 0), c: bone }]);
  stMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.52, metalness: 0.0, envMap: env, envMapIntensity: 0.12 });
}

type StalkerState = 'idle' | 'chase' | 'windup' | 'lunge' | 'recover';
export class Stalker extends Enemy {
  kind = 'stalker' as const; radius = 0.8;
  private state: StalkerState = 'idle'; private stateT = 0;
  private home = new THREE.Vector3(); private wander = new THREE.Vector3(); private wanderT = 0;
  private legs: { pivot: THREE.Object3D; mesh: THREE.Mesh; base: number; phase: number }[] = [];
  private gait = Math.random() * 6; private yaw = Math.random() * 6.28; private body = new THREE.Group();
  private weave = Math.random() * 10; private struck = false; private deathT = 0; private stagger = 0;
  private lungeDir = new THREE.Vector3(); private scaleK = 0.9 + Math.random() * 0.3;
  private c = new THREE.Vector3();

  constructor(g: Game, x: number, z: number) {
    super();
    if (!stBody) buildStalkerAssets(g.world.env);
    this.hp = 70;
    this.glowBase.setRGB(1.6, 3.2, 0.35); this.glowMat = new THREE.MeshBasicMaterial({ color: this.glowBase.clone(), vertexColors: true });
    const body = new THREE.Mesh(stBody, stMat); body.castShadow = true;
    this.body.add(body, new THREE.Mesh(stGlow, this.glowMat));
    for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) {
      const pivot = new THREE.Object3D(), mesh = new THREE.Mesh(stLeg, stMat);
      const fwd = [0.65, 0, -0.65][i];
      pivot.position.set(sx * 0.3, 0.6, [0.38, 0.02, -0.34][i]);
      const base = sx > 0 ? -fwd : Math.PI + fwd;
      pivot.rotation.y = base; pivot.add(mesh); this.body.add(pivot);
      this.legs.push({ pivot, mesh, base, phase: (i + (sx > 0 ? 0 : 1)) % 2 * Math.PI });
    }
    this.group.add(this.body); this.group.scale.setScalar(this.scaleK);
    this.home.set(x, 0, z); this.pos.set(x, heightAt(x, z), z); this.wander.copy(this.pos);
    g.scene.add(this.group);
  }
  center(out: THREE.Vector3) { return out.set(this.pos.x, this.pos.y + 0.7 * this.scaleK, this.pos.z); }
  rayHit(o: THREE.Vector3, d: THREE.Vector3) {
    const s = this.scaleK, sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const head = raySphere(o.x, o.y, o.z, d.x, d.y, d.z, this.pos.x + sy * 0.8 * s, this.pos.y + 0.62 * s, this.pos.z + cy * 0.8 * s, 0.4 * s);
    const body = raySphere(o.x, o.y, o.z, d.x, d.y, d.z, this.pos.x - sy * 0.15 * s, this.pos.y + 0.68 * s, this.pos.z - cy * 0.15 * s, 0.62 * s);
    const tail = raySphere(o.x, o.y, o.z, d.x, d.y, d.z, this.pos.x - sy * 0.9 * s, this.pos.y + 0.74 * s, this.pos.z - cy * 0.9 * s, 0.6 * s);
    let t = -1, crit = false;
    if (head >= 0) { t = head; crit = true; }
    if (body >= 0 && (t < 0 || body < t)) { t = body; crit = false; }
    if (tail >= 0 && (t < 0 || tail < t)) { t = tail; crit = false; }
    return t < 0 ? null : { t, crit };
  }
  alert(g: Game) { if (!this.aggro) { this.aggro = true; this.state = 'chase'; if (Math.random() < 0.7) g.audio.screech(this.pos); } }
  damage(n: number, g: Game) { this.stagger = 0.16; return super.damage(n, g); }

  update(dt: number, g: Game) {
    const p = g.player, col = g.world.colliders;
    if (this.dead) {                                   // collapse, curl up, sink away
      this.deathT += dt;
      const k = Math.min(1, this.deathT / 0.5);
      this.body.rotation.z = k * 1.35; this.body.position.y = -k * 0.25;
      for (const l of this.legs) l.mesh.rotation.z = k * 1.1;
      if (this.deathT > 5) { this.group.position.y -= dt * 0.35; }
      if (this.deathT > 7.5) { g.scene.remove(this.group); this.glowMat.dispose(); this.remove = true; }
      return;
    }
    this.updateFlash(dt);
    this.stagger = Math.max(0, this.stagger - dt);
    const dx = p.pos.x - this.pos.x, dz = p.pos.z - this.pos.z, dist = Math.hypot(dx, dz), dyv = p.pos.y - this.pos.y;
    let mx = 0, mz = 0, speed = 0;
    this.stateT -= dt;

    switch (this.state) {
      case 'idle': {
        this.wanderT -= dt;
        if (this.wanderT <= 0) { this.wanderT = 2.5 + Math.random() * 4; const a = Math.random() * 6.28, r = Math.random() * 11; this.wander.set(this.home.x + Math.cos(a) * r, 0, this.home.z + Math.sin(a) * r); }
        const wx = this.wander.x - this.pos.x, wz = this.wander.z - this.pos.z, wd = Math.hypot(wx, wz);
        if (wd > 0.8) { mx = wx / wd; mz = wz / wd; speed = 1.7; }
        if (!p.dead && (dist < 11 || (dist < 30 && this.checkLos(dt, g, 0.8)))) this.alert(g);
        break;
      }
      case 'chase': {
        this.weave += dt * 2.4;
        const w = Math.sin(this.weave) * clamp((dist - 4) / 10, 0, 0.55);      // zig-zag while closing in
        mx = dx / (dist || 1); mz = dz / (dist || 1);
        const sx = -mz, sz = mx; mx += sx * w; mz += sz * w; const l = Math.hypot(mx, mz); mx /= l; mz /= l;
        speed = this.stagger > 0 ? 2 : 6.3;
        if (p.dead) { this.state = 'idle'; this.aggro = false; this.home.copy(this.pos); }
        else if (dist < 4.6 && Math.abs(dyv) < 2.2) { this.state = 'windup'; this.stateT = 0.36; g.audio.screech(this.pos, true); }
        break;
      }
      case 'windup': {
        mx = dx / (dist || 1); mz = dz / (dist || 1); speed = -1.2;            // rear back
        if (this.stateT <= 0) { this.state = 'lunge'; this.stateT = 0.42; this.struck = false; this.lungeDir.set(dx / (dist || 1), 0, dz / (dist || 1)); }
        break;
      }
      case 'lunge': {
        mx = this.lungeDir.x; mz = this.lungeDir.z; speed = 13.5;
        if (!this.struck && dist < 1.55 && Math.abs(dyv) < 1.9) {
          this.struck = true; g.damagePlayer(11 + Math.random() * 4, this.pos); g.audio.squelch(this.pos);
          p.vel.x += this.lungeDir.x * 4; p.vel.z += this.lungeDir.z * 4;
        }
        if (this.stateT <= 0) { this.state = 'recover'; this.stateT = 0.55 + Math.random() * 0.4; }
        break;
      }
      case 'recover': {
        mx = -dx / (dist || 1); mz = -dz / (dist || 1); speed = 1.6;
        if (this.stateT <= 0) this.state = 'chase';
        break;
      }
    }
    // ---- move with simple steering; colliders push the body around obstacles
    const lam = this.state === 'lunge' ? 30 : 7;
    this.vel.x = damp(this.vel.x, mx * speed, lam, dt); this.vel.z = damp(this.vel.z, mz * speed, lam, dt);
    this.pos.x += this.vel.x * dt; this.pos.z += this.vel.z * dt;
    for (const o of g.enemies) {                        // keep the pack from stacking up
      if (o === this || o.kind !== 'stalker' || o.dead) continue;
      const ox = this.pos.x - o.pos.x, oz = this.pos.z - o.pos.z, d2 = ox * ox + oz * oz;
      if (d2 < 2.6 && d2 > 1e-4) { const d = Math.sqrt(d2), push = (1.61 - d) * 0.5; this.pos.x += (ox / d) * push; this.pos.z += (oz / d) * push; }
    }
    const gy0 = heightAt(this.pos.x, this.pos.z);
    col.resolve(this.pos, 0.55, gy0 + 0.2, gy0 + 1.1);
    const r = Math.hypot(this.pos.x, this.pos.z); if (r > WORLD_R + 3) { this.pos.x *= (WORLD_R + 3) / r; this.pos.z *= (WORLD_R + 3) / r; }
    const gy = heightAt(this.pos.x, this.pos.z);
    this.pos.y = damp(this.pos.y, gy, 18, dt);

    // ---- pose: face travel direction, pitch to the slope, procedural gait
    const v = Math.hypot(this.vel.x, this.vel.z);
    const faceX = this.state === 'idle' ? this.vel.x : this.state === 'recover' || this.state === 'windup' ? dx : mx, faceZ = this.state === 'idle' ? this.vel.z : this.state === 'recover' || this.state === 'windup' ? dz : mz;
    if (Math.hypot(faceX, faceZ) > 0.05) { let d = Math.atan2(faceX, faceZ) - this.yaw; d = Math.atan2(Math.sin(d), Math.cos(d)); this.yaw += d * Math.min(1, dt * 9); }
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const slope = Math.atan2(heightAt(this.pos.x + sy, this.pos.z + cy) - heightAt(this.pos.x - sy, this.pos.z - cy), 2);
    this.group.rotation.order = 'YXZ'; this.group.rotation.y = this.yaw;
    this.group.rotation.x = damp(this.group.rotation.x, -slope + (this.state === 'windup' ? -0.35 : this.state === 'lunge' ? 0.25 : 0), 10, dt);
    this.gait += v * dt * 2.6;
    this.body.position.y = Math.sin(this.gait * 2) * 0.03 * Math.min(1, v) + (this.state === 'windup' ? -0.12 : 0);
    for (const l of this.legs) {
      const ph = this.gait + l.phase, amp = Math.min(1, v / 3);
      l.pivot.rotation.y = l.base + Math.sin(ph) * 0.42 * amp * (l.base > 1.5 ? 1 : -1);
      l.mesh.rotation.z = Math.max(0, Math.cos(ph)) * 0.38 * amp + (this.state === 'lunge' ? 0.5 : 0);
    }
  }

  die(g: Game) {
    this.center(this.c);
    g.particles.goo(this.c, 1.6, 3.4, 0.3, 26, 5); g.audio.creatureDie(this.pos);
    this.glowBase.setRGB(0.15, 0.3, 0.03); this.glowMat.color.copy(this.glowBase);
  }
}

// ================================================================ Drone plasma bolts
export class Bolts {
  private pool: { mesh: THREE.Mesh; vel: THREE.Vector3; life: number }[] = [];
  constructor(scene: THREE.Scene) {
    const geo = new THREE.SphereGeometry(0.11, 8, 6); geo.scale(1, 1, 5.5);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(9, 1.6, 0.5), fog: false });
    for (let i = 0; i < 28; i++) { const mesh = new THREE.Mesh(geo, mat); mesh.visible = false; scene.add(mesh); this.pool.push({ mesh, vel: new THREE.Vector3(), life: 0 }); }
  }
  fire(from: THREE.Vector3, dir: THREE.Vector3, _g: Game) {
    const b = this.pool.find((x) => x.life <= 0); if (!b) return;
    b.life = 3; b.vel.copy(dir).multiplyScalar(36); b.mesh.position.copy(from); b.mesh.visible = true;
    b.mesh.lookAt(from.clone().add(dir));
  }
  clear() { for (const b of this.pool) { b.life = 0; b.mesh.visible = false; } }
  update(dt: number, g: Game) {
    const p = g.player, col = g.world.colliders;
    for (const b of this.pool) {
      if (b.life <= 0) continue;
      b.life -= dt;
      const pos = b.mesh.position, step = 36 * dt, d = b.vel;
      // swept test against the world, then against the player's body capsule
      const t = col.raycast(pos.x, pos.y, pos.z, d.x / 36, d.y / 36, d.z / 36, step + 0.2);
      let hitPlayer = false;
      if (!p.dead) {
        const midX = pos.x + d.x * dt * 0.5, midY = pos.y + d.y * dt * 0.5, midZ = pos.z + d.z * dt * 0.5;
        const cy = clamp(midY, p.pos.y + 0.3, p.eye.y);
        hitPlayer = Math.hypot(midX - p.pos.x, midY - cy, midZ - p.pos.z) < 0.5 + step * 0.5;
      }
      if (hitPlayer) { g.damagePlayer(6 + Math.random() * 3, pos.clone().addScaledVector(d, -0.2)); b.life = 0; }
      else if (t !== Infinity || b.life <= 0) {
        if (t !== Infinity) { pos.addScaledVector(d, t / 36); g.particles.impact(pos, new THREE.Vector3(0, 1, 0), 0.12, 0.1, 0.08); g.particles.emit(pos.x, pos.y, pos.z, 0, 0, 0, 0.14, 1.4, 8, 1.6, 0.5); }
        b.life = 0;
      } else {
        pos.addScaledVector(d, dt);
        if (Math.random() < 0.5) g.particles.emit(pos.x, pos.y, pos.z, 0, 0, 0, 0.16, 0.22, 4, 0.7, 0.2);
      }
      if (b.life <= 0) b.mesh.visible = false;
    }
  }
}
