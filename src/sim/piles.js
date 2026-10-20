// Debris piles (PRIME TIME): small settled debris is folded into a rubble heightfield that grows as
// buildings crumble. Rows run along z, columns along x (Rapier heightfield layout, column-major).
export class Piles {
  constructor(R, world, bounds, cell = 0.5) {
    this.R = R; this.world = world;
    const [x0, z0, x1, z1] = bounds;
    this.cell = cell; this.x0 = x0; this.z0 = z0;
    this.ncols = Math.round((x1 - x0) / cell); this.nrows = Math.round((z1 - z0) / cell);
    this.sx = this.ncols * cell; this.sz = this.nrows * cell;
    this.h = new Float32Array((this.ncols + 1) * (this.nrows + 1));
    this.body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x0 + this.sx / 2, 0, z0 + this.sz / 2));
    this.collider = null; this.dirty = false; this.lastBuild = -1; this.version = 0; this.volume = 0;
  }
  idx(col, row) { return col * (this.nrows + 1) + row; }
  add(x, z, vol) {
    if (!(vol > 0)) return;
    const r = 0.55 + Math.cbrt(vol) * 0.9;
    const c0 = Math.max(0, Math.floor((x - r - this.x0) / this.cell)), c1 = Math.min(this.ncols, Math.ceil((x + r - this.x0) / this.cell));
    const r0 = Math.max(0, Math.floor((z - r - this.z0) / this.cell)), r1 = Math.min(this.nrows, Math.ceil((z + r - this.z0) / this.cell));
    let wsum = 0; const ws = [];
    for (let c = c0; c <= c1; c++) for (let q = r0; q <= r1; q++) {
      const dx = this.x0 + c * this.cell - x, dz = this.z0 + q * this.cell - z;
      const w = Math.exp(-(dx * dx + dz * dz) / (r * r * 0.5));
      if (w > 0.02) { ws.push(c, q, w); wsum += w; }
    }
    if (!wsum) return;
    const k = (vol * 1.35) / (wsum * this.cell * this.cell); // bulking: rubble takes more room than solid
    for (let i = 0; i < ws.length; i += 3) {
      const id = this.idx(ws[i], ws[i + 1]);
      this.h[id] = Math.min(3.0, this.h[id] + k * ws[i + 2]);
    }
    this.volume += vol; this.dirty = true;
  }
  heightAt(x, z) {
    const c = Math.round((x - this.x0) / this.cell), q = Math.round((z - this.z0) / this.cell);
    if (c < 0 || q < 0 || c > this.ncols || q > this.nrows) return 0;
    return this.h[this.idx(c, q)];
  }
  update(time) {
    if (!this.dirty || time - this.lastBuild < 0.7) return false;
    this.dirty = false; this.lastBuild = time; this.version++;
    if (this.collider) this.world.removeCollider(this.collider, false);
    const desc = this.R.ColliderDesc.heightfield(this.nrows, this.ncols, this.h, { x: this.sx, y: 1, z: this.sz }).setFriction(1.0);
    this.collider = this.world.createCollider(desc, this.body);
    return true;
  }
  reset() { this.h.fill(0); this.volume = 0; this.dirty = true; }
}
