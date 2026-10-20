// The destruction graph: pre-fractured fragments ("destruction bones") + bonds between touching fragments.
// Bonds inside a module come from shared Voronoi faces, bonds between modules from overlapping faces on
// the shared plane (the in-level "connection tool" step of THE FINALS pipeline).
import { fractureBox, makeSeeds } from './voronoi.js';
import { mulberry32 } from './rng.js';
import { matOf } from './materials.js';

export const STATIC = 0, DYNAMIC = 1, DEAD = 2;

function clip2(subject, clipPoly) {
  let out = subject;
  for (let i = 0; i < clipPoly.length && out.length; i++) {
    const A = clipPoly[i], B = clipPoly[(i + 1) % clipPoly.length];
    const inp = out; out = [];
    const side = (p) => (B[0] - A[0]) * (p[1] - A[1]) - (B[1] - A[1]) * (p[0] - A[0]);
    for (let k = 0; k < inp.length; k++) {
      const P = inp[k], Q = inp[(k + 1) % inp.length];
      const sp = side(P), sq = side(Q);
      if (sp >= 0) out.push(P);
      if ((sp >= 0) !== (sq >= 0)) { const t = sp / (sp - sq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
    }
  }
  return out;
}
function moments2(P) { // area, centroid, second moments about centroid, half extents
  let a = 0, cx = 0, cy = 0, ixx = 0, iyy = 0, ixy = 0;
  for (let i = 0; i < P.length; i++) {
    const [x0, y0] = P[i], [x1, y1] = P[(i + 1) % P.length];
    const c = x0 * y1 - x1 * y0;
    a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    ixx += (y0 * y0 + y0 * y1 + y1 * y1) * c; iyy += (x0 * x0 + x0 * x1 + x1 * x1) * c; ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * c;
  }
  a /= 2; if (Math.abs(a) < 1e-12) return null;
  cx /= 6 * a; cy /= 6 * a; ixx /= 12; iyy /= 12; ixy /= 24;
  const sg = a < 0 ? -1 : 1; a *= sg; ixx *= sg; iyy *= sg; ixy *= sg;
  let hu = 0, hw = 0; for (const [x, y] of P) { hu = Math.max(hu, Math.abs(x - cx)); hw = Math.max(hw, Math.abs(y - cy)); }
  return { a, cx, cy, Suu: iyy - a * cx * cx, Sww: ixx - a * cy * cy, Suw: ixy - a * cx * cy, hu, hw };
}

export class Structure {
  constructor(scene, seed = 1337) {
    this.scene = scene;
    this.modules = scene.modules.map((m, i) => ({
      ...m, id: i, shards: [],
      center: [(m.min[0] + m.max[0]) / 2, (m.min[1] + m.max[1]) / 2, (m.min[2] + m.max[2]) / 2],
      size: [m.max[0] - m.min[0], m.max[1] - m.min[1], m.max[2] - m.min[2]],
      def: matOf(m.mat),
    }));
    this.shards = [];
    this.bonds = [];
    const t0 = Date.now();
    this._fracture(seed);
    this._interBonds();
    this._regions();
    this.buildMs = Date.now() - t0;
  }

  _fracture(seed) {
    for (const m of this.modules) {
      const rng = mulberry32(seed + m.id * 7919);
      const def = m.def;
      const vol = m.size[0] * m.size[1] * m.size[2];
      const n = m.fixed ? 1 : Math.max(1, Math.min(def.maxSeeds, Math.round(vol * def.frac)));
      const seeds = makeSeeds(m.size, n, rng);
      const cells = fractureBox(m.size, seeds);
      const seedToShard = new Map();
      for (const cell of cells) {
        const id = this.shards.length;
        seedToShard.set(cell.seed, id);
        const c = [m.center[0] + cell.c[0], m.center[1] + cell.c[1], m.center[2] + cell.c[2]];
        let ntri = 0; for (const f of cell.faces) ntri += f.pts.length - 2;
        const tri = new Float32Array(ntri * 9), triN = new Float32Array(ntri * 3), triSide = new Int8Array(ntri);
        const uniq = [];
        let t = 0, r = 0;
        for (const f of cell.faces) {
          const L = f.pts.map((p) => [p[0] - cell.c[0], p[1] - cell.c[1], p[2] - cell.c[2]]);
          for (const p of L) {
            const d = Math.hypot(p[0], p[1], p[2]); if (d > r) r = d;
            if (!uniq.some((q) => Math.abs(q[0] - p[0]) < 1e-6 && Math.abs(q[1] - p[1]) < 1e-6 && Math.abs(q[2] - p[2]) < 1e-6)) uniq.push(p);
          }
          for (let i = 1; i + 1 < L.length; i++) {
            tri.set(L[0], t * 9); tri.set(L[i], t * 9 + 3); tri.set(L[i + 1], t * 9 + 6);
            triN.set(f.n, t * 3); triSide[t] = f.nb < 0 ? -f.nb - 1 : -1; t++;
          }
        }
        const hull = new Float32Array(uniq.length * 3);
        const k = r > 0.12 ? 0.985 : 0.97;
        uniq.forEach((p, i) => { hull[i * 3] = p[0] * k; hull[i * 3 + 1] = p[1] * k; hull[i * 3 + 2] = p[2] * k; });
        const hpScale = Math.min(1.4, Math.max(0.7, Math.pow(cell.vol / 0.15, 0.2)));
        const sd = seeds[cell.seed];
        this.shards.push({
          id, mod: m.id, seedW: [m.center[0] + sd[0], m.center[1] + sd[1], m.center[2] + sd[2]], mat: m.mat, def, vol: cell.vol, mass: cell.vol * def.density, c, r, hull, tri, triN, triSide,
          hp: def.hp * hpScale, dmg: 0, state: STATIC, bonds: [], fixed: !!m.fixed, glass: !!def.glass,
          tint: 0.93 + rng() * 0.12, body: null, lp: null, lq: null, collider: null, extF: null, region: -1,
        });
        m.shards.push(id);
      }
      // bonds across interior Voronoi faces
      for (const cell of cells) {
        const a = seedToShard.get(cell.seed);
        for (const f of cell.faces) {
          if (f.nb < 0 || f.nb < cell.seed) continue;
          const b = seedToShard.get(f.nb); if (b === undefined) continue;
          this._addBond(a, b, f.area, [m.center[0] + f.c[0], m.center[1] + f.c[1], m.center[2] + f.c[2]], -1, 1, f.n, true);
        }
      }
    }
  }

  _addBond(a, b, area, p, ax, sg, n, intra) {
    const id = this.bonds.length;
    this.bonds.push({ id, a, b, area, p, ax, sg, n, intra, broken: false, dmg: 0 });
    this.shards[a].bonds.push(id); this.shards[b].bonds.push(id);
    return id;
  }

  _interBonds() {
    const M = this.modules, eps = 1e-4;
    const order = M.map((m) => m.id).sort((a, b) => M[a].min[0] - M[b].min[0]);
    let pairs = 0;
    for (let ii = 0; ii < order.length; ii++) {
      const A = M[order[ii]];
      for (let jj = ii + 1; jj < order.length; jj++) {
        const B = M[order[jj]];
        if (B.min[0] > A.max[0] + eps) break;
        if (A.fixed && B.fixed) continue;
        for (let ax = 0; ax < 3; ax++) {
          let lo = null, hi = null;
          if (Math.abs(A.max[ax] - B.min[ax]) < eps) { lo = A; hi = B; } else if (Math.abs(B.max[ax] - A.min[ax]) < eps) { lo = B; hi = A; } else continue;
          const u = (ax + 1) % 3, w = (ax + 2) % 3;
          const ou = Math.min(A.max[u], B.max[u]) - Math.max(A.min[u], B.min[u]);
          const ow = Math.min(A.max[w], B.max[w]) - Math.max(A.min[w], B.min[w]);
          if (ou < 1e-3 || ow < 1e-3) continue;
          pairs++;
          this._bondFaces(lo, hi, ax, u, w);
        }
      }
    }
    this.modulePairs = pairs;
  }

  _facesOnSide(mod, side) {
    const out = [];
    for (const sid of mod.shards) {
      const s = this.shards[sid];
      const pts = [];
      for (let t = 0; t < s.triSide.length; t++) if (s.triSide[t] === side) for (let k = 0; k < 3; k++) pts.push([s.tri[t * 9 + k * 3] + s.c[0], s.tri[t * 9 + k * 3 + 1] + s.c[1], s.tri[t * 9 + k * 3 + 2] + s.c[2]]);
      if (pts.length >= 3) out.push({ sid, pts });
    }
    return out;
  }

  _bondFaces(lo, hi, ax, u, w) {
    const fa = this._facesOnSide(lo, ax * 2 + 1), fb = this._facesOnSide(hi, ax * 2);
    const plane = lo.max[ax];
    const to2 = (pts) => {
      const P = pts.map((p) => [p[u], p[w]]);
      P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lower = [], upper = [];
      for (const p of P) { while (lower.length >= 2 && cr(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-12) lower.pop(); lower.push(p); }
      for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (upper.length >= 2 && cr(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-12) upper.pop(); upper.push(p); }
      upper.pop(); lower.pop();
      const H = lower.concat(upper);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of H) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
      return { H, x0, y0, x1, y1 };
    };
    const A2 = fa.map((f) => ({ sid: f.sid, ...to2(f.pts) }));
    const B2 = fb.map((f) => ({ sid: f.sid, ...to2(f.pts) }));
    for (const a of A2) for (const b of B2) {
      if (a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0) continue;
      const I = clip2(a.H, b.H);
      if (I.length < 3) continue;
      const mo = moments2(I);
      if (!mo || mo.a < 2e-4) continue;
      const p = [0, 0, 0]; p[ax] = plane; p[u] = mo.cx; p[w] = mo.cy;
      const n = [0, 0, 0]; n[ax] = 1;
      const id = this._addBond(a.sid, b.sid, mo.a, p, ax, 1, n, false);
      const bd = this.bonds[id]; bd.Suu = Math.max(mo.Suu, 1e-9); bd.Sww = Math.max(mo.Sww, 1e-9); bd.Suw = mo.Suw; bd.hu = mo.hu; bd.hw = mo.hw;
    }
  }

  // Strain groups: one per building (like the magenta "strain groups" in Embark's tooling). Secondary groups
  // (bridges, gantries; building id >= 90) lean on primary ones: a static fragment of another group is an anchor
  // for them, while primary groups ignore what hangs off them.
  _regions() {
    const map = new Map(); this.regions = [];
    for (const m of this.modules) {
      const key = m.building ?? 1000 + m.id;
      if (!map.has(key)) { map.set(key, this.regions.length); this.regions.push({ id: this.regions.length, key, secondary: key >= 90 && key < 1000, modules: [], shards: [], bonds: [], dirty: true, graph: null }); }
      const R = this.regions[map.get(key)];
      m.region = R.id; R.modules.push(m.id);
      for (const s of m.shards) { this.shards[s].region = R.id; R.shards.push(s); }
    }
    for (const b of this.bonds) {
      if (b.intra) continue;
      const ra = this.shards[b.a].region, rb = this.shards[b.b].region;
      this.regions[ra].bonds.push(b.id); if (rb !== ra) this.regions[rb].bonds.push(b.id);
    }
  }

  other(bond, sid) { return bond.a === sid ? bond.b : bond.a; }
  // Voronoi property: the fragment containing a (rest-space) point is the one with the nearest seed
  shardAt(mid, p) {
    let best = -1, bd = Infinity;
    for (const sid of this.modules[mid].shards) {
      const s = this.shards[sid]; if (s.state === 2) continue;
      const d = (s.seedW[0] - p[0]) ** 2 + (s.seedW[1] - p[1]) ** 2 + (s.seedW[2] - p[2]) ** 2;
      if (d < bd) { bd = d; best = sid; }
    }
    return best;
  }
  health(s) { return s.fixed ? 1 : Math.max(0.2, Math.min(1, 1 - 0.8 * s.dmg / s.hp)); }
}
