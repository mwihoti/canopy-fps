// Level layout: terrain height function, creek, and the named sites.
// Everything is a pure function of (x, z) so gameplay code can query the
// ground without touching mesh data.
import * as THREE from 'three';
import { fbm, vnoise, smoothstep, lerp } from '../core/math';

export const WORLD_R = 96;        // playable radius (m)
export const WATER_Y = -0.55;     // creek water level
/** Direction *towards* the sun (north-west, ~46 deg elevation). */
export const SUN = new THREE.Vector3(-0.38, 0.72, -0.58).normalize();

export type SiteKind = 'start' | 'temple' | 'outpost' | 'circle' | 'extract';
export interface Site { name: string; kind: SiteKind; x: number; z: number; r: number; h: number; }

export const SITES: Site[] = [
  { name: 'Insertion', kind: 'start', x: 6, z: 82, r: 6, h: 0 },
  { name: 'Relay Alpha', kind: 'temple', x: -56, z: 28, r: 15, h: 0 },
  { name: 'Relay Bravo', kind: 'outpost', x: 58, z: 16, r: 15, h: 0 },
  { name: 'Relay Charlie', kind: 'circle', x: -8, z: -54, r: 13, h: 0 },
  { name: 'Extraction', kind: 'extract', x: 30, z: -78, r: 9, h: 0 },
];

function baseHeight(x: number, z: number): number {
  return 0.55 + fbm(x * 0.017 + 31.4, z * 0.017 + 12.7, 4) * 6.5 + (vnoise(x * 0.16, z * 0.16) - 0.5) * 0.45;
}
for (const s of SITES) s.h = Math.max(1.0, baseHeight(s.x, s.z));

/** Centre line of the creek (runs west-east across the middle of the map). */
export function creekZ(x: number): number {
  return -14 + 11 * Math.sin(x * 0.045) + 5 * Math.sin(x * 0.11 + 1.3);
}
export function creekDist(x: number, z: number): number {
  return Math.abs(z - creekZ(x));
}

/** Terrain height at world (x, z). */
export function heightAt(x: number, z: number): number {
  let h = baseHeight(x, z);
  for (let i = 0; i < SITES.length; i++) {
    const s = SITES[i];
    const dx = x - s.x, dz = z - s.z;
    const d2 = dx * dx + dz * dz, r1 = s.r * 1.35;
    if (d2 < r1 * r1) h = lerp(h, s.h, 1 - smoothstep(s.r * 0.7, r1, Math.sqrt(d2)));
  }
  const cd = creekDist(x, z);
  if (cd < 8) h = lerp(h, -1.25, 1 - smoothstep(1.2, 8, cd));
  const r = Math.hypot(x, z);
  if (r > WORLD_R - 5) { const t = (r - (WORLD_R - 5)) / 16; h += Math.min(t * t * 16, 30); }
  return h;
}

/** Approximate terrain normal (central differences). */
export function normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const e = 0.6;
  return out.set(heightAt(x - e, z) - heightAt(x + e, z), 2 * e, heightAt(x, z - e) - heightAt(x, z + e)).normalize();
}
