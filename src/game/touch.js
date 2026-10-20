// Touch controls: floating left stick (walk, push to the rim = sprint), drag anywhere on the right to look,
// FIRE (hold = auto, drag on it to aim), JUMP, ALT (C4), USE (ziplines / ladders) and a small toolbar.
// Pointer Events + per-finger capture, so any number of thumbs can be down at once.
export class Touch {
  constructor(game) {
    this.g = game; this.I = game.input;
    this.look = null; this.stick = null; this.fire = null; this.sens = 0.0052;
    const el = (this.root = document.createElement('div'));
    el.id = 'touch';
    el.innerHTML = `
      <div class="tz" data-z="move"></div><div class="tz" data-z="look"></div>
      <div class="stick"><i></i></div>
      <button class="tb fire" data-b="fire"><span>ОГОНЬ</span></button>
      <button class="tb jump" data-b="jump"><span>ПРЫЖОК</span></button>
      <button class="tb alt" data-b="alt"><span>ПОДРЫВ</span></button>
      <button class="tb use" data-b="use"><span>ЗИП</span></button>
      <div class="tbar">
        <button data-a="menu" title="меню">II</button><button data-a="view" title="вид">ВИД</button><button data-a="graph" title="граф">ГРАФ</button>
        <button data-a="slow" title="слоумо">×¼</button><button data-a="fly" title="полёт">ЛЕТ</button><button data-a="reset" title="сброс">↺</button>
      </div>`;
    document.body.appendChild(el);
    this.stickEl = el.querySelector('.stick'); this.knob = this.stickEl.querySelector('i');
    this.btn = Object.fromEntries([...el.querySelectorAll('[data-b]')].map((b) => [b.dataset.b, b]));
    for (const z of el.querySelectorAll('.tz')) {
      z.addEventListener('pointerdown', (e) => this._down(e, z.dataset.z));
      z.addEventListener('pointermove', (e) => this._move(e));
      z.addEventListener('pointerup', (e) => this._up(e)); z.addEventListener('pointercancel', (e) => this._up(e));
    }
    for (const [k, b] of Object.entries(this.btn)) {
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); b.classList.add('down'); this._press(k, e); });
      b.addEventListener('pointermove', (e) => { if (k === 'fire' && this.fire && this.fire.id === e.pointerId) this._lookDelta(e, this.fire); });
      const rel = (e) => { b.classList.remove('down'); this._release(k, e); };
      b.addEventListener('pointerup', rel); b.addEventListener('pointercancel', rel);
    }
    for (const b of el.querySelectorAll('[data-a]')) b.addEventListener('click', (e) => { e.preventDefault(); this.g.action(b.dataset.a); });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  _down(e, zone) {
    e.preventDefault();
    e.target.setPointerCapture(e.pointerId);
    this.g.audio.init();
    if (zone === 'move' && !this.stick) {
      this.stick = { id: e.pointerId, x0: e.clientX, y0: e.clientY };
      this.stickEl.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; this.stickEl.classList.add('on'); this.knob.style.transform = '';
    } else if (!this.look) this.look = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }
  _move(e) {
    if (this.stick && e.pointerId === this.stick.id) {
      const R = Math.min(70, window.innerHeight * 0.13);
      let dx = e.clientX - this.stick.x0, dy = e.clientY - this.stick.y0;
      const L = Math.hypot(dx, dy);
      if (L > R * 1.6) { const k = (L - R * 1.6) / L; this.stick.x0 += dx * k; this.stick.y0 += dy * k; dx -= dx * k; dy -= dy * k; this.stickEl.style.transform = `translate(${this.stick.x0}px, ${this.stick.y0}px)`; }
      const m = Math.min(1, Math.hypot(dx, dy) / R), a = Math.atan2(dy, dx);
      const dead = m < 0.12 ? 0 : (m - 0.12) / 0.88;
      this.I.move = [Math.cos(a) * dead, -Math.sin(a) * dead];
      this.I.sprint = Math.hypot(dx, dy) > R * 1.05;
      const kx = Math.cos(a) * Math.min(1, m) * R, ky = Math.sin(a) * Math.min(1, m) * R;
      this.knob.style.transform = `translate(${kx}px, ${ky}px)`;
      this.stickEl.classList.toggle('run', this.I.sprint);
    } else if (this.look && e.pointerId === this.look.id) this._lookDelta(e, this.look);
  }
  _lookDelta(e, st) {
    const pl = this.g.player; if (!pl || !this.g.running) return;
    const k = this.sens * (this.g.camera.fov / 74);
    pl.yaw -= (e.clientX - st.x) * k; pl.pitch = Math.max(-1.5, Math.min(1.5, pl.pitch - (e.clientY - st.y) * k));
    st.x = e.clientX; st.y = e.clientY;
  }
  _up(e) {
    if (this.stick && e.pointerId === this.stick.id) { this.stick = null; this.I.move = null; this.I.sprint = false; this.stickEl.classList.remove('on', 'run'); }
    if (this.look && e.pointerId === this.look.id) this.look = null;
  }
  _press(k, e) {
    const I = this.I; this.g.audio.init();
    if (k === 'fire') { I.lmb = true; I.lmbPressed = true; this.fire = { id: e.pointerId, x: e.clientX, y: e.clientY }; }
    else if (k === 'jump') { I.jumpPressed = true; I.jumpHeld = true; }
    else if (k === 'alt') I.rmbPressed = true;
    else if (k === 'use') I.usePressed = true;
  }
  _release(k) {
    if (k === 'fire') { this.I.lmb = false; this.fire = null; }
    if (k === 'jump') this.I.jumpHeld = false;
  }
  // per-frame: contextual buttons
  update() {
    const g = this.g, pl = g.player; if (!pl) return;
    const useOn = !!(pl.near || pl.zip || pl.ladder);
    this.btn.use.classList.toggle('show', useOn);
    this.btn.use.firstElementChild.textContent = pl.zip || pl.ladder ? 'СОЙТИ' : 'ЗИП';
    this.btn.alt.classList.toggle('show', g.weapons && g.weapons.current.id === 'c4');
  }
  reset() { const I = this.I; I.move = null; I.sprint = false; I.lmb = false; I.jumpHeld = false; this.stick = this.look = this.fire = null; this.stickEl.classList.remove('on', 'run'); for (const b of Object.values(this.btn)) b.classList.remove('down'); }
}
