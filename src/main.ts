// Entry point: renderer setup, loading, menu / pause state machine, main loop.
import * as THREE from 'three';
import { Input } from './core/input';
import { TouchControls } from './core/touch';
import { installJungleFog } from './world/world';
import { GameAudio } from './audio/audio';
import { Game, Settings } from './game/game';

const $ = (id: string) => document.getElementById(id)!;
const show = (id: string, on: boolean) => $(id).classList.toggle('on', on);
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 20)));
const TEST = location.search.includes('test') || (window as any).__TEST;
/** Phone / tablet: touch is the primary pointer. Drives lighter defaults and the on-screen controls. */
const MOBILE = navigator.maxTouchPoints > 0 && matchMedia('(pointer: coarse)').matches;

type State = 'loading' | 'menu' | 'playing' | 'paused' | 'ended';
let state: State = 'loading';

// ---- persisted settings (localStorage may be unavailable in sandboxed frames)
const settings: Settings & { volume: number } = { sens: 1, quality: MOBILE ? 0 : 1, volume: 0.8 };
try { Object.assign(settings, JSON.parse(localStorage.getItem('canopy-settings') || '{}')); } catch { /* ignore */ }
const save = () => { try { localStorage.setItem('canopy-settings', JSON.stringify(settings)); } catch { /* ignore */ } };

async function boot() {
  const canvas = $('c') as HTMLCanvasElement;
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  } catch {
    $('loadText').textContent = 'WebGL 2 is required to run this game.'; return;
  }
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping;                     // tone mapping happens in the post chain
  installJungleFog();

  const bar = $('bar').firstElementChild as HTMLElement;
  bar.style.width = '25%'; await nextFrame();

  const audio = new GameAudio(); audio.volume = settings.volume;
  const input = new Input(canvas);
  if (TEST) input.fallback = true;
  const game = new Game(renderer, audio, settings, MOBILE);      // generates the whole world (synchronous)
  bar.style.width = '80%'; $('loadText').textContent = 'Compiling shaders…'; await nextFrame();
  game.resize(); game.menuUpdate(0.016); game.render(0.016, 0.016);   // warm-up frame compiles every program
  bar.style.width = '100%'; await nextFrame();
  window.addEventListener('resize', () => { game.resize(); if (state === 'paused') game.render(0, 0.016); });

  // ---- touch controls: on from the start on phones, or as soon as a finger lands on a hybrid device
  let touch: TouchControls | null = null;
  const enableTouch = () => {
    if (touch) return;
    touch = new TouchControls(input, () => pause());
    input.touch = true; document.body.classList.add('touch'); input.releaseLock();
  };
  if (MOBILE) enableTouch(); else window.addEventListener('touchstart', enableTouch, { once: true, passive: true });

  // ---- state transitions
  const setState = (s: State) => {
    state = s; document.body.classList.toggle('playing', s === 'playing');
    show('loading', false); show('menu', s === 'menu'); show('pause', s === 'paused');
    game.hud.show(s === 'playing' || s === 'paused');
    if (s === 'paused') audio.suspend(); else audio.resume();
  };
  const play = () => {
    audio.init(); audio.setVolume(settings.volume); show('dead', false); show('win', false); setState('playing');
    if (TEST) return;
    if (input.touch) {
      // phones: go fullscreen + landscape where the browser allows it (both need a user gesture and may be refused)
      try { const p: any = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); p?.catch?.(() => {}); } catch { /* unsupported */ }
      try { (screen.orientation as any)?.lock?.('landscape')?.catch?.(() => {}); } catch { /* unsupported */ }
    } else input.requestLock();
  };
  const pause = () => { if (state !== 'playing') return; touch?.release(); setState('paused'); input.releaseLock(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  input.onLockChange = (locked) => { if (!locked && state === 'playing' && !input.fallback && !input.touch) pause(); };
  game.onEnd = (won) => {
    state = 'ended'; document.body.classList.remove('playing'); touch?.release(); input.releaseLock();
    const acc = game.weapon.shots ? Math.round((game.stats.hits / game.weapon.shots) * 100) : 0;
    const t = Math.floor(game.playTime), relays = game.relays.filter((r) => r.dead).length;
    const html = `<span>Time</span><span class="mono">${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}</span>
      <span>Relays destroyed</span><span class="mono">${relays} / 3</span>
      <span>Hostiles eliminated</span><span class="mono">${game.stats.kills}</span>
      <span>Accuracy</span><span class="mono">${acc}%</span>
      <span>Damage taken</span><span class="mono">${Math.round(game.stats.damageTaken)}</span>`;
    $(won ? 'winStats' : 'deadStats').innerHTML = html; show(won ? 'win' : 'dead', true); game.hud.show(false);
  };

  $('btnStart').addEventListener('click', play);
  $('btnResume').addEventListener('click', play);
  for (const id of ['btnRestartP', 'btnRestartD', 'btnRestartW']) $(id).addEventListener('click', () => { game.reset(); play(); });
  canvas.addEventListener('click', () => { if (state === 'playing' && !input.locked && !input.fallback && !input.touch && !TEST) input.requestLock(); });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyP' || (e.code === 'Escape' && (input.fallback || !input.locked))) { if (state === 'playing') pause(); else if (state === 'paused' && e.code === 'KeyP') play(); }
    if (e.code === 'KeyF') game.hud.showFps = !game.hud.showFps;
  });

  // ---- settings UI
  const sens = $('sens') as HTMLInputElement, vol = $('vol') as HTMLInputElement, qs = Array.from(document.querySelectorAll<HTMLSelectElement>('.set-quality'));
  const sync = () => { sens.value = String(settings.sens); $('sensOut').textContent = settings.sens.toFixed(2); vol.value = String(settings.volume); $('volOut').textContent = String(Math.round(settings.volume * 100)); qs.forEach((q) => (q.value = String(settings.quality))); };
  sens.addEventListener('input', () => { settings.sens = +sens.value; sync(); save(); });
  vol.addEventListener('input', () => { settings.volume = +vol.value; audio.setVolume(settings.volume); sync(); save(); });
  qs.forEach((q) => q.addEventListener('change', () => { settings.quality = +q.value; game.applyQuality(); sync(); save(); if (state === 'paused') game.render(0, 0.016); }));
  sync();

  setState('menu');

  // ---- PWA: offline shell + installability (silently skipped where service workers are not allowed)
  try {
    if (!TEST && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('./sw.js').catch(() => {});
  } catch { /* sandboxed frame */ }

  // ---- main loop
  let last = performance.now();
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const raw = Math.min(0.25, (now - last) / 1000), dt = Math.min(raw, 0.05); last = now;
    if (state === 'playing' || state === 'ended') { game.update(dt, input); game.render(dt, raw); }
    else if (state === 'menu') { game.menuUpdate(dt); game.render(dt, 1 / 60); }
    input.endFrame();
  };
  if (TEST) {
    // headless test harness: frames are stepped manually instead of via rAF
    Object.assign(window as any, { __game: game, __play: play, __input: input, __state: () => state,
      __step: (n: number, dt = 1 / 60) => { for (let i = 0; i < n; i++) frameStep(dt); },
      __sim: (n: number, dt = 1 / 60) => { for (let i = 0; i < n; i++) { game.update(dt, input); input.endFrame(); } } });
    const frameStep = (dt: number) => {
      if (state === 'playing' || state === 'ended') { game.update(dt, input); game.render(dt, dt); } else if (state === 'menu') { game.menuUpdate(dt); game.render(dt, dt); }
      input.endFrame();
    };
    return;
  }
  requestAnimationFrame(frame);
}

boot();
