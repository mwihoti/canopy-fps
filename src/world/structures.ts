// Non-vegetation scenery: boulders, fallen logs, the ruined temple, the stone
// circle, the abandoned outpost and the extraction pad. Each builder also
// registers colliders and reports gameplay anchor points (relays, pickups...).
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, Rng, vnoise } from '../core/math';
import { Geo, addBox, addTube, trs, RGB, InstanceBatcher } from './geo';
import { heightAt, creekDist, SITES, WORLD_R, WATER_Y, Site } from './layout';
import type { TextureSet } from './textures';
import type { ColliderWorld } from './colliders';

export interface Anchors {
  relays: THREE.Vector3[];                 // relay base positions (Alpha, Bravo, Charlie)
  barrels: THREE.Vector3[];
  ammo: THREE.Vector3[]; med: THREE.Vector3[];
  lamps: { pos: THREE.Vector3; color: number; intensity: number; dist: number }[];
  blinkers: THREE.Mesh[];                  // antenna lights
  extract: THREE.Vector3; start: THREE.Vector3;
}

function rockGeo(seed: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 3);
  g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-3);
  const p = g.attributes.position as THREE.BufferAttribute, col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const n = vnoise(x * 1.4 + seed * 7.1 + y * 0.8, z * 1.4 - y * 0.6 + seed * 3.3) * 0.5 + vnoise(x * 3.5 + seed, z * 3.5 + y * 2.5) * 0.2;
    const s = 0.72 + n * 0.75;
    x *= s; y *= s * 0.78; z *= s;
    if (y < -0.35) y = -0.35 + (y + 0.35) * 0.25;            // flatten the buried base
    p.setXYZ(i, x, y, z);
    const moss = Math.max(0, Math.min(1, (y - 0.15) * 2.2 + (vnoise(x * 3 + 5, z * 3) - 0.5) * 1.2));
    const v = 0.75 + vnoise(x * 6, z * 6 + y * 4) * 0.4;
    col[i * 3] = v * (1 - moss * 0.55); col[i * 3 + 1] = v * (1 - moss * 0.1); col[i * 3 + 2] = v * (1 - moss * 0.65);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function logGeo(rnd: Rng): THREE.BufferGeometry {
  const g = new Geo(), pts: THREE.Vector3[] = [], radii: number[] = [];
  for (let i = 0; i <= 6; i++) { pts.push(new THREE.Vector3(-3 + i, 0.42 + Math.sin(i * 1.3) * 0.04, Math.sin(i * 0.9) * 0.06)); radii.push(0.46 - i * 0.012 + rnd() * 0.03); }
  addTube(g, pts, radii, { radial: 9, uRep: 2, vScale: 2.5, capEnd: true, capStart: true, col: () => [0.62, 0.7, 0.5] });
  return g.build();
}

export function buildStructures(scene: THREE.Object3D, tex: TextureSet, col: ColliderWorld): Anchors {
  const rnd = mulberry32(4242);
  const A: Anchors = { relays: [], barrels: [], ammo: [], med: [], lamps: [], blinkers: [], extract: new THREE.Vector3(), start: new THREE.Vector3() };

  const rockMat = new THREE.MeshStandardMaterial({ map: tex.rock.map, bumpMap: tex.rock.bump, bumpScale: 3, vertexColors: true, roughness: 0.95 });
  const brickMat = new THREE.MeshStandardMaterial({ map: tex.brick.map, bumpMap: tex.brick.bump, bumpScale: 4, vertexColors: true, roughness: 0.95 });
  const metalMat = new THREE.MeshStandardMaterial({ map: tex.metal.map, bumpMap: tex.metal.bump, bumpScale: 2, vertexColors: true, roughness: 0.6, metalness: 0.55 });
  const woodMat = new THREE.MeshStandardMaterial({ map: tex.wood.map, bumpMap: tex.wood.bump, bumpScale: 2, vertexColors: true, roughness: 0.85 });
  const barkMat = new THREE.MeshStandardMaterial({ map: tex.bark.map, bumpMap: tex.bark.bump, bumpScale: 2.5, vertexColors: true, roughness: 0.95 });
  const plainMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });

  const stone = new Geo(), metal = new Geo(), wood = new Geo(), plain = new Geo();
  const grey = (): RGB => { const v = 0.8 + rnd() * 0.35; return [v, v * (0.97 + rnd() * 0.06), v * (0.9 + rnd() * 0.1)]; };

  /** Stone block with matching box collider. */
  const block = (x: number, y: number, z: number, w: number, h: number, d: number, ry = 0, rx = 0, rz = 0, walk = false, collide = true) => {
    addBox(stone, w, h, d, trs(x, y + h / 2, z, rx, ry, rz), grey(), 0.5);
    if (collide) col.addBox(x, z, w / 2, d / 2, -ry, y - 0.5, y + h, walk);
  };

  // ------------------------------------------------------------ boulders & logs
  const rocks = [rockGeo(1), rockGeo(2), rockGeo(3)], logG = logGeo(rnd);
  const batch = new InstanceBatcher(88);
  for (let n = 0, tries = 0; n < 150 && tries < 4000; tries++) {
    const a = rnd() * 6.283, r = Math.sqrt(rnd()) * 108, x = Math.cos(a) * r, z = Math.sin(a) * r;
    let bad = false; for (const s of SITES) if (Math.hypot(x - s.x, z - s.z) < s.r * 0.75) bad = true;
    if (bad) continue;
    const nearCreek = creekDist(x, z) < 9;
    if (!nearCreek && rnd() < 0.45) continue;
    const s = nearCreek ? 0.5 + rnd() * 1.3 : 0.6 + rnd() * 1.9, sy = s * (0.7 + rnd() * 0.5), y = heightAt(x, z);
    batch.add('rock' + (n % 3), rocks[n % 3], rockMat, trs(x, y + sy * 0.12, z, 0, rnd() * 6.28, 0, s, sy, s * (0.8 + rnd() * 0.4)), null, true);
    if (r < WORLD_R) col.addCircle(x, z, s * 0.82, y - 1, y + sy * 0.72, true);
    n++;
  }
  for (let n = 0, tries = 0; n < 34 && tries < 2000; tries++) {
    const a = rnd() * 6.283, r = Math.sqrt(rnd()) * 90, x = Math.cos(a) * r, z = Math.sin(a) * r;
    let bad = creekDist(x, z) < 3; for (const s of SITES) if (Math.hypot(x - s.x, z - s.z) < s.r * 0.8) bad = true;
    if (bad) continue;
    const ry = rnd() * 6.28, s = 0.8 + rnd() * 0.5, y = (heightAt(x + Math.cos(ry) * 2, z - Math.sin(ry) * 2) + heightAt(x - Math.cos(ry) * 2, z + Math.sin(ry) * 2)) / 2;
    batch.add('log', logG, barkMat, trs(x, y - 0.08, z, 0, ry, 0, s), null, true);
    col.addBox(x, z, 3.05 * s, 0.4 * s, -ry, y - 1, y + 0.78 * s, true);
    n++;
  }
  batch.build(scene);

  // ------------------------------------------------------------ Relay Alpha: sunken temple
  const temple = (s: Site) => {
    const { x, z, h } = s;
    block(x, h - 0.6, z, 17, 0.95, 17, 0, 0, 0, true);             // tier 1 (top = h+0.35)
    block(x, h + 0.35, z, 12.5, 0.35, 12.5, 0, 0, 0, true);         // tier 2
    block(x, h + 0.7, z, 8, 0.35, 8, 0, 0, 0, true);                // tier 3 (top = h+1.05)
    A.relays.push(new THREE.Vector3(x, h + 1.05, z));
    const tops: Record<string, number> = {};
    for (const [px, pz] of [[-5, -5], [5, -5], [-5, 5], [5, 5], [-5, 0], [5, 0], [0, -5]]) {
      const broken = rnd() < 0.35, ph = broken ? 1.2 + rnd() * 1.6 : 5.2;
      block(x + px, h + 0.7, z + pz, 1.0, ph, 1.0, (rnd() - 0.5) * 0.1, broken ? (rnd() - 0.5) * 0.08 : 0);
      block(x + px, h + 0.7, z + pz, 1.3, 0.3, 1.3, 0, 0, 0, false, false);                   // plinth
      if (!broken) { block(x + px, h + 0.7 + ph, z + pz, 1.35, 0.35, 1.35, 0, 0, 0, false, false); tops[`${px},${pz}`] = ph; }
    }
    // lintels between surviving pillars
    const lint = (a: number[], b: number[]) => {
      if (tops[`${a}`] && tops[`${b}`]) block(x + (a[0] + b[0]) / 2, h + 0.7 + 5.55, z + (a[1] + b[1]) / 2, Math.abs(a[0] - b[0]) + 1.4 || 1.1, 0.6, Math.abs(a[1] - b[1]) + 1.4 || 1.1, 0, 0, 0, false, false);
    };
    lint([-5, -5], [0, -5]); lint([0, -5], [5, -5]); lint([-5, -5], [-5, 0]); lint([5, -5], [5, 0]); lint([-5, 0], [-5, 5]); lint([5, 0], [5, 5]);
    // crumbling rear wall and scattered blocks
    for (let wx = -7.5; wx <= 7.5; wx += 2.5) if (rnd() < 0.75) block(x + wx, h + 0.35, z - 7.6, 2.4, 1.2 + rnd() * 2.6, 0.9, (rnd() - 0.5) * 0.06);
    for (let i = 0; i < 16; i++) {
      const a = rnd() * 6.28, d = 7 + rnd() * 9, bx = x + Math.cos(a) * d, bz = z + Math.sin(a) * d, w = 0.7 + rnd() * 1.1;
      const gy = col.groundAt(bx, bz, 50);
      block(bx, gy - 0.25, bz, w, 0.5 + rnd() * 0.7, 0.6 + rnd() * 0.9, rnd() * 6.28, (rnd() - 0.5) * 0.5, (rnd() - 0.5) * 0.4, true);
    }
    // entry stair flanks (south side)
    block(x - 3.2, h + 0.35, z + 7.4, 1.2, 1.5, 2.2); block(x + 3.2, h + 0.35, z + 7.4, 1.2, 1.1, 2.2);
    A.ammo.push(new THREE.Vector3(x + 3, h + 0.7, z + 4)); A.med.push(new THREE.Vector3(x - 3.5, h + 0.7, z - 3.5));
  };

  // ------------------------------------------------------------ Relay Charlie: stone circle
  const circle = (s: Site) => {
    const { x, z, h } = s;
    const dais = new Geo();
    addTube(dais, [new THREE.Vector3(x, h - 0.5, z), new THREE.Vector3(x, h + 0.4, z)], [3.4, 3.2], { radial: 20, uRep: 8, vScale: 1.5, capEnd: true, col: () => [0.9, 0.9, 0.85] });
    const dm = new THREE.Mesh(dais.build(), brickMat); dm.receiveShadow = dm.castShadow = true; scene.add(dm);
    col.addCircle(x, z, 3.2, h - 1, h + 0.4, true);
    A.relays.push(new THREE.Vector3(x, h + 0.4, z));
    const N = 9; let prevTall: number[] | null = null;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 6.283 + 0.3, mx = x + Math.cos(a) * 8.5, mz = z + Math.sin(a) * 8.5, fallen = rnd() < 0.2, mh = 3.4 + rnd() * 1.8;
      const gy = heightAt(mx, mz);
      if (fallen) { block(mx, gy - 0.2, mz, 1.3, 0.9, mh, a + 0.5, 0.05, 0, true); prevTall = null; continue; }
      block(mx, gy - 0.5, mz, 1.4, mh + 0.5, 0.85, -a + Math.PI / 2, (rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.1);
      if (prevTall && rnd() < 0.7) {                                   // trilithon lintel
        const lx = (mx + prevTall[0]) / 2, lz = (mz + prevTall[1]) / 2, top = Math.min(gy + mh, prevTall[2]);
        block(lx, top - 0.05, lz, Math.hypot(mx - prevTall[0], mz - prevTall[1]) + 1.2, 0.7, 0.95, -Math.atan2(mz - prevTall[1], mx - prevTall[0]), 0, 0, false, false);
      }
      prevTall = [mx, mz, gy + mh];
    }
    A.ammo.push(new THREE.Vector3(x + 4.5, h, z + 3)); A.med.push(new THREE.Vector3(x - 4.5, h, z + 2.5));
  };

  // ------------------------------------------------------------ Relay Bravo: abandoned outpost
  const outpost = (s: Site) => {
    const { x, z, h } = s;
    const green: RGB = [0.9, 1, 0.9], rust: RGB = [1.1, 0.85, 0.7];
    const wall = (wx: number, wz: number, w: number, hh: number, d: number, c: RGB = green) => {
      addBox(metal, w, hh, d, trs(wx, h + hh / 2, wz), c, 0.35);
      col.addBox(wx, wz, w / 2, d / 2, 0, h - 0.5, h + hh);
    };
    // hut (6 x 5 m), door facing west (towards the yard and relay)
    const hx = x + 6, hz = z - 4;
    addBox(plain, 6.4, 0.16, 5.4, trs(hx, h + 0.08, hz), [0.25, 0.25, 0.24]);
    wall(hx, hz - 2.5, 6, 2.6, 0.12); wall(hx, hz + 2.5, 6, 2.6, 0.12); wall(hx + 3, hz, 0.12, 2.6, 5, rust);
    wall(hx - 3, hz - 1.7, 0.12, 2.6, 1.6); wall(hx - 3, hz + 1.7, 0.12, 2.6, 1.6);
    addBox(metal, 0.12, 0.6, 1.8, trs(hx - 3, h + 2.3, hz), green, 0.35);
    addBox(metal, 7.2, 0.08, 6.2, trs(hx, h + 2.85, hz, 0, 0, -0.12), rust, 0.35);                // tilted roof
    addBox(wood, 1.6, 0.8, 0.8, trs(hx + 2, h + 0.56, hz - 1.6), [1, 1, 1], 1);                  // table
    A.lamps.push({ pos: new THREE.Vector3(hx - 0.5, h + 2.3, hz), color: 0xffb060, intensity: 14, dist: 14 });
    A.med.push(new THREE.Vector3(hx + 1.5, h + 0.16, hz + 1.2)); A.ammo.push(new THREE.Vector3(hx + 1.2, h + 0.16, hz - 0.4));

    // watchtower
    const tx = x - 7, tz = z - 6;
    for (const [lx, lz] of [[-1.5, -1.5], [1.5, -1.5], [-1.5, 1.5], [1.5, 1.5]]) {
      addBox(wood, 0.22, 7.2, 0.22, trs(tx + lx, h + 3.6, tz + lz, 0, 0, 0), [0.7, 0.7, 0.7], 1);
      col.addBox(tx + lx, tz + lz, 0.14, 0.14, 0, h - 0.5, h + 7.2);
    }
    for (const [ry, ox, oz] of [[0, 0, -1.5], [0, 0, 1.5], [Math.PI / 2, -1.5, 0], [Math.PI / 2, 1.5, 0]]) {
      addBox(wood, 4.3, 0.1, 0.12, trs(tx + ox, h + 2.2, tz + oz, 0, ry, 0.78), [0.6, 0.6, 0.6], 1);
      addBox(wood, 4.3, 0.1, 0.12, trs(tx + ox, h + 4.9, tz + oz, 0, ry, -0.78), [0.6, 0.6, 0.6], 1);
      addBox(wood, 3.8, 0.9, 0.06, trs(tx + ox * 1.2, h + 7.75, tz + oz * 1.2, 0, ry, 0), [0.8, 0.8, 0.8], 1);   // parapet
    }
    addBox(wood, 3.9, 0.14, 3.9, trs(tx, h + 7.2, tz), [0.8, 0.8, 0.8], 1);
    addBox(metal, 4.6, 0.07, 4.6, trs(tx, h + 9.6, tz, 0.08, 0, 0.06), rust, 0.35);
    for (const [lx, lz] of [[-1.7, -1.7], [1.7, -1.7], [-1.7, 1.7], [1.7, 1.7]]) addBox(wood, 0.1, 2.4, 0.1, trs(tx + lx, h + 8.4, tz + lz), [0.6, 0.6, 0.6], 1);

    // antenna mast with blinking beacon
    const ax = x + 9.5, az = z + 5;
    addTube(metal, [new THREE.Vector3(ax, h - 0.3, az), new THREE.Vector3(ax, h + 13, az)], [0.09, 0.04], { radial: 6, col: () => [0.6, 0.6, 0.6] });
    for (const yy of [5, 9, 12]) addBox(metal, 1.6 - yy * 0.08, 0.04, 0.04, trs(ax, h + yy, az, 0, yy), [0.6, 0.6, 0.6]);
    col.addCircle(ax, az, 0.15, h - 1, h + 13);
    const blink = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshBasicMaterial({ color: new THREE.Color(6, 0.3, 0.2) }));
    blink.position.set(ax, h + 13.1, az); scene.add(blink); A.blinkers.push(blink);

    // crates, sandbags, barrels
    const crate = (cx: number, cz: number, cy = 0, sz = 1, ry = rnd() * 0.6) => {
      addBox(wood, sz, sz, sz, trs(cx, h + cy + sz / 2, cz, 0, ry, 0), [0.9 + rnd() * 0.2, 0.9, 0.85], 1 / sz);
      col.addBox(cx, cz, sz / 2, sz / 2, -ry, h + cy - 0.5, h + cy + sz, true);
    };
    crate(x - 2.5, z + 6); crate(x - 3.7, z + 6.3); crate(x - 3.1, z + 6.1, 1, 0.9); crate(x + 2, z + 7.5, 0, 1.2); crate(x - 9, z + 2.5); crate(x + 1, z - 8.5, 0, 0.9);
    // concrete barricades
    const bags = (bx: number, bz: number, ry: number, len: number) => {
      addBox(stone, len * 0.72, 1.0, 0.5, trs(bx, h + 0.45, bz, 0, ry, 0), [0.85, 0.85, 0.8], 0.5);
      addBox(stone, len * 0.72 + 0.1, 0.25, 0.75, trs(bx, h + 0.1, bz, 0, ry, 0), [0.7, 0.7, 0.66], 0.5);
      col.addBox(bx, bz, len * 0.36, 0.28, -ry, h - 0.5, h + 0.95, true);
    };
    bags(x - 5, z + 10.5, 0.15, 6); bags(x + 4.5, z + 10.8, -0.2, 5); bags(x - 11.5, z + 5, 1.4, 5); bags(x - 2, z - 11, 0.1, 6);
    for (const [bx, bz] of [[-6.5, -1.5], [-7.4, -1.1], [3.5, 3.2], [9, -9], [-1, -9.3]]) A.barrels.push(new THREE.Vector3(x + bx, h, z + bz));
    // floodlight pole
    addBox(metal, 0.12, 4.6, 0.12, trs(x - 1, h + 2.3, z + 9.2), [0.6, 0.6, 0.6]);
    addBox(metal, 0.5, 0.3, 0.3, trs(x - 1, h + 4.6, z + 9.0, 0.5), [0.5, 0.5, 0.5]);
    col.addBox(x - 1, z + 9.2, 0.1, 0.1, 0, h - 1, h + 4.6);
    A.lamps.push({ pos: new THREE.Vector3(x - 1, h + 4.3, z + 8.6), color: 0xfff0c8, intensity: 26, dist: 20 });
    A.relays.push(new THREE.Vector3(x - 1, h, z + 1));
  };

  // ------------------------------------------------------------ extraction pad & insertion point
  const extract = (s: Site) => {
    const { x, z, h } = s;
    const pad = new Geo();
    addTube(pad, [new THREE.Vector3(x, h - 0.4, z), new THREE.Vector3(x, h + 0.12, z)], [5.2, 5.0], { radial: 28, uRep: 12, vScale: 1.5, capEnd: true, col: () => [0.75, 0.75, 0.72] });
    const pm = new THREE.Mesh(pad.build(), brickMat); pm.receiveShadow = true; scene.add(pm);
    col.addCircle(x, z, 5.0, h - 1, h + 0.12, true);
    // painted landing marks
    for (let i = 0; i < 8; i++) { const a = (i / 8) * 6.283; addBox(plain, 0.9, 0.02, 0.28, trs(x + Math.cos(a) * 4.1, h + 0.13, z + Math.sin(a) * 4.1, 0, -a + Math.PI / 2), [1.6, 1.3, 0.25]); }
    addBox(plain, 0.35, 0.02, 2.4, trs(x - 0.8, h + 0.13, z), [1.3, 1.3, 1.2]); addBox(plain, 0.35, 0.02, 2.4, trs(x + 0.8, h + 0.13, z), [1.3, 1.3, 1.2]); addBox(plain, 1.6, 0.02, 0.35, trs(x, h + 0.13, z), [1.3, 1.3, 1.2]);
    A.extract.set(x, h + 0.12, z);
    A.med.push(new THREE.Vector3(x + 3, h + 0.12, z + 2)); A.ammo.push(new THREE.Vector3(x - 3, h + 0.12, z + 2));
  };
  const start = (s: Site) => {
    const { x, z, h } = s;
    A.start.set(x, h, z);
    // supply drop: a couple of crates and a lantern
    addBox(wood, 1, 1, 1, trs(x + 2.6, h + 0.5, z + 1.2, 0, 0.4), [1, 1, 1], 1); col.addBox(x + 2.6, z + 1.2, 0.5, 0.5, -0.4, h - 0.5, h + 1, true);
    addBox(wood, 0.8, 0.8, 0.8, trs(x + 3.5, h + 0.4, z + 0.2, 0, 0.1), [0.9, 0.9, 0.85], 1.25); col.addBox(x + 3.5, z + 0.2, 0.4, 0.4, -0.1, h - 0.5, h + 0.8, true);
    A.ammo.push(new THREE.Vector3(x + 1.6, h, z - 0.4));
  };

  for (const s of SITES) {
    if (s.kind === 'temple') temple(s); else if (s.kind === 'outpost') outpost(s);
    else if (s.kind === 'circle') circle(s); else if (s.kind === 'extract') extract(s); else start(s);
  }

  // ------------------------------------------------------------ small forgotten ruins in the undergrowth
  for (let n = 0, tries = 0; n < 7 && tries < 400; tries++) {
    const a = rnd() * 6.283, r = 20 + rnd() * 62, x = Math.cos(a) * r, z = Math.sin(a) * r;
    let bad = creekDist(x, z) < 8; for (const s of SITES) if (Math.hypot(x - s.x, z - s.z) < s.r * 1.6) bad = true;
    if (bad) continue;
    const ry = rnd() * 6.28, c = Math.cos(ry), sn = Math.sin(ry);
    for (let i = 0; i < 5; i++) {
      const o = (i - 2) * 2.3, bx = x + c * o, bz = z - sn * o;
      if (rnd() < 0.3) continue;
      const gy = heightAt(bx, bz);
      if (i % 2 === 0) block(bx, gy - 0.4, bz, 0.95, 1.6 + rnd() * 3.2, 0.95, ry + (rnd() - 0.5) * 0.1, (rnd() - 0.5) * 0.1, (rnd() - 0.5) * 0.1);
      else block(bx, gy - 0.4, bz, 2.3, 0.9 + rnd() * 1.4, 0.8, ry);
    }
    for (let i = 0; i < 4; i++) { const bx = x + (rnd() - 0.5) * 9, bz = z + (rnd() - 0.5) * 9; block(bx, heightAt(bx, bz) - 0.25, bz, 0.7 + rnd(), 0.6, 0.6 + rnd() * 0.6, rnd() * 6, (rnd() - 0.5) * 0.5, 0, true); }
    if (n % 2 === 0) A.ammo.push(new THREE.Vector3(x + c * 1.2 + sn * 1.5, 0, z - sn * 1.2 + c * 1.5)); else A.med.push(new THREE.Vector3(x + sn * 1.5, 0, z + c * 1.5));
    n++;
  }
  for (const p of [...A.ammo, ...A.med]) if (p.y === 0) p.y = heightAt(p.x, p.z);

  const add = (g: Geo, m: THREE.Material) => { if (!g.count) return; const mesh = new THREE.Mesh(g.build(), m); mesh.castShadow = mesh.receiveShadow = true; scene.add(mesh); };
  add(stone, brickMat); add(metal, metalMat); add(wood, woodMat); add(plain, plainMat);
  void WATER_Y;
  return A;
}
