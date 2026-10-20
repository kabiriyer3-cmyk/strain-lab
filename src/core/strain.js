// STRAIN - structural analysis layer.
// Fine fragments are merged into coarse "strain nodes" (one per connected piece of a module), touching nodes
// form connections, nodes resting on the indestructible base are anchored. Each island is solved as a static
// frame of rigid bodies joined by 6-DOF elastic connections (direct stiffness method + sparse Cholesky).
// A connection breaks when its combined load leaves the "diamond" interaction envelope
//   |axial|/Naxial + |shear|/V + |bending|/M  >  1 + random offset            (cf. GDC 2024 slides)
import { STATIC } from './structure.js';
import { hash2 } from './rng.js';
import { solveBlockSPD } from './sparse.js';
import { KIND_STIFF } from './materials.js';

const G = 9.81;

export function buildRegionGraph(st, region) {
  const R = st.regions[region];
  const nodes = [], nodeOf = new Map();
  // 1) nodes = connected static pieces of each module
  for (const mid of R.modules) {
    const m = st.modules[mid];
    if (m.fixed || m.def.glass) continue;
    const seen = new Set();
    for (const sid of m.shards) {
      const s0 = st.shards[sid];
      if (s0.state !== STATIC || seen.has(sid)) continue;
      const comp = []; const stack = [sid]; seen.add(sid);
      while (stack.length) {
        const a = stack.pop(); comp.push(a);
        for (const bid of st.shards[a].bonds) {
          const b = st.bonds[bid]; if (!b.intra || b.broken) continue;
          const o = b.a === a ? b.b : b.a;
          if (seen.has(o) || st.shards[o].state !== STATIC) continue;
          seen.add(o); stack.push(o);
        }
      }
      const node = { id: nodes.length, module: mid, shards: comp, mass: 0, com: [0, 0, 0], extF: [0, 0, 0], extT: [0, 0, 0], conns: [], U: 0, island: -1 };
      for (const a of comp) { const s = st.shards[a]; node.mass += s.mass; node.com[0] += s.mass * s.c[0]; node.com[1] += s.mass * s.c[1]; node.com[2] += s.mass * s.c[2]; nodeOf.set(a, node.id); }
      node.com = node.com.map((v) => v / node.mass);
      for (const a of comp) {
        const s = st.shards[a]; if (!s.extF) continue;
        const f = s.extF, r = [s.c[0] - node.com[0], s.c[1] - node.com[1], s.c[2] - node.com[2]];
        node.extF[0] += f[0]; node.extF[1] += f[1]; node.extF[2] += f[2];
        node.extT[0] += r[1] * f[2] - r[2] * f[1]; node.extT[1] += r[2] * f[0] - r[0] * f[2]; node.extT[2] += r[0] * f[1] - r[1] * f[0];
      }
      nodes.push(node);
    }
  }
  // 2) connections = aggregated inter-module bonds between two nodes (or node <-> base = anchor)
  const cmap = new Map(); const conns = [];
  for (const bid of R.bonds) {
    const b = st.bonds[bid]; if (b.broken) continue;
    const sa = st.shards[b.a], sb = st.shards[b.b];
    const cross = sa.region !== sb.region;
    if (cross && !R.secondary && !sa.fixed && !sb.fixed) continue;
    // in a secondary group, a static fragment of another group behaves like the indestructible base
    const na = sa.fixed || (cross && sa.region !== region && sa.state === STATIC) ? -1 : sa.state === STATIC ? nodeOf.get(b.a) : undefined;
    const nb = sb.fixed || (cross && sb.region !== region && sb.state === STATIC) ? -1 : sb.state === STATIC ? nodeOf.get(b.b) : undefined;
    if (na === undefined || nb === undefined || (na === -1 && nb === -1)) continue;
    let A = na, Bn = nb, sg = b.sg;
    if (A === -1 || (Bn !== -1 && Bn < A)) { A = nb; Bn = na; sg = -sg; }
    const key = A * 100003 + Bn;
    let c = cmap.get(key);
    if (!c) {
      c = { id: conns.length, a: A, b: Bn, ax: b.ax, sg, bonds: [], area: 0, p: [0, 0, 0], S: [0, 0, 0], ma: st.modules[st.shards[A === na ? b.a : b.b].mod].id, mb: Bn === -1 ? -1 : st.modules[st.shards[A === na ? b.b : b.a].mod].id, U: 0 };
      cmap.set(key, c); conns.push(c);
    }
    const h = Math.min(st.health(sa), st.health(sb));
    const ar = b.area * h;
    c.bonds.push(bid); c.area += ar; c.hsum = (c.hsum || 0);
    c.p[0] += ar * b.p[0]; c.p[1] += ar * b.p[1]; c.p[2] += ar * b.p[2];
  }
  for (const c of conns) {
    const inv = 1 / Math.max(c.area, 1e-9);
    c.p = c.p.map((v) => v * inv);
    // second moments of the contact patch about its centroid (in-plane axes u,w)
    const u = (c.ax + 1) % 3, w = (c.ax + 2) % 3;
    let Suu = 0, Sww = 0, Suw = 0;
    for (const bid of c.bonds) {
      const b = st.bonds[bid];
      const h = Math.min(st.health(st.shards[b.a]), st.health(st.shards[b.b]));
      const ar = b.area * h;
      const du = b.p[u] - c.p[u], dw = b.p[w] - c.p[w];
      Suu += ar * du * du + h * b.Suu; Sww += ar * dw * dw + h * b.Sww; Suw += ar * du * dw + h * b.Suw;
    }
    // principal axes
    const tr = Suu + Sww, det = Suu * Sww - Suw * Suw, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(tr / 2 - disc, 1e-12);
    let e1u = 1, e1w = 0;
    if (Math.abs(Suw) > 1e-14) { e1u = l1 - Sww; e1w = Suw; const l = Math.hypot(e1u, e1w); e1u /= l; e1w /= l; } else if (Sww > Suu) { e1u = 0; e1w = 1; }
    const e1 = [0, 0, 0], e2 = [0, 0, 0]; e1[u] = e1u; e1[w] = e1w; e2[u] = -e1w; e2[w] = e1u;
    let h1 = 0, h2 = 0;
    for (const bid of c.bonds) {
      const b = st.bonds[bid];
      const d = [b.p[0] - c.p[0], b.p[1] - c.p[1], b.p[2] - c.p[2]];
      h1 = Math.max(h1, Math.abs(d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2]) + Math.abs(e1u) * b.hu + Math.abs(e1w) * b.hw);
      h2 = Math.max(h2, Math.abs(d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2]) + Math.abs(e1w) * b.hu + Math.abs(e1u) * b.hw);
    }
    const n = [0, 0, 0]; n[c.ax] = c.sg;
    c.n = n; c.e1 = e1; c.e2 = e2; c.I1 = l2; c.I2 = l1; c.J = l1 + l2; c.h1 = h1; c.h2 = h2; // I1: about e1 (small), I2: about e2
    const MA = st.modules[c.ma], MB = c.mb >= 0 ? st.modules[c.mb] : MA;
    const ma = MA.def, mb = MB.def;
    const fa = KIND_STIFF[MA.kind] ?? 1, fb = c.mb >= 0 ? KIND_STIFF[MB.kind] ?? 1 : fa;
    const Ea = ma.E * fa, Eb = mb.E * fb, Ga = ma.G * fa, Gb = mb.G * fb;
    c.sigT = Math.min(ma.sigT, mb.sigT); c.sigC = Math.min(ma.sigC, mb.sigC); c.tau = Math.min(ma.tau, mb.tau);
    c.E = 2 * Ea * Eb / (Ea + Eb); c.Gm = 2 * Ga * Gb / (Ga + Gb); c.duct = Math.min(ma.duct, mb.duct);
    c.off = (hash2(c.ma, c.mb + 7) - 0.5) * 0.24;
    nodes[c.a].conns.push(c.id); if (c.b >= 0) nodes[c.b].conns.push(c.id);
  }
  // 3) islands (union-find over node-node connections)
  const par = nodes.map((nd) => nd.id);
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  for (const c of conns) if (c.b >= 0) { const ra = find(c.a), rb = find(c.b); if (ra !== rb) par[ra] = rb; }
  const imap = new Map(), islands = [];
  for (const nd of nodes) {
    const r = find(nd.id);
    if (!imap.has(r)) { imap.set(r, islands.length); islands.push({ id: islands.length, nodes: [], conns: [], anchored: false, solved: false, maxU: 0 }); }
    const I = islands[imap.get(r)]; nd.island = I.id; I.nodes.push(nd.id);
  }
  for (const c of conns) { const I = islands[nodes[c.a].island]; I.conns.push(c.id); if (c.b === -1) I.anchored = true; }
  const detached = [];
  for (const I of islands) if (!I.anchored) for (const nid of I.nodes) for (const s of nodes[nid].shards) detached.push(s);
  // glass carries no load: a pane stays while any fragment still touches an anchored static fragment
  const okShard = (o) => { const so = st.shards[o]; if (so.fixed) return true; if (so.state !== STATIC) return false; const nid = nodeOf.get(o); return nid !== undefined && islands[nodes[nid].island].anchored; };
  for (const mid of R.modules) {
    const m = st.modules[mid]; if (!m.def.glass) continue;
    const live = m.shards.filter((s) => st.shards[s].state === STATIC);
    const seen = new Set();
    for (const s0 of live) {
      if (seen.has(s0)) continue;
      const comp = [], stack = [s0]; seen.add(s0); let ok = false;
      while (stack.length) {
        const a = stack.pop(); comp.push(a);
        for (const bid of st.shards[a].bonds) {
          const b = st.bonds[bid]; if (b.broken) continue; const o = b.a === a ? b.b : b.a;
          const so = st.shards[o];
          if (so.mod === mid) { if (so.state === STATIC && !seen.has(o)) { seen.add(o); stack.push(o); } } else if (okShard(o)) ok = true;
        }
      }
      if (!ok) detached.push(...comp);
    }
  }
  return { region, nodes, conns, islands, detached, nodeOf };
}

function skew(r) { return [0, -r[2], r[1], r[2], 0, -r[0], -r[1], r[0], 0]; }
function m3mul(A, B) { const C = new Array(9); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i * 3 + j] = A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]; return C; }
// world-frame 3x3 from local diag(k0,k1,k2) in frame [n,e1,e2]
function frameK(n, e1, e2, k0, k1, k2) {
  const K = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) K[i * 3 + j] = k0 * n[i] * n[j] + k1 * e1[i] * e1[j] + k2 * e2[i] * e2[j];
  return K;
}
// out(6x6) += sign * Ga^T D Gb  with G = [[I,-S],[0,I]]  ->  [[KL, -KL Sb],[Sa KL, -Sa KL Sb + KA]]
function addGDG(out, Sa, Sb, KL, KA, sign) {
  const KLSb = m3mul(KL, Sb), SaKL = m3mul(Sa, KL), SaKLSb = m3mul(Sa, KLSb);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    out[i * 6 + j] += sign * KL[i * 3 + j];
    out[i * 6 + 3 + j] += sign * -KLSb[i * 3 + j];
    out[(3 + i) * 6 + j] += sign * SaKL[i * 3 + j];
    out[(3 + i) * 6 + 3 + j] += sign * (KA[i * 3 + j] - SaKLSb[i * 3 + j]);
  }
}

// Solve one anchored island. Fills c.U (+ components) for its connections and nd.U for its nodes.
export function solveIsland(graph, island) {
  const { nodes, conns } = graph;
  const ids = island.nodes, n = ids.length;
  const loc = new Map(); ids.forEach((id, i) => loc.set(id, i));
  const diag = Array.from({ length: n }, () => new Float64Array(36));
  const off = new Map();
  const rhs = new Float64Array(6 * n);
  for (let i = 0; i < n; i++) {
    const nd = nodes[ids[i]];
    rhs[i * 6 + 1] = -nd.mass * G / 1000 + nd.extF[1];
    rhs[i * 6] = nd.extF[0]; rhs[i * 6 + 2] = nd.extF[2];
    rhs[i * 6 + 3] = nd.extT[0]; rhs[i * 6 + 4] = nd.extT[1]; rhs[i * 6 + 5] = nd.extT[2];
  }
  for (const cid of island.conns) {
    const c = conns[cid];
    const ca = nodes[c.a].com, cb = c.b >= 0 ? nodes[c.b].com : null;
    const ra = [c.p[0] - ca[0], c.p[1] - ca[1], c.p[2] - ca[2]];
    const L = Math.max(0.25, cb ? Math.hypot(cb[0] - ca[0], cb[1] - ca[1], cb[2] - ca[2]) : 2 * Math.hypot(ra[0], ra[1], ra[2]));
    const A = Math.max(c.area, 1e-6);
    // thin strips (wall on slab, slab on wall) act almost like hinges about their long axis: they keep the
    // strength to carry a cantilever but attract little moment from redundant paths
    const thin = c.h2 < 0.3 * c.h1 ? 0.08 : 1;
    c.kn = c.E * A / L; c.ks = c.Gm * A / L; c.kt = c.Gm * c.J / L * (thin < 1 ? 0.3 : 1); c.kb1 = c.E * c.I1 / L * thin; c.kb2 = c.E * c.I2 / L;
    const KL = frameK(c.n, c.e1, c.e2, c.kn, c.ks, c.ks), KA = frameK(c.n, c.e1, c.e2, c.kt, c.kb1, c.kb2);
    const Sa = skew(ra); c.ra = ra;
    const ia = loc.get(c.a);
    addGDG(diag[ia], Sa, Sa, KL, KA, 1);
    if (cb) {
      const rb = [c.p[0] - cb[0], c.p[1] - cb[1], c.p[2] - cb[2]]; c.rb = rb;
      const Sb = skew(rb), ib = loc.get(c.b);
      addGDG(diag[ib], Sb, Sb, KL, KA, 1);
      // block (row ia, col ib) = -Ga^T D Gb ; store as lower (i>j)
      const blk = new Float64Array(36); addGDG(blk, Sa, Sb, KL, KA, -1);
      if (ia > ib) { const k = ia + ',' + ib; const e = off.get(k); if (e) for (let q = 0; q < 36; q++) e[q] += blk[q]; else off.set(k, blk); }
      else { const t = new Float64Array(36); for (let r = 0; r < 6; r++) for (let q = 0; q < 6; q++) t[q * 6 + r] = blk[r * 6 + q]; const k = ib + ',' + ia; const e = off.get(k); if (e) for (let q = 0; q < 36; q++) e[q] += t[q]; else off.set(k, t); }
    }
  }
  let dmax = 0; for (const d of diag) for (let q = 0; q < 6; q++) dmax = Math.max(dmax, d[q * 7]);
  for (const d of diag) for (let q = 0; q < 6; q++) d[q * 7] += dmax * 1e-10;
  const { x, nnz } = solveBlockSPD(n, diag, off, rhs);
  island.nnz = nnz;
  let maxU = 0;
  for (const i of ids) nodes[i].U = 0;
  for (const cid of island.conns) {
    const c = conns[cid];
    const ia = loc.get(c.a) * 6;
    const ta = [x[ia], x[ia + 1], x[ia + 2]], tha = [x[ia + 3], x[ia + 4], x[ia + 5]];
    const da = [ta[0] + tha[1] * c.ra[2] - tha[2] * c.ra[1], ta[1] + tha[2] * c.ra[0] - tha[0] * c.ra[2], ta[2] + tha[0] * c.ra[1] - tha[1] * c.ra[0]];
    let d = [-da[0], -da[1], -da[2]], ph = [-tha[0], -tha[1], -tha[2]];
    if (c.b >= 0) {
      const ib = loc.get(c.b) * 6;
      const tb = [x[ib], x[ib + 1], x[ib + 2]], thb = [x[ib + 3], x[ib + 4], x[ib + 5]];
      const db = [tb[0] + thb[1] * c.rb[2] - thb[2] * c.rb[1], tb[1] + thb[2] * c.rb[0] - thb[0] * c.rb[2], tb[2] + thb[0] * c.rb[1] - thb[1] * c.rb[0]];
      d = [db[0] - da[0], db[1] - da[1], db[2] - da[2]]; ph = [thb[0] - tha[0], thb[1] - tha[1], thb[2] - tha[2]];
    }
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const N = c.kn * dot(d, c.n);                      // + tension, - compression (kN)
    const V = c.ks * Math.hypot(dot(d, c.e1), dot(d, c.e2));
    const T = Math.abs(c.kt * dot(ph, c.n));
    const M1 = c.kb1 * dot(ph, c.e1), M2 = c.kb2 * dot(ph, c.e2);
    const A = Math.max(c.area, 1e-6);
    const uAx = N > 0 ? N / (c.sigT * A) : -N / (c.sigC * A);
    const uSh = V / (c.tau * A) + T / (c.tau * c.J / Math.max(1e-3, Math.hypot(c.h1, c.h2)));
    const uBe = Math.hypot(M1 / (c.sigT * c.I1 / Math.max(c.h2, 1e-3)), M2 / (c.sigT * c.I2 / Math.max(c.h1, 1e-3)));
    c.N = N; c.V = V; c.M = Math.hypot(M1, M2); c.uAx = uAx; c.uSh = uSh; c.uBe = uBe;
    c.U = uAx + uSh + uBe;
    c.thr = 1 + c.off;
    if (c.U > maxU) maxU = c.U;
    const r = c.U / c.thr;
    if (r > nodes[c.a].U) nodes[c.a].U = r;
    if (c.b >= 0 && r > nodes[c.b].U) nodes[c.b].U = r;
  }
  island.maxU = maxU; island.solved = true;
  return maxU;
}
