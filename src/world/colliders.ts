// Lightweight collision world: vertical cylinders and oriented boxes stored
// in a uniform grid, plus analytic ray tests against them and the terrain.
// Used for player/enemy movement, hitscan shots, projectiles and line of sight.
import { heightAt } from './layout';

export interface Collider {
  box: boolean;
  x: number; z: number;
  r: number;                 // radius (circle) or bounding radius (box)
  hx: number; hz: number;    // box half extents
  cos: number; sin: number;  // box rotation
  y0: number; top: number;   // vertical extent
  walk: boolean;             // can be stood on
}

const CELL = 8;
const STEP = 0.48;           // max height the player can step up without jumping
const key = (cx: number, cz: number) => (cx + 512) * 1024 + (cz + 512);

export class ColliderWorld {
  all: Collider[] = [];
  private grid = new Map<number, Collider[]>();

  private insert(c: Collider) {
    this.all.push(c);
    const x0 = Math.floor((c.x - c.r) / CELL), x1 = Math.floor((c.x + c.r) / CELL);
    const z0 = Math.floor((c.z - c.r) / CELL), z1 = Math.floor((c.z + c.r) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const k = key(cx, cz);
      let a = this.grid.get(k); if (!a) this.grid.set(k, (a = []));
      a.push(c);
    }
  }
  addCircle(x: number, z: number, r: number, y0: number, top: number, walk = false) {
    this.insert({ box: false, x, z, r, hx: 0, hz: 0, cos: 1, sin: 0, y0, top, walk });
  }
  addBox(x: number, z: number, hx: number, hz: number, rot: number, y0: number, top: number, walk = false) {
    this.insert({ box: true, x, z, r: Math.hypot(hx, hz), hx, hz, cos: Math.cos(rot), sin: Math.sin(rot), y0, top, walk });
  }

  /** Push a vertical capsule (radius, feet..head) out of nearby colliders. Mutates p. */
  resolve(p: { x: number; z: number }, radius: number, feetY: number, headY: number) {
    const cx0 = Math.floor((p.x - radius) / CELL), cx1 = Math.floor((p.x + radius) / CELL);
    const cz0 = Math.floor((p.z - radius) / CELL), cz1 = Math.floor((p.z + radius) / CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
      const a = this.grid.get(key(cx, cz)); if (!a) continue;
      for (let i = 0; i < a.length; i++) {
        const c = a[i];
        if (headY < c.y0 || (feetY >= c.top - (c.walk ? STEP : 0.05))) continue;
        const dx = p.x - c.x, dz = p.z - c.z;
        if (!c.box) {
          const rr = c.r + radius, d2 = dx * dx + dz * dz;
          if (d2 < rr * rr) {
            const d = Math.sqrt(d2) || 0.0001, push = (rr - d) / d;
            p.x += dx * push; p.z += dz * push;
          }
        } else {
          // into box space
          const lx = c.cos * dx + c.sin * dz, lz = -c.sin * dx + c.cos * dz;
          const qx = Math.max(-c.hx, Math.min(c.hx, lx)), qz = Math.max(-c.hz, Math.min(c.hz, lz));
          let nx = lx - qx, nz = lz - qz;
          const d2 = nx * nx + nz * nz;
          if (d2 >= radius * radius) continue;
          let push: number;
          if (d2 < 1e-8) {
            // centre is inside the box: leave through the nearest face
            const px = c.hx - Math.abs(lx), pz = c.hz - Math.abs(lz);
            if (px < pz) { nx = Math.sign(lx) || 1; nz = 0; push = px + radius; }
            else { nx = 0; nz = Math.sign(lz) || 1; push = pz + radius; }
          } else {
            const d = Math.sqrt(d2); nx /= d; nz /= d; push = radius - d;
          }
          p.x += (c.cos * nx - c.sin * nz) * push;
          p.z += (c.sin * nx + c.cos * nz) * push;
        }
      }
    }
  }

  /** Height of the walkable surface under (x, z) for something whose feet are at feetY. */
  groundAt(x: number, z: number, feetY: number): number {
    let g = heightAt(x, z);
    const a = this.grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    if (a) for (let i = 0; i < a.length; i++) {
      const c = a[i];
      if (!c.walk || c.top <= g || feetY < c.top - STEP) continue;
      const dx = x - c.x, dz = z - c.z;
      if (!c.box) { if (dx * dx + dz * dz < c.r * c.r) g = c.top; }
      else {
        const lx = c.cos * dx + c.sin * dz, lz = -c.sin * dx + c.cos * dz;
        if (Math.abs(lx) <= c.hx && Math.abs(lz) <= c.hz) g = c.top;
      }
    }
    return g;
  }

  /** Nearest hit of a ray against colliders + terrain. Returns distance or Infinity. */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, terrain = true): number {
    let best = maxT;
    // --- terrain: adaptive ray march + bisection
    if (terrain) {
      let t = 0, prev = 0;
      while (t < best) {
        const y = oy + dy * t, gap = y - heightAt(ox + dx * t, oz + dz * t);
        if (gap < 0) {
          let a = prev, b = t;
          for (let i = 0; i < 6; i++) {
            const m = (a + b) * 0.5;
            if (oy + dy * m - heightAt(ox + dx * m, oz + dz * m) < 0) b = m; else a = m;
          }
          best = Math.min(best, b); break;
        }
        if (dy >= 0 && y > 40) break;
        prev = t; t += Math.max(0.35, gap * 0.45);
      }
    }
    // --- colliders (brute force: a few thousand cheap tests per ray)
    const all = this.all;
    for (let i = 0; i < all.length; i++) {
      const c = all[i];
      const mx = c.x - ox, mz = c.z - oz;
      // quick reject: closest approach in XZ
      const along = mx * dx + mz * dz;
      if (along < -c.r || along > best + c.r) continue;
      if (!c.box) {
        const a = dx * dx + dz * dz; if (a < 1e-8) continue;
        const b = -(mx * dx + mz * dz), cc = mx * mx + mz * mz - c.r * c.r;
        const disc = b * b - a * cc; if (disc < 0) continue;
        const t = (-b - Math.sqrt(disc)) / a;
        if (t < 0 || t >= best) continue;
        const y = oy + dy * t;
        if (y >= c.y0 - 0.3 && y <= c.top) best = t;
      } else {
        // ray in box space, slab test
        const lox = -(c.cos * mx + c.sin * mz), loz = -(-c.sin * mx + c.cos * mz);
        const ldx = c.cos * dx + c.sin * dz, ldz = -c.sin * dx + c.cos * dz;
        let t0 = 0, t1 = best;
        const slab = (o: number, d: number, lo: number, hi: number) => {
          if (Math.abs(d) < 1e-8) return o >= lo && o <= hi;
          let a = (lo - o) / d, b = (hi - o) / d; if (a > b) { const s = a; a = b; b = s; }
          t0 = Math.max(t0, a); t1 = Math.min(t1, b); return t0 <= t1;
        };
        if (slab(lox, ldx, -c.hx, c.hx) && slab(loz, ldz, -c.hz, c.hz) && slab(oy, dy, c.y0 - 0.3, c.top) && t0 < best) best = t0;
      }
    }
    return best >= maxT ? Infinity : best;
  }

  /** True if nothing solid lies between two points. */
  los(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    let dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.hypot(dx, dy, dz); if (d < 0.01) return true;
    dx /= d; dy /= d; dz /= d;
    return this.raycast(ax, ay, az, dx, dy, dz, d - 0.3) === Infinity;
  }
}
