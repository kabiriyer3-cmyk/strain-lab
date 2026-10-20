// Scene blueprints. Like THE FINALS' Houdini "Building Creator", a building is assembled from feature
// rules (walls split into piers/sills/lintels per bay and story, floor slabs per bay, columns, stairs, parapets,
// balconies) and every element is an axis-aligned module that later gets pre-fractured.
// Level layer on top: street furniture (lamps, barriers, crates), ziplines, ladders and jump pads.
import { mulberry32 } from './rng.js';

const PLASTER = 0xefebe3, CEIL = 0xf2efe9, FLOOR = 0xb89f80, ROOF = 0x8f8b84, BASEC = 0x86817a;
const WALK = 0xc2bdb3, CURB = 0xa29d94, STEEL = 0x3a4048, WOOD = 0xb07a45;
export const DECOR = 80; // strain group of all street furniture

function builder(M) {
  return (min, max, mat, kind, colors, extra = {}) => {
    M.push({ min, max, mat, kind, colors: Array.isArray(colors) ? colors : [colors, colors, colors, colors, colors, colors], ...extra });
    return M.length - 1;
  };
}

// side colour arrays are ordered [-x, +x, -y, +y, -z, +z]
function sideColors(axis, outwardSign, facade, inner) {
  const c = [inner, inner, inner, inner, inner, inner];
  const i = axis === 'x' ? 0 : 4; // axis of the wall normal: x walls face +-x, z walls face +-z
  c[i + (outwardSign > 0 ? 1 : 0)] = facade;
  return c;
}

// o.flip mirrors the building in z, so its front (doors, balconies) faces +z instead of -z.
// o.stairs = { i, j: 0 } adds a switch-back wooden stair: even stories climb +x in bay i, odd ones -x in bay i+1.
export function makeBuilding(M, o) {
  const add = builder(M);
  const start = M.length;
  const bay = o.bay ?? 3, bx = o.bx, bz = o.bz, S = o.stories, H = o.storyH ?? 3.2;
  const tw = o.wallT ?? 0.3, ts = o.slabT ?? 0.3, B = 0.3;
  const W = bx * bay, D = bz * bay, X = o.x, Z = o.z, bid = o.id;
  const wm = o.wallMat ?? 'concrete', sm = o.slabMat ?? 'concrete', cm = o.colMat ?? 'concrete';
  const facade = o.color, trim = o.trim ?? PLASTER;
  const P = (x, y, z) => [X + x, y, Z + z];
  const tag = (story) => ({ building: bid, story });
  add(P(-0.4, 0, -0.4), P(W + 0.4, B, D + 0.4), 'base', 'base', BASEC, { ...tag(-1), fixed: true });

  const opening = o.opening || ((side, s, k) => (s === 0 && side === (o.doorSide ?? 'front') && k === (o.doorBay ?? 1) ? 'door' : 'win'));
  const st = o.stairs || null, runs = [];
  const stairBay = (s) => (s % 2 === 0 ? st.i : st.i + 1);
  const skipped = (s, i, j) => (o.skipSlab && o.skipSlab(s, i, j)) || (st && j === st.j && i === stairBay(s));

  function wall(side, s, y0, yt) {
    const alongX = side === 'front' || side === 'back';
    const n = alongX ? bx : bz;
    const a0 = alongX ? 0 : tw, a1 = alongX ? W : D - tw;
    const c0 = side === 'front' ? 0 : side === 'back' ? D - tw : side === 'left' ? 0 : W - tw;
    const c1 = c0 + tw;
    const outward = side === 'front' || side === 'left' ? -1 : 1;
    const cols = sideColors(alongX ? 'z' : 'x', outward, facade, PLASTER);
    const box = (u0, u1, v0, v1, cc0, cc1, mat, kind, colors) => alongX
      ? add(P(u0, v0, cc0), P(u1, v1, cc1), mat, kind, colors, tag(s))
      : add(P(cc0, v0, u0), P(cc1, v1, u1), mat, kind, colors, tag(s));
    const ops = [];
    for (let k = 0; k < n; k++) {
      const type = opening(side, s, k);
      if (type === 'solid') continue;
      const ow = type === 'door' ? 1.3 : type === 'shop' ? 2.2 : 1.3;
      const m = (k + 0.5) * bay;
      const u0 = m - ow / 2, u1 = m + ow / 2;
      if (u0 < a0 + 0.35 || u1 > a1 - 0.35) continue;
      ops.push({ u0, u1, type });
    }
    // piers = complement of the openings, split so no module is longer than 2.4 m
    let cur = a0;
    const piers = [];
    for (const op of ops) { piers.push([cur, op.u0]); cur = op.u1; }
    piers.push([cur, a1]);
    for (const [p0, p1] of piers) {
      const L = p1 - p0; if (L < 0.05) continue;
      const parts = Math.max(1, Math.ceil(L / 2.4));
      for (let q = 0; q < parts; q++) box(p0 + (L * q) / parts, p0 + (L * (q + 1)) / parts, y0, yt, c0, c1, wm, 'wall', cols);
    }
    const gm = (c0 + c1) / 2;
    for (const op of ops) {
      const sill = op.type === 'win' ? 0.9 : op.type === 'shop' ? 0.35 : 0;
      const head = op.type === 'door' ? 2.3 : op.type === 'shop' ? 2.55 : 2.2;
      if (sill > 0) box(op.u0, op.u1, y0, y0 + sill, c0, c1, wm, 'sill', cols);
      if (yt - (y0 + head) > 0.08) box(op.u0, op.u1, y0 + head, yt, c0, c1, wm, 'lintel', cols);
      if (op.type !== 'door') box(op.u0, op.u1, y0 + sill, y0 + head, gm - 0.03, gm + 0.03, 'glass', 'glass', 0xa9d7e6);
    }
  }

  for (let s = 0; s < S; s++) {
    const y0 = B + s * H, yt = y0 + H - ts;
    if (o.walls !== false) for (const side of ['front', 'back', 'left', 'right']) wall(side, s, y0, yt);
    if (o.columns !== false) {
      const all = o.walls === false;
      for (let i = all ? 0 : 1; i <= (all ? bx : bx - 1); i++) for (let j = all ? 0 : 1; j <= (all ? bz : bz - 1); j++) {
        const x = Math.min(Math.max(i * bay, 0.2), W - 0.2), z = Math.min(Math.max(j * bay, 0.2), D - 0.2);
        add(P(x - 0.2, y0, z - 0.2), P(x + 0.2, yt, z + 0.2), cm, 'column', PLASTER, tag(s));
      }
    }
    // one interior partition line with a doorway, runs between the columns
    if (o.partition && bz > 1) {
      const zc = Math.floor(bz / 2) * bay;
      const skip = (s * 7 + bid * 3) % bx;
      for (let i = 0; i < bx; i++) {
        if (i === skip) continue;
        const xa = i === 0 ? tw : i * bay + 0.2, xb = i === bx - 1 ? W - tw : (i + 1) * bay - 0.2;
        // non-load-bearing: a 2 cm gap under the slab, so partitions never prop the floor above
        add(P(xa, y0, zc - 0.1), P(xb, yt - 0.02, zc + 0.1), o.partitionMat ?? 'brick', 'partition', PLASTER, tag(s));
      }
    }
    // stairs: a saw-tooth stringer of 10 blocks spanning floor -> next slab, so it hangs like a real flight
    if (st) {
      // a 0.3 m landing at the foot keeps the climber's head clear of the neighbouring ceiling
      const n = 10, rise = H / n, land = 0.3, run = (bay - land) / n, dep = 0.6;
      const even = s % 2 === 0, i = stairBay(s);
      const zA = st.j * bay + (st.j === 0 ? tw : 0) + 0.05;
      const [za, zb] = even ? [zA, zA + 1.2] : [zA + 1.25, zA + 2.4];
      const sc0 = [0x9a6a3c, 0x9a6a3c, 0x8a5d34, 0xc89a64, 0x9a6a3c, 0x9a6a3c];
      const mods = [];
      for (let k = 0; k < n; k++) {
        const xa = even ? i * bay + land + k * run : (i + 1) * bay - land - (k + 1) * run;
        const top = y0 + (k + 1) * rise, bot = Math.max(y0, top - dep);
        mods.push(add(P(xa, bot, za), P(xa + run, top, zb), st.mat ?? 'wood', 'stair', sc0, tag(s)));
      }
      runs.push({ mods, dir: even ? 1 : -1, y0, H });
    }
    const sc = [trim, trim, CEIL, s === S - 1 ? ROOF : o.floorColor ?? FLOOR, trim, trim];
    const kind = s === S - 1 ? 'roof' : 'slab';
    for (let i = 0; i < bx; i++) for (let j = 0; j < bz; j++) {
      const x0 = i * bay, x1 = (i + 1) * bay;
      if (!skipped(s, i, j)) { add(P(x0, yt, j * bay), P(x1, y0 + H, (j + 1) * bay), sm, kind, sc, tag(s)); continue; }
      // stairwell: keep the strip of slab that sits on the facade, so the wall above still stands on something
      if (o.walls === false) continue;
      let za = j * bay, zb = (j + 1) * bay;
      if (j === 0) { add(P(x0, yt, 0), P(x1, y0 + H, tw), sm, kind, sc, tag(s)); za = tw; }
      if (j === bz - 1) { add(P(x0, yt, D - tw), P(x1, y0 + H, D), sm, kind, sc, tag(s)); zb = D - tw; }
      if (i === 0) add(P(0, yt, za), P(tw, y0 + H, zb), sm, kind, sc, tag(s));
      if (i === bx - 1) add(P(W - tw, yt, za), P(W, y0 + H, zb), sm, kind, sc, tag(s));
    }
    for (const b of o.balconies || []) {
      if (b.story !== s) continue;
      for (let i = b.i0; i < b.i1; i++) {
        add(P(i * bay, yt, -1.5), P((i + 1) * bay, y0 + H, 0), sm, 'balcony', [trim, trim, CEIL, FLOOR, trim, trim], tag(s));
        add(P(i * bay, y0 + H, -1.5), P((i + 1) * bay, y0 + H + 1.0, -1.42), b.mat ?? 'rail', 'rail', 0x2f3a33, tag(s));
      }
    }
  }
  // roof parapet
  const yr = B + S * H;
  const pc = facade;
  for (let i = 0; i < bx; i++) {
    add(P(i * bay, yr, 0), P((i + 1) * bay, yr + 0.8, 0.25), wm, 'parapet', pc, tag(S));
    add(P(i * bay, yr, D - 0.25), P((i + 1) * bay, yr + 0.8, D), wm, 'parapet', pc, tag(S));
  }
  for (let j = 0; j < bz; j++) {
    const z0 = j === 0 ? 0.25 : j * bay, z1 = j === bz - 1 ? D - 0.25 : (j + 1) * bay;
    add(P(0, yr, z0), P(0.25, yr + 0.8, z1), wm, 'parapet', pc, tag(S));
    add(P(W - 0.25, yr, z0), P(W, yr + 0.8, z1), wm, 'parapet', pc, tag(S));
  }
  if (o.flip) {
    const k = 2 * Z + D;
    for (let q = start; q < M.length; q++) {
      const m = M[q];
      const z0 = k - m.max[2], z1 = k - m.min[2];
      m.min = [m.min[0], m.min[1], z0]; m.max = [m.max[0], m.max[1], z1];
      const c = m.colors.slice(); const t = c[4]; c[4] = c[5]; c[5] = t; m.colors = c;
    }
  }
  return { x0: X, z0: Z, x1: X + W, z1: Z + D, front: o.flip ? Z + D : Z, slabY: (s) => [B + s * H + H - ts, B + (s + 1) * H], top: yr, H, ramps: runs.map((r) => stairRamp(M, r)) };
}

// Saw-tooth stairs are hard on a capsule controller, so each flight also gets an invisible player-only ramp
// through the step nosings (it is removed as soon as any step of the flight breaks).
function stairRamp(M, r) {
  const b0 = M[r.mods[0]], b9 = M[r.mods[r.mods.length - 1]];
  const x0 = r.dir > 0 ? b0.min[0] : b0.max[0], t0 = b0.max[1];
  const x9 = r.dir > 0 ? b9.min[0] : b9.max[0], t9 = b9.max[1];
  const slope = (t9 - t0) / (x9 - x0);
  const xf = x0 - (t0 - r.y0) / slope;
  return { a: [xf, r.y0 + 0.03], b: [x9, t9 + 0.03], z: [b0.min[2], b0.max[2]], mods: r.mods };
}

// A walkway spanning between two facades. It only touches the two buildings: a "suspended structure".
function makeBridge(M, x0, x1, z0, z1, y0, y1, mat, color, seg = 2.4) {
  const add = builder(M);
  const L = x1 - x0, n = Math.max(1, Math.ceil(L / seg));
  for (let k = 0; k < n; k++) {
    const a = x0 + (L * k) / n, b = x0 + (L * (k + 1)) / n;
    add([a, y0, z0], [b, y1, z1], mat, 'bridge', [color, color, CEIL, 0x6f6a63, color, color], { building: 99, story: 0 });
    add([a, y1, z0], [b, y1 + 1.05, z0 + 0.1], 'rail', 'rail', 0x2c3339, { building: 99, story: 0 });
    add([a, y1, z1 - 0.1], [b, y1 + 1.05, z1], 'rail', 'rail', 0x2c3339, { building: 99, story: 0 });
  }
}

// Street furniture. Pavements and posts are indestructible anchors (like the map base), the rest breaks.
function furniture(M) {
  const add = builder(M);
  const T = { building: DECOR, story: 0 };
  let stack = 0;
  return {
    pave(x0, z0, x1, z1, h = 0.15) { return add([x0, 0, z0], [x1, h, z1], 'base', 'pavement', [CURB, CURB, CURB, WALK, CURB, CURB], { ...T, story: -1, fixed: true }); },
    footing(x0, z0, x1, z1, h = 0.04) { return add([x0, 0, z0], [x1, h, z1], 'base', 'footing', 0x5d5f62, { ...T, story: -1, fixed: true }); },
    post(x, z, y0, h, r = 0.14) { return add([x - r, y0, z - r], [x + r, y0 + h, z + r], 'base', 'post', 0xffd23f, { ...T, story: -1, fixed: true }); },
    // street lamp: steel pole + arm toward the street + a glass lamp under the arm
    lamp(x, z, y0, dz = 1) {
      const top = y0 + 4.75;
      add([x - 0.09, y0, z - 0.09], [x + 0.09, top, z + 0.09], 'steel', 'lamp', STEEL, T);
      const za = dz > 0 ? [z + 0.09, z + 1.35] : [z - 1.35, z - 0.09];
      add([x - 0.06, top - 0.15, za[0]], [x + 0.06, top, za[1]], 'steel', 'lamp', STEEL, T);
      const zl = dz > 0 ? [z + 1.0, z + 1.32] : [z - 1.32, z - 1.0];
      add([x - 0.16, top - 0.3, zl[0]], [x + 0.16, top - 0.15, zl[1]], 'glass', 'lampglass', 0xfff3c8, T);
    },
    // jersey barrier on its own footing (or straight on a pavement when y0 > 0)
    barrier(x, z, y0, alongX = true, L = 2.4) {
      if (y0 === 0) { this.footing(alongX ? x - L / 2 : x - 0.35, alongX ? z - 0.35 : z - L / 2, alongX ? x + L / 2 : x + 0.35, alongX ? z + 0.35 : z + L / 2); y0 = 0.04; }
      const hx = alongX ? L / 2 : 0.3, hz = alongX ? 0.3 : L / 2;
      return add([x - hx, y0, z - hz], [x + hx, y0 + 0.85, z + hz], 'concrete', 'barrier', [0xf2efe8, 0xf2efe8, 0xb9b4aa, 0xc9c4ba, 0xf2efe8, 0xf2efe8], T);
    },
    // loose wooden crates: dynamic from the start, one strain group per stack
    crates(x, z, y0, n = 1, s = 0.95, rot = 0) {
      const key = 2000 + stack++;
      for (let k = 0; k < n; k++) {
        const sz = s * (k ? 0.86 : 1), ox = k ? Math.sin(rot + k) * 0.06 : 0, oz = k ? Math.cos(rot + k) * 0.06 : 0;
        const yb = k ? M[M.length - 1].max[1] : y0;
        add([x - sz / 2 + ox, yb, z - sz / 2 + oz], [x + sz / 2 + ox, yb + sz, z + sz / 2 + oz], 'crate', 'crate', [WOOD, WOOD, 0x8f6236, 0xc28f58, WOOD, WOOD], { building: key, story: k, dynamic: true });
      }
    },
    cashout(x, z, y0) {
      add([x - 1.0, y0, z - 0.7], [x + 1.0, y0 + 1.15, z + 0.7], 'base', 'cashout', [0x1d2026, 0x1d2026, 0x1d2026, 0xffd23f, 0x1d2026, 0x1d2026], { ...T, story: -1, fixed: true });
      add([x - 0.7, y0 + 1.15, z - 0.35], [x + 0.7, y0 + 2.05, z + 0.35], 'base', 'cashout', [0x1d2026, 0x1d2026, 0x1d2026, 0x1d2026, 0xff2e63, 0xff2e63], { ...T, story: -1, fixed: true, screen: true });
    },
  };
}

// highest module whose footprint contains (x, z) and whose top is at or below y
function moduleBelow(M, x, z, y) {
  let best = -1, by = -Infinity;
  for (let i = 0; i < M.length; i++) {
    const m = M[i];
    if (x < m.min[0] || x > m.max[0] || z < m.min[2] || z > m.max[2] || m.max[1] > y + 1e-3 || m.mat === 'glass') continue;
    if (m.max[1] > by) { by = m.max[1]; best = i; }
  }
  return best;
}
const zip = (M, a, b) => ({ a, b, ma: moduleBelow(M, a[0], a[2], a[1]), mb: moduleBelow(M, b[0], b[2], b[1]) });
const ladder = (M, x, z, nx, nz, y0, y1) => ({ p: [x, z], n: [nx, nz], y0, y1, w: 0.62, mod: moduleBelow(M, x - nx * 0.6, z - nz * 0.6, y1) });

// Out-of-bounds city blocks around the arena: solid but not destructible (rendered with a window texture).
function skyline(seed, rows) {
  const rng = mulberry32(seed), out = [];
  const tints = [0xc4bcae, 0xb3bcc2, 0xcdbfa8, 0xa2adb4, 0xc2b09e, 0xada597, 0xd2cabd, 0x95a1a8, 0xc98f74, 0x9fb3a6];
  for (const r of rows) {
    let a = r.a0;
    while (a < r.a1) {
      const w = r.w0 + rng() * (r.w1 - r.w0), d = r.d0 + rng() * (r.d1 - r.d0), h = r.h0 + rng() * (r.h1 - r.h0);
      const b = r.b + (r.flip ? -d : 0) + (rng() - 0.5) * 3;
      const box = r.axis === 'x' ? { min: [a, 0, b], max: [a + w, h, b + d] } : { min: [b, 0, a], max: [b + d, h, a + w] };
      out.push({ ...box, color: tints[(rng() * tints.length) | 0] });
      a += w + 1.5 + rng() * 4;
    }
  }
  return out;
}

function district() {
  const M = [];
  // all fronts face the street (+z). Parking deck, apartments with stairs, a tower, a brick house, a cafe.
  const Dk = makeBuilding(M, { id: 4, x: -46, z: -9, bx: 3, bz: 4, stories: 3, color: 0xbfc4c6, walls: false, flip: true, floorColor: 0x9a968f });
  const A = makeBuilding(M, { id: 0, x: -30, z: -6, bx: 4, bz: 3, stories: 4, color: 0xe7a07c, partition: true, flip: true, doorBay: 3,
    stairs: { i: 1, j: 0 }, balconies: [{ story: 1, i0: 1, i1: 3 }, { story: 2, i0: 1, i1: 3 }] });
  const C = makeBuilding(M, { id: 1, x: -8, z: -3, bx: 2, bz: 2, stories: 7, color: 0xd9dcd6, doorBay: 0, flip: true,
    opening: (side, s, k) => (s === 0 && side === 'front' && k === 0 ? 'door' : s === 0 ? 'shop' : 'win') });
  const Bd = makeBuilding(M, { id: 2, x: 6, z: -6, bx: 3, bz: 3, stories: 3, color: 0xe6be6a, wallMat: 'brick', slabMat: 'wood', colMat: 'wood',
    partition: true, partitionMat: 'wood', flip: true, balconies: [{ story: 1, i0: 0, i1: 3, mat: 'wood' }] });
  const E = makeBuilding(M, { id: 3, x: 21, z: -3, bx: 2, bz: 2, stories: 2, color: 0x7fb7a4, wallMat: 'wood', slabMat: 'wood', colMat: 'wood',
    storyH: 3.0, wallT: 0.2, slabT: 0.22, flip: true, doorBay: 0, opening: (side, s, k) => (s === 0 && side === 'front' ? (k === 0 ? 'door' : 'shop') : 'win') });
  // skybridge A <-> C at the slab of story 2 (deck flush with the floor slabs)
  const [ys0, ys1] = A.slabY(1);
  makeBridge(M, A.x1, C.x0, -1.4, 1.4, ys0, ys1, 'concrete', 0xc7c2b8);
  // steel gantry C <-> B at roof height of B, a jumbotron hangs from it on two ropes
  const [yg0, yg1] = Bd.slabY(2);
  const add = builder(M);
  const gx0 = C.x1, gx1 = Bd.x0, gl = gx1 - gx0;
  const gmods = [];
  for (let k = 0; k < 3; k++) gmods.push(add([gx0 + (gl * k) / 3, yg0 - 0.25, -0.35], [gx0 + (gl * (k + 1)) / 3, yg1, 0.35], 'steel', 'gantry', STEEL, { building: 98, story: 0 }));
  const jx = (gx0 + gx1) / 2, jt = yg0 - 0.25 - 1.6;
  const jumbo = add([jx - 2.6, jt - 2.8, -0.2], [jx + 2.6, jt, 0.2], 'panel', 'jumbotron', [0x1d2026, 0x1d2026, 0x1d2026, 0x1d2026, 0xff2e63, 0xff2e63], { building: 97, story: 0, dynamic: true, screen: true });
  const ropes = [
    { a: { module: gmods[1], point: [jx - 2.1, yg0 - 0.25, 0] }, b: { module: jumbo, point: [jx - 2.1, jt, 0] } },
    { a: { module: gmods[1], point: [jx + 2.1, yg0 - 0.25, 0] }, b: { module: jumbo, point: [jx + 2.1, jt, 0] } },
  ];
  // street furniture: pavement along the fronts, the far pavement and the spawn plaza
  const F = furniture(M);
  F.pave(-54, 3.4, 36, 7.0);
  F.pave(-54, 17.0, 36, 34.0);
  for (const x of [-44, -32, -20, -8, 4, 16, 28]) F.lamp(x, 6.4, 0.15, 1);
  for (const x of [-38, -14, 10]) F.lamp(x, 17.6, 0.15, -1);
  F.barrier(-25, 5.6, 0.15); F.barrier(-1.2, 5.6, 0.15); F.barrier(18.5, 5.6, 0.15, false);
  F.barrier(-16, 12.0, 0, true); F.barrier(3.5, 10.5, 0, false); F.barrier(-30, 14.2, 0, true);
  F.barrier(-11.5, 21.5, 0.15); F.barrier(-4.5, 21.5, 0.15); F.barrier(-20, 24.5, 0.15, false);
  F.crates(-15.5, 19.2, 0.15, 2); F.crates(-14.3, 19.4, 0.15, 1); F.crates(1.5, 23.5, 0.15, 2, 0.95, 1.3);
  F.crates(-41.5, -4.5, 0.3, 2); F.crates(-38.5, -7.5, 0.3, 1); F.crates(12.5, 13.0, 0, 1); F.crates(25.5, 5.4, 0.15, 2, 0.9, 0.4);
  F.cashout(-8, 30.0, 0.15);
  // ziplines (end points hang ~2.2 m above the roofs they land on)
  const ziplines = [
    zip(M, [-25.5, 4.25, 19.0], [-25.5, 16.4, 1.0]),        // plaza -> A roof
    zip(M, [-39.0, 12.6, -3.0], [-28.5, 16.0, -3.0]),       // parking deck -> A roof
    zip(M, [-20.0, 17.0, -1.5], [-6.0, 26.2, -1.0]),        // A roof -> tower roof
    zip(M, [-4.0, 26.6, 1.0], [10.0, 12.6, 1.5]),           // tower roof -> brick house roof
  ];
  const ladders = [
    ladder(M, -41.5, Dk.front, 0, 1, 0.3, Dk.top + 1.1),    // parking deck, street side
    ladder(M, Bd.x0, -3.0, -1, 0, 0.3, Bd.top + 1.1),       // brick house, alley side
    ladder(M, E.x0, 0.0, -1, 0, 0.3, E.top + 1.1),          // cafe, side wall
  ];
  const props = [
    { type: 'canister', p: [-27.8, 0.6, 5.2] }, { type: 'canister', p: [-27.1, 0.6, 5.7] }, { type: 'canister', p: [-12.8, 0.45, 1.5] },
    { type: 'canister', p: [-12.2, 0.45, 2.3] }, { type: 'canister', p: [3.0, 0.45, -1.8] }, { type: 'canister', p: [16.8, 0.6, 5.0] },
    { type: 'canister', p: [-6.5, 0.6, 19.4] }, { type: 'canister', p: [-38.5, 0.75, -1.0] }, { type: 'canister', p: [23.2, 0.6, 5.6] },
    { type: 'pad', p: [-22.5, 0.15, 6.2] }, { type: 'pad', p: [10.5, 0.15, 6.2] }, { type: 'pad', p: [-1.0, 0.15, 25.5] },
  ];
  return {
    modules: M, ropes, props, ziplines, ladders, ramps: A.ramps, spawn: [-8, 1.35, 27], look: [-8, 7, 0], bounds: [-56, -40, 40, 46],
    street: { z0: 7.0, z1: 17.0, x0: -54, x1: 36, crossings: [-8, 18] },
    skyline: skyline(5, [
      { axis: 'x', a0: -78, a1: 62, b: -22, flip: true, w0: 9, w1: 18, d0: 10, d1: 18, h0: 14, h1: 44 },
      { axis: 'x', a0: -78, a1: 62, b: 40, w0: 10, w1: 20, d0: 10, d1: 16, h0: 10, h1: 34 },
      { axis: 'z', a0: -20, a1: 38, b: -62, flip: true, w0: 10, w1: 16, d0: 10, d1: 14, h0: 12, h1: 30 },
      { axis: 'z', a0: -20, a1: 38, b: 46, w0: 10, w1: 16, d0: 10, d1: 14, h0: 12, h1: 30 },
    ]),
  };
}

function lab() {
  const M = [];
  const add = builder(M);
  const base = (x0, z0, x1, z1, b) => add([x0, 0, z0], [x1, 0.3, z1], 'base', 'base', BASEC, { fixed: true, building: b, story: -1 });
  // 1. balanced "T": a beam on a single column. Cut one arm and the column has to carry the moment.
  base(-27, -9, -23, -5, 10);
  add([-25.5, 0.3, -7.5], [-24.5, 4.3, -6.5], 'concrete', 'column', 0xd8d3c8, { building: 10, story: 0 });
  for (let k = 0; k < 5; k++) add([-28.75 + k * 1.5, 4.3, -7.5], [-27.25 + k * 1.5, 5.3, -6.5], 'concrete', 'beam', 0xe0a46f, { building: 10, story: 0 });
  // 2. continuous bridge on four piers
  for (const px of [-16.5, -10.5, -4.5, 1.5]) { base(px - 1, -8, px + 1, -6, 11); add([px - 0.5, 0.3, -7.5], [px + 0.5, 4.3, -6.5], 'concrete', 'column', 0xd8d3c8, { building: 11, story: 0 }); }
  for (let k = 0; k < 7; k++) add([-17.5 + k * 3, 4.3, -8.5], [-14.5 + k * 3, 5.0, -5.5], 'concrete', 'bridge', 0xc9c4ba, { building: 11, story: 0 });
  // 3. "pancake" tower: slabs on columns only
  makeBuilding(M, { id: 12, x: 9, z: -10, bx: 2, bz: 2, stories: 6, color: 0x9fc7b5, walls: false });
  // 4. brick wall (Jenga)
  base(-27, 4, -15, 6, 13);
  for (let r = 0; r < 6; r++) for (let c = 0; c < 6; c++) {
    const off = r % 2 ? 0.5 : 0;
    const x0 = -26.5 + c * 2 + off, x1 = Math.min(-26.5 + (c + 1) * 2 + off, -15.5);
    if (x1 - x0 < 0.3) continue;
    add([x0, 0.3 + r * 0.6, 4.7], [x1, 0.9 + r * 0.6, 5.3], 'brick', 'wall', 0xc0704a, { building: 13, story: r });
  }
  // 5. wooden shed
  makeBuilding(M, { id: 14, x: -8, z: 3, bx: 2, bz: 2, stories: 2, color: 0xb98a5a, wallMat: 'wood', slabMat: 'wood', colMat: 'wood', storyH: 3.0, wallT: 0.2, slabT: 0.22, flip: true });
  const F = furniture(M);
  F.crates(-2.5, 12.5, 0, 2); F.crates(-1.2, 12.8, 0, 1); F.barrier(6, 13, 0, true); F.barrier(-13, 13, 0, true);
  const props = [
    { type: 'canister', p: [2, 0.45, 6] }, { type: 'canister', p: [2.8, 0.45, 6.4] }, { type: 'canister', p: [2.3, 1.35, 6.2] },
    { type: 'pad', p: [5, 0.0, 9] },
  ];
  return { modules: M, ropes: [], props, ziplines: [], ladders: [], spawn: [-6, 1.2, 20], look: [-6, 4, -4], bounds: [-48, -40, 48, 40] };
}

function house() {
  const M = [];
  const H0 = makeBuilding(M, { id: 0, x: -6, z: -6, bx: 4, bz: 4, stories: 5, color: 0xa8cdb8, partition: true, flip: true, doorBay: 3, stairs: { i: 1, j: 0 },
    balconies: [{ story: 2, i0: 1, i1: 3 }, { story: 3, i0: 0, i1: 4 }] });
  const F = furniture(M);
  F.pave(-12, 6.4, 12, 9.5);
  for (const x of [-10, 10]) F.lamp(x, 9.0, 0.15, 1);
  F.barrier(-3, 13, 0, true); F.crates(4, 12, 0, 2);
  const ladders = [ladder(M, H0.x1, 0, 1, 0, 0.3, H0.top + 1.1)];
  return { modules: M, ropes: [], ladders, ziplines: [], ramps: H0.ramps, props: [{ type: 'canister', p: [8, 0.45, 12] }, { type: 'canister', p: [8.8, 0.45, 12.6] }, { type: 'pad', p: [-9, 0.0, 12] }], spawn: [0, 1.2, 26], look: [0, 6, 0], bounds: [-40, -40, 40, 40] };
}

export const SCENES = {
  district: { title: 'КВАРТАЛ', sub: '5 зданий · зиплайны · лестницы · джамботрон', build: district },
  lab: { title: 'ПОЛИГОН', sub: 'консоль · мост · «блинчик» · стена', build: lab },
  house: { title: 'ДОМ', sub: '5 этажей · лестница на крышу', build: house },
};
