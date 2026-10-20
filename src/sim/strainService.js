// Front-end for Strain: batches structural deltas each tick and gets solve results back.
// Worker backend when available, inline (time-budgeted) backend otherwise.
import { solveRegion, liteStructure, attachHealth } from '../core/strainRun.js';

export class StrainService {
  constructor(st, { workerFactory = null } = {}) {
    this.st = st;
    this.epoch = new Int32Array(st.regions.length);
    this.results = [];
    this.d = { states: [], dmg: [], broken: [], ext: [], dirty: new Set() };
    this.worker = null;
    this.inflight = 0;
    if (workerFactory) {
      try {
        this.worker = workerFactory();
        this.worker.onmessage = (e) => { this.inflight = Math.max(0, this.inflight - 1); this.results.push(e.data); };
        this.worker.onerror = (e) => { console.warn('strain worker failed, falling back inline', e.message); this.worker = null; this._inline(); };
        this.worker.postMessage({ type: 'init', lite: liteStructure(st) });
      } catch (err) { console.warn('no strain worker:', err); this.worker = null; }
    }
    if (!this.worker) this._inline();
    for (const r of st.regions) this.markDirty(r.id);
  }
  _inline() { this.lite = null; this.queue = new Map(); this.mode = 'inline'; }
  get backend() { return this.worker ? 'worker' : 'inline'; }
  shardState(id, state) { this.d.states.push(id, state); }
  shardDmg(id, dmg) { this.d.dmg.push(id, dmg); }
  bondBroken(id) { this.d.broken.push(id); }
  extForce(id, f) { this.d.ext.push(id, f ? f[0] : 0, f ? f[1] : 0, f ? f[2] : 0); }
  markDirty(region) { this.epoch[region]++; this.d.dirty.add(region); }
  flush() {
    const d = this.d;
    if (!d.dirty.size && !d.states.length && !d.dmg.length && !d.broken.length && !d.ext.length) return;
    const dirty = []; for (const r of d.dirty) dirty.push(r, this.epoch[r]);
    if (this.worker) {
      this.worker.postMessage({ type: 'update', states: d.states, dmg: d.dmg, broken: d.broken, ext: d.ext, dirty });
      this.inflight++;
    } else {
      // inline: the real structure is the source of truth already
      for (let i = 0; i < dirty.length; i += 2) this.queue.set(dirty[i], dirty[i + 1]);
    }
    this.d = { states: [], dmg: [], broken: [], ext: [], dirty: new Set() };
  }
  // returns finished results; inline backend solves within the time budget
  poll(budgetMs = 6) {
    if (!this.worker && this.queue && this.queue.size) {
      const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
      if (!this.st.health) attachHealth(this.st);
      while (this.queue.size) {
        const [region, epoch] = this.queue.entries().next().value; this.queue.delete(region);
        this.results.push(solveRegion(this.st, region, epoch));
        if ((typeof performance !== 'undefined' ? performance : Date).now() - t0 > budgetMs) break;
      }
    }
    const out = this.results; this.results = [];
    return out;
  }
  busy() { return this.worker ? this.inflight > 0 : this.queue && this.queue.size > 0; }
  dispose() { if (this.worker) this.worker.terminate(); this.worker = null; }
}
