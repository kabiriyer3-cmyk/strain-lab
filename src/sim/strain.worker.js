// Strain thread. THE FINALS amortises Strain across frames on the server; here it simply runs off the main thread.
import { solveRegion, attachHealth } from '../core/strainRun.js';
let st = null;
const queue = new Map(); // region -> epoch (latest wins)
let busy = false;
function pump() {
  busy = false;
  const it = queue.entries().next();
  if (it.done || !st) return;
  const [region, epoch] = it.value; queue.delete(region);
  const res = solveRegion(st, region, epoch);
  const v = res.viz;
  self.postMessage(res, [res.detached.buffer, v.nodeCom.buffer, v.nodeU.buffer, v.connA.buffer, v.connB.buffer, v.connP.buffer, v.connU.buffer, v.connThr.buffer, v.connAx.buffer, v.connSh.buffer, v.connBe.buffer, v.connMa.buffer, v.connMb.buffer, v.shardNode.buffer]);
  if (queue.size && !busy) { busy = true; setTimeout(pump, 0); }
}
self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') { st = attachHealth(m.lite); queue.clear(); }
  else if (m.type === 'update') {
    if (!st) return;
    const S = st.shards, Bn = st.bonds;
    for (let i = 0; i < m.states.length; i += 2) S[m.states[i]].state = m.states[i + 1];
    for (let i = 0; i < m.dmg.length; i += 2) S[m.dmg[i]].dmg = m.dmg[i + 1];
    for (const b of m.broken) Bn[b].broken = true;
    for (let i = 0; i < m.ext.length; i += 4) S[m.ext[i]].extF = m.ext[i + 1] === 0 && m.ext[i + 2] === 0 && m.ext[i + 3] === 0 ? null : [m.ext[i + 1], m.ext[i + 2], m.ext[i + 3]];
    for (let i = 0; i < m.dirty.length; i += 2) queue.set(m.dirty[i], m.dirty[i + 1]);
  }
  if (!busy && queue.size) { busy = true; setTimeout(pump, 0); }
};
