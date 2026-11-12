// Destructible objectives and props: power relays, explosive barrels, pickups.
import * as THREE from 'three';
import { raySphere } from '../core/math';
import { mergeParts } from './enemies';
import type { Game } from './game';

type RGB = [number, number, number];
const M = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

export interface Target {
  pos: THREE.Vector3; dead: boolean; metal: boolean;
  rayHit(o: THREE.Vector3, d: THREE.Vector3): number;      // distance or -1
  damage(n: number, g: Game): void;
}

// ---------------------------------------------------------------- Relay
let relayGeo: THREE.BufferGeometry, relayMat: THREE.MeshStandardMaterial;
export class Relay implements Target {
  group = new THREE.Group(); pos: THREE.Vector3; hp = 170; dead = false; metal = true;
  private core: THREE.Mesh; private rings: THREE.Mesh[] = []; private light: THREE.PointLight; private coreMat: THREE.MeshBasicMaterial;
  private static registered = new Set<number>();
  private hum: (p: any) => void; private smokeT = 0; private deadT = 0; private hitFlash = 0;

  constructor(g: Game, p: THREE.Vector3, public name: string, public index: number) {
    this.pos = p.clone();
    if (!relayGeo) {
      const d: RGB = [0.13, 0.14, 0.16], m: RGB = [0.3, 0.31, 0.33], y: RGB = [0.7, 0.45, 0.06];
      const parts: { g: THREE.BufferGeometry; m?: THREE.Matrix4; c: RGB }[] = [
        { g: new THREE.CylinderGeometry(1.15, 1.4, 0.5, 6), m: M(0, 0.25, 0), c: d },
        { g: new THREE.CylinderGeometry(0.75, 1.0, 0.25, 6), m: M(0, 0.62, 0), c: y },
        { g: new THREE.CylinderGeometry(0.3, 0.44, 2.6, 8), m: M(0, 2.0, 0), c: m },
        { g: new THREE.CylinderGeometry(0.5, 0.36, 0.3, 8), m: M(0, 3.25, 0), c: d },
      ];
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        parts.push({ g: new THREE.BoxGeometry(0.12, 2.3, 0.3), m: M(Math.cos(a) * 0.72, 1.35, Math.sin(a) * 0.72, 0, -a, 0.33), c: d });
        parts.push({ g: new THREE.BoxGeometry(0.1, 1.5, 0.16), m: M(Math.cos(a + 1) * 1.02, 4.0, Math.sin(a + 1) * 1.02, 0, -a - 1, -0.35), c: m });      // cage prongs
        parts.push({ g: new THREE.BoxGeometry(0.5, 0.6, 0.5), m: M(Math.cos(a + 0.5) * 0.95, 0.8, Math.sin(a + 0.5) * 0.95, 0, -a - 0.5), c: m });       // junction boxes
      }
      relayGeo = mergeParts(parts);
      relayMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.75, envMap: g.world.env, envMapIntensity: 0.9 });
    }
    const body = new THREE.Mesh(relayGeo, relayMat); body.castShadow = body.receiveShadow = true;
    this.coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 4.5, 6) });
    this.core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), this.coreMat); this.core.position.y = 4.0;
    for (let i = 0; i < 2; i++) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(0.82 + i * 0.16, 0.035, 6, 32), this.coreMat); r.position.y = 4.0; this.rings.push(r);
    }
    this.light = new THREE.PointLight(0x48d8ff, 26, 22, 1.5); this.light.position.y = 4.0;
    this.group.add(body, this.core, ...this.rings, this.light); this.group.position.copy(p);
    g.scene.add(this.group);
    if (!Relay.registered.has(index)) { Relay.registered.add(index); g.world.colliders.addCircle(p.x, p.z, 1.15, p.y - 1, p.y + 4.6); }
    this.hum = g.audio.hum(58, 0.15, 0.2);
  }

  /** Same vertical cylinder as the relay's movement collider, so shots that are
   *  stopped by the structure always register as hits on it. */
  rayHit(o: THREE.Vector3, d: THREE.Vector3) {
    if (this.dead) return -1;
    const mx = o.x - this.pos.x, mz = o.z - this.pos.z, a = d.x * d.x + d.z * d.z;
    if (a < 1e-8) return -1;
    const b = mx * d.x + mz * d.z, c = mx * mx + mz * mz - 1.2 * 1.2, disc = b * b - a * c;
    if (disc < 0) return -1;
    const t = (-b - Math.sqrt(disc)) / a, y = o.y + d.y * t;
    return t >= 0 && y >= this.pos.y - 0.3 && y <= this.pos.y + 4.9 ? t : -1;
  }

  damage(n: number, g: Game) {
    if (this.dead) return;
    this.hp -= n; this.hitFlash = 0.1;
    if (this.hp <= 0) {
      this.dead = true; this.hum(null);
      const c = this.pos.clone(); c.y += 3.8;
      g.particles.explosion(c, 2.2, 3, 7, 10); g.particles.explosion(this.pos.clone().setY(this.pos.y + 1.5), 1.6);
      g.audio.relayDown(c); g.explode(c, 7, 60, this);
      this.core.visible = false; this.light.intensity = 0;
      g.onRelayDestroyed(this);
    }
  }

  update(dt: number, g: Game) {
    const t = g.time;
    if (this.dead) {
      this.deadT += dt;
      for (const r of this.rings) { r.position.y = Math.max(0.75, r.position.y - dt * (2 + this.deadT * 6)); r.rotation.x = damp01(r.rotation.x, Math.PI / 2, dt * 3); }
      this.coreMat.color.setRGB(0.05, 0.05, 0.05);
      this.smokeT -= dt;
      if (this.smokeT <= 0 && this.pos.distanceToSquared(g.player.pos) < 70 * 70) { this.smokeT = 0.09; g.particles.smoke(new THREE.Vector3(this.pos.x, this.pos.y + 3.2, this.pos.z), 1.3); if (Math.random() < 0.15) g.particles.impact(new THREE.Vector3(this.pos.x, this.pos.y + 3, this.pos.z), new THREE.Vector3(0, 1, 0), 0.1, 0.1, 0.1); }
      return;
    }
    const health = this.hp / 170, flick = health < 0.5 ? 0.6 + 0.4 * Math.sin(t * 40) * Math.sin(t * 13) : 1;
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    const k = (0.85 + 0.15 * Math.sin(t * 3 + this.index)) * flick + this.hitFlash * 20;
    // core shifts from cyan to angry orange as it takes damage
    this.coreMat.color.setRGB((0.6 + (1 - health) * 6) * k, (4.5 - (1 - health) * 2.5) * k, (6 - (1 - health) * 5.5) * k);
    this.light.color.setRGB(0.28 + (1 - health) * 0.7, 0.85 - (1 - health) * 0.35, 1 - (1 - health) * 0.8); this.light.intensity = 26 * k;
    this.core.rotation.y += dt * 1.2; this.core.rotation.x += dt * 0.7;
    this.rings[0].rotation.x += dt * 1.6; this.rings[0].rotation.y += dt * 0.9; this.rings[1].rotation.z += dt * 1.3; this.rings[1].rotation.x -= dt * 1.1;
    this.hum(this.pos);
    if (health < 0.6 && Math.random() < dt * 6 * (1 - health)) g.particles.impact(new THREE.Vector3(this.pos.x, this.pos.y + 1 + Math.random() * 3, this.pos.z), new THREE.Vector3(Math.random() - 0.5, 0.5, Math.random() - 0.5), 0.1, 0.1, 0.1);
  }

  dispose(g: Game) { this.hum(null); g.scene.remove(this.group); this.coreMat.dispose(); }
}
const damp01 = (a: number, b: number, k: number) => a + (b - a) * Math.min(1, k);

// ---------------------------------------------------------------- Explosive barrel
let barrelGeo: THREE.BufferGeometry, barrelMat: THREE.MeshStandardMaterial;
export class Barrel implements Target {
  mesh: THREE.Mesh; pos: THREE.Vector3; hp = 24; dead = false; metal = true; private fuse = -1;
  constructor(g: Game, p: THREE.Vector3) {
    this.pos = p.clone();
    if (!barrelGeo) {
      barrelGeo = mergeParts([
        { g: new THREE.CylinderGeometry(0.31, 0.31, 0.95, 14), m: M(0, 0.475, 0), c: [0.62, 0.07, 0.04] },
        { g: new THREE.CylinderGeometry(0.33, 0.33, 0.05, 14), m: M(0, 0.3, 0), c: [0.3, 0.05, 0.04] }, { g: new THREE.CylinderGeometry(0.33, 0.33, 0.05, 14), m: M(0, 0.68, 0), c: [0.3, 0.05, 0.04] },
        { g: new THREE.BoxGeometry(0.3, 0.2, 0.02), m: M(0, 0.48, 0.31), c: [0.9, 0.7, 0.1] },
      ]);
      barrelMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.5, envMap: g.world.env, envMapIntensity: 0.6 });
    }
    this.mesh = new THREE.Mesh(barrelGeo, barrelMat); this.mesh.position.copy(p); this.mesh.rotation.y = Math.random() * 6; this.mesh.castShadow = this.mesh.receiveShadow = true;
    g.scene.add(this.mesh);
  }
  rayHit(o: THREE.Vector3, d: THREE.Vector3) { return this.dead ? -1 : raySphere(o.x, o.y, o.z, d.x, d.y, d.z, this.pos.x, this.pos.y + 0.5, this.pos.z, 0.5); }
  damage(n: number, _g: Game) { if (this.dead) return; this.hp -= n; if (this.hp <= 0 && this.fuse < 0) this.fuse = 0.05 + Math.random() * 0.12; }
  update(dt: number, g: Game) {
    if (this.dead || this.fuse < 0) return;
    this.fuse -= dt;
    if (this.fuse <= 0) {
      this.dead = true; this.mesh.visible = false;
      const c = this.pos.clone(); c.y += 0.6;
      g.particles.explosion(c, 1.8); g.audio.explosion(c, true); g.explode(c, 6.5, 130, this);
    }
  }
  dispose(g: Game) { g.scene.remove(this.mesh); }
}

// ---------------------------------------------------------------- Pickups
let ammoGeo: THREE.BufferGeometry, medGeo: THREE.BufferGeometry, pickMat: THREE.MeshStandardMaterial;
export class Pickup {
  mesh: THREE.Mesh; taken = false; private glow: THREE.Mesh; private base: number;
  constructor(g: Game, public pos: THREE.Vector3, public type: 'ammo' | 'med', public temp = false) {
    if (!ammoGeo) {
      ammoGeo = mergeParts([{ g: new THREE.BoxGeometry(0.46, 0.26, 0.28), c: [0.16, 0.22, 0.12] }, { g: new THREE.BoxGeometry(0.48, 0.05, 0.3), m: M(0, 0.06, 0), c: [0.75, 0.55, 0.1] }, { g: new THREE.BoxGeometry(0.2, 0.04, 0.05), m: M(0, 0.15, 0), c: [0.1, 0.1, 0.1] }]);
      medGeo = mergeParts([{ g: new THREE.BoxGeometry(0.4, 0.26, 0.3), c: [0.85, 0.85, 0.82] }, { g: new THREE.BoxGeometry(0.18, 0.06, 0.31), m: M(0, 0, 0), c: [0.8, 0.06, 0.05] }, { g: new THREE.BoxGeometry(0.06, 0.18, 0.31), m: M(0, 0, 0), c: [0.8, 0.06, 0.05] }]);
      pickMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 });
    }
    this.base = g.world.colliders.groundAt(pos.x, pos.z, pos.y + 2) + 0.45;
    this.mesh = new THREE.Mesh(type === 'ammo' ? ammoGeo : medGeo, pickMat); this.mesh.castShadow = true;
    this.mesh.position.set(pos.x, this.base, pos.z);
    // soft beacon so supplies read from a distance in the undergrowth
    this.glow = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.1), new THREE.MeshBasicMaterial({ map: g.world.tex.glow, color: type === 'ammo' ? new THREE.Color(1.6, 1.1, 0.25) : new THREE.Color(0.3, 1.6, 1.2), transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.mesh.add(this.glow);
    g.scene.add(this.mesh);
  }
  update(dt: number, g: Game, life: number) {
    this.mesh.rotation.y += dt * 1.4; this.mesh.position.y = this.base + Math.sin(g.time * 2.2 + this.pos.x) * 0.08;
    this.glow.quaternion.copy(g.camera.quaternion).premultiply(this.mesh.quaternion.clone().invert());
    void life;
  }
  dispose(g: Game) { g.scene.remove(this.mesh); (this.glow.material as THREE.Material).dispose(); }
}
