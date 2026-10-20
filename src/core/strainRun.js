// One Strain pass over a group: rebuild coarse graph -> find unsupported islands -> solve anchored islands ->
// report overloaded connections. Runs inside the worker (or inline as a fallback / in tests).
import { buildRegionGraph, solveIsland } from './strain.js';

export function solveRegion(st, region, epoch) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const g = buildRegionGraph(st, region);
  let maxU = 0, nnz = 0;
  for (const I of g.islands) if (I.anchored) { maxU = Math.max(maxU, solveIsland(g, I)); nnz += I.nnz || 0; }
  const breaks = [];
  const n = g.nodes.length, m = g.conns.length;
  const nodeCom = new Float32Array(n * 3), nodeU = new Float32Array(n);
  g.nodes.forEach((nd, i) => { nodeCom.set(nd.com, i * 3); nodeU[i] = nd.U; });
  const connA = new Int32Array(m), connB = new Int32Array(m), connP = new Float32Array(m * 3), connU = new Float32Array(m), connThr = new Float32Array(m);
  const connAx = new Float32Array(m), connSh = new Float32Array(m), connBe = new Float32Array(m), connMa = new Int32Array(m), connMb = new Int32Array(m);
  g.conns.forEach((c, i) => {
    connA[i] = c.a; connB[i] = c.b; connP.set(c.p, i * 3); connMa[i] = c.ma; connMb[i] = c.mb;
    const solved = c.U !== undefined && g.islands[g.nodes[c.a].island].anchored;
    connU[i] = solved ? c.U : 0; connThr[i] = c.thr || 1; connAx[i] = (c.uAx || 0) * (c.N > 0 ? 1 : -1); connSh[i] = c.uSh || 0; connBe[i] = c.uBe || 0;
    if (solved && c.U > c.thr) {
      breaks.push({ key: c.ma + ':' + c.mb, bonds: c.bonds.slice(), p: c.p, e1: c.e1, h1: c.h1, h2: c.h2, duct: c.duct, area: c.area,
        U: c.U, thr: c.thr, cap: Math.min(c.sigT, c.tau) * c.area, ma: c.ma, mb: c.mb });
    }
  });
  const R = st.regions[region];
  const shardNode = new Int32Array(R.shards.length).fill(-1);
  R.shards.forEach((sid, i) => { const v = g.nodeOf.get(sid); if (v !== undefined) shardNode[i] = v; });
  const ms = (typeof performance !== 'undefined' ? performance : Date).now() - t0;
  return { type: 'result', region, epoch, detached: Int32Array.from(g.detached), breaks, ms, maxU, nnz, nodes: n, conns: m,
    viz: { nodeCom, nodeU, connA, connB, connP, connU, connThr, connAx, connSh, connBe, connMa, connMb, shardNode } };
}

// Minimal mirror of the Structure that the solver needs (sent once to the worker).
export function liteStructure(st) {
  return {
    shards: st.shards.map((s) => ({ id: s.id, state: s.state, bonds: s.bonds, mass: s.mass, c: s.c, extF: null, fixed: s.fixed, region: s.region, mod: s.mod, dmg: s.dmg, hp: s.hp })),
    bonds: st.bonds.map((b) => ({ a: b.a, b: b.b, area: b.area, p: b.p, ax: b.ax, sg: b.sg, intra: b.intra, broken: b.broken, Suu: b.Suu || 0, Sww: b.Sww || 0, Suw: b.Suw || 0, hu: b.hu || 0, hw: b.hw || 0 })),
    modules: st.modules.map((m) => ({ id: m.id, kind: m.kind, fixed: !!m.fixed, shards: m.shards, def: { sigT: m.def.sigT, sigC: m.def.sigC, tau: m.def.tau, E: m.def.E, G: m.def.G, duct: m.def.duct, glass: !!m.def.glass } })),
    regions: st.regions.map((r) => ({ id: r.id, modules: r.modules, bonds: r.bonds, secondary: r.secondary, shards: r.shards })),
  };
}
export function attachHealth(lite) {
  lite.health = (s) => (s.fixed ? 1 : Math.max(0.2, Math.min(1, 1 - 0.8 * s.dmg / s.hp)));
  return lite;
}
