// Game orchestration: owns the scene, world, player, enemies and objectives,
// runs the simulation step and drives HUD / audio / post-processing state.
import * as THREE from 'three';
import { clamp } from '../core/math';
import type { Input } from '../core/input';
import { World } from '../world/world';
import { heightAt, creekDist, SITES, WATER_Y, WORLD_R } from '../world/layout';
import { Particles } from '../fx/particles';
import { PostFX } from '../fx/postfx';
import { GameAudio } from '../audio/audio';
import { Player } from './player';
import { Weapon } from './weapon';
import { Enemy, Drone, Stalker, Bolts } from './enemies';
import { Relay, Barrel, Pickup, Target } from './targets';
import { Hud, Marker } from './hud';

export type Phase = 'relays' | 'extract' | 'hold' | 'won' | 'dead';
export interface Settings { sens: number; quality: number; }
export const QUALITY = [
  { scale: 0.7, shadow: 1024, ao: 0, vol: 10, detail: 0.55, label: 'Low' },
  { scale: 0.85, shadow: 2048, ao: 8, vol: 14, detail: 0.8, label: 'Medium' },
  { scale: 1.0, shadow: 2048, ao: 12, vol: 22, detail: 1.0, label: 'High' },
];
const HOLD_TIME = 32;

export class Game {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(74, 1, 0.06, 600);
  world: World; particles = new Particles(); post: PostFX; hud = new Hud();
  player = new Player(); weapon: Weapon; bolts: Bolts;
  enemies: Enemy[] = []; relays: Relay[] = []; barrels: Barrel[] = []; pickups: Pickup[] = [];
  phase: Phase = 'relays'; time = 0; playTime = 0;
  stats = { kills: 0, hits: 0, damageTaken: 0 };
  private holdT = 0; private holdWave = 0; private beacon!: THREE.Mesh; private beaconLight!: THREE.PointLight;
  private endT = 0; private heartT = 0; private tension = 0;
  private tmp = new THREE.Vector3(); private tmp2 = new THREE.Vector3();
  onEnd: (won: boolean) => void = () => {};

  constructor(public renderer: THREE.WebGLRenderer, public audio: GameAudio, public settings: Settings, public mobile = false) {
    const q = QUALITY[settings.quality];
    this.world = new World(this.scene, renderer, mobile ? 0.6 : 1);        // phones get a thinner jungle
    this.world.setShadowQuality(q.shadow); this.world.detail = q.detail; this.world.shadowEvery = mobile ? 3 : 2;
    this.post = new PostFX(renderer, q);
    this.scene.add(this.camera, this.particles.points);
    renderer.info.autoReset = false;
    this.weapon = new Weapon(this.camera, this.scene, this.world.env, this.world.tex.glow);
    this.bolts = new Bolts(this.scene);
    // extraction beacon: a column of light that switches on once the relays are down
    const ex = this.world.anchors.extract;
    const bg = new THREE.CylinderGeometry(0.5, 1.6, 60, 20, 1, true); bg.translate(0, 30, 0);
    this.beacon = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 2.2, 0.9), transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    this.beacon.position.copy(ex); this.beacon.visible = false; this.beacon.renderOrder = 4;
    this.beaconLight = new THREE.PointLight(0x55ff99, 0, 30, 1.4); this.beaconLight.position.copy(ex).y += 2.5;
    this.scene.add(this.beacon, this.beaconLight);
    this.reset();
  }

  // ------------------------------------------------------------ lifecycle
  reset() {
    for (const e of this.enemies) { if (!e.dead) (e as any).hum?.(null); this.scene.remove(e.group); }
    for (const r of this.relays) r.dispose(this); for (const b of this.barrels) b.dispose(this); for (const p of this.pickups) p.dispose(this);
    this.enemies = []; this.relays = []; this.barrels = []; this.pickups = []; this.bolts.clear();
    const A = this.world.anchors;
    this.player.reset(A.start.x, A.start.y, A.start.z, 0.12);
    this.weapon.reset();
    this.phase = 'relays'; this.playTime = 0; this.holdT = 0; this.holdWave = 0; this.endT = 0; this.stats = { kills: 0, hits: 0, damageTaken: 0 };
    this.beacon.visible = false; this.beaconLight.intensity = 0; this.post.fade = 0; this.post.damage = 0;
    this.hud.setHold(null);

    ['Alpha', 'Bravo', 'Charlie'].forEach((n, i) => this.relays.push(new Relay(this, A.relays[i], n, i)));
    for (const b of A.barrels) this.barrels.push(new Barrel(this, b));
    for (const p of A.ammo) this.pickups.push(new Pickup(this, p, 'ammo'));
    for (const p of A.med) this.pickups.push(new Pickup(this, p, 'med'));

    // garrisons around each relay + roaming packs in between
    for (const r of this.relays) {
      for (let i = 0; i < 3; i++) { const s = this.spawnPoint(r.pos.x, r.pos.z, 6, 14); this.enemies.push(new Drone(this, s.x, s.z)); }
      for (let i = 0; i < 3; i++) { const s = this.spawnPoint(r.pos.x, r.pos.z, 9, 20); this.enemies.push(new Stalker(this, s.x, s.z)); }
    }
    for (const [x, z, n] of [[-6, 44, 2], [-30, 0, 2], [28, -34, 2], [-44, -34, 2], [24, 40, 1], [46, -48, 2]]) {
      for (let i = 0; i < n; i++) { const s = this.spawnPoint(x, z, 1, 6); this.enemies.push(new Stalker(this, s.x, s.z)); }
    }
    for (const [x, z] of [[10, 22], [-22, -26]]) { const s = this.spawnPoint(x, z, 0, 5); this.enemies.push(new Drone(this, s.x, s.z)); }
    this.hud.message('Destroy the relays', 'Three power relays — follow the compass markers', 6);
  }

  /** Random walkable spot in a ring around (cx, cz). */
  private spawnPoint(cx: number, cz: number, rMin: number, rMax: number): THREE.Vector3 {
    const p = new THREE.Vector3();
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * 6.283, r = rMin + Math.random() * (rMax - rMin);
      p.set(cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r);
      if (Math.hypot(p.x, p.z) > WORLD_R - 3 || heightAt(p.x, p.z) < WATER_Y + 0.2) continue;
      const before = { x: p.x, z: p.z }; this.world.colliders.resolve(p, 0.9, heightAt(p.x, p.z), heightAt(p.x, p.z) + 1);
      if (Math.hypot(p.x - before.x, p.z - before.z) < 0.5) break;
    }
    p.y = heightAt(p.x, p.z);
    return p;
  }

  /** Reinforcements arrive out of the jungle already hunting the player. */
  private spawnWave(drones: number, stalkers: number, cx = this.player.pos.x, cz = this.player.pos.z) {
    for (let i = 0; i < drones + stalkers; i++) {
      const s = this.spawnPoint(cx, cz, 34, 50);
      const e = i < drones ? new Drone(this, s.x, s.z) : new Stalker(this, s.x, s.z);
      e.alert(this); this.enemies.push(e);
    }
  }

  // ------------------------------------------------------------ combat services
  /** Fire a hitscan ray. Applies damage/effects and returns the impact point. */
  hitscan(o: THREE.Vector3, d: THREE.Vector3, dmg: number): THREE.Vector3 {
    let best = this.world.colliders.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 220), kind = 0, crit = false;
    let enemy: Enemy | null = null, target: Target | null = null;
    if (best === Infinity) best = 220; else kind = 1;
    for (const e of this.enemies) {
      if (e.dead) continue;
      const h = e.rayHit(o, d);
      if (h && h.t < best) { best = h.t; enemy = e; crit = h.crit; kind = 2; }
    }
    for (const list of [this.relays, this.barrels] as Target[][]) for (const t of list) {
      const h = t.rayHit(o, d);
      if (h >= 0 && h < best + 0.06) { best = Math.min(best, h); target = t; enemy = null; kind = 3; }
    }
    const p = new THREE.Vector3().copy(o).addScaledVector(d, best), n = this.tmp.copy(d).multiplyScalar(-0.6); n.y += 0.5;
    if (kind === 2 && enemy) {
      const killed = enemy.damage(dmg * (crit ? 1.9 : 1), this);
      this.stats.hits++; this.hud.hitMarker(killed); this.audio.hitMarker(killed);
      if (enemy.kind === 'stalker') this.particles.goo(p, 1.4, 3.0, 0.3, crit ? 14 : 8, 3.5); else { this.particles.impact(p, n, 0.1, 0.1, 0.1); this.audio.impact(p, true); }
      if (killed) this.onKill(enemy);
    } else if (kind === 3 && target) {
      target.damage(dmg, this); this.stats.hits++; this.hud.hitMarker(target.dead); this.audio.hitMarker(false);
      this.particles.impact(p, n, 0.12, 0.12, 0.12); this.audio.impact(p, true);
    } else if (kind === 1) {
      const gy = heightAt(p.x, p.z);
      if (gy < WATER_Y && p.y < WATER_Y + 0.15) { p.y = WATER_Y; this.particles.splash(p); }
      else if (p.y - gy < 0.25) this.particles.impact(p, n, 0.2, 0.14, 0.08, false);             // dirt
      else this.particles.impact(p, n, 0.24, 0.2, 0.14);                                         // bark / stone
      if (best < 60) this.audio.impact(p, false);
    }
    return p;
  }

  /** True if the view direction rests on a live enemy / relay / barrel with nothing solid in between. */
  targetInSights(): boolean {
    const o = this.player.eye, d = this.player.forward;
    let wall = this.world.colliders.raycast(o.x, o.y, o.z, d.x, d.y, d.z, 70); if (wall === Infinity) wall = 70;
    for (const e of this.enemies) { if (e.dead) continue; const h = e.rayHit(o, d); if (h && h.t < wall) return true; }
    if (this.phase === 'relays') for (const r of this.relays) { const h = r.rayHit(o, d); if (h >= 0 && h < wall + 0.06) return true; }
    return false;
  }

  /** Radial blast: hurts enemies, props and the player with linear falloff. */
  explode(c: THREE.Vector3, radius: number, dmg: number, source: object) {
    for (const e of this.enemies) {
      if (e.dead) continue;
      const d = e.center(this.tmp2).distanceTo(c);
      if (d < radius && e.damage(dmg * (1 - d / radius), this)) this.onKill(e);
    }
    for (const list of [this.relays, this.barrels] as Target[][]) for (const t of list) {
      if (t === source || t.dead) continue;
      const d = t.pos.distanceTo(c); if (d < radius) t.damage(dmg * 0.5 * (1 - d / radius), this);
    }
    const dp = this.player.eye.distanceTo(c);
    if (dp < radius) this.damagePlayer(dmg * 0.33 * (1 - dp / radius), c);
    if (dp < radius * 4) this.player.shake = Math.max(this.player.shake, 1.1 * (1 - dp / (radius * 4)));
  }

  damagePlayer(n: number, from: THREE.Vector3) {
    const p = this.player;
    if (p.dead || this.phase === 'won') return;
    p.hp -= n; p.lastHurt = this.time; p.shake = Math.max(p.shake, 0.7); this.stats.damageTaken += n;
    this.post.damage = Math.min(1, this.post.damage + 0.45 + n * 0.02);
    this.hud.damageFrom(from.x, from.z); this.audio.hurt();
    if (p.hp <= 0) { p.hp = 0; p.dead = true; this.phase = 'dead'; this.endT = 0; this.audio.fail(); this.post.fadeColor.setRGB(0.12, 0, 0); }
  }

  /** Gunfire carries: nearby enemies investigate. */
  onGunshot(at: THREE.Vector3) {
    for (const e of this.enemies) if (!e.aggro && !e.dead && e.pos.distanceToSquared(at) < (e.kind === 'drone' ? 46 * 46 : 36 * 36)) e.alert(this);
  }

  private onKill(e: Enemy) {
    this.stats.kills++;
    const roll = Math.random(), p = e.center(new THREE.Vector3());
    const needHp = this.player.hp < 55, needAmmo = this.weapon.reserve < 70;
    if (roll < (needHp ? 0.3 : 0.1)) this.pickups.push(new Pickup(this, p, 'med', true));
    else if (roll < (needAmmo ? 0.75 : 0.4)) this.pickups.push(new Pickup(this, p, 'ammo', true));
  }

  onRelayDestroyed(r: Relay) {
    const left = this.relays.filter((x) => !x.dead).length;
    if (left > 0) {
      this.hud.message(`Relay ${r.name} destroyed`, `${left} remaining — hostiles converging`, 4.5); this.audio.objective();
      this.spawnWave(2, 2);
    } else {
      this.phase = 'extract'; this.beacon.visible = true; this.beaconLight.intensity = 40;
      this.hud.message('All relays down', 'Get to the extraction beacon', 6); this.audio.objective(true);
      this.spawnWave(2, 3);
    }
  }

  // ------------------------------------------------------------ frame
  /** Idle fly-by used behind the title screen. */
  menuUpdate(dt: number) {
    this.time += dt;
    const p = this.player, A = this.world.anchors.start;
    p.yaw = 0.12 + Math.sin(this.time * 0.08) * 0.55; p.pitch = 0.16 + Math.sin(this.time * 0.05) * 0.06;
    p.eye.set(A.x, A.y + 1.68, A.z); p.applyCamera(this.camera, this.time); this.camera.updateMatrixWorld();
    this.weapon.group.visible = false;
    for (const r of this.relays) r.update(dt, this);
    this.world.update(this.time, this.camera, this.post.height);
    this.particles.update(dt, this.post.height, this.camera.fov);
  }

  update(dt: number, input: Input) {
    this.time += dt;
    const p = this.player, w = this.weapon;
    w.group.visible = true;
    if (this.phase !== 'dead' && this.phase !== 'won') { this.playTime += dt; p.update(dt, input, this); }
    else { p.vel.set(0, 0, 0); p.eye.y = Math.max(heightAt(p.pos.x, p.pos.z) + 0.35, p.eye.y - (this.phase === 'dead' ? dt * 1.6 : 0)); }
    p.applyCamera(this.camera, this.time);
    if (this.phase === 'dead') this.camera.rotation.z += Math.min(0.5, this.endT * 0.6);
    this.camera.updateMatrixWorld();
    w.update(dt, input, this, this.camera);

    // ---- actors
    let aggro = 0;
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i]; e.update(dt, this);
      e.group.visible = e.pos.distanceToSquared(p.pos) < 95 * 95;       // lost in the haze anyway
      if (e.aggro && !e.dead) aggro++;
      if (e.remove) this.enemies.splice(i, 1);
    }
    this.bolts.update(dt, this);
    for (const r of this.relays) r.update(dt, this);
    for (const b of this.barrels) b.update(dt, this);
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const k = this.pickups[i]; k.update(dt, this, 0);
      const dx = k.pos.x - p.pos.x, dz = k.pos.z - p.pos.z;
      if (!p.dead && dx * dx + dz * dz < 1.7 * 1.7 && Math.abs(k.mesh.position.y - p.pos.y) < 2.4) {
        if (k.type === 'ammo' && w.reserve < 240) { w.reserve = Math.min(240, w.reserve + 45); k.taken = true; this.hud.message('', '+45 rounds', 1.5); }
        if (k.type === 'med' && p.hp < 100) { p.hp = Math.min(100, p.hp + 40); k.taken = true; this.hud.message('', '+40 health', 1.5); }
        if (k.taken) { this.audio.pickup(); k.dispose(this); this.pickups.splice(i, 1); }
      }
    }

    this.updateObjective(dt);

    // ---- ambience, audio & feedback
    this.world.update(this.time, this.camera, this.post.height);
    this.particles.update(dt, this.post.height, this.camera.fov);
    this.audio.setListener(p.eye, this.camera);
    this.tension += (clamp(aggro / 4, 0, 1) - this.tension) * Math.min(1, dt * 0.8);
    this.audio.setTension(this.phase === 'dead' || this.phase === 'won' ? 0 : this.tension);
    this.audio.setCreek(clamp(1 - creekDist(p.pos.x, p.pos.z) / 22, 0, 1));
    this.post.damage = Math.max(0, this.post.damage - dt * 1.4);
    this.post.lowHealth = p.dead ? 1 : clamp((35 - p.hp) / 35, 0, 1);
    if (p.hp < 35 && !p.dead) { this.heartT -= dt; if (this.heartT <= 0) { this.heartT = 0.85; this.audio.heartbeat(); } }
    if (this.phase === 'extract' || this.phase === 'hold') {
      const ex = this.world.anchors.extract;
      this.beacon.rotation.y += dt * 0.4; (this.beacon.material as THREE.MeshBasicMaterial).opacity = 0.13 + 0.05 * Math.sin(this.time * 3);
      if (Math.random() < dt * 20) this.particles.emit(ex.x + (Math.random() - 0.5) * 2, ex.y + Math.random() * 6, ex.z + (Math.random() - 0.5) * 2, 0, 1.5 + Math.random() * 2, 0, 2, 0.12, 0.6, 3, 1.2);
    }
    if (this.phase === 'dead' || this.phase === 'won') {
      this.endT += dt; this.post.fade = clamp(this.endT / 2.4, 0, this.phase === 'won' ? 1 : 0.8);
      if (this.endT > 2.6 && this.endT - dt <= 2.6) this.onEnd(this.phase === 'won');
    }
    this.updateHud(dt);
  }

  private updateObjective(dt: number) {
    const p = this.player, ex = this.world.anchors.extract;
    const d = Math.hypot(p.pos.x - ex.x, p.pos.z - ex.z);
    if (this.phase === 'extract' && d < 5.5) {
      this.phase = 'hold'; this.holdT = 0; this.holdWave = 0;
      this.hud.message('Hold the landing zone', 'Extraction inbound — stay on the pad', 5); this.audio.objective();
    }
    if (this.phase === 'hold') {
      const inside = d < 9;
      if (inside) this.holdT += dt;
      if (this.holdWave === 0 && this.holdT > 0.5) { this.spawnWave(2, 3, ex.x, ex.z); this.holdWave = 1; }
      if (this.holdWave === 1 && this.holdT > 12) { this.spawnWave(3, 3, ex.x, ex.z); this.holdWave = 2; }
      if (this.holdWave === 2 && this.holdT > 22) { this.spawnWave(2, 4, ex.x, ex.z); this.holdWave = 3; }
      this.hud.setHold(this.holdT / HOLD_TIME, inside ? `EXTRACTION IN ${Math.ceil(HOLD_TIME - this.holdT)}s` : 'RETURN TO THE LANDING ZONE');
      if (this.holdT >= HOLD_TIME) {
        this.phase = 'won'; this.endT = 0; this.hud.setHold(null); this.post.fadeColor.setRGB(0.92, 1, 0.94);
        this.hud.message('Extraction complete', '', 5); this.audio.objective(true);
        for (const e of this.enemies) if (!e.dead) e.damage(9999, this);
      }
    }
  }

  private updateHud(dt: number) {
    const p = this.player, w = this.weapon, hud = this.hud;
    hud.setVitals(p.hp);
    hud.setAmmo(w.mag, w.reserve, w.reloading > 0 ? 'RELOADING' : w.mag === 0 && w.reserve === 0 ? 'NO AMMO' : w.mag <= 6 ? 'PRESS R TO RELOAD' : '');
    const pxPerRad = this.renderer.domElement.clientHeight / ((this.camera.fov * Math.PI) / 180);
    hud.setCrosshair(w.spread(this) * pxPerRad, p.ads < 0.6 && !p.sprinting && w.reloading <= 0);
    const markers: Marker[] = [];
    if (this.phase === 'relays') {
      for (const r of this.relays) if (!r.dead) markers.push({ x: r.pos.x, z: r.pos.z, label: r.name[0], color: '#ffc45c' });
      hud.setObjective('Destroy the power relays', this.relays.map((r) => ({ text: `Relay ${r.name} — ${SITES[r.index + 1].kind === 'temple' ? 'sunken temple' : SITES[r.index + 1].kind === 'outpost' ? 'abandoned outpost' : 'stone circle'}`, done: r.dead })));
    } else {
      const ex = this.world.anchors.extract; markers.push({ x: ex.x, z: ex.z, label: 'LZ', color: '#6fe3d0' });
      hud.setObjective(this.phase === 'hold' ? 'Hold the landing zone' : 'Reach the extraction beacon', [{ text: 'Relays destroyed', done: true }, { text: this.phase === 'hold' ? 'Survive until the dropship arrives' : 'Follow the green beacon north-east', done: this.phase === 'won' }]);
    }
    const info = this.renderer.info.render;
    hud.update(dt, p.pos.x, p.pos.z, p.yaw, markers, this.fps, `${info.calls} calls ${(info.triangles / 1000).toFixed(0)}k tris ${this.post.width}x${this.post.height}`);
  }

  // ------------------------------------------------------------ rendering & resolution
  fps = 60; private fpsAcc = 0; private fpsN = 0; private slowT = 0; dynScale = 1;
  resize() {
    const q = QUALITY[this.settings.quality], pr = Math.min(window.devicePixelRatio || 1, this.mobile ? 1.25 : 1.5);
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setPixelRatio(1); this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.post.setSize(w * pr * q.scale * this.dynScale, h * pr * q.scale * this.dynScale);
  }
  applyQuality() {
    const q = QUALITY[this.settings.quality];
    this.world.setShadowQuality(q.shadow); this.world.detail = q.detail; this.post.setQuality(q); this.dynScale = 1; this.resize();
  }
  render(dt: number, rawDt: number) {
    this.renderer.info.reset();
    this.post.render(this.scene, this.camera, this.world.sun, this.time, dt);
    // rolling FPS + dynamic resolution: drop internal resolution if we cannot hold ~50 fps
    this.fpsAcc += rawDt; this.fpsN++;
    if (this.fpsAcc >= 0.5) {
      this.fps = this.fpsN / this.fpsAcc; this.fpsAcc = 0; this.fpsN = 0;
      this.slowT = this.fps < 48 ? this.slowT + 1 : 0;
      if (this.slowT >= 4 && this.dynScale > 0.6) { this.dynScale = Math.max(0.6, this.dynScale - 0.1); this.slowT = 0; this.resize(); }
    }
  }
}
