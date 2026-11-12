// On-screen controls for phones and tablets. They write into the same Input
// object the keyboard and mouse use, so gameplay code does not care which is active.
//   left side  – floating analog stick (push fully forward to sprint)
//   right side – drag to look; buttons for fire, aim, jump, reload, crouch
import type { Input } from './input';

const STICK_R = 56;          // px of travel for full deflection
const LOOK_GAIN = 2.3;       // touch pixels -> equivalent mouse counts

export class TouchControls {
  private stickId = -1; private ox = 0; private oy = 0;
  private look = new Map<number, { x: number; y: number }>();   // every finger that may steer the view
  private base: HTMLElement; private knob: HTMLElement;

  constructor(private input: Input, onPause: () => void) {
    const $ = (id: string) => document.getElementById(id)!;
    this.base = $('stick'); this.knob = this.base.firstElementChild as HTMLElement;
    const opts = { passive: false } as AddEventListenerOptions;
    const each = (e: TouchEvent, fn: (t: Touch) => void) => { e.preventDefault(); for (let i = 0; i < e.changedTouches.length; i++) fn(e.changedTouches[i]); };

    // ---- movement stick
    const zone = $('stickZone');
    zone.addEventListener('touchstart', (e) => each(e, (t) => {
      if (this.stickId !== -1) return;
      this.stickId = t.identifier; this.ox = Math.max(STICK_R + 8, t.clientX); this.oy = Math.min(window.innerHeight - STICK_R - 8, t.clientY);
      this.base.style.left = this.ox + 'px'; this.base.style.top = this.oy + 'px'; this.base.classList.add('on');
      this.moveStick(t);
    }), opts);
    zone.addEventListener('touchmove', (e) => each(e, (t) => { if (t.identifier === this.stickId) this.moveStick(t); }), opts);
    const endStick = (e: TouchEvent) => each(e, (t) => {
      if (t.identifier !== this.stickId) return;
      this.stickId = -1; input.axisX = input.axisY = 0; input.touchSprint = false;
      this.base.classList.remove('on'); this.knob.style.transform = '';
    });
    zone.addEventListener('touchend', endStick, opts); zone.addEventListener('touchcancel', endStick, opts);

    // ---- look: the empty right side, and the fire button (so you can track a target while shooting)
    const lookable = (el: HTMLElement, down?: () => void, up?: () => void) => {
      el.addEventListener('touchstart', (e) => each(e, (t) => { this.look.set(t.identifier, { x: t.clientX, y: t.clientY }); down?.(); el.classList.add('on'); }), opts);
      el.addEventListener('touchmove', (e) => each(e, (t) => {
        const p = this.look.get(t.identifier); if (!p) return;
        input.mouseDX += (t.clientX - p.x) * LOOK_GAIN; input.mouseDY += (t.clientY - p.y) * LOOK_GAIN;
        p.x = t.clientX; p.y = t.clientY;
      }), opts);
      const end = (e: TouchEvent) => each(e, (t) => { if (this.look.delete(t.identifier)) { up?.(); el.classList.remove('on'); } });
      el.addEventListener('touchend', end, opts); el.addEventListener('touchcancel', end, opts);
    };
    lookable($('lookZone'));
    lookable($('tFire'), () => (input.lmb = true), () => (input.lmb = false));

    // ---- buttons
    const tap = (id: string, fn: (el: HTMLElement) => void) => { const el = $(id); el.addEventListener('touchstart', (e) => { e.preventDefault(); e.stopPropagation(); fn(el); }, opts); };
    tap('tJump', () => input.pressed.add('Space'));
    tap('tReload', () => input.pressed.add('KeyR'));
    tap('tAds', (el) => { input.rmb = !input.rmb; el.classList.toggle('on', input.rmb); });
    tap('tCrouch', (el) => { if (input.keys.has('KeyC')) input.keys.delete('KeyC'); else input.keys.add('KeyC'); el.classList.toggle('on', input.keys.has('KeyC')); });
    tap('tPause', () => onPause());
  }

  private moveStick(t: Touch) {
    let dx = (t.clientX - this.ox) / STICK_R, dy = (t.clientY - this.oy) / STICK_R;
    const l = Math.hypot(dx, dy); if (l > 1) { dx /= l; dy /= l; }
    const dead = 0.12, m = Math.hypot(dx, dy);
    this.input.axisX = m < dead ? 0 : dx; this.input.axisY = m < dead ? 0 : -dy;
    this.input.touchSprint = l > 1.25 && -dy > 0.75;          // pushed well past the rim, mostly forward
    this.knob.style.transform = `translate(${dx * STICK_R}px, ${dy * STICK_R}px)`;
  }

  /** Clear latched state (called when pausing / restarting). */
  release() {
    const i = this.input; i.lmb = false; i.rmb = false; i.axisX = i.axisY = 0; i.touchSprint = false; i.keys.delete('KeyC');
    this.look.clear(); this.stickId = -1; this.base.classList.remove('on');
    for (const id of ['tAds', 'tCrouch', 'tFire']) document.getElementById(id)!.classList.remove('on');
  }
}
