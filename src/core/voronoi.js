// Pre-fracture: clip an axis-aligned box into convex Voronoi cells (what Houdini does offline for THE FINALS).
// A cell is a list of convex polygon faces. Face.nb >= 0 -> interior face shared with seed nb (becomes a bond),
// face.nb < 0 -> lies on box side s = -nb - 1 (0:-x 1:+x 2:-y 3:+y 4:-z 5:+z).
import { dot, sub, cross, norm } from './math.js';

function boxFaces(h) {
  const [hx, hy, hz] = h;
  const v = [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz], [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]];
  const F = [
    [[0, 4, 7, 3], [-1, 0, 0], -1], [[1, 2, 6, 5], [1, 0, 0], -2],
    [[0, 1, 5, 4], [0, -1, 0], -3], [[3, 7, 6, 2], [0, 1, 0], -4],
    [[0, 3, 2, 1], [0, 0, -1], -5], [[4, 5, 6, 7], [0, 0, 1], -6],
  ];
  return F.map(([idx, n, nb]) => ({ pts: idx.map((i) => v[i].slice()), n, nb }));
}

function orderCap(pts, n) {
  let cx = 0, cy = 0, cz = 0;
  for (const p of pts) { cx += p[0]; cy += p[1]; cz += p[2]; }
  const k = pts.length; const c = [cx / k, cy / k, cz / k];
  const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(a, n)); const w = cross(n, u);
  return pts.map((p) => { const d = sub(p, c); return { p, t: Math.atan2(dot(d, w), dot(d, u)) }; })
    .sort((A, B) => A.t - B.t).map((o) => o.p);
}

function dedupe(pts, eps) {
  const out = [];
  for (const p of pts) {
    let dup = false;
    for (const q of out) if (Math.abs(p[0] - q[0]) < eps && Math.abs(p[1] - q[1]) < eps && Math.abs(p[2] - q[2]) < eps) { dup = true; break; }
    if (!dup) out.push(p);
  }
  return out;
}

// keep the half-space dot(n, x) <= d
function clip(faces, n, d, nb, eps) {
  const out = []; const cap = [];
  let cut = false;
  for (const f of faces) {
    const P = f.pts, m = P.length, res = [];
    for (let i = 0; i < m; i++) {
      const a = P[i], b = P[(i + 1) % m];
      const da = dot(n, a) - d, db = dot(n, b) - d;
      if (da <= eps) { res.push(a); if (da >= -eps) cap.push(a); } else cut = true;
      if ((da < -eps && db > eps) || (da > eps && db < -eps)) {
        const t = da / (da - db);
        const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        res.push(p); cap.push(p);
      }
    }
    if (res.length >= 3) out.push({ pts: res, n: f.n, nb: f.nb });
  }
  if (!cut) return faces;
  const c = dedupe(cap, eps * 20);
  if (c.length >= 3) out.push({ pts: orderCap(c, n), n: n.slice(), nb });
  return out;
}

export function polyArea(pts, n) {
  let cx = 0, cy = 0, cz = 0, at = 0;
  const p0 = pts[0];
  for (let i = 1; i + 1 < pts.length; i++) {
    const c = cross(sub(pts[i], p0), sub(pts[i + 1], p0));
    const ar = 0.5 * Math.abs(dot(c, n));
    cx += ar * (p0[0] + pts[i][0] + pts[i + 1][0]) / 3; cy += ar * (p0[1] + pts[i][1] + pts[i + 1][1]) / 3; cz += ar * (p0[2] + pts[i][2] + pts[i + 1][2]) / 3;
    at += ar;
  }
  const inv = at > 0 ? 1 / at : 0;
  return { area: at, c: at > 0 ? [cx * inv, cy * inv, cz * inv] : p0.slice() };
}

function cellProps(faces) {
  let rx = 0, ry = 0, rz = 0, k = 0;
  for (const f of faces) for (const p of f.pts) { rx += p[0]; ry += p[1]; rz += p[2]; k++; }
  const r = [rx / k, ry / k, rz / k];
  let vol = 0, cx = 0, cy = 0, cz = 0;
  for (const f of faces) {
    const P = f.pts;
    for (let i = 1; i + 1 < P.length; i++) {
      const a = sub(P[0], r), b = sub(P[i], r), c = sub(P[i + 1], r);
      const v = dot(a, cross(b, c)) / 6;
      vol += v;
      cx += v * (r[0] * 4 + a[0] + b[0] + c[0]) / 4; cy += v * (r[1] * 4 + a[1] + b[1] + c[1]) / 4; cz += v * (r[2] * 4 + a[2] + b[2] + c[2]) / 4;
    }
  }
  return { vol, c: vol > 0 ? [cx / vol, cy / vol, cz / vol] : r };
}

// size: [sx, sy, sz] of a box centred at the origin; seeds: array of [x,y,z] inside it.
export function fractureBox(size, seeds) {
  const h = [size[0] / 2, size[1] / 2, size[2] / 2];
  const maxDim = Math.max(size[0], size[1], size[2]);
  const eps = 1e-7 * maxDim;
  const cells = [];
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i];
    let faces = boxFaces(h);
    if (seeds.length > 1) {
      const others = [];
      for (let j = 0; j < seeds.length; j++) if (j !== i) { const d = sub(seeds[j], s); others.push({ j, d, l: Math.hypot(d[0], d[1], d[2]) }); }
      others.sort((A, B) => A.l - B.l);
      for (const o of others) {
        let rmax = 0;
        for (const f of faces) for (const p of f.pts) { const q = Math.hypot(p[0] - s[0], p[1] - s[1], p[2] - s[2]); if (q > rmax) rmax = q; }
        if (o.l * 0.5 > rmax + eps) break;
        if (o.l < 1e-9) continue;
        const n = [o.d[0] / o.l, o.d[1] / o.l, o.d[2] / o.l];
        const mid = [s[0] + o.d[0] * 0.5, s[1] + o.d[1] * 0.5, s[2] + o.d[2] * 0.5];
        faces = clip(faces, n, dot(n, mid), o.j, eps);
        if (faces.length < 4) break;
      }
    }
    if (faces.length < 4) continue;
    const { vol, c } = cellProps(faces);
    if (!(vol > 1e-9)) continue;
    const fl = [];
    for (const f of faces) { const { area, c: fc } = polyArea(f.pts, f.n); if (area > 1e-8) fl.push({ pts: f.pts, n: f.n, nb: f.nb, area, c: fc }); }
    cells.push({ seed: i, faces: fl, vol, c });
  }
  return cells;
}

// Seed layouts. Panels (walls/slabs) get one layer through their thickness so chunks span the wall,
// long members (columns/beams) get slices, blocks get a 3D scatter.
export function makeSeeds(size, count, rng) {
  const dims = [0, 1, 2].sort((a, b) => size[a] - size[b]);
  const [t, m, L] = dims;
  const h = [size[0] / 2, size[1] / 2, size[2] / 2];
  const seeds = [];
  if (count <= 1) return [[0, 0, 0]];
  if (size[t] < 0.45 * size[m]) {
    const A = size[m] * size[L];
    const dmin = 0.6 * Math.sqrt(A / count);
    let tries = 0;
    while (seeds.length < count && tries++ < count * 60) {
      const p = [0, 0, 0];
      p[m] = (rng() * 2 - 1) * h[m] * 0.97; p[L] = (rng() * 2 - 1) * h[L] * 0.97; p[t] = (rng() * 2 - 1) * h[t] * 0.2;
      let ok = true;
      for (const q of seeds) if (Math.hypot(p[m] - q[m], p[L] - q[L]) < dmin) { ok = false; break; }
      if (ok) seeds.push(p);
    }
  } else if (size[L] > 2.2 * size[m]) {
    for (let k = 0; k < count; k++) {
      const p = [0, 0, 0];
      p[L] = ((k + 0.5 + (rng() - 0.5) * 0.5) / count * 2 - 1) * h[L];
      p[m] = (rng() * 2 - 1) * h[m] * 0.3; p[t] = (rng() * 2 - 1) * h[t] * 0.3;
      seeds.push(p);
    }
  } else {
    const dmin = 0.55 * Math.cbrt(size[0] * size[1] * size[2] / count);
    let tries = 0;
    while (seeds.length < count && tries++ < count * 60) {
      const p = [(rng() * 2 - 1) * h[0] * 0.95, (rng() * 2 - 1) * h[1] * 0.95, (rng() * 2 - 1) * h[2] * 0.95];
      let ok = true;
      for (const q of seeds) if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < dmin) { ok = false; break; }
      if (ok) seeds.push(p);
    }
  }
  return seeds.length ? seeds : [[0, 0, 0]];
}
