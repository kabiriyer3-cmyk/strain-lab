// Scene blueprints. Like THE FINALS' Houdini "Building Creator", a building is assembled from feature
// rules (walls split into piers/sills/lintels per bay and story, floor slabs per bay, columns, parapets,
// balconies) and every element is an axis-aligned module that later gets pre-fractured.
const PLASTER = 0xefebe3, CEIL = 0xf2efe9, FLOOR = 0xb89f80, ROOF = 0x8f8b84, BASEC = 0x86817a;

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

export function makeBuilding(M, o) {
  const add = builder(M);
  const bay = o.bay ?? 3, bx = o.bx, bz = o.bz, S = o.stories, H = o.storyH ?? 3.2;
  const tw = o.wallT ?? 0.3, ts = o.slabT ?? 0.3, B = 0.3;
  const W = bx * bay, D = bz * bay, X = o.x, Z = o.z, bid = o.id;
  const wm = o.wallMat ?? 'concrete', sm = o.slabMat ?? 'concrete', cm = o.colMat ?? 'concrete';
  const facade = o.color, trim = o.trim ?? PLASTER;
  const P = (x, y, z) => [X + x, y, Z + z];
  const tag = (story) => ({ building: bid, story });
  add(P(-0.4, 0, -0.4), P(W + 0.4, B, D + 0.4), 'base', 'base', BASEC, { ...tag(-1), fixed: true });

  const opening = o.opening || ((side, s, k) => (s === 0 && side === (o.doorSide ?? 'front') && k === (o.doorBay ?? 1) ? 'door' : 'win'));

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
        if (o.columns === false) { /* walls end at each other */ }
        // non-load-bearing: a 2 cm gap under the slab, so partitions never prop the floor above
        add(P(xa, y0, zc - 0.1), P(xb, yt - 0.02, zc + 0.1), o.partitionMat ?? 'brick', 'partition', PLASTER, tag(s));
      }
    }
    const sc = [trim, trim, CEIL, s === S - 1 ? ROOF : o.floorColor ?? FLOOR, trim, trim];
    for (let i = 0; i < bx; i++) for (let j = 0; j < bz; j++) {
      if (o.skipSlab && o.skipSlab(s, i, j)) continue;
      add(P(i * bay, yt, j * bay), P((i + 1) * bay, y0 + H, (j + 1) * bay), sm, s === S - 1 ? 'roof' : 'slab', sc, tag(s));
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
  return { x0: X, z0: Z, x1: X + W, z1: Z + D, slabY: (s) => [B + s * H + H - ts, B + (s + 1) * H], top: yr };
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

function district() {
  const M = [];
  const A = makeBuilding(M, { id: 0, x: -24, z: -4.5, bx: 4, bz: 3, stories: 4, color: 0xe7a07c, partition: true,
    balconies: [{ story: 1, i0: 1, i1: 3 }, { story: 2, i0: 1, i1: 3 }] });
  const C = makeBuilding(M, { id: 1, x: -4, z: -3, bx: 2, bz: 2, stories: 7, color: 0xd9dcd6, doorBay: 0,
    opening: (side, s, k) => (s === 0 && side === 'front' && k === 0 ? 'door' : s === 0 ? 'shop' : 'win') });
  const Bd = makeBuilding(M, { id: 2, x: 9, z: -4.5, bx: 3, bz: 3, stories: 3, color: 0xe6be6a, wallMat: 'brick', slabMat: 'wood', colMat: 'wood',
    partition: true, partitionMat: 'wood', balconies: [{ story: 1, i0: 0, i1: 3, mat: 'wood' }] });
  // skybridge A <-> C at the slab of story 2 (deck flush with the floor slabs)
  const [ys0, ys1] = A.slabY(1);
  makeBridge(M, A.x1, C.x0, -1.4, 1.4, ys0, ys1, 'concrete', 0xc7c2b8);
  // steel gantry C <-> B at roof height of B, a jumbotron hangs from it on two ropes
  const [yg0, yg1] = Bd.slabY(2);
  const add = builder(M);
  const gx0 = C.x1, gx1 = Bd.x0, gl = gx1 - gx0;
  const gmods = [];
  for (let k = 0; k < 3; k++) gmods.push(add([gx0 + (gl * k) / 3, yg0 - 0.25, -0.35], [gx0 + (gl * (k + 1)) / 3, yg1, 0.35], 'steel', 'gantry', 0x3a4048, { building: 98, story: 0 }));
  const jx = (gx0 + gx1) / 2, jt = yg0 - 0.25 - 1.6;
  const jumbo = add([jx - 2.6, jt - 2.8, -0.2], [jx + 2.6, jt, 0.2], 'panel', 'jumbotron', [0x1d2026, 0x1d2026, 0x1d2026, 0x1d2026, 0xff2e63, 0x1d2026], { building: 97, story: 0, dynamic: true });
  const ropes = [
    { a: { module: gmods[1], point: [jx - 2.1, yg0 - 0.25, 0] }, b: { module: jumbo, point: [jx - 2.1, jt, 0] } },
    { a: { module: gmods[1], point: [jx + 2.1, yg0 - 0.25, 0] }, b: { module: jumbo, point: [jx + 2.1, jt, 0] } },
  ];
  const props = [
    { type: 'canister', p: [-12.5, 0.45, 6.5] }, { type: 'canister', p: [-12.0, 0.45, 7.3] }, { type: 'canister', p: [5.5, 0.45, 6.2] },
    { type: 'canister', p: [7.6, 0.45, 5.4] }, { type: 'canister', p: [21.5, 0.45, 2.0] },
    { type: 'pad', p: [-6.5, 0.02, 9] }, { type: 'pad', p: [6.5, 0.02, 9] },
  ];
  return { modules: M, ropes, props, spawn: [0, 1.2, 22], look: [0, 6, 0], bounds: [-48, -40, 48, 40] };
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
  makeBuilding(M, { id: 14, x: -8, z: 3, bx: 2, bz: 2, stories: 2, color: 0xb98a5a, wallMat: 'wood', slabMat: 'wood', colMat: 'wood', storyH: 3.0, wallT: 0.2, slabT: 0.22 });
  const props = [
    { type: 'canister', p: [2, 0.45, 6] }, { type: 'canister', p: [2.8, 0.45, 6.4] }, { type: 'canister', p: [2.3, 1.35, 6.2] },
    { type: 'pad', p: [5, 0.02, 9] },
  ];
  return { modules: M, ropes: [], props, spawn: [-6, 1.2, 20], look: [-6, 4, -4], bounds: [-48, -40, 48, 40] };
}

function house() {
  const M = [];
  makeBuilding(M, { id: 0, x: -6, z: -6, bx: 4, bz: 4, stories: 5, color: 0xa8cdb8, partition: true, balconies: [{ story: 2, i0: 1, i1: 3 }, { story: 3, i0: 0, i1: 4 }] });
  return { modules: M, ropes: [], props: [{ type: 'canister', p: [8, 0.45, 8] }, { type: 'canister', p: [8.8, 0.45, 8.6] }, { type: 'pad', p: [-9, 0.02, 10] }], spawn: [0, 1.2, 24], look: [0, 6, 0], bounds: [-40, -40, 40, 40] };
}

export const SCENES = {
  district: { title: 'КВАРТАЛ', sub: '3 здания · мост · джамботрон', build: district },
  lab: { title: 'ПОЛИГОН', sub: 'консоль · мост · «блинчик» · стена', build: lab },
  house: { title: 'ДОМ', sub: 'одно 5-этажное здание', build: house },
};
