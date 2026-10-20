// All sound is synthesised with WebAudio: no assets, works offline and straight from file://.
export class Audio {
  constructor() {
    this.ctx = null; this.muted = false; this.last = {}; this.listener = [0, 0, 0];
  }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain(); this.master.gain.value = 0.7;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 6;
    this.master.connect(comp); comp.connect(ctx.destination);
    const len = ctx.sampleRate * 2; const buf = ctx.createBuffer(1, len, ctx.sampleRate); const d = buf.getChannelData(0);
    let b = 0; for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = w * 0.6 + b * 2.2; }
    this.noise = buf;
  }
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.7; }
  setListener(p) { this.listener = p; }
  _vol(p, ref = 30) { if (!p) return 1; const d = Math.hypot(p[0] - this.listener[0], p[1] - this.listener[1], p[2] - this.listener[2]); return 1 / (1 + (d / ref) ** 2); }
  _rate(key, ms) { const t = performance.now(); if (this.last[key] && t - this.last[key] < ms) return false; this.last[key] = t; return true; }
  _noise(t0, dur, f0, f1, gain, type = 'lowpass', q = 0.7) {
    const ctx = this.ctx; const src = ctx.createBufferSource(); src.buffer = this.noise; src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, t0); f.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(this.master); src.start(t0, Math.random() * 1.5); src.stop(t0 + dur + 0.05);
  }
  _tone(t0, dur, f0, f1, gain, type = 'sine') {
    const ctx = this.ctx; const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(this.master); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  ok() { return this.ctx && !this.muted && this.ctx.state === 'running'; }
  boom(p, size = 1) {
    if (!this.ok()) return; const v = this._vol(p, 45) * Math.min(1.4, size); const t = this.ctx.currentTime + 0.01 + (this._dist(p) / 340) * 0.5;
    this._noise(t, 1.6 + size * 0.6, 2400, 90, 0.9 * v); this._tone(t, 0.7, 70, 28, 0.9 * v); this._noise(t + 0.05, 2.4, 600, 60, 0.35 * v);
  }
  _dist(p) { return p ? Math.hypot(p[0] - this.listener[0], p[1] - this.listener[1], p[2] - this.listener[2]) : 0; }
  crumble(p, k = 1) { if (!this.ok() || !this._rate('crumble', 70)) return; const v = this._vol(p, 25) * Math.min(1, k); const t = this.ctx.currentTime; this._noise(t, 0.5 + Math.random() * 0.6, 1400, 200, 0.35 * v, 'bandpass', 0.9); }
  impact(p, J) { if (!this.ok() || !this._rate('impact', 45)) return; const k = Math.min(1.2, Math.log10(1 + J / 800) * 0.6); const v = this._vol(p, 28) * k; const t = this.ctx.currentTime; this._noise(t, 0.25 + k * 0.3, 900, 120, 0.6 * v); this._tone(t, 0.25, 110, 45, 0.35 * v); }
  creak(p, k = 0.5) {
    if (!this.ok() || !this._rate('creak', 260)) return; const v = this._vol(p, 30) * (0.35 + k * 0.4); const ctx = this.ctx; const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; const base = 55 + Math.random() * 60; o.frequency.setValueAtTime(base, t); o.frequency.linearRampToValueAtTime(base * (0.7 + Math.random() * 0.6), t + 0.9);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 9 + Math.random() * 14; const lg = ctx.createGain(); lg.gain.value = base * 0.18; lfo.connect(lg); lg.connect(o.frequency);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 9; f.frequency.value = 300 + Math.random() * 500;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25 * v, t + 0.15); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.0);
    o.connect(f); f.connect(g); g.connect(this.master); o.start(t); lfo.start(t); o.stop(t + 1.05); lfo.stop(t + 1.05);
  }
  crack(p) { if (!this.ok() || !this._rate('crack', 60)) return; const v = this._vol(p, 30); const t = this.ctx.currentTime; this._noise(t, 0.12, 5000, 900, 0.5 * v, 'highpass', 0.5); this._noise(t + 0.02, 0.6, 700, 120, 0.4 * v); }
  glass(p) { if (!this.ok() || !this._rate('glass', 40)) return; const v = this._vol(p, 25); const t = this.ctx.currentTime; this._noise(t, 0.35, 9000, 3000, 0.25 * v, 'highpass', 0.6); for (let i = 0; i < 4; i++) this._tone(t + Math.random() * 0.15, 0.3 + Math.random() * 0.3, 2200 + Math.random() * 3000, 1800 + Math.random() * 2000, 0.05 * v); }
  gun() { if (!this.ok()) return; const t = this.ctx.currentTime; this._noise(t, 0.09, 6000, 900, 0.35, 'lowpass', 0.6); this._tone(t, 0.06, 160, 60, 0.3, 'square'); }
  launch() { if (!this.ok()) return; const t = this.ctx.currentTime; this._noise(t, 0.6, 3000, 400, 0.4, 'bandpass', 0.8); this._tone(t, 0.25, 120, 50, 0.3); }
  swing() { if (!this.ok()) return; const t = this.ctx.currentTime; this._noise(t, 0.22, 600, 2400, 0.18, 'bandpass', 1.4); }
  thud(p) { if (!this.ok()) return; const v = this._vol(p, 20); const t = this.ctx.currentTime; this._tone(t, 0.25, 90, 40, 0.7 * v); this._noise(t, 0.35, 1200, 150, 0.5 * v); }
  beep() { if (!this.ok()) return; const t = this.ctx.currentTime; this._tone(t, 0.08, 1800, 1800, 0.12, 'square'); }
  snap(p) { if (!this.ok() || !this._rate('snap', 80)) return; const v = this._vol(p, 25); const t = this.ctx.currentTime; this._tone(t, 0.15, 900, 300, 0.2 * v, 'triangle'); this._noise(t, 0.2, 3000, 600, 0.25 * v, 'bandpass', 2); }
  pad() { if (!this.ok()) return; const t = this.ctx.currentTime; this._tone(t, 0.4, 200, 900, 0.3, 'triangle'); }
}
