// All sound is synthesised with the Web Audio API: oscillators, filtered noise
// and a generated impulse response for reverb. No samples are loaded.
import * as THREE from 'three';

type V3 = { x: number; y: number; z: number };

export class GameAudio {
  ctx!: AudioContext;
  ready = false;
  private master!: GainNode; private sfx!: GainNode; private amb!: GainNode; private rev!: ConvolverNode; private revGain!: GainNode;
  private noiseBuf!: AudioBuffer;
  private ambTimers: number[] = [];
  private creekGain!: GainNode; private tension!: GainNode;
  private listener = new THREE.Vector3(); private right = new THREE.Vector3(1, 0, 0);
  volume = 0.8;

  /** Must be called from a user gesture. */
  init() {
    if (this.ready) { this.ctx.resume(); return; }
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    try { this.ctx = new AC(); } catch { return; }
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = this.volume;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.2;
    this.master.connect(comp); comp.connect(c.destination);
    this.sfx = c.createGain(); this.sfx.connect(this.master);
    this.amb = c.createGain(); this.amb.gain.value = 0.9; this.amb.connect(this.master);
    // white noise source buffer shared by everything
    this.noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const nd = this.noiseBuf.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    // reverb: exponentially decaying filtered noise = damp forest slap-back
    const len = Math.floor(c.sampleRate * 1.9), ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch); let lp = 0;
      for (let i = 0; i < len; i++) { const t = i / len; lp += (Math.random() * 2 - 1 - lp) * (0.5 - t * 0.38); d[i] = lp * Math.pow(1 - t, 3.2) * (i < 600 ? i / 600 : 1); }
    }
    this.rev = c.createConvolver(); this.rev.buffer = ir;
    this.revGain = c.createGain(); this.revGain.gain.value = 0.55; this.rev.connect(this.revGain); this.revGain.connect(this.master);
    this.ready = true;
    this.startAmbience();
  }

  setVolume(v: number) { this.volume = v; if (this.ready) this.master.gain.value = v; }
  suspend() { if (this.ready) this.ctx.suspend(); }
  resume() { if (this.ready) this.ctx.resume(); }

  setListener(pos: THREE.Vector3, cam: THREE.Camera) {
    this.listener.copy(pos); this.right.set(1, 0, 0).applyQuaternion(cam.quaternion);
  }

  // ------------------------------------------------------------ building blocks
  private noise(dur: number, loop = false): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf; s.loop = loop;
    s.start(this.ctx.currentTime, Math.random() * 1.5, loop ? undefined : dur + 0.05); return s;
  }
  /** Output node with distance attenuation + stereo pan for a world position. */
  private out(pos: V3 | null, gain: number, reverb = 0.3, refDist = 6): GainNode {
    const c = this.ctx, g = c.createGain();
    let vol = gain, pan = 0;
    if (pos) {
      const dx = pos.x - this.listener.x, dy = pos.y - this.listener.y, dz = pos.z - this.listener.z, d = Math.hypot(dx, dy, dz);
      vol *= refDist / (refDist + Math.max(0, d - 1));
      pan = d > 0.01 ? THREE.MathUtils.clamp((dx * this.right.x + dz * this.right.z) / d, -1, 1) * 0.85 : 0;
    }
    g.gain.value = vol;
    const p = c.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(this.sfx);
    if (reverb > 0) { const r = c.createGain(); r.gain.value = reverb; p.connect(r); r.connect(this.rev); }
    return g;
  }
  private env(g: AudioParam, t: number, a: number, peak: number, d: number) {
    g.setValueAtTime(0.0001, t); g.exponentialRampToValueAtTime(peak, t + a); g.exponentialRampToValueAtTime(0.0001, t + a + d);
  }
  private tone(type: OscillatorType, f0: number, f1: number, dur: number, dest: AudioNode, peak = 1, attack = 0.005, delay = 0) {
    const c = this.ctx, t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    this.env(g.gain, t, attack, peak, dur); o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur + attack + 0.05);
    return o;
  }
  private burst(freq: number, q: number, dur: number, dest: AudioNode, peak = 1, type: BiquadFilterType = 'bandpass', delay = 0, f1 = 0) {
    const c = this.ctx, t = c.currentTime + delay, n = this.noise(dur + delay), f = c.createBiquadFilter(), g = c.createGain();
    f.type = type; f.frequency.setValueAtTime(freq, t); if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur); f.Q.value = q;
    this.env(g.gain, t, 0.002, peak, dur); n.connect(f); f.connect(g); g.connect(dest);
  }

  // ------------------------------------------------------------ weapon
  gunshot() {
    if (!this.ready) return;
    const o = this.out(null, 0.9, 0.5), det = 0.92 + Math.random() * 0.16;
    this.burst(1900 * det, 0.6, 0.11, o, 1.0, 'bandpass', 0, 500);          // crack
    this.burst(5200, 0.8, 0.035, o, 0.6, 'highpass');                        // snap
    this.tone('triangle', 170 * det, 42, 0.16, o, 1.1);                      // body thump
    this.tone('square', 95 * det, 40, 0.07, o, 0.35);
    this.burst(700, 0.5, 0.5, o, 0.12, 'lowpass', 0.03);                     // tail
  }
  dryFire() { if (this.ready) this.burst(3500, 3, 0.03, this.out(null, 0.35, 0), 1); }
  reload(stage: number) {
    if (!this.ready) return;
    const o = this.out(null, 0.5, 0.1);
    if (stage === 0) { this.burst(1800, 2, 0.05, o, 0.9); this.tone('square', 240, 120, 0.05, o, 0.25); }                    // mag out
    else if (stage === 1) { this.burst(1200, 2, 0.06, o, 1); this.tone('square', 160, 220, 0.06, o, 0.35); this.burst(3000, 4, 0.03, o, 0.6, 'bandpass', 0.07); }  // mag in
    else { this.burst(2600, 3, 0.04, o, 1); this.burst(1500, 3, 0.05, o, 0.9, 'bandpass', 0.09); this.tone('square', 300, 150, 0.04, o, 0.3, 0.003, 0.09); }      // bolt
  }
  hitMarker(kill: boolean) {
    if (!this.ready) return;
    const o = this.out(null, 0.22, 0);
    this.tone('square', kill ? 1500 : 1900, kill ? 700 : 1700, kill ? 0.14 : 0.04, o, 0.8);
    if (kill) this.tone('square', 2200, 1100, 0.12, o, 0.5, 0.003, 0.06);
  }
  impact(pos: V3, metal: boolean) {
    if (!this.ready) return;
    const o = this.out(pos, 0.35, 0.2, 4);
    if (metal) { this.tone('triangle', 2400 + Math.random() * 1800, 1400, 0.12, o, 0.6); this.burst(4000, 5, 0.04, o, 0.7); }
    else this.burst(600 + Math.random() * 500, 1, 0.07, o, 1, 'lowpass');
  }

  // ------------------------------------------------------------ player
  footstep(wet: boolean, sprint: boolean) {
    if (!this.ready) return;
    const o = this.out(null, sprint ? 0.26 : 0.17, 0.05);
    this.burst(wet ? 900 : 260 + Math.random() * 120, 0.8, wet ? 0.16 : 0.08, o, 1, 'lowpass');
    if (wet) this.burst(2400, 1.5, 0.12, o, 0.5, 'bandpass', 0.02, 800); else this.burst(3200, 1, 0.03, o, 0.18, 'highpass', 0.01);
  }
  land(strength: number) { if (this.ready) { const o = this.out(null, 0.3 * strength, 0.1); this.burst(180, 0.7, 0.14, o, 1, 'lowpass'); this.tone('sine', 90, 45, 0.12, o, 0.7); } }
  hurt() {
    if (!this.ready) return;
    const o = this.out(null, 0.5, 0.1);
    this.burst(500, 1, 0.12, o, 1, 'lowpass'); this.tone('sawtooth', 190, 90, 0.2, o, 0.4);
  }
  pickup() { if (this.ready) { const o = this.out(null, 0.25, 0.15); this.tone('triangle', 660, 660, 0.08, o, 0.8); this.tone('triangle', 990, 990, 0.14, o, 0.8, 0.005, 0.07); } }
  objective(final = false) {
    if (!this.ready) return;
    const o = this.out(null, 0.3, 0.5), notes = final ? [392, 523, 659, 784, 1046] : [523, 659, 784];
    notes.forEach((f, i) => { this.tone('triangle', f, f, 0.35, o, 0.7, 0.01, i * 0.11); this.tone('sine', f * 2, f * 2, 0.3, o, 0.25, 0.01, i * 0.11); });
  }
  fail() { if (this.ready) { const o = this.out(null, 0.4, 0.6); [220, 185, 147, 110].forEach((f, i) => this.tone('sawtooth', f, f * 0.97, 0.6, o, 0.4, 0.02, i * 0.22)); } }
  heartbeat() { if (this.ready) { const o = this.out(null, 0.5, 0); this.tone('sine', 70, 40, 0.12, o, 1); this.tone('sine', 60, 36, 0.12, o, 0.7, 0.005, 0.18); } }

  // ------------------------------------------------------------ enemies & world
  droneShot(pos: V3) {
    if (!this.ready) return;
    const o = this.out(pos, 0.5, 0.35, 8);
    this.tone('sawtooth', 1500, 220, 0.2, o, 0.6); this.tone('square', 900, 150, 0.16, o, 0.3); this.burst(3000, 2, 0.06, o, 0.5);
  }
  droneAlert(pos: V3) { if (this.ready) { const o = this.out(pos, 0.3, 0.4, 10); this.tone('square', 880, 880, 0.07, o, 0.6); this.tone('square', 1320, 1320, 0.1, o, 0.6, 0.005, 0.09); } }
  explosion(pos: V3, big = false) {
    if (!this.ready) return;
    const o = this.out(pos, big ? 1.4 : 0.9, 0.8, big ? 22 : 12);
    this.burst(900, 0.4, big ? 1.1 : 0.6, o, 1, 'lowpass', 0, 90);
    this.tone('sine', big ? 85 : 110, 28, big ? 0.9 : 0.5, o, 1.2);
    this.burst(3500, 0.7, 0.12, o, 0.5, 'bandpass');
    if (big) this.burst(300, 0.6, 2.2, o, 0.4, 'lowpass', 0.15, 60);
  }
  screech(pos: V3, attack = false) {
    if (!this.ready) return;
    const c = this.ctx, o = this.out(pos, attack ? 0.5 : 0.42, 0.45, 9), t = c.currentTime, dur = attack ? 0.28 : 0.6;
    // FM growl: saw carrier with a fast wobbling pitch, through a vocal-ish band-pass
    const car = c.createOscillator(), mod = c.createOscillator(), mg = c.createGain(), f = c.createBiquadFilter(), g = c.createGain();
    car.type = 'sawtooth'; const base = attack ? 300 : 210 + Math.random() * 60;
    car.frequency.setValueAtTime(base, t); car.frequency.linearRampToValueAtTime(base * (attack ? 2.3 : 1.7), t + dur * 0.35); car.frequency.exponentialRampToValueAtTime(base * 0.6, t + dur);
    mod.frequency.value = 38 + Math.random() * 20; mg.gain.value = base * 0.5; mod.connect(mg); mg.connect(car.frequency);
    f.type = 'bandpass'; f.frequency.setValueAtTime(900, t); f.frequency.linearRampToValueAtTime(2200, t + dur * 0.4); f.Q.value = 2.5;
    this.env(g.gain, t, 0.02, 1, dur); car.connect(f); f.connect(g); g.connect(o);
    car.start(t); mod.start(t); car.stop(t + dur + 0.1); mod.stop(t + dur + 0.1);
    this.burst(2600, 2, dur * 0.8, o, 0.35, 'bandpass', 0, 1500);
  }
  creatureDie(pos: V3) { if (this.ready) { const o = this.out(pos, 0.45, 0.4, 9); this.tone('sawtooth', 320, 60, 0.7, o, 0.6, 0.02); this.burst(800, 1.5, 0.5, o, 0.5, 'bandpass', 0, 200); } }
  squelch(pos: V3) { if (this.ready) this.burst(700, 1.2, 0.09, this.out(pos, 0.35, 0.1, 5), 1, 'lowpass', 0, 250); }
  relayDown(pos: V3) {
    if (!this.ready) return;
    this.explosion(pos, true);
    const o = this.out(pos, 0.5, 0.7, 20); this.tone('sawtooth', 900, 30, 1.6, o, 0.5, 0.01, 0.1); this.tone('square', 1350, 45, 1.2, o, 0.25, 0.01, 0.1);
  }

  /** Persistent positional hum (drones, relays). Call the returned fn every frame; pass null to stop. */
  hum(freq: number, rough: number, level: number): (pos: V3 | null) => void {
    let n: { g: GainNode; pan: StereoPannerNode; oscs: OscillatorNode[] } | null = null, done = false;
    const build = () => {
      const c = this.ctx, g = c.createGain(), pan = c.createStereoPanner(), f = c.createBiquadFilter();
      g.gain.value = 0; f.type = 'lowpass'; f.frequency.value = freq * 5; f.Q.value = 1.5;
      const oscs: OscillatorNode[] = [];
      for (const [mul, type] of [[1, 'sawtooth'], [1.012 + rough * 0.02, 'sawtooth'], [0.5, 'square']] as [number, OscillatorType][]) {
        const o = c.createOscillator(); o.type = type; o.frequency.value = freq * mul; o.connect(f); o.start(); oscs.push(o);
      }
      const lfo = c.createOscillator(), lg = c.createGain(); lfo.frequency.value = 11 + rough * 20; lg.gain.value = freq * 0.6; lfo.connect(lg); lg.connect(f.frequency); lfo.start(); oscs.push(lfo);
      f.connect(g); g.connect(pan); pan.connect(this.sfx);
      return { g, pan, oscs };
    };
    return (pos) => {
      if (!this.ready || done) return;
      const c = this.ctx;
      if (!pos) {
        done = true;
        if (n) { const k = n; k.g.gain.setTargetAtTime(0, c.currentTime, 0.05); setTimeout(() => { k.oscs.forEach((o) => { try { o.stop(); } catch { /* already stopped */ } }); k.g.disconnect(); }, 400); }
        return;
      }
      const dx = pos.x - this.listener.x, dy = pos.y - this.listener.y, dz = pos.z - this.listener.z, d = Math.hypot(dx, dy, dz);
      if (!n) { if (d > 70) return; n = build(); }                 // voices are only allocated for sources in earshot
      n.g.gain.setTargetAtTime(level * 5 / (5 + d * d * 0.06 + d), c.currentTime, 0.06);
      n.pan.pan.setTargetAtTime(d > 0.01 ? THREE.MathUtils.clamp((dx * this.right.x + dz * this.right.z) / d, -1, 1) * 0.8 : 0, c.currentTime, 0.06);
    };
  }

  /** 0..1: how hot the fight is. Drives a low tension drone. */
  setTension(v: number) { if (this.ready) this.tension.gain.setTargetAtTime(v * 0.16, this.ctx.currentTime, 0.8); }
  /** 0..1: proximity to the creek. */
  setCreek(v: number) { if (this.ready) this.creekGain.gain.setTargetAtTime(v * 0.2, this.ctx.currentTime, 0.4); }

  // ------------------------------------------------------------ ambience
  private startAmbience() {
    const c = this.ctx;
    // canopy wind / distant rain-forest hiss
    const wind = this.noise(0, true), wf = c.createBiquadFilter(), wg = c.createGain();
    wf.type = 'lowpass'; wf.frequency.value = 520; wg.gain.value = 0.16; wind.connect(wf); wf.connect(wg); wg.connect(this.amb);
    const wl = c.createOscillator(), wlg = c.createGain(); wl.frequency.value = 0.07; wlg.gain.value = 0.07; wl.connect(wlg); wlg.connect(wg.gain); wl.start();
    // cicada wall: two amplitude-modulated narrow noise bands
    for (const [freq, rate, lvl, slow] of [[5400, 43, 0.035, 0.11], [7300, 61, 0.022, 0.07], [3900, 27, 0.02, 0.05]]) {
      const n = this.noise(0, true), f = c.createBiquadFilter(), g = c.createGain(), trem = c.createGain(), swell = c.createGain();
      f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 14; g.gain.value = lvl;
      const lfo = c.createOscillator(), lg = c.createGain(); lfo.type = 'square'; lfo.frequency.value = rate; lg.gain.value = 0.5; trem.gain.value = 0.5; lfo.connect(lg); lg.connect(trem.gain); lfo.start();
      const sl = c.createOscillator(), sg = c.createGain(); sl.frequency.value = slow; sg.gain.value = 0.5; swell.gain.value = 0.5; sl.connect(sg); sg.connect(swell.gain); sl.start();
      n.connect(f); f.connect(trem); trem.connect(swell); swell.connect(g); g.connect(this.amb);
    }
    // creek babble (gain driven by distance)
    const cr = this.noise(0, true), cf = c.createBiquadFilter(), cf2 = c.createBiquadFilter();
    this.creekGain = c.createGain(); this.creekGain.gain.value = 0;
    cf.type = 'bandpass'; cf.frequency.value = 1100; cf.Q.value = 0.8; cf2.type = 'highpass'; cf2.frequency.value = 500;
    const cl = c.createOscillator(), clg = c.createGain(); cl.frequency.value = 3.1; clg.gain.value = 350; cl.connect(clg); clg.connect(cf.frequency); cl.start();
    cr.connect(cf); cf.connect(cf2); cf2.connect(this.creekGain); this.creekGain.connect(this.amb);
    // tension drone
    this.tension = c.createGain(); this.tension.gain.value = 0;
    const tf = c.createBiquadFilter(); tf.type = 'lowpass'; tf.frequency.value = 240; tf.connect(this.tension); this.tension.connect(this.amb);
    for (const fr of [55, 55.7, 82.4, 110.6]) { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = fr; o.connect(tf); o.start(); }
    const tl = c.createOscillator(), tlg = c.createGain(); tl.frequency.value = 1.6; tlg.gain.value = 90; tl.connect(tlg); tlg.connect(tf.frequency); tl.start();

    // scheduled wildlife
    const every = (min: number, max: number, fn: () => void) => {
      const tick = () => { if (this.ctx.state === 'running') fn(); this.ambTimers.push(window.setTimeout(tick, (min + Math.random() * (max - min)) * 1000)); };
      this.ambTimers.push(window.setTimeout(tick, Math.random() * max * 1000));
    };
    const far = (lvl: number) => { const g = c.createGain(), p = c.createStereoPanner(), r = c.createGain(); g.gain.value = lvl * (0.4 + Math.random() * 0.6); p.pan.value = Math.random() * 1.6 - 0.8; r.gain.value = 0.9; g.connect(p); p.connect(this.amb); p.connect(r); r.connect(this.rev); return g; };
    every(1.5, 6, () => {                                           // songbird: repeated falling whistle
      const o = far(0.07), f = 2400 + Math.random() * 1600, n = 2 + Math.floor(Math.random() * 4), gap = 0.16 + Math.random() * 0.1;
      for (let i = 0; i < n; i++) this.tone('sine', f, f * (0.62 + Math.random() * 0.1), 0.11, o, 1, 0.01, i * gap);
    });
    every(4, 11, () => {                                            // trill
      const o = far(0.05), f = 3200 + Math.random() * 1500, n = 8 + Math.floor(Math.random() * 10);
      for (let i = 0; i < n; i++) this.tone('sine', f * (i % 2 ? 1.12 : 1), f * (i % 2 ? 1.1 : 1.02), 0.035, o, 1, 0.004, i * 0.055);
    });
    every(5, 14, () => {                                            // two-note "whoo-wip"
      const o = far(0.08), f = 700 + Math.random() * 500;
      this.tone('sine', f, f * 0.95, 0.3, o, 1, 0.04); this.tone('sine', f * 1.2, f * 1.9, 0.14, o, 1, 0.01, 0.38);
    });
    every(7, 20, () => {                                            // parrot squawk
      const o = far(0.045), f = 1100 + Math.random() * 500;
      for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) { this.tone('sawtooth', f, f * 1.35, 0.13, o, 0.7, 0.01, i * 0.22); this.burst(f * 2.4, 6, 0.12, o, 0.8, 'bandpass', i * 0.22); }
    });
    every(3, 9, () => {                                             // frog chorus
      const o = far(0.06), f = 260 + Math.random() * 180, n = 2 + Math.floor(Math.random() * 5);
      for (let i = 0; i < n; i++) { this.tone('square', f, f * 1.25, 0.07, o, 0.6, 0.005, i * 0.2); this.tone('square', f * 2.01, f * 2.4, 0.06, o, 0.25, 0.005, i * 0.2); }
    });
    every(14, 34, () => {                                           // howler monkey, far off
      const o = far(0.07), t = c.currentTime, osc = c.createOscillator(), f = c.createBiquadFilter(), g = c.createGain(), base = 230 + Math.random() * 90;
      osc.type = 'sawtooth'; f.type = 'bandpass'; f.frequency.value = 650; f.Q.value = 3;
      for (let i = 0; i < 4; i++) { osc.frequency.setValueAtTime(base, t + i * 0.55); osc.frequency.linearRampToValueAtTime(base * 1.5, t + i * 0.55 + 0.2); osc.frequency.linearRampToValueAtTime(base * 0.9, t + i * 0.55 + 0.5);
        g.gain.setValueAtTime(0.0001, t + i * 0.55); g.gain.exponentialRampToValueAtTime(1, t + i * 0.55 + 0.12); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.55 + 0.5); }
      osc.connect(f); f.connect(g); g.connect(o); osc.start(t); osc.stop(t + 2.4);
    });
    every(0.6, 2.2, () => { const o = far(0.03); this.tone('sine', 1800 + Math.random() * 2500, 900, 0.03, o, 1, 0.002); });   // water drips
  }
}
