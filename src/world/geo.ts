// Minimal mesh builder used by the procedural generators (trees, plants, ruins).
import * as THREE from 'three';

export type RGB = [number, number, number];

export class Geo {
  p: number[] = []; n: number[] = []; uv: number[] = []; c: number[] = []; w: number[] = []; i: number[] = [];
  get count() { return this.p.length / 3; }

  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, col: RGB, wind = 0): number {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.uv.push(u, v); this.c.push(col[0], col[1], col[2]); this.w.push(wind);
    return this.count - 1;
  }
  quad(a: number, b: number, c: number, d: number) { this.i.push(a, b, c, a, c, d); }
  tri(a: number, b: number, c: number) { this.i.push(a, b, c); }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.w, 1));
    g.setIndex(this.i);
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}

const _t = new THREE.Vector3(), _n = new THREE.Vector3(), _b = new THREE.Vector3(), _ref = new THREE.Vector3();

export interface TubeOpts {
  radial: number; uRep?: number; vScale?: number;
  col?: (t: number) => RGB;
  flare?: (t: number, ang: number) => number;   // radius multiplier
  capEnd?: boolean; capStart?: boolean;
}

/** Sweep a ring along a polyline (trunks, branches, lianas, pipes). */
export function addTube(g: Geo, pts: THREE.Vector3[], radii: number[], o: TubeOpts) {
  const n = pts.length, R = o.radial, uRep = o.uRep ?? 1, vScale = o.vScale ?? 2;
  let vAcc = 0, prev = -1;
  const firstRing = g.count;
  for (let k = 0; k < n; k++) {
    _t.subVectors(pts[Math.min(k + 1, n - 1)], pts[Math.max(k - 1, 0)]).normalize();
    _ref.set(Math.abs(_t.y) > 0.9 ? 1 : 0, Math.abs(_t.y) > 0.9 ? 0 : 1, 0);
    _n.crossVectors(_t, _ref).normalize(); _b.crossVectors(_t, _n);
    if (k > 0) vAcc += pts[k].distanceTo(pts[k - 1]);
    const t = k / (n - 1), col = o.col ? o.col(t) : ([1, 1, 1] as RGB), cur = g.count;
    for (let j = 0; j <= R; j++) {
      const a = (j / R) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      const dx = _n.x * ca + _b.x * sa, dy = _n.y * ca + _b.y * sa, dz = _n.z * ca + _b.z * sa;
      const rr = radii[k] * (o.flare ? o.flare(t, a) : 1);
      g.vert(pts[k].x + dx * rr, pts[k].y + dy * rr, pts[k].z + dz * rr, dx, dy, dz, (j / R) * uRep, vAcc / vScale, col);
    }
    if (prev >= 0) for (let j = 0; j < R; j++) g.quad(prev + j, prev + j + 1, cur + j + 1, cur + j);
    prev = cur;
  }
  const cap = (k: number, sign: number) => {
    const dir = _t.subVectors(pts[Math.min(k + 1, n - 1)], pts[Math.max(k - 1, 0)]).normalize().multiplyScalar(sign);
    const col = o.col ? o.col(k / (n - 1)) : ([1, 1, 1] as RGB);
    const ring = (sign > 0 ? prev : firstRing), c = g.vert(pts[k].x, pts[k].y, pts[k].z, dir.x, dir.y, dir.z, 0.5, 0.5, col);
    const first = g.count;
    for (let j = 0; j <= R; j++) {
      const s = ring + j;
      g.vert(g.p[s * 3], g.p[s * 3 + 1], g.p[s * 3 + 2], dir.x, dir.y, dir.z, 0.5 + 0.5 * Math.cos((j / R) * 6.283), 0.5 + 0.5 * Math.sin((j / R) * 6.283), col);
    }
    for (let j = 0; j < R; j++) sign > 0 ? g.tri(c, first + j, first + j + 1) : g.tri(c, first + j + 1, first + j);
  };
  if (o.capEnd) cap(n - 1, 1);
  if (o.capStart) cap(0, -1);
}

const FACES: [number[], number[], number[]][] = [
  [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
];
const _v = new THREE.Vector3(), _nn = new THREE.Vector3(), _nm = new THREE.Matrix3();

/** Add a box (centred, size w/h/d) transformed by `m`. UVs are in metres * uvScale. */
export function addBox(g: Geo, w: number, h: number, d: number, m: THREE.Matrix4, col: RGB, uvScale = 0.5) {
  const half = [w / 2, h / 2, d / 2];
  _nm.getNormalMatrix(m);
  const uOff = (m.elements[12] * 0.37 + m.elements[13] * 0.61) % 1, vOff = (m.elements[14] * 0.53) % 1;  // de-correlate bricks
  for (const [n, u, v] of FACES) {
    const hn = Math.abs(n[0]) * half[0] + Math.abs(n[1]) * half[1] + Math.abs(n[2]) * half[2];
    const hu = Math.abs(u[0]) * half[0] + Math.abs(u[1]) * half[1] + Math.abs(u[2]) * half[2];
    const hv = Math.abs(v[0]) * half[0] + Math.abs(v[1]) * half[1] + Math.abs(v[2]) * half[2];
    _nn.set(n[0], n[1], n[2]).applyMatrix3(_nm).normalize();
    const idx: number[] = [];
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      _v.set(n[0] * hn + u[0] * hu * su + v[0] * hv * sv, n[1] * hn + u[1] * hu * su + v[1] * hv * sv, n[2] * hn + u[2] * hu * su + v[2] * hv * sv).applyMatrix4(m);
      idx.push(g.vert(_v.x, _v.y, _v.z, _nn.x, _nn.y, _nn.z, uOff + su * hu * uvScale, vOff + sv * hv * uvScale, col));
    }
    g.quad(idx[0], idx[1], idx[2], idx[3]);
  }
}

const _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(1, 1, 1), _pp = new THREE.Vector3();
/** Compose a TRS matrix (allocates). */
export function trs(x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.Matrix4 {
  return new THREE.Matrix4().compose(_pp.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s.set(sx, sy, sz));
}

/** Groups instances by (type, grid cell) and emits one InstancedMesh per group so
 *  that three.js frustum culling can reject whole chunks of jungle. */
export class InstanceBatcher {
  private buckets = new Map<string, { geo: THREE.BufferGeometry; mat: THREE.Material; cast: boolean; maxDist: number; m: THREE.Matrix4[]; c: THREE.Color[] }>();
  constructor(private cell: number) {}

  add(id: string, geo: THREE.BufferGeometry, mat: THREE.Material, m: THREE.Matrix4, color: THREE.Color | null, cast: boolean, maxDist = 0) {
    const k = `${id}|${Math.floor(m.elements[12] / this.cell)}|${Math.floor(m.elements[14] / this.cell)}`;
    let b = this.buckets.get(k);
    if (!b) this.buckets.set(k, (b = { geo, mat, cast, maxDist, m: [], c: [] }));
    b.m.push(m); if (color) b.c.push(color);
  }

  /** Returns meshes that want manual distance culling (undergrowth). */
  build(parent: THREE.Object3D): THREE.InstancedMesh[] {
    const distCulled: THREE.InstancedMesh[] = [];
    for (const b of this.buckets.values()) {
      const mesh = new THREE.InstancedMesh(b.geo, b.mat, b.m.length);
      for (let i = 0; i < b.m.length; i++) { mesh.setMatrixAt(i, b.m[i]); if (b.c.length) mesh.setColorAt(i, b.c[i]); }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = b.cast; mesh.receiveShadow = true;
      mesh.computeBoundingSphere(); mesh.computeBoundingBox();
      mesh.matrixAutoUpdate = false;
      if (b.maxDist > 0) { mesh.userData.maxDist = b.maxDist; distCulled.push(mesh); }
      parent.add(mesh);
    }
    return distCulled;
  }
}
