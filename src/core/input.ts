// Keyboard / mouse state with pointer-lock handling.
// If pointer lock is unavailable (some sandboxed iframes) we fall back to
// un-locked mouse look so the game stays playable.

export class Input {
  keys = new Set<string>();
  pressed = new Set<string>();   // keys that went down this frame
  mouseDX = 0; mouseDY = 0;
  lmb = false; rmb = false;
  locked = false;
  fallback = false;              // true = play without pointer lock
  everLocked = false;
  // touch controls (see touch.ts)
  touch = false; axisX = 0; axisY = 0; touchSprint = false;
  onLockChange: (locked: boolean) => void = () => {};

  constructor(private el: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code); this.pressed.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.lmb = this.rmb = false; });
    document.addEventListener('mousemove', (e) => {
      if (this.locked || this.fallback) { this.mouseDX += e.movementX || 0; this.mouseDY += e.movementY || 0; }
    });
    el.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.lmb = true;
      if (e.button === 2) this.rmb = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.lmb = false;
      if (e.button === 2) this.rmb = false;
    });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (this.locked) this.everLocked = true;
      this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      // Never managed to lock at all -> assume it is blocked and use fallback look.
      if (!this.everLocked) this.fallback = true;
      else this.onLockChange(false);
    });
  }

  /** Must be called from a user gesture. */
  requestLock() {
    if (this.fallback) return;
    try {
      const p: any = (this.el as any).requestPointerLock();
      if (p && p.catch) p.catch(() => { if (!this.everLocked) this.fallback = true; else this.onLockChange(false); });
    } catch {
      this.fallback = true;
    }
  }

  releaseLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  down(code: string) { return this.keys.has(code); }
  hit(code: string) { return this.pressed.has(code); }

  endFrame() { this.pressed.clear(); this.mouseDX = 0; this.mouseDY = 0; }
}
