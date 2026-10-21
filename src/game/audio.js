// Sound: CC0 recordings (see sfx.js) played through a small sample engine: random variants with pitch jitter,
// distance gain / stereo pan / air-absorption low-pass / speed-of-sound delay, a convolution "street" reverb
// and a voice cap. Banks stay silent while loading; only if a bank fails to load (e.g. offline from file://)
// does that event fall back to the old WebAudio synthesiser.
import { BANKS, rawUrl, localName } from './sfx.js';

const WOODY = new Set(['wood', 'crate', 'panel']), METAL = new Set(['steel', 'rail']);

class Synth {
  constructor(a) { this.a = a; }
  get ctx() { return this.a.ctx; }
  get out() { return this.a.dry; }
  _noise(t0, dur, f0, f1, gain, type = 'lowpass', q = 0.7) {
    const ctx = this.ctx; const src = ctx.createBufferSource(); src.buffer = this.a.noise; src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, t0); f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(this.out); src.start(t0, Math.random() * 1.5); src.stop(t0 + dur + 0.05);
  }
  _tone(t0, dur, f0, f1, gain, type = 'sine') {
    const ctx = this.ctx; const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.out); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  boom(p, size) { const v = this.a._vol(p, 45) * Math.min(1.4, size); const t = this.ctx.currentTime + 0.01; this._noise(t, 1.6 + size * 0.6, 2400, 90, 0.9 * v); this._tone(t, 0.7, 70, 28, 0.9 * v); }
  crumble(p, k) { const v = this.a._vol(p, 25) * Math.min(1, k); this._noise(this.ctx.currentTime, 0.5 + Math.random() * 0.6, 1400, 200, 0.35 * v, 'bandpass', 0.9); }
  impact(p, J) { const k = Math.min(1.2, Math.log10(1 + J / 800) * 0.6); const v = this.a._vol(p, 28) * k; const t = this.ctx.currentTime; this._noise(t, 0.25 + k * 0.3, 900, 120, 0.6 * v); this._tone(t, 0.25, 110, 45, 0.35 * v); }
  glass(p) { const v = this.a._vol(p, 25); const t = this.ctx.currentTime; this._noise(t, 0.35, 9000, 3000, 0.25 * v, 'highpass', 0.6); }
  gun() { const t = this.ctx.currentTime; this._noise(t, 0.09, 6000, 900, 0.35, 'lowpass', 0.6); this._tone(t, 0.06, 160, 60, 0.3, 'square'); }
  launch() { const t = this.ctx.currentTime; this._noise(t, 0.6, 3000, 400, 0.4, 'bandpass', 0.8); }
  thud(p) { const v = this.a._vol(p, 20); const t = this.ctx.currentTime; this._tone(t, 0.25, 90, 40, 0.7 * v); this._noise(t, 0.35, 1200, 150, 0.5 * v); }
  beep() { this._tone(this.ctx.currentTime, 0.08, 1800, 1800, 0.12, 'square'); }
}

export class Audio {
  constructor(opts = {}) {
    this.ctx = null; this.muted = false; this.last = {}; this.listener = [0, 0, 0]; this.right = [1, 0, 0];
    this.lite = !!opts.lite; this.maxVoices = this.lite ? 14 : 26; this.voices = 0;
    this.buf = {}; this.state = {}; this.lastIdx = {}; this.loaded = 0; this.total = Object.keys(BANKS).length;
    this.syn = new Synth(this); this.zipVoice = null;
  }
  init() {
    if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    let ctx;
    try { ctx = this.ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { ctx = this.ctx = new AC(); }
    this.master = ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.85;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -15; comp.knee.value = 12; comp.ratio.value = 5; comp.attack.value = 0.002; comp.release.value = 0.22;
    this.master.connect(comp); comp.connect(ctx.destination);
    this.dry = ctx.createGain(); this.dry.connect(this.master);
    if (!this.lite && ctx.createConvolver) {
      this.verb = ctx.createConvolver(); this.verb.buffer = this._ir(1.8);
      const wet = ctx.createGain(); wet.gain.value = 0.5; this.verb.connect(wet); wet.connect(this.master);
    }
    const len = ctx.sampleRate; const nb = ctx.createBuffer(1, len, ctx.sampleRate); const d = nb.getChannelData(0);
    let b = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = w * 0.6 + b * 2.2; }
    this.noise = nb;
    // iOS needs a sound started inside the unlocking gesture
    const s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, 22050); s.connect(ctx.destination); s.start(0);
    if (ctx.state !== 'running') ctx.resume();
    this._load();
  }
  // impulse response: short urban slap-back + a darkening diffuse tail
  _ir(sec) {
    const ctx = this.ctx, sr = ctx.sampleRate, n = Math.floor(sr * sec), buf = ctx.createBuffer(2, n, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c); let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / sr, x = i / n;
        const a = 0.2 + 0.7 * x;
        lp += (Math.random() * 2 - 1 - lp) * (1 - a);
        d[i] = t < 0.011 ? 0 : lp * Math.pow(1 - x, 2.4) * Math.exp(-t * 1.9) * 0.55;
      }
      for (const [dt, g] of [[0.021, 0.42], [0.038, 0.3], [0.061, 0.22], [0.093, 0.12]]) { const k = Math.floor((dt + c * 0.0037) * sr); if (k < n) d[k] += g * (c ? 0.9 : 1); }
    }
    return buf;
  }
  async _load() {
    let local = null;
    try { const r = await fetch('sfx/index.json', { cache: 'no-cache' }); if (r.ok) local = new Set((await r.json()).files); } catch (e) { /* file:// or a dev build without sfx */ }
    const order = Object.entries(BANKS).sort((a, b) => a[1].prio - b[1].prio);
    const jobs = [], left = new Map();
    for (const [name, bank] of order) {
      const files = this.lite && bank.low !== undefined ? bank.files.slice(0, bank.low) : bank.files;
      this.buf[name] = [];
      if (!files.length) { this.state[name] = 'skip'; continue; }
      this.state[name] = 'loading'; left.set(name, files.length);
      for (const f of files) jobs.push({ name, src: bank.src, f });
    }
    let i = 0;
    const worker = async () => {
      while (i < jobs.length) {
        const j = jobs[i++];
        const b = await this._fetchOne(j.src, j.f, local);
        if (b) this.buf[j.name].push(b);
        const n = left.get(j.name) - 1; left.set(j.name, n);
        if (n === 0) { this.state[j.name] = this.buf[j.name].length ? 'ok' : 'fail'; if (this.state[j.name] === 'ok') this.loaded++; }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker(), worker()]);
    console.log(`[strain-lab] sfx: ${this.loaded}/${order.length} banks loaded${local ? '' : ' (no local sfx/, used GitHub mirror)'}`);
  }
  async _fetchOne(src, f, local) {
    const ln = localName(src, f), urls = [];
    if (local && local.has(ln)) urls.push('sfx/' + ln);
    urls.push(rawUrl(src, f));
    for (const u of urls) {
      try {
        const r = await fetch(u); if (!r.ok) continue;
        return await this._decode(await r.arrayBuffer());
      } catch (e) { /* next source */ }
    }
    return null;
  }
  _decode(ab) { return new Promise((res, rej) => { const p = this.ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); }); }

  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.85; if (m) this.zip(false); }
  setListener(p, yaw = 0) { this.listener = p; this.right = [Math.cos(yaw), 0, -Math.sin(yaw)]; }
  ok() { return this.ctx && !this.muted && this.ctx.state === 'running'; }
  failed(name) { return this.state[name] === 'fail'; }
  _dist(p) { return p ? Math.hypot(p[0] - this.listener[0], p[1] - this.listener[1], p[2] - this.listener[2]) : 0; }
  _vol(p, ref = 30) { if (!p) return 1; const d = this._dist(p); return 1 / (1 + (d / ref) ** 2); }
  _pan(p) { const dx = p[0] - this.listener[0], dy = p[1] - this.listener[1], dz = p[2] - this.listener[2]; const L = Math.hypot(dx, dy, dz) || 1; return Math.max(-1, Math.min(1, (dx * this.right[0] + dz * this.right[2]) / L)) * 0.8; }
  _rate(key, ms) { const t = performance.now(); if (this.last[key] && t - this.last[key] < ms) return false; this.last[key] = t; return true; }
  _pick(name) {
    const L = this.buf[name]; if (!L || !L.length) return null;
    let k = (Math.random() * L.length) | 0; if (L.length > 1 && k === this.lastIdx[name]) k = (k + 1) % L.length;
    this.lastIdx[name] = k; return L[k];
  }

  // o: p (world pos), vol, rate, jit, ref (m), lpRef, wet, delay, sound (speed-of-sound delay), prio, offset, dur, fade, loop
  play(name, o = {}) {
    if (!this.ok()) return null;
    const prio = o.prio ?? 1;
    if (this.voices >= this.maxVoices + (prio >= 3 ? 10 : prio >= 2 ? 4 : 0)) return null;
    const buf = this._pick(name); if (!buf) return null;
    const ctx = this.ctx, d = o.p ? this._dist(o.p) : 0;
    const g = (o.vol ?? 1) * (o.p ? 1 / (1 + (d / (o.ref ?? 18)) ** 1.7) : 1);
    if (g < 0.012) return null;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = !!o.loop;
    const rate = (o.rate ?? 1) * (1 + (Math.random() * 2 - 1) * (o.jit ?? 0.06));
    src.playbackRate.value = rate;
    let node = src;
    const cut = o.p ? 19000 / (1 + d / (o.lpRef ?? 32)) : 0;
    if (cut && cut < 15000) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = Math.max(600, cut); f.Q.value = 0.5; node.connect(f); node = f; }
    const gn = ctx.createGain();
    const t0 = ctx.currentTime + 0.005 + (o.delay ?? 0) + (o.sound ? Math.min(0.32, d / 343) : 0);
    gn.gain.setValueAtTime(g, t0);
    if (o.dur) { const fe = Math.min(o.fade ?? 0.12, o.dur * 0.8); gn.gain.setValueAtTime(g, t0 + o.dur - fe); gn.gain.linearRampToValueAtTime(0.0001, t0 + o.dur); }
    node.connect(gn); node = gn;
    if (o.p && ctx.createStereoPanner) { const pn = ctx.createStereoPanner(); pn.pan.value = this._pan(o.p); node.connect(pn); node = pn; }
    node.connect(this.dry);
    const wet = o.wet ?? 0.12;
    if (this.verb && wet > 0) { const s = ctx.createGain(); s.gain.value = wet * Math.min(1.4, 0.5 + d / 35); node.connect(s); s.connect(this.verb); }
    let off = o.offset ?? 0;
    if (off === 'rand') off = Math.random() * Math.max(0, buf.duration - (o.dur || 0) * rate - 0.05);
    if (o.loop) src.start(t0, off); else src.start(t0, off, o.dur ? o.dur * rate + 0.03 : buf.duration);
    this.voices++;
    src.onended = () => { this.voices--; try { node.disconnect(); } catch (e) { /* gone */ } };
    return { src, gain: gn };
  }
  _bankFor(mat, kind) {
    if (mat === 'glass') return kind === 'hit' ? 'hitGlass' : kind === 'bullet' ? 'bulletGlass' : 'glass';
    if (WOODY.has(mat)) return kind === 'hit' ? 'hitWood' : kind === 'bullet' ? 'bulletWood' : 'woodBreak';
    if (METAL.has(mat)) return kind === 'hit' ? 'hitMetal' : kind === 'bullet' ? 'bulletMetal' : 'metalFall';
    return kind === 'hit' ? 'hitRock' : kind === 'bullet' ? 'bulletRock' : 'crumble';
  }

  // ------------------------------------------------------------------ game events
  boom(p, size = 1, kind = 'rpg') {
    if (!this.ok()) return;
    if (this.failed('boom')) return this.syn.boom(p, size);
    const big = kind === 'c4' || kind === 'canister' || kind === 'meteor';
    const rate = 1.04 - Math.min(0.3, Math.max(0, size - 1) * 0.22);
    this.play('boom', { p, vol: 1.1 * Math.min(1.5, 0.65 + size * 0.4), rate, jit: 0.05, ref: 40, lpRef: 70, wet: 0.45, prio: 3, sound: true });
    this.play('boomLow', { p, vol: 0.95 * Math.min(1.4, size), rate: 0.86 * rate, jit: 0.04, ref: 60, lpRef: 400, wet: 0.2, prio: 3, sound: true });
    if (big) this.play('boomBig', { p, vol: kind === 'meteor' ? 0.95 : 0.7, rate: kind === 'meteor' ? 0.78 : 1.0, jit: 0.05, ref: 45, wet: 0.4, prio: 2, sound: true });
    if (kind === 'slam') this.play('punch', { p, vol: 0.9, rate: 0.6, ref: 15, prio: 3 });
    else this.play('rubble', { p, vol: 0.55 * Math.min(1.3, size), rate: 0.92, jit: 0.1, ref: 26, delay: 0.16 + Math.random() * 0.22, wet: 0.22, prio: 1, sound: true });
  }
  crumble(p, k = 1, mat = 'concrete') {
    if (!this.ok() || !this._rate('crumble', 55)) return;
    const bank = this._bankFor(mat, 'break');
    if (this.failed(bank)) return this.syn.crumble(p, k);
    this.play(bank, { p, vol: 0.5 * Math.min(1.25, 0.45 + k), rate: 1.02 - Math.min(0.25, k * 0.15), jit: 0.1, ref: 18, wet: 0.16, prio: 1 });
  }
  glass(p) {
    if (!this.ok() || !this._rate('glass', 45)) return;
    if (this.failed('glass')) return this.syn.glass(p);
    this.play('glass', { p, vol: 0.5, jit: 0.08, ref: 16, wet: 0.2, prio: 1 });
    if (Math.random() < 0.35) this.play('glassFall', { p, vol: 0.3, delay: 0.12, jit: 0.1, ref: 14, prio: 0 });
  }
  impact(p, J, mat = 'concrete') {
    if (!this.ok() || !this._rate('impact', 38)) return;
    const k = Math.min(1.4, Math.log10(1 + J / 800) * 0.6);
    const bank = this._bankFor(mat, 'hit');
    if (this.failed(bank)) return this.syn.impact(p, J);
    this.play(bank, { p, vol: 0.6 * k, rate: 1.06 - k * 0.2, jit: 0.08, ref: 20, wet: 0.18, prio: 1 });
    if (J > 15000 && bank === 'hitRock' && this._rate('rubbleImpact', 260)) this.play('rubble', { p, vol: 0.45 * k, rate: 0.86, ref: 22, wet: 0.22, prio: 1 });
    if (J > 8000 && bank === 'hitMetal') this.play('heavyMetal', { p, vol: 0.4 * k, rate: 0.82, ref: 20, prio: 1 });
  }
  creak(p, k = 0.5) {
    if (!this.ok() || !this._rate('creak', 230)) return;
    this.play('creak', { p, vol: 0.35 + 0.45 * k, rate: 0.48 + Math.random() * 0.25, jit: 0.02, ref: 22, wet: 0.4, prio: 1 });
  }
  crack(p) {
    if (!this.ok() || !this._rate('crack', 70)) return;
    this.play('crumble', { p, vol: 0.62, rate: 0.72, jit: 0.08, ref: 24, wet: 0.32, prio: 2 });
  }
  collapse(p, n) {
    if (!this.ok() || !this._rate('collapse', 1100)) return;
    const k = Math.min(1.3, 0.6 + n / 400);
    this.play('fall', { p, vol: 0.9 * k, rate: 0.84, jit: 0.05, ref: 40, wet: 0.45, prio: 2, sound: true });
    this.play('boomLow', { p, vol: 0.7 * k, rate: 0.52, jit: 0.03, ref: 60, lpRef: 400, wet: 0.3, prio: 2, sound: true });
    this.play('rubble', { p, vol: 0.6 * k, rate: 0.8, delay: 0.55, ref: 30, wet: 0.3, prio: 1, sound: true });
  }
  bullet(p, mat) {
    if (!this.ok() || !this._rate('bullet', 28)) return;
    this.play(this._bankFor(mat, 'bullet'), { p, vol: 0.32, jit: 0.1, ref: 12, wet: 0.08, prio: 1 });
  }
  gun() {
    if (!this.ok()) return;
    if (this.failed('gun')) return this.syn.gun();
    this.play('gun', { vol: 0.55, rate: 0.8, jit: 0.04, dur: 0.38, fade: 0.14, wet: 0.28, prio: 3 });
    if (!this.lite) this.play('punch', { vol: 0.14, rate: 0.55, jit: 0.05, dur: 0.12, fade: 0.06, wet: 0, prio: 2 });
  }
  launch() {
    if (!this.ok()) return;
    if (this.failed('launch')) return this.syn.launch();
    this.play('launch', { vol: 0.6, rate: 1.25, jit: 0.05, offset: 'rand', dur: 0.85, fade: 0.55, wet: 0.25, prio: 3 });
    this.play('punch', { vol: 0.55, rate: 0.62, jit: 0.04, wet: 0.1, prio: 3 });
    this.play('boomLow', { vol: 0.28, rate: 1.7, jit: 0.04, wet: 0.15, prio: 3 });
  }
  swing() { if (this.ok()) this.play('swing', { vol: 0.5, jit: 0.08, wet: 0.05, prio: 3 }); }
  thud(p, mat = 'concrete') {
    if (!this.ok()) return;
    if (this.failed('punch')) return this.syn.thud(p);
    this.play('punch', { p, vol: 0.85, rate: 0.75, ref: 10, prio: 3 });
    this.play(this._bankFor(mat, 'hit'), { p, vol: 0.7, rate: 0.95, ref: 12, wet: 0.15, prio: 3 });
  }
  beep() { if (!this.ok()) return; if (this.failed('tick')) return this.syn.beep(); this.play('tick', { vol: 0.4, jit: 0.02, wet: 0, prio: 3 }); }
  arm(p) { if (this.ok()) this.play('arm', { p, vol: 0.55, ref: 8, wet: 0.05, prio: 3 }); }
  snap(p, rope) {
    if (!this.ok() || !this._rate('snap', 90)) return;
    if (rope) { this.play('latch', { p, vol: 0.8, rate: 0.75, ref: 20, prio: 2 }); this.play('hitMetal', { p, vol: 0.6, rate: 0.7, ref: 20, prio: 2 }); }
    else this.play('woodBreak', { p, vol: 0.3, rate: 1.2, ref: 16, prio: 1 });
  }
  pad() { if (!this.ok()) return; this.play('soft', { vol: 0.6, rate: 0.7, prio: 3 }); this.play('boomLow', { vol: 0.32, rate: 2.0, wet: 0.1, prio: 3 }); }
  step(mat) { if (this.ok()) this.play(mat === 'wood' ? 'stepWood' : mat === 'metal' ? 'stepMetal' : 'stepConcrete', { vol: mat === 'metal' ? 0.12 : 0.22, jit: 0.08, wet: 0.03, prio: 2 }); }
  land(v) { if (this.ok()) this.play('land', { vol: Math.min(0.75, 0.18 + v * 0.05), rate: 0.9, prio: 2 }); }
  djump() { if (this.ok()) this.play('swing', { vol: 0.16, rate: 1.45, prio: 2 }); }
  equip() { if (this.ok() && this._rate('equip', 80)) this.play('equip', { vol: 0.35, wet: 0, prio: 3 }); }
  ui(ok = false) { if (this.ok()) this.play(ok ? 'uiOk' : 'ui', { vol: 0.45, wet: 0, jit: 0.02, prio: 3 }); }
  zip(on, speed = 10) {
    if (!on) { if (this.zipVoice) { const v = this.zipVoice, t = this.ctx.currentTime; this.zipVoice = null; try { v.gain.gain.cancelScheduledValues(t); v.gain.gain.setTargetAtTime(0.0001, t, 0.05); v.src.stop(t + 0.3); } catch (e) { /* stopped */ } } return; }
    if (!this.ok()) return;
    if (!this.zipVoice) { this.play('latch', { vol: 0.6, prio: 3 }); this.zipVoice = this.play('zip', { vol: 0.14, rate: 0.55, jit: 0, loop: true, wet: 0, prio: 3 }); }
    if (this.zipVoice) this.zipVoice.src.playbackRate.value = 0.45 + speed / 28;
  }
}
