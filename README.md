# CANOPY — a procedural jungle FPS

A small first-person shooter that runs entirely in the browser on Three.js.
**No external assets**: every mesh, texture, shader, animation and sound is generated in code at start-up.

```
npm install
npm run dev        # play at http://localhost:5173
npm run build      # -> dist/index.html (single self-contained file, Three.js inlined)
npm run typecheck
```

## Playing

Destroy the three power relays (follow the compass markers), then reach the extraction pad and hold it for 32 s.

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| W A S D | move | LMB | fire |
| Shift | sprint | RMB | aim down sights |
| Space | jump | R | reload |
| C / Ctrl | crouch | Esc / P | pause |
| F | FPS / draw-call counter | ← → ↑ ↓ | look (if pointer lock is blocked) |

Enemies: **drones** (patrol, orbit, telegraphed plasma bursts) and **stalkers** (six-legged predators that zig-zag in and lunge; head shots do extra damage).
Red barrels at the outpost explode. Gunfire attracts everything within earshot.

## Mobile & PWA

Touch devices get on-screen controls automatically (and a lighter jungle + Low graphics by default):
left thumb = analog move (push past the ring to sprint), right thumb = drag to look, buttons for fire / aim / jump / reload / crouch.
The carbine also auto-fires while your sights rest on a hostile, and holding FIRE still lets you drag to aim.

The build is an installable PWA: `dist/` contains `index.html`, `manifest.json`, `sw.js` and `icons/`.
Host that folder on any HTTPS static host (Vercel, Netlify, GitHub Pages, Cloudflare Pages — URLs are relative, so sub-paths work),
open it on the phone and choose *Install app* / *Add to Home Screen*. It then launches fullscreen in landscape and works offline.
`npm run icons` regenerates the icons (they are drawn in code by `scripts/make-icons.mjs`).

## Code map

| Path | What it does |
| --- | --- |
| `src/main.ts` | Renderer setup, loading, menu / pause state machine, main loop |
| `src/core/` | Seeded RNG + noise (`math.ts`), keyboard / mouse / pointer-lock (`input.ts`), on-screen touch controls (`touch.ts`) |
| `public/` | PWA shell: `manifest.json`, `sw.js` (offline cache), generated icons |
| `src/world/layout.ts` | Terrain height function, creek, site positions, sun direction |
| `src/world/textures.ts` | All textures: tiling noise as raw pixels, foliage sprites via Canvas 2D |
| `src/world/geo.ts` | Mesh builder (tubes, boxes) and the chunked `InstancedMesh` batcher |
| `src/world/flora.ts` | Recursive branching trees, palms, ferns, vines, lianas, undergrowth scatter, wind shader |
| `src/world/structures.ts` | Boulders, logs, temple, stone circle, outpost, extraction pad |
| `src/world/colliders.ts` | Grid of cylinders / oriented boxes; movement resolution, ray casts, line of sight |
| `src/world/world.ts` | Terrain + water shaders, sky, lights, custom height fog, shadow frustum, motes |
| `src/fx/postfx.ts` | HDR chain: SSAO + shadow-mapped volumetric shafts → bloom → ACES grade → FXAA |
| `src/fx/particles.ts` | Pooled CPU particles (sparks, smoke, explosions) in one draw call |
| `src/audio/audio.ts` | Web Audio synthesis: weapon, creatures, drones, reverb, layered jungle ambience |
| `src/game/` | Player controller, weapon, enemies + AI, relays / barrels / pickups, HUD, game rules |

## Rendering notes

- **Instancing**: ~1,000 trees and ~20,000 undergrowth plants are a handful of unique meshes, instanced per grid cell so frustum culling rejects whole chunks; undergrowth chunks are also distance-culled.
- **Lighting**: one shadow-casting sun (texel-snapped frustum that follows the player, refreshed every other frame) plus a hemisphere fill. Leaf cards cast alpha-tested shadows, which is where the dappled light comes from.
- **Volumetrics**: a half-resolution pass marches each view ray through the sun's shadow map, so the light shafts are real gaps in the canopy.
- **Fog**: three.js' fog shader chunks are replaced with height-dependent, sun-tinted haze.
- **Performance**: quality presets (render scale, shadow size, AO / shaft sample counts, undergrowth range) and automatic resolution scaling when the frame rate drops below ~48 fps.
