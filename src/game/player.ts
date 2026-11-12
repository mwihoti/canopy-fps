// First-person character controller: mouse look, walk / sprint / crouch / jump,
// collision against the collider world, head bob and camera feel.
import * as THREE from 'three';
import { clamp, damp, lerp } from '../core/math';
import type { Input } from '../core/input';
import { heightAt, WATER_Y, WORLD_R } from '../world/layout';
import type { Game } from './game';

const RADIUS = 0.36, STAND = 1.68, CROUCH = 1.02, GRAVITY = 21;

export class Player {
  pos = new THREE.Vector3(); vel = new THREE.Vector3();
  yaw = 0; pitch = 0;
  hp = 100; dead = false;
  onGround = true; crouch = 0; sprinting = false; inWater = false;
  ads = 0;                                   // 0..1 aim-down-sights blend (driven by Weapon)
  recoilPitch = 0; recoilYaw = 0; shake = 0;
  bobPhase = 0; bobAmt = 0; private landDip = 0; private smoothY = 0; private stepAcc = 0;
  lastHurt = -99;
  eye = new THREE.Vector3(); forward = new THREE.Vector3();
  moveSpeed = 0;

  reset(x: number, y: number, z: number, yaw: number) {
    this.pos.set(x, y, z); this.vel.set(0, 0, 0); this.yaw = yaw; this.pitch = 0; this.hp = 100; this.dead = false;
    this.smoothY = y; this.crouch = 0; this.recoilPitch = this.recoilYaw = this.shake = 0; this.onGround = true; this.lastHurt = -99;
  }

  update(dt: number, input: Input, g: Game) {
    const col = g.world.colliders;
    // ---- look
    const sens = g.settings.sens * 0.0021 * (1 - this.ads * 0.45);
    this.yaw -= input.mouseDX * sens; this.pitch -= input.mouseDY * sens;
    this.yaw += ((input.down('ArrowLeft') ? 1 : 0) - (input.down('ArrowRight') ? 1 : 0)) * 2.2 * dt;
    this.pitch += ((input.down('ArrowUp') ? 1 : 0) - (input.down('ArrowDown') ? 1 : 0)) * 1.5 * dt;
    this.pitch = clamp(this.pitch, -1.5, 1.5);

    // ---- wish direction
    const f = (input.down('KeyW') ? 1 : 0) - (input.down('KeyS') ? 1 : 0) + input.axisY, s = (input.down('KeyD') ? 1 : 0) - (input.down('KeyA') ? 1 : 0) + input.axisX;
    const wantCrouch = input.down('KeyC') || input.down('ControlLeft');
    this.crouch = damp(this.crouch, wantCrouch ? 1 : 0, 12, dt);
    this.sprinting = (input.down('ShiftLeft') || input.touchSprint) && f > 0.5 && !wantCrouch && this.ads < 0.3;
    this.inWater = heightAt(this.pos.x, this.pos.z) < WATER_Y - 0.1 && this.pos.y < WATER_Y;
    let speed = wantCrouch ? 2.3 : this.sprinting ? 7.3 : 4.5;
    speed *= (1 - this.ads * 0.4) * (this.inWater ? 0.72 : 1);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let wx = -sy * f + cy * s, wz = -cy * f - sy * s;
    const wl = Math.hypot(wx, wz); if (wl > 0) { wx /= wl; wz /= wl; }
    speed *= Math.min(1, wl);                         // analog stick: partial deflection = slower walk

    if (this.onGround) {
      this.vel.x = damp(this.vel.x, wx * speed, 11, dt); this.vel.z = damp(this.vel.z, wz * speed, 11, dt);
      if (input.hit('Space')) { this.vel.y = 7.1; this.onGround = false; g.audio.footstep(this.inWater, true); }
    } else {
      this.vel.x += wx * speed * 2.0 * dt; this.vel.z += wz * speed * 2.0 * dt;
      const h = Math.hypot(this.vel.x, this.vel.z), max = Math.max(speed, 4.5);
      if (h > max) { this.vel.x *= max / h; this.vel.z *= max / h; }
    }
    this.vel.y -= GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);

    // ---- collide
    const height = lerp(STAND, CROUCH, this.crouch) + 0.12;
    col.resolve(this.pos, RADIUS, this.pos.y, this.pos.y + height);
    const r = Math.hypot(this.pos.x, this.pos.z);
    if (r > WORLD_R) { this.pos.x *= WORLD_R / r; this.pos.z *= WORLD_R / r; }
    const ground = col.groundAt(this.pos.x, this.pos.z, this.pos.y);
    if (this.pos.y <= ground) {
      if (!this.onGround && this.vel.y < -5) { this.landDip = Math.min(0.28, -this.vel.y * 0.022); g.audio.land(Math.min(1.5, -this.vel.y / 8)); if (this.inWater) g.particles.splash(this.pos); }
      this.pos.y = ground; this.vel.y = 0; this.onGround = true;
    } else if (this.onGround && this.vel.y <= 0 && this.pos.y - ground < 0.5) {
      this.pos.y = ground; this.vel.y = 0;             // stay glued to slopes and steps going down
    } else this.onGround = false;

    // ---- footsteps & bob
    this.moveSpeed = Math.hypot(this.vel.x, this.vel.z);
    const moving = this.onGround && this.moveSpeed > 0.6;
    this.bobAmt = damp(this.bobAmt, moving ? Math.min(1, this.moveSpeed / 4.5) : 0, 8, dt);
    if (moving) {
      this.bobPhase += this.moveSpeed * dt * 1.55;
      this.stepAcc += this.moveSpeed * dt;
      if (this.stepAcc > (this.sprinting ? 2.5 : 1.9)) {
        this.stepAcc = 0; g.audio.footstep(this.inWater, this.sprinting);
        if (this.inWater) g.particles.splash(new THREE.Vector3(this.pos.x, WATER_Y, this.pos.z));
      }
    }
    this.landDip = damp(this.landDip, 0, 9, dt);
    this.recoilPitch = damp(this.recoilPitch, 0, 7, dt); this.recoilYaw = damp(this.recoilYaw, 0, 7, dt);
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.smoothY = this.onGround ? damp(this.smoothY, this.pos.y, 16, dt) : this.pos.y;
    if (Math.abs(this.smoothY - this.pos.y) > 1) this.smoothY = this.pos.y;

    // ---- slow regeneration back to a survivable floor
    if (g.time - this.lastHurt > 6 && this.hp < 40) this.hp = Math.min(40, this.hp + dt * 5);

    const eyeH = lerp(STAND, CROUCH, this.crouch) - this.landDip + Math.sin(this.bobPhase * 2) * 0.03 * this.bobAmt * (1 - this.ads * 0.7);
    this.eye.set(this.pos.x, this.smoothY + eyeH, this.pos.z);
    const p = this.pitch + this.recoilPitch, y = this.yaw + this.recoilYaw;
    this.forward.set(-Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p));
  }

  applyCamera(cam: THREE.PerspectiveCamera, time: number) {
    const sh = this.shake * this.shake;
    cam.position.copy(this.eye);
    cam.position.x += Math.cos(this.yaw) * Math.cos(this.bobPhase) * 0.022 * this.bobAmt * (1 - this.ads * 0.7);
    cam.position.z -= Math.sin(this.yaw) * Math.cos(this.bobPhase) * 0.022 * this.bobAmt * (1 - this.ads * 0.7);
    cam.rotation.set(
      this.pitch + this.recoilPitch + Math.sin(time * 61) * 0.02 * sh,
      this.yaw + this.recoilYaw + Math.sin(time * 47) * 0.02 * sh,
      Math.cos(this.bobPhase) * 0.006 * this.bobAmt + Math.sin(time * 53) * 0.025 * sh, 'YXZ');
  }
}
