// Procedural vegetation: branching trees, palms, ferns, vines and undergrowth.
// A handful of unique meshes are generated per species and then instanced
// thousands of times, grouped into grid cells for culling.
import * as THREE from 'three';
import { mulberry32, Rng, fbm } from '../core/math';
import { Geo, addTube, RGB, InstanceBatcher, trs } from './geo';
import { heightAt, creekDist, SITES, WORLD_R, WATER_Y, SUN } from './layout';
import type { TextureSet } from './textures';
import type { ColliderWorld } from './colliders';

/** Shared clock uniform for all wind-animated materials. */
export const windTime = { value: 0 };

// ---------------------------------------------------------------- materials
/** Alpha-tested foliage material: vertex wind sway, soft "blob" normals that are
 *  not flipped on back faces, and a cheap back-lit translucency term. */
export function foliageMaterial(map: THREE.Texture, wind: number, transl: number, rough = 0.72): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.42, side: THREE.DoubleSide, vertexColors: true, roughness: rough, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = windTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nattribute float aWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 wp = (instanceMatrix * vec4(position, 1.0)).xyz;
        #else
          vec3 wp = position;
        #endif
        float ph = dot(wp, vec3(0.31, 0.17, 0.23));
        float gust = 0.6 + 0.4 * sin(uTime * 0.31 + wp.x * 0.04 + wp.z * 0.03);
        transformed += vec3(sin(uTime * 1.3 + ph), 0.45 * sin(uTime * 1.9 + ph * 1.7), cos(uTime * 1.1 + ph * 0.9))
                       * aWind * gust * ${wind.toFixed(3)};`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        #ifdef DOUBLE_SIDED
          normal *= faceDirection;   // undo the back-face flip: leaves are lit as a soft volume
        #endif`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        vec3 sunV = normalize((viewMatrix * vec4(${SUN.x.toFixed(4)}, ${SUN.y.toFixed(4)}, ${SUN.z.toFixed(4)}, 0.0)).xyz);
        float tr = pow(max(dot(normalize(-vViewPosition), sunV), 0.0), 3.0);
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.95, 0.45) * tr * ${transl.toFixed(3)};`);
  };
  m.customProgramCacheKey = () => `foliage_${wind}_${transl}`;
  return m;
}

// ---------------------------------------------------------------- tree generator
interface TreeParams {
  trunkH: number; trunkR: number; trunkSegs: number; radial: number; wiggle: number;
  crownStart: number; mainBranches: number; branchLen: number; spread: number; depth: number;
  leafSize: number; leavesPerTwig: number; flare: number; lean: number;
}
export interface TreeMesh { bark: THREE.BufferGeometry; leaves: THREE.BufferGeometry; trunkR: number; height: number; crownY: number; crownR: number; }

const UP = new THREE.Vector3(0, 1, 0);

function genTree(P: TreeParams, rnd: Rng): TreeMesh {
  const bark = new Geo(), leaf = new Geo();
  const crownC = new THREE.Vector3(0, P.trunkH * 0.92, 0);
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpN = new THREE.Vector3(), out = new THREE.Vector3();
  let maxY = 0, crownR = 0;

  const card = (c: THREE.Vector3, size: number) => {
    // random orientation, biased to face up/down so the canopy reads from the forest floor
    tmpN.set((rnd() - 0.5) * 1.6, 0.45 + rnd(), (rnd() - 0.5) * 1.6).normalize();
    tmpA.set(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).cross(tmpN).normalize();
    tmpB.crossVectors(tmpN, tmpA);
    // shading normal bulges away from the crown centre
    out.subVectors(c, crownC).normalize().multiplyScalar(0.7).addScaledVector(UP, 0.65).addScaledVector(tmpN, 0.25).normalize();
    const s = size * 0.5, tint = 0.72 + rnd() * 0.4;
    const col: RGB = [tint * (0.9 + rnd() * 0.25), tint, tint * (0.8 + rnd() * 0.3)];
    const i0 = leaf.count;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      leaf.vert(c.x + tmpA.x * s * su + tmpB.x * s * sv, c.y + tmpA.y * s * su + tmpB.y * s * sv, c.z + tmpA.z * s * su + tmpB.z * s * sv,
        out.x, out.y, out.z, su * 0.5 + 0.5, sv * 0.5 + 0.5, col, 1);
    }
    leaf.quad(i0, i0 + 1, i0 + 2, i0 + 3);
    maxY = Math.max(maxY, c.y + s); crownR = Math.max(crownR, Math.hypot(c.x, c.z) + s * 0.6);
  };

  const grow = (start: THREE.Vector3, dir: THREE.Vector3, len: number, r0: number, depth: number) => {
    const n = depth === 0 ? P.trunkSegs : depth >= P.depth ? 2 : depth === 1 ? 4 : 3;
    const pts = [start.clone()], radii = [r0];
    const p = start.clone(), d = dir.clone();
    const taper = depth === 0 ? 0.5 : 0.72, wig = depth === 0 ? P.wiggle : 0.34;
    for (let i = 1; i <= n; i++) {
      d.x += (rnd() - 0.5) * wig; d.z += (rnd() - 0.5) * wig;
      if (depth > 0) d.y += 0.05 + (rnd() - 0.5) * 0.22;
      d.normalize();
      p.addScaledVector(d, len / n);
      pts.push(p.clone()); radii.push(r0 * (1 - (taper * i) / n));
    }
    const shade = depth === 0 ? 1 : 0.8;
    addTube(bark, pts, radii, {
      radial: depth === 0 ? P.radial : depth === 1 ? 5 : 3,
      uRep: depth === 0 ? 3 : 1, vScale: depth === 0 ? 3 : 1.5,
      col: (t) => {
        const moss = depth === 0 ? Math.max(0, 1 - t * 7) : 0;   // green, damp trunk bases
        return [shade * (1 - moss * 0.45), shade * (1 - moss * 0.1), shade * (1 - moss * 0.6)];
      },
      flare: depth === 0 && P.flare > 0
        ? (t, a) => 1 + P.flare * Math.pow(1 - t, 7) * (0.35 + Math.pow(Math.abs(Math.cos(a * 2.5 + 0.7)), 3))
        : undefined,
    });
    const pointAt = (t: number, o: THREE.Vector3) => {
      const f = Math.min(n - 0.001, t * n), i = Math.floor(f);
      return o.lerpVectors(pts[i], pts[i + 1], f - i);
    };
    if (depth < P.depth) {
      const kids = depth === 0 ? P.mainBranches : 2 + (rnd() < 0.55 ? 1 : 0);
      const azOff = rnd() * 6.28;
      for (let c = 0; c < kids; c++) {
        const t = depth === 0 ? P.crownStart + (1 - P.crownStart) * ((c + rnd() * 0.8) / kids) : 0.35 + 0.65 * rnd();
        const at = pointAt(t, new THREE.Vector3());
        const az = azOff + (c / kids) * Math.PI * 2 + (rnd() - 0.5) * 0.9;
        const sp = depth === 0 ? P.spread * (0.8 + rnd() * 0.4) : 0.55 + rnd() * 0.55;
        tmpA.set(Math.abs(d.y) > 0.9 ? 1 : 0, Math.abs(d.y) > 0.9 ? 0 : 1, 0).cross(d).normalize();
        tmpB.crossVectors(d, tmpA);
        const nd = d.clone().multiplyScalar(Math.cos(sp)).addScaledVector(tmpA, Math.cos(az) * Math.sin(sp)).addScaledVector(tmpB, Math.sin(az) * Math.sin(sp)).normalize();
        const rAt = r0 * (1 - taper * t);
        grow(at, nd, (depth === 0 ? P.branchLen : len * 0.62) * (0.8 + rnd() * 0.4), rAt * (depth === 0 ? 0.42 : 0.6), depth + 1);
      }
    }
    if (depth >= P.depth - 1) {
      const cnt = depth >= P.depth ? P.leavesPerTwig : Math.ceil(P.leavesPerTwig / 2);
      for (let k = 0; k < cnt; k++) {
        const c = pointAt(0.35 + 0.65 * rnd(), new THREE.Vector3());
        c.x += (rnd() - 0.5) * P.leafSize * 0.7; c.y += (rnd() - 0.3) * P.leafSize * 0.4; c.z += (rnd() - 0.5) * P.leafSize * 0.7;
        card(c, P.leafSize * (0.75 + rnd() * 0.5));
      }
    }
    if (depth === 0 || depth >= P.depth) card(p.clone(), P.leafSize * 1.1);
  };

  grow(new THREE.Vector3(0, -0.6, 0), new THREE.Vector3(P.lean * (rnd() - 0.5), 1, P.lean * (rnd() - 0.5)).normalize(), P.trunkH + 0.6, P.trunkR, 0);
  return { bark: bark.build(), leaves: leaf.build(), trunkR: P.trunkR, height: maxY, crownY: P.trunkH * P.crownStart, crownR };
}

/** Fronds arching out of a crown point: palms, tree ferns, ferns, banana plants. */
interface RosetteParams { count: number; len: number; width: number; segs: number; rise: number; droop: number; fold: number; }
function addRosette(g: Geo, origin: THREE.Vector3, P: RosetteParams, rnd: Rng) {
  for (let f = 0; f < P.count; f++) {
    const az = (f / P.count) * Math.PI * 2 + rnd() * 0.7;
    let ang = P.rise * (0.65 + 0.6 * rnd());
    const len = P.len * (0.75 + 0.5 * rnd()), ca = Math.cos(az), sa = Math.sin(az);
    const tint = 0.75 + rnd() * 0.4, col: RGB = [tint, tint, tint * 0.9];
    let px = origin.x, py = origin.y, pz = origin.z, prev = -1;
    for (let s = 0; s <= P.segs; s++) {
      const t = s / P.segs, c = Math.cos(ang), sn = Math.sin(ang);
      // local frame: forward f = (ca*c, sn, sa*c), side = (-sa, 0, ca), normal = (-ca*sn, c, -sa*sn)
      const nx = -ca * sn, ny = c, nz = -sa * sn, hw = P.width * 0.5, fh = P.fold * P.width;
      const cur = g.count;
      g.vert(px + sa * hw + nx * fh, py + ny * fh, pz - ca * hw + nz * fh, nx - sa * 0.35, ny, nz + ca * 0.35, 0, t, col, t * t);
      g.vert(px, py, pz, nx, ny, nz, 0.5, t, col, t * t);
      g.vert(px - sa * hw + nx * fh, py + ny * fh, pz + ca * hw + nz * fh, nx + sa * 0.35, ny, nz - ca * 0.35, 1, t, col, t * t);
      if (prev >= 0) { g.quad(prev, prev + 1, cur + 1, cur); g.quad(prev + 1, prev + 2, cur + 2, cur + 1); }
      prev = cur;
      const step = len / P.segs;
      px += ca * c * step; py += sn * step; pz += sa * c * step;
      ang -= (P.droop * (0.8 + 0.4 * rnd()) / P.segs) * (0.6 + t * 1.2);
    }
  }
}

function genPalm(rnd: Rng, h: number, r: number, frond: RosetteParams): TreeMesh {
  const bark = new Geo(), leaf = new Geo();
  const pts: THREE.Vector3[] = [], radii: number[] = [];
  const lx = (rnd() - 0.5) * 2.2, lz = (rnd() - 0.5) * 2.2;
  for (let i = 0; i <= 7; i++) {
    const t = i / 7;
    pts.push(new THREE.Vector3(lx * t * t, -0.4 + (h + 0.4) * t, lz * t * t));
    radii.push(r * (1.25 - 0.5 * t) * (i === 0 ? 1.5 : 1));
  }
  addTube(bark, pts, radii, { radial: 6, uRep: 1, vScale: 0.9, col: (t) => [0.75 - t * 0.15, 0.7 - t * 0.1, 0.6] });
  addRosette(leaf, pts[7], frond, rnd);
  return { bark: bark.build(), leaves: leaf.build(), trunkR: r, height: h + 2, crownY: h, crownR: frond.len };
}

function genRosette(P: RosetteParams, rnd: Rng): THREE.BufferGeometry {
  const g = new Geo(); addRosette(g, new THREE.Vector3(0, 0.02, 0), P, rnd); return g.build();
}

/** Crossed quads for grass tufts. */
function genGrass(): THREE.BufferGeometry {
  const g = new Geo();
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI, ca = Math.cos(a) * 0.55, sa = Math.sin(a) * 0.55, i0 = g.count;
    g.vert(-ca, 0, -sa, 0, 1, 0, 0, 0, [1, 1, 1], 0); g.vert(ca, 0, sa, 0, 1, 0, 1, 0, [1, 1, 1], 0);
    g.vert(ca, 0.9, sa, 0, 1, 0, 1, 1, [1, 1, 1], 1); g.vert(-ca, 0.9, -sa, 0, 1, 0, 0, 1, [1, 1, 1], 1);
    g.quad(i0, i0 + 1, i0 + 2, i0 + 3);
  }
  return g.build();
}

/** Two crossed hanging ribbons, 8 m long, origin at the top. */
function genVine(): THREE.BufferGeometry {
  const g = new Geo(), L = 8, SEG = 8;
  for (let k = 0; k < 2; k++) {
    const ca = k === 0 ? 0.3 : 0, sa = k === 0 ? 0 : 0.3;
    let prev = -1;
    for (let s = 0; s <= SEG; s++) {
      const t = s / SEG, cur = g.count, w = t * t;
      g.vert(-ca, -L * t, -sa, sa * 3, 0.3, ca * 3, 0, t * 4, [1, 1, 1], w);
      g.vert(ca, -L * t, sa, sa * 3, 0.3, ca * 3, 1, t * 4, [1, 1, 1], w);
      if (prev >= 0) g.quad(prev, prev + 1, cur + 1, cur);
      prev = cur;
    }
  }
  return g.build();
}

// ---------------------------------------------------------------- placement
export interface FloraResult { distCulled: THREE.InstancedMesh[]; bigTrees: { x: number; y: number; z: number; s: number; mesh: TreeMesh }[]; }

export function buildFlora(scene: THREE.Object3D, tex: TextureSet, colliders: ColliderWorld, density: number): FloraResult {
  const rnd = mulberry32(1337);
  const barkMat = new THREE.MeshStandardMaterial({ map: tex.bark.map, bumpMap: tex.bark.bump, bumpScale: 2.5, vertexColors: true, roughness: 0.93 });
  const canopyMat = foliageMaterial(tex.cluster, 0.10, 0.5);
  const canopyMat2 = foliageMaterial(tex.cluster2, 0.08, 0.5);
  const palmMat = foliageMaterial(tex.palm, 0.09, 0.4, 0.6);
  const fernMat = foliageMaterial(tex.fern, 0.035, 0.12);
  const broadMat = foliageMaterial(tex.broad, 0.05, 0.3, 0.5);
  const grassMat = foliageMaterial(tex.grass, 0.05, 0.1);
  const vineMat = foliageMaterial(tex.vine, 0.22, 0.25);

  // --- unique meshes
  const bigP = (): TreeParams => ({ trunkH: 17 + rnd() * 6, trunkR: 0.55 + rnd() * 0.25, trunkSegs: 9, radial: 10, wiggle: 0.05, crownStart: 0.66, mainBranches: 6, branchLen: 6.5, spread: 1.05, depth: 3, leafSize: 4.2, leavesPerTwig: 4, flare: 1.6, lean: 0.12 });
  const midP = (): TreeParams => ({ trunkH: 7.5 + rnd() * 3.5, trunkR: 0.2 + rnd() * 0.09, trunkSegs: 7, radial: 7, wiggle: 0.16, crownStart: 0.5, mainBranches: 4, branchLen: 3.4, spread: 0.95, depth: 2, leafSize: 3.0, leavesPerTwig: 4, flare: 0.5, lean: 0.35 });
  const big = [genTree(bigP(), rnd), genTree(bigP(), rnd)];
  const mid = [genTree(midP(), rnd), genTree(midP(), rnd)];
  const palmFrond: RosetteParams = { count: 13, len: 3.6, width: 1.25, segs: 5, rise: 0.75, droop: 1.9, fold: 0.12 };
  const palms = [genPalm(rnd, 8.5, 0.17, palmFrond), genPalm(rnd, 6.2, 0.15, palmFrond)];
  const treeFern = genPalm(rnd, 2.6, 0.12, { count: 9, len: 2.3, width: 0.8, segs: 5, rise: 0.6, droop: 1.7, fold: 0.08 });
  const fernGeo = genRosette({ count: 6, len: 1.25, width: 0.52, segs: 3, rise: 0.95, droop: 1.6, fold: 0.07 }, rnd);
  const bananaGeo = genRosette({ count: 6, len: 2.3, width: 0.85, segs: 4, rise: 1.2, droop: 1.3, fold: 0.1 }, rnd);
  const grassGeo = genGrass(), vineGeo = genVine();

  const trees = new InstanceBatcher(88), under = new InstanceBatcher(44);
  const placed: { x: number; z: number; r: number }[] = [];
  const bigTrees: FloraResult['bigTrees'] = [];

  /** Can a plant stand here? `clear` scales the clearings kept around sites. */
  const ok = (x: number, z: number, minD: number, clear: number, maxR: number): boolean => {
    const r = Math.hypot(x, z);
    if (r > maxR) return false;
    if (r < WORLD_R + 2 && creekDist(x, z) < 4.2) return false;
    for (const s of SITES) if (Math.hypot(x - s.x, z - s.z) < s.r * clear) return false;
    for (const p of placed) { const d = minD + p.r; if ((p.x - x) ** 2 + (p.z - z) ** 2 < d * d) return false; }
    return true;
  };
  const tint = (lo: number, hi: number) => { const v = lo + rnd() * (hi - lo); return new THREE.Color(v * (0.9 + rnd() * 0.2), v, v * (0.85 + rnd() * 0.25)); };

  // --- emergent giants with buttress roots
  for (let n = 0, tries = 0; n < 185 && tries < 9000; tries++) {
    const x = (rnd() - 0.5) * 262, z = (rnd() - 0.5) * 262;
    if (!ok(x, z, 6.5, 0.95, 130)) continue;
    const v = Math.floor(rnd() * big.length), s = 0.85 + rnd() * 0.45, y = heightAt(x, z);
    const m = trs(x, y, z, 0, rnd() * 6.28, 0, s);
    trees.add('bigB' + v, big[v].bark, barkMat, m, null, true);
    trees.add('bigL' + v, big[v].leaves, v === 1 ? canopyMat2 : canopyMat, m, tint(0.78, 1.08), true);
    placed.push({ x, z, r: 1.2 });
    if (Math.hypot(x, z) < WORLD_R + 6) colliders.addCircle(x, z, big[v].trunkR * s * 1.35, y - 2, y + big[v].height * s);
    bigTrees.push({ x, y, z, s, mesh: big[v] });
    n++;
  }
  // --- mid-storey trees
  for (let n = 0, tries = 0; n < Math.floor(430 * density) && tries < 20000; tries++) {
    const x = (rnd() - 0.5) * 256, z = (rnd() - 0.5) * 256;
    if (!ok(x, z, 2.6, 0.85, 127)) continue;
    const v = Math.floor(rnd() * mid.length), s = 0.8 + rnd() * 0.55, y = heightAt(x, z);
    const m = trs(x, y, z, 0, rnd() * 6.28, 0, s);
    trees.add('midB' + v, mid[v].bark, barkMat, m, null, true);
    trees.add('midL' + v, mid[v].leaves, v === 0 ? canopyMat2 : canopyMat, m, tint(0.8, 1.15), true);
    placed.push({ x, z, r: 0.4 });
    if (Math.hypot(x, z) < WORLD_R + 6) colliders.addCircle(x, z, mid[v].trunkR * s * 1.15, y - 2, y + mid[v].height * s);
    n++;
  }
  // --- palms (denser along the creek) and tree ferns
  for (let n = 0, tries = 0; n < Math.floor(210 * density) && tries < 20000; tries++) {
    const x = (rnd() - 0.5) * 230, z = (rnd() - 0.5) * 230;
    if (creekDist(x, z) > 16 && rnd() < 0.6) continue;
    if (!ok(x, z, 2.2, 0.7, 118)) continue;
    const isFern = rnd() < 0.4, v = Math.floor(rnd() * 2), tm = isFern ? treeFern : palms[v];
    const s = 0.8 + rnd() * 0.5, y = heightAt(x, z), m = trs(x, y, z, 0, rnd() * 6.28, 0, s);
    const id = isFern ? 'tf' : 'palm' + v;
    trees.add(id + 'B', tm.bark, barkMat, m, null, true);
    trees.add(id + 'L', tm.leaves, isFern ? fernMat : palmMat, m, tint(0.8, 1.15), true);
    placed.push({ x, z, r: 0.3 });
    if (Math.hypot(x, z) < WORLD_R + 4) colliders.addCircle(x, z, tm.trunkR * s * 1.3, y - 2, y + tm.crownY * s);
    n++;
  }

  // --- hanging vines under the giants' crowns
  for (const t of bigTrees) {
    if (Math.hypot(t.x, t.z) > WORLD_R + 15) continue;
    const cnt = 2 + Math.floor(rnd() * 5);
    for (let i = 0; i < cnt; i++) {
      const a = rnd() * 6.28, d = (0.25 + rnd() * 0.6) * t.mesh.crownR * t.s;
      const x = t.x + Math.cos(a) * d, z = t.z + Math.sin(a) * d;
      const top = t.y + t.mesh.crownY * t.s + rnd() * 3, g = heightAt(x, z);
      const len = Math.min(top - g - 1.6 - rnd() * 3, 5 + rnd() * 9);
      if (len < 3) continue;
      trees.add('vine', vineGeo, vineMat, trs(x, top, z, 0, rnd() * 6.28, 0, 0.8 + rnd() * 0.5, len / 8, 0.8 + rnd() * 0.5), tint(0.8, 1.1), false);
    }
  }
  trees.build(scene);

  // --- lianas: sagging ropes slung between neighbouring giants (one merged mesh)
  const lg = new Geo();
  let lianas = 0;
  for (let i = 0; i < bigTrees.length && lianas < 46; i++) for (let j = i + 1; j < bigTrees.length && lianas < 46; j++) {
    const a = bigTrees[i], b = bigTrees[j], d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d > 17 || d < 8 || rnd() < 0.55 || Math.hypot(a.x, a.z) > WORLD_R + 10) continue;
    const ya = a.y + 7 + rnd() * 8, yb = b.y + 7 + rnd() * 8, sag = 2 + rnd() * 3.5;
    const pts: THREE.Vector3[] = [], radii: number[] = [];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      pts.push(new THREE.Vector3(a.x + (b.x - a.x) * t + Math.sin(t * 9) * 0.15, ya + (yb - ya) * t - Math.sin(t * Math.PI) * sag, a.z + (b.z - a.z) * t + Math.cos(t * 7) * 0.15));
      radii.push(0.045 + 0.02 * Math.sin(t * 20));
    }
    addTube(lg, pts, radii, { radial: 4, vScale: 0.6, col: () => [0.55, 0.6, 0.4] });
    lianas++;
  }
  const lianaMesh = new THREE.Mesh(lg.build(), barkMat);
  lianaMesh.castShadow = true; lianaMesh.receiveShadow = true; scene.add(lianaMesh);

  // --- undergrowth: ferns, broad-leaf plants, grass. Clumped with low-frequency noise.
  const scatter = (count: number, maxR: number, fn: (x: number, z: number, y: number, dens: number) => void, clear = 0.45) => {
    for (let n = 0, tries = 0; n < count && tries < count * 6; tries++) {
      const a = rnd() * 6.283, r = Math.sqrt(rnd()) * maxR, x = Math.cos(a) * r, z = Math.sin(a) * r;
      const y = heightAt(x, z);
      if (y < WATER_Y + 0.12) continue;
      let blocked = false;
      for (const s of SITES) if (Math.hypot(x - s.x, z - s.z) < s.r * clear) { blocked = true; break; }
      if (blocked) continue;
      const dens = fbm(x * 0.045 + 5, z * 0.045 + 9, 3);
      if (rnd() > dens * 1.7 - 0.25) continue;
      fn(x, z, y, dens); n++;
    }
  };
  scatter(Math.floor(4800 * density), 110, (x, z, y) => {
    const s = 0.7 + rnd() * 0.9;
    under.add('fern', fernGeo, fernMat, trs(x, y, z, (rnd() - 0.5) * 0.2, rnd() * 6.28, (rnd() - 0.5) * 0.2, s), tint(0.75, 1.2), false, 64);
  });
  scatter(Math.floor(1500 * density), 108, (x, z, y) => {
    const s = 0.6 + rnd() * 0.8;
    under.add('banana', bananaGeo, broadMat, trs(x, y, z, 0, rnd() * 6.28, 0, s), tint(0.8, 1.2), false, 90);
  });
  scatter(Math.floor(15000 * density), 104, (x, z, y) => {
    const s = 0.5 + rnd() * 0.7;
    under.add('grass', grassGeo, grassMat, trs(x, y - 0.03, z, 0, rnd() * 6.28, 0, s, s * (0.6 + rnd() * 0.6), s), tint(0.62, 1.0), false, 46);
  }, 0.3);
  const distCulled = under.build(scene);

  return { distCulled, bigTrees };
}
