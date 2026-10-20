// Sparse direct solver for block-SPD systems (6x6 blocks: 3 translations + 3 rotations per node).
// THE FINALS' Strain uses a sparse direct Cholesky solver; this is a compact version of the same idea:
// minimum-degree ordering on the node graph -> symbolic fill -> right-looking block Cholesky.
const B = 6, BB = 36;

function chol6(A) { // in-place lower Cholesky of a 6x6 row-major block; returns false if not SPD
  for (let j = 0; j < B; j++) {
    let d = A[j * B + j];
    for (let k = 0; k < j; k++) d -= A[j * B + k] * A[j * B + k];
    if (!(d > 1e-300)) d = 1e-300;
    const ljj = Math.sqrt(d); A[j * B + j] = ljj;
    for (let i = j + 1; i < B; i++) {
      let s = A[i * B + j];
      for (let k = 0; k < j; k++) s -= A[i * B + k] * A[j * B + k];
      A[i * B + j] = s / ljj;
    }
    for (let k = j + 1; k < B; k++) A[j * B + k] = 0;
  }
}
// X = Bm * L^-T  (solve X L^T = Bm row by row: L x = row^T)
function trsmRight(L, Bm, X) {
  for (let r = 0; r < B; r++) {
    for (let i = 0; i < B; i++) {
      let s = Bm[r * B + i];
      for (let k = 0; k < i; k++) s -= L[i * B + k] * X[r * B + k];
      X[r * B + i] = s / L[i * B + i];
    }
  }
}
// C -= A * B^T
function gemmNT(A, Bm, C) {
  for (let i = 0; i < B; i++) for (let j = 0; j < B; j++) {
    let s = 0;
    for (let k = 0; k < B; k++) s += A[i * B + k] * Bm[j * B + k];
    C[i * B + j] -= s;
  }
}
function fwd(L, b, o) { for (let i = 0; i < B; i++) { let s = b[o + i]; for (let k = 0; k < i; k++) s -= L[i * B + k] * b[o + k]; b[o + i] = s / L[i * B + i]; } }
function bwd(L, b, o) { for (let i = B - 1; i >= 0; i--) { let s = b[o + i]; for (let k = i + 1; k < B; k++) s -= L[k * B + i] * b[o + k]; b[o + i] = s / L[i * B + i]; } }

// n nodes; diag[i] = Float64Array(36); off = Map("i,j" with i>j -> Float64Array(36) = A[i][j]); rhs Float64Array(6n)
export function solveBlockSPD(n, diag, off, rhs) {
  const adj = Array.from({ length: n }, () => new Set());
  for (const k of off.keys()) { const c = k.indexOf(','); const i = +k.slice(0, c), j = +k.slice(c + 1); adj[i].add(j); adj[j].add(i); }
  // --- minimum degree ordering + symbolic factorisation (neighbour set at elimination = column pattern)
  const pos = new Int32Array(n).fill(-1), order = new Int32Array(n), pattern = new Array(n);
  const alive = new Uint8Array(n).fill(1);
  // bucketed degrees for speed
  for (let step = 0; step < n; step++) {
    let best = -1, bd = 1e9;
    for (let v = 0; v < n; v++) if (alive[v]) { const d = adj[v].size; if (d < bd) { bd = d; best = v; if (d <= 1) break; } }
    const v = best; alive[v] = 0; pos[v] = step; order[step] = v;
    const nb = Array.from(adj[v]);
    pattern[v] = nb;
    for (let x = 0; x < nb.length; x++) {
      const a = nb[x]; const sa = adj[a]; sa.delete(v);
      for (let y = 0; y < nb.length; y++) if (y !== x) sa.add(nb[y]);
    }
    adj[v].clear();
  }
  // --- numeric factorisation, right-looking. W[col] : Map(row -> block)  (rows eliminated after col)
  const W = Array.from({ length: n }, () => new Map());
  const D = diag.map((d) => Float64Array.from(d));
  for (const [k, blk] of off) {
    const c = k.indexOf(','); const i = +k.slice(0, c), j = +k.slice(c + 1);
    if (pos[i] > pos[j]) W[j].set(i, Float64Array.from(blk));
    else { const t = new Float64Array(BB); for (let r = 0; r < B; r++) for (let q = 0; q < B; q++) t[q * B + r] = blk[r * B + q]; W[i].set(j, t); }
  }
  const Lcol = new Array(n);
  let nnz = 0;
  for (let step = 0; step < n; step++) {
    const v = order[step];
    const Lvv = D[v]; chol6(Lvv);
    const pv = pattern[v], m = pv.length;
    const Ls = new Array(m);
    for (let x = 0; x < m; x++) {
      const u = pv[x];
      let blk = W[v].get(u);
      if (!blk) blk = new Float64Array(BB);
      const X = new Float64Array(BB); trsmRight(Lvv, blk, X); Ls[x] = X;
    }
    Lcol[v] = Ls; nnz += m;
    for (let x = 0; x < m; x++) {
      const u1 = pv[x];
      for (let y = 0; y < m; y++) {
        const u2 = pv[y];
        if (pos[u1] < pos[u2]) continue;
        if (u1 === u2) { gemmNT(Ls[x], Ls[x], D[u1]); continue; }
        let tgt = W[u2].get(u1);
        if (!tgt) { tgt = new Float64Array(BB); W[u2].set(u1, tgt); }
        gemmNT(Ls[x], Ls[y], tgt);
      }
    }
    W[v] = null;
  }
  // --- solve L y = b, L^T x = y
  const x = Float64Array.from(rhs);
  const tmp = new Float64Array(B);
  for (let step = 0; step < n; step++) {
    const v = order[step]; const o = v * B;
    fwd(D[v], x, o);
    const pv = pattern[v], Ls = Lcol[v];
    for (let k = 0; k < pv.length; k++) {
      const L = Ls[k], ou = pv[k] * B;
      for (let i = 0; i < B; i++) { let s = 0; for (let q = 0; q < B; q++) s += L[i * B + q] * x[o + q]; x[ou + i] -= s; }
    }
  }
  for (let step = n - 1; step >= 0; step--) {
    const v = order[step]; const o = v * B;
    const pv = pattern[v], Ls = Lcol[v];
    tmp.fill(0);
    for (let k = 0; k < pv.length; k++) {
      const L = Ls[k], ou = pv[k] * B;
      for (let q = 0; q < B; q++) { let s = 0; for (let i = 0; i < B; i++) s += L[i * B + q] * x[ou + i]; tmp[q] += s; }
    }
    for (let q = 0; q < B; q++) x[o + q] -= tmp[q];
    bwd(D[v], x, o);
  }
  return { x, nnz: nnz + n };
}
