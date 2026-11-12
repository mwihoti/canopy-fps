// DOM heads-up display: vitals, ammo, objectives, compass, crosshair and feedback.
const $ = (id: string) => document.getElementById(id)!;

export interface Marker { x: number; z: number; label: string; color: string; }

export class Hud {
  private root = $('hud'); private hpNum = $('hpnum'); private hpBar = $('hpbar').firstElementChild as HTMLElement;
  private ammoCur = $('ammoCur'); private ammoRes = $('ammoRes'); private ammoHint = $('ammoHint');
  private objTitle = $('objTitle'); private objList = $('objList');
  private cross = Array.from($('cross').children) as HTMLElement[];
  private hit = $('hit'); private dmg = $('dmg'); private msg = $('msg'); private sub = $('sub');
  private hold = $('hold'); private holdBar = $('hold').querySelector('i') as HTMLElement; private holdText = $('holdText');
  private fps = $('fps');
  private compass = ($('compass') as HTMLCanvasElement).getContext('2d')!;
  private hitT = 0; private msgT = 0;
  private dmgArcs: { el: HTMLElement; t: number; x: number; z: number }[] = [];
  private last = { hp: -1, mag: -1, res: -1, hint: '', obj: '' };
  showFps = false;

  show(on: boolean) { this.root.classList.toggle('on', on); }

  setVitals(hp: number) {
    const v = Math.max(0, Math.ceil(hp));
    if (v === this.last.hp) return; this.last.hp = v;
    this.hpNum.textContent = String(v); this.hpBar.style.width = v + '%';
    this.hpBar.style.background = v > 50 ? 'var(--teal)' : v > 25 ? 'var(--amber)' : 'var(--red)';
  }
  setAmmo(mag: number, res: number, hint: string) {
    if (mag !== this.last.mag) { this.ammoCur.textContent = String(mag); this.ammoCur.style.color = mag <= 6 ? 'var(--red)' : 'var(--amber)'; this.last.mag = mag; }
    if (res !== this.last.res) { this.ammoRes.textContent = '/ ' + res; this.last.res = res; }
    if (hint !== this.last.hint) { this.ammoHint.textContent = hint; this.last.hint = hint; }
  }
  setObjective(title: string, lines: { text: string; done: boolean }[]) {
    const key = title + lines.map((l) => l.text + l.done).join('|');
    if (key === this.last.obj) return; this.last.obj = key;
    this.objTitle.textContent = title;
    this.objList.innerHTML = lines.map((l) => `<div class="${l.done ? 'done' : ''}">${l.done ? '■' : '□'} ${l.text}</div>`).join('');
  }
  setCrosshair(spreadPx: number, visible: boolean) {
    const g = 4 + spreadPx, [t, b, l, r, d] = this.cross;
    t.style.top = -g - 9 + 'px'; b.style.top = g + 'px'; l.style.left = -g - 9 + 'px'; r.style.left = g + 'px';
    const o = visible ? '0.9' : '0';
    t.style.opacity = b.style.opacity = l.style.opacity = r.style.opacity = o; d.style.opacity = visible ? '0.9' : '0';
  }
  hitMarker(kill: boolean) { this.hitT = kill ? 0.4 : 0.18; this.hit.classList.toggle('kill', kill); }
  damageFrom(x: number, z: number) {
    const el = document.createElement('b'); this.dmg.appendChild(el);
    this.dmgArcs.push({ el, t: 1.3, x, z });
  }
  message(text: string, sub = '', secs = 3.5) {
    if (text) { this.msg.textContent = text; this.msg.style.opacity = '1'; } else if (this.msgT > secs) secs = this.msgT;
    this.sub.textContent = sub; this.sub.style.opacity = '1'; this.msgT = secs;
  }
  setHold(frac: number | null, text = '') {
    this.hold.style.display = frac === null ? 'none' : 'block';
    if (frac !== null) { this.holdBar.style.width = (frac * 100).toFixed(1) + '%'; this.holdText.textContent = text; }
  }

  update(dt: number, px: number, pz: number, yaw: number, markers: Marker[], fpsVal: number, info: string) {
    if (this.hitT > 0) { this.hitT -= dt; this.hit.style.opacity = String(Math.max(0, Math.min(1, this.hitT * 8))); }
    if (this.msgT > 0) { this.msgT -= dt; if (this.msgT <= 0) this.msg.style.opacity = this.sub.style.opacity = '0'; }
    const bearing = -yaw;                                   // 0 = north (-Z), clockwise
    for (let i = this.dmgArcs.length - 1; i >= 0; i--) {
      const a = this.dmgArcs[i]; a.t -= dt;
      if (a.t <= 0) { a.el.remove(); this.dmgArcs.splice(i, 1); continue; }
      const rel = Math.atan2(a.x - px, -(a.z - pz)) - bearing;
      a.el.style.transform = `rotate(${rel}rad)`; a.el.style.opacity = String(Math.min(1, a.t * 1.5));
    }
    this.fps.textContent = this.showFps ? `${fpsVal.toFixed(0)} fps  ${info}` : '';
    this.drawCompass(px, pz, bearing, markers);
  }

  private drawCompass(px: number, pz: number, bearing: number, markers: Marker[]) {
    const c = this.compass, W = 920, H = 88, span = (110 * Math.PI) / 180, toX = (rel: number) => W / 2 + (rel / (span / 2)) * (W / 2);
    const wrap = (a: number) => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; };
    c.clearRect(0, 0, W, H);
    const fade = c.createLinearGradient(0, 0, W, 0);
    fade.addColorStop(0, 'rgba(8,16,12,0)'); fade.addColorStop(0.5, 'rgba(8,16,12,0.6)'); fade.addColorStop(1, 'rgba(8,16,12,0)');
    c.fillStyle = fade; c.fillRect(0, 8, W, 46);
    c.textAlign = 'center'; c.lineWidth = 2;
    for (let d = 0; d < 360; d += 15) {
      const rel = wrap((d * Math.PI) / 180 - bearing); if (Math.abs(rel) > span / 2) continue;
      const x = toX(rel), a = 1 - Math.abs(rel) / (span / 2);
      c.strokeStyle = c.fillStyle = `rgba(233,242,234,${0.25 + a * 0.7})`;
      const major = d % 90 === 0, mid = d % 45 === 0;
      c.beginPath(); c.moveTo(x, 12); c.lineTo(x, major ? 26 : 19); c.stroke();
      if (mid) { c.font = `${major ? 600 : 400} ${major ? 24 : 17}px Bahnschrift, "Segoe UI", sans-serif`; c.fillText(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][d / 45], x, 50); }
    }
    c.fillStyle = '#ffc45c'; c.beginPath(); c.moveTo(W / 2 - 7, 2); c.lineTo(W / 2 + 7, 2); c.lineTo(W / 2, 12); c.fill();
    for (const m of markers) {
      const dx = m.x - px, dz = m.z - pz, dist = Math.hypot(dx, dz);
      let rel = wrap(Math.atan2(dx, -dz) - bearing);
      rel = Math.max(-span / 2 + 0.05, Math.min(span / 2 - 0.05, rel));
      const x = toX(rel);
      c.fillStyle = m.color; c.beginPath(); c.moveTo(x, 58); c.lineTo(x + 9, 68); c.lineTo(x, 78); c.lineTo(x - 9, 68); c.fill();
      c.font = '600 15px ui-monospace, Consolas, monospace'; c.fillStyle = 'rgba(0,0,0,.7)'; c.fillText(`${m.label} ${dist.toFixed(0)}m`, x + 1, 87);
      c.fillStyle = m.color; c.fillText(`${m.label} ${dist.toFixed(0)}m`, x, 86);
    }
  }
}
