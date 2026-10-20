// The destruction runtime. Three layers, as THE FINALS describes them (PRIME TIME, 2026):
//   1. STRAIN   - structural integrity of static buildings (worker thread, see strainService.js)
//   2. GRADUAL  - when Strain breaks a connection, a loose attachment (ball joints / hinge) keeps the pieces
//                 together, so floors hinge and sag before they let go
//   3. PHYSICS  - free debris: rigid compounds that crack on impact, deal impact damage, pile up
// Plus blast waves, explosive canisters, a swinging jumbotron on ropes and a rubble heightfield.
import { Structure, STATIC, DYNAMIC, DEAD } from '../core/structure.js';
import { SCENES } from '../core/scenes.js';
import { qMul, qRot, qConj, qAngle, dist, norm, sub } from '../core/math.js';
import { mulberry32 } from '../core/rng.js';
import { StrainService } from './strainService.js';
import { Piles } from './piles.js';

export const DT = 1 / 60;
const G_STATIC = 0x0001, G_DEBRIS = 0x0002, G_PLAYER = 0x0004, G_PROP = 0x0008, G_SMALL = 0x0010, G_RAMP = 0x0020;
const groups = (member, filter) => ((member & 0xffff) << 16) | (filter & 0xffff);
export const GROUPS = {
  static: groups(G_STATIC, 0xffff),
  debris: groups(G_DEBRIS, 0xffff),
  small: groups(G_SMALL, G_STATIC | G_DEBRIS | G_SMALL | G_PROP),
  prop: groups(G_PROP, 0xffff),
  player: groups(G_PLAYER, G_STATIC | G_DEBRIS | G_PROP | G_RAMP),
  ramp: groups(G_RAMP, G_PLAYER),                                  // invisible stair ramps: only the player walks on them
  query: groups(G_STATIC | G_DEBRIS | G_PROP | G_SMALL, 0xffff & ~G_RAMP), // rays (bullets, projectiles) ignore ramps
};

export class Sim {
  constructor(R, sceneKey, opts = {}) {
    this.R = R;
    this.sceneKey = sceneKey;
    this.def = SCENES[sceneKey].build();
    this.st = new Structure(this.def, opts.seed ?? 1337, { fracScale: opts.fracScale ?? 1 });
    this.maxBodies = opts.maxBodies ?? 520;
    this.rng = mulberry32(99);
    this.world = new R.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = DT;
    this.world.integrationParameters.numSolverIterations = 6;
    this.eq = new R.EventQueue(true);
    this.time = 0; this.tick = 0;
    this.events = [];
    this.bodies = new Map(); this.nextBody = 1;
    this.colShard = new Map(); this.colProp = new Map();
    this.modBody = new Array(this.st.modules.length).fill(null);
    this.atts = []; this.shardAtts = new Map();
    this.projectiles = []; this.props = []; this.delayed = [];
    this.breakQueue = []; this.breakKeys = new Set();
    this.regionViz = new Array(this.st.regions.length).fill(null);
    this.regionStats = new Array(this.st.regions.length).fill(null);
    this.dirtyChunks = new Set();
    this.stats = { solves: 0, solveMs: 0, lastSolveMs: 0, nnz: 0, breaks: 0, detached: 0, impacts: 0, netNaive: 0, netComp: 0, maxU: 0 };
    this.net = { prev: new Map(), naive: 0, comp: 0, acc: 0 };
    this._buildWorld();
    this._buildRamps();
    this.piles = new Piles(R, this.world, this.def.bounds);
    this._buildProps();
    this._buildRopes();
    this.strain = new StrainService(this.st, { workerFactory: opts.workerFactory || null });
    this.strain.flush();
  }

  // ------------------------------------------------------------------ world construction
  _buildWorld() {
    const R = this.R, W = this.world;
    const ground = W.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -1, 0));
    this.groundCollider = W.createCollider(R.ColliderDesc.cuboid(400, 1, 400).setFriction(0.9).setCollisionGroups(GROUPS.static), ground);
    const city = W.createRigidBody(R.RigidBodyDesc.fixed());
    for (const b of this.def.skyline || []) {
      const h = [(b.max[0] - b.min[0]) / 2, (b.max[1] - b.min[1]) / 2, (b.max[2] - b.min[2]) / 2];
      W.createCollider(R.ColliderDesc.cuboid(h[0], h[1], h[2]).setTranslation(b.min[0] + h[0], b.min[1] + h[1], b.min[2] + h[2]).setFriction(0.9).setCollisionGroups(GROUPS.static), city);
    }
    // An intact module collides as ONE box; it is swapped for per-fragment hulls the moment it is damaged
    // (SideFX: Embark merges adjacent convex hulls of a fractured asset wherever the profile allows).
    for (const m of this.st.modules) {
      m.col = null; m.dynCol = null;
      if (m.dynamic) continue;
      const rb = W.createRigidBody(R.RigidBodyDesc.fixed());
      this.modBody[m.id] = rb;
      const cd = R.ColliderDesc.cuboid(m.size[0] / 2, m.size[1] / 2, m.size[2] / 2).setTranslation(m.center[0], m.center[1], m.center[2]).setFriction(0.85).setCollisionGroups(GROUPS.static);
      const col = W.createCollider(cd, rb);
      if (m.fixed) { const sid = m.shards[0]; this.st.shards[sid].collider = col; this.colShard.set(col.handle, sid); }
      else { m.col = col; this.colShard.set(col.handle, -1 - m.id); }
    }
  }
  _buildRamps() {
    const R = this.R;
    this.ramps = (this.def.ramps || []).map((r) => {
      const dx = r.b[0] - r.a[0], dy = r.b[1] - r.a[1], L = Math.hypot(dx, dy);
      const sx = dx < 0 ? -1 : 1, ang = Math.atan2(dy * sx, dx * sx); // keep the box's local +y pointing up
      const nx = -Math.sin(ang), ny = Math.cos(ang), hy = 0.1;
      const cx = (r.a[0] + r.b[0]) / 2 - nx * hy, cy = (r.a[1] + r.b[1]) / 2 - ny * hy, cz = (r.z[0] + r.z[1]) / 2;
      const body = this.world.createRigidBody(R.RigidBodyDesc.fixed());
      const col = this.world.createCollider(R.ColliderDesc.cuboid(L / 2, hy, (r.z[1] - r.z[0]) / 2).setTranslation(cx, cy, cz)
        .setRotation({ x: 0, y: 0, z: Math.sin(ang / 2), w: Math.cos(ang / 2) }).setFriction(0.9).setCollisionGroups(GROUPS.ramp), body);
      return { ...r, body, col, alive: true };
    });
  }
  _checkRamps() {
    for (const r of this.ramps) {
      if (!r.alive) continue;
      if (r.mods.some((mid) => this.st.modules[mid].shards.some((sid) => this.st.shards[sid].state !== STATIC))) {
        r.alive = false; this.world.removeRigidBody(r.body); r.body = r.col = null;
      }
    }
  }
  _hull(s) { const cd = this.R.ColliderDesc.convexHull(s.hull); return cd || this.R.ColliderDesc.ball(Math.max(0.04, s.r * 0.55)); }
  _unsolidStatic(m, except = null) {
    if (!m.col) return;
    this.colShard.delete(m.col.handle); this.world.removeCollider(m.col, false); m.col = null;
    const rb = this.modBody[m.id];
    for (const sid of m.shards) {
      const s = this.st.shards[sid];
      if (s.state !== STATIC || (except && except.has(sid))) continue;
      const col = this.world.createCollider(this._hull(s).setTranslation(s.c[0], s.c[1], s.c[2]).setFriction(0.85).setCollisionGroups(GROUPS.static), rb);
      s.collider = col; this.colShard.set(col.handle, sid);
    }
  }
  _unsolidDyn(m) {
    const dc = m.dynCol; if (!dc) return;
    m.dynCol = null;
    const rec = dc.rec;
    this.colShard.delete(dc.col.handle);
    if (!this.bodies.has(rec.id)) return;
    this.world.removeCollider(dc.col, false);
    for (const sid of m.shards) {
      const s = this.st.shards[sid];
      if (s.state !== DYNAMIC || s.body !== rec) continue;
      const col = this.world.createCollider(this._dynDesc(s, s.lp, s.lq, rec), rec.rb);
      s.collider = col; this.colShard.set(col.handle, sid);
    }
  }
  _dynDesc(s, lp, lq, rec) {
    return this._hull(s).setTranslation(lp[0], lp[1], lp[2]).setRotation({ x: lq[0], y: lq[1], z: lq[2], w: lq[3] })
      .setDensity(s.def.density).setFriction(0.8).setRestitution(0.04)
      .setCollisionGroups(rec.small ? GROUPS.small : GROUPS.debris)
      .setActiveEvents(this.R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(rec.thr);
  }
  // collider handle (+ optional world point) -> fragment id
  resolveShard(handle, point) {
    const v = this.colShard.get(handle);
    if (v === undefined) return -1;
    if (v >= 0) return v;
    const m = this.st.modules[-1 - v];
    if (!point) { for (const sid of m.shards) if (this.st.shards[sid].state !== DEAD) return sid; return -1; }
    let pr = point;
    const dc = m.dynCol;
    if (dc && this.bodies.has(dc.rec.id)) {
      // world -> rest frame through any fragment of the module (they share one rigid transform)
      const s0 = this.st.shards[m.shards.find((sid) => this.st.shards[sid].body === dc.rec)];
      if (s0) { const ps = this.shardPose(s0); const l = qRot(qConj(ps.q), sub(point, ps.p)); pr = [s0.c[0] + l[0], s0.c[1] + l[1], s0.c[2] + l[2]]; }
    }
    return this.st.shardAt(m.id, pr);
  }

  _buildProps() {
    const R = this.R;
    for (const p of this.def.props || []) {
      if (p.type === 'canister') {
        const rb = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(p.p[0], p.p[1], p.p[2]).setCanSleep(true));
        const col = this.world.createCollider(R.ColliderDesc.cylinder(0.45, 0.3).setDensity(300).setFriction(0.7).setCollisionGroups(GROUPS.prop)
          .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(9000), rb);
        const pr = { type: 'canister', rb, col, hp: 1, alive: true, id: this.props.length };
        this.colProp.set(col.handle, pr); this.props.push(pr);
      } else if (p.type === 'pad') {
        this.props.push({ type: 'pad', p: p.p, r: 1.1, id: this.props.length, alive: true });
      }
    }
  }

  _buildRopes() {
    for (const rope of this.def.ropes || []) {
      const pick = (end) => {
        const m = this.st.modules[end.module];
        let best = -1, bd = Infinity;
        for (const sid of m.shards) { const d = dist(this.st.shards[sid].c, end.point); if (d < bd) { bd = d; best = sid; } }
        return best;
      };
      const a = pick(rope.a), b = pick(rope.b);
      const L = dist(rope.a.point, rope.b.point);
      this._newAtt({ type: 'rope', sideA: this.st.modules[rope.a.module].shards.slice(), sideB: this.st.modules[rope.b.module].shards.slice(),
        ptsA: [rope.a.point], ptsB: [rope.b.point], refA: a, refB: b, length: L, cap: 260, bend: Math.PI });
    }
  }

  // ------------------------------------------------------------------ helpers
  shardPose(s) {
    if (s.state === DYNAMIC && s.body) {
      const rb = s.body.rb; const t = rb.translation(), q = rb.rotation();
      const Q = [q.x, q.y, q.z, q.w];
      const p = qRot(Q, s.lp);
      return { p: [t.x + p[0], t.y + p[1], t.z + p[2]], q: qMul(Q, s.lq) };
    }
    return { p: s.c, q: [0, 0, 0, 1] };
  }
  shardPos(s) { return this.shardPose(s).p; }
  _chunkDirty(s) { this.dirtyChunks.add(this.st.modules[s.mod].chunk ?? s.mod); }
  _rbOf(s) { if (s.state === DYNAMIC && s.body) return s.body.rb; if (s.state === STATIC) return this.modBody[s.mod]; return null; }

  // ------------------------------------------------------------------ bodies
  createBody(ids, o = {}) {
    const R = this.R, st = this.st;
    const poses = o.poses || ids.map((id) => this.shardPose(st.shards[id]));
    let M = 0, ox = 0, oy = 0, oz = 0, vol = 0, glassOnly = true;
    ids.forEach((id, i) => { const s = st.shards[id]; M += s.mass; vol += s.vol; ox += s.mass * poses[i].p[0]; oy += s.mass * poses[i].p[1]; oz += s.mass * poses[i].p[2]; if (!s.glass) glassOnly = false; });
    ox /= M; oy /= M; oz /= M;
    const q = o.q || [0, 0, 0, 1], qi = qConj(q);
    const v = o.v || [0, 0, 0], w = o.w || [0, 0, 0];
    const small = vol < 0.05 || glassOnly;
    const desc = R.RigidBodyDesc.dynamic().setTranslation(ox, oy, oz).setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] })
      .setLinvel(v[0], v[1], v[2]).setAngvel({ x: w[0], y: w[1], z: w[2] }).setCanSleep(true).setCcdEnabled(!!o.ccd || (small && Math.hypot(v[0], v[1], v[2]) > 8));
    if (small) desc.setAngularDamping(0.25).setLinearDamping(0.05);
    const rb = this.world.createRigidBody(desc);
    const rec = { id: this.nextBody++, rb, shards: [], mass: M, vol, age: 0, sleep: 0, small, glass: glassOnly, dirty: true, split: false, atts: new Set(), kind: o.kind || 'debris' };
    rec.thr = Math.max(2500, M * 9.81 * 2.5 / Math.sqrt(ids.length));
    // static colliders go away first (whole module boxes when the module leaves in one piece)
    const idset = new Set(ids), byMod = new Map();
    for (const id of ids) { const sm = st.shards[id].mod; if (!byMod.has(sm)) byMod.set(sm, []); byMod.get(sm).push(id); }
    for (const [mid, list] of byMod) {
      const m = st.modules[mid];
      if (m.col) {
        const allStaticHere = m.shards.every((sid) => st.shards[sid].state !== STATIC || idset.has(sid));
        if (allStaticHere) { this.colShard.delete(m.col.handle); this.world.removeCollider(m.col, false); m.col = null; }
        else this._unsolidStatic(m, idset);
      }
      if (m.dynCol && m.dynCol.rec !== rec) { this.colShard.delete(m.dynCol.col.handle); m.dynCol = null; }
      void list;
    }
    const lps = new Map();
    ids.forEach((id, i) => {
      const s = st.shards[id];
      const lp = qRot(qi, [poses[i].p[0] - ox, poses[i].p[1] - oy, poses[i].p[2] - oz]);
      const lq = qMul(qi, poses[i].q);
      lps.set(id, i);
      if (s.state === STATIC) {
        if (s.collider) { this.colShard.delete(s.collider.handle); this.world.removeCollider(s.collider, false); s.collider = null; }
        this._chunkDirty(s); this.strain.markDirty(s.region);
      }
      s.collider = null;
      s.state = DYNAMIC; s.body = rec; s.lp = lp; s.lq = lq;
      this.strain.shardState(id, DYNAMIC);
      rec.shards.push(id);
    });
    for (const r of st.regions) if (r.secondary) this.strain.markDirty(r.id);
    for (const [mid, list] of byMod) {
      const m = st.modules[mid];
      const whole = !m.fixed && list.length === m.shards.length && list.length > 1;
      if (whole) {
        // one box for the whole module: pose of the module centre through any of its fragments
        const s0 = st.shards[list[0]];
        const l = qRot(s0.lq, [m.center[0] - s0.c[0], m.center[1] - s0.c[1], m.center[2] - s0.c[2]]);
        const lp = [s0.lp[0] + l[0], s0.lp[1] + l[1], s0.lp[2] + l[2]], lq = s0.lq;
        const sameRot = list.every((sid) => qAngle(st.shards[sid].lq, lq) < 1e-3);
        if (sameRot) {
          const cd = R.ColliderDesc.cuboid(m.size[0] / 2 * 0.985, m.size[1] / 2 * 0.985, m.size[2] / 2 * 0.985).setTranslation(lp[0], lp[1], lp[2]).setRotation({ x: lq[0], y: lq[1], z: lq[2], w: lq[3] })
            .setDensity(M / Math.max(1e-6, vol)).setFriction(0.8).setRestitution(0.04).setCollisionGroups(small ? GROUPS.small : GROUPS.debris)
            .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(rec.thr);
          const col = this.world.createCollider(cd, rb);
          m.dynCol = { col, rec }; this.colShard.set(col.handle, -1 - m.id);
          continue;
        }
      }
      for (const sid of list) {
        const sh = st.shards[sid];
        const col = this.world.createCollider(this._dynDesc(sh, sh.lp, sh.lq, rec), rb);
        sh.collider = col; this.colShard.set(col.handle, sid);
      }
    }
    this._snap(rec); rec.prevP = rec.curP.slice(); rec.prevQ = rec.curQ.slice();
    this.bodies.set(rec.id, rec);
    this.events.push({ type: 'body+', body: rec });
    for (const id of ids) this._touchAtts(id);
    return rec;
  }
  _dropStatic(s) {
    const m = this.st.modules[s.mod];
    if (m.col) this._unsolidStatic(m);
    if (s.collider) { this.colShard.delete(s.collider.handle); this.world.removeCollider(s.collider, false); s.collider = null; }
    this._chunkDirty(s);
    this.strain.markDirty(s.region);
    for (const r of this.st.regions) if (r.secondary) this.strain.markDirty(r.id);
  }
  removeBody(rec, toPile = false) {
    if (!this.bodies.has(rec.id)) return;
    for (const att of rec.atts) { att.joints = []; att.rbA = att.rbB = null; att.active = false; }
    if (toPile) { const t = rec.rb.translation(); this.piles.add(t.x, t.z, rec.vol); }
    for (const id of rec.shards) { const m = this.st.modules[this.st.shards[id].mod]; if (m.dynCol && m.dynCol.rec === rec) { this.colShard.delete(m.dynCol.col.handle); m.dynCol = null; } }
    for (const id of rec.shards) {
      const s = this.st.shards[id];
      if (s.body !== rec) continue;
      if (s.collider) this.colShard.delete(s.collider.handle);
      s.collider = null; s.body = null; s.state = DEAD; this.strain.shardState(id, DEAD);
      for (const bid of s.bonds) { const b = this.st.bonds[bid]; if (!b.broken) { b.broken = true; this.strain.bondBroken(bid); } }
    }
    this.world.removeRigidBody(rec.rb);
    this.bodies.delete(rec.id);
    this.events.push({ type: 'body-', body: rec });
    const touched = new Set(); for (const att of rec.atts) touched.add(att);
    rec.atts.clear();
    for (const att of touched) this._refreshAtt(att);
  }
  _snap(rec) {
    const t = rec.rb.translation(), q = rec.rb.rotation();
    rec.curP = [t.x, t.y, t.z]; rec.curQ = [q.x, q.y, q.z, q.w];
  }

  // split a compound after bonds inside it broke
  _split(rec) {
    rec.split = false;
    const st = this.st;
    const alive = rec.shards.filter((id) => st.shards[id].body === rec && st.shards[id].state === DYNAMIC);
    if (!alive.length) { this.removeBody(rec); return; }
    const inBody = new Set(alive), seen = new Set(), comps = [];
    for (const s0 of alive) {
      if (seen.has(s0)) continue;
      const comp = [], stack = [s0]; seen.add(s0);
      while (stack.length) {
        const a = stack.pop(); comp.push(a);
        for (const bid of st.shards[a].bonds) {
          const b = st.bonds[bid]; if (b.broken) continue;
          const o = b.a === a ? b.b : b.a;
          if (inBody.has(o) && !seen.has(o)) { seen.add(o); stack.push(o); }
        }
      }
      comps.push(comp);
    }
    if (comps.length === 1) {
      if (alive.length !== rec.shards.length) { rec.shards = alive; rec.dirty = true; rec.mass = alive.reduce((m, id) => m + st.shards[id].mass, 0); rec.vol = alive.reduce((m, id) => m + st.shards[id].vol, 0); this.events.push({ type: 'body~', body: rec }); }
      return;
    }
    const rb = rec.rb, v = rb.linvel(), w = rb.angvel(), c = rb.worldCom(), q = rb.rotation();
    const Q = [q.x, q.y, q.z, q.w];
    const poses = new Map(alive.map((id) => [id, this.shardPose(st.shards[id])]));
    const atts = [...rec.atts];
    // detach from the old body without killing shards
    for (const att of rec.atts) { att.joints = []; att.rbA = att.rbB = null; att.active = false; }
    rec.atts.clear();
    for (const id of alive) { const m = st.modules[st.shards[id].mod]; if (m.dynCol && m.dynCol.rec === rec) { this.colShard.delete(m.dynCol.col.handle); m.dynCol = null; } }
    for (const id of alive) { const s = st.shards[id]; if (s.collider) this.colShard.delete(s.collider.handle); s.collider = null; s.state = -1; s.body = null; }
    this.world.removeRigidBody(rb); this.bodies.delete(rec.id);
    this.events.push({ type: 'body-', body: rec });
    for (const comp of comps) {
      const ps = comp.map((id) => poses.get(id));
      let M = 0, cx = 0, cy = 0, cz = 0;
      comp.forEach((id, i) => { const m = st.shards[id].mass; M += m; cx += m * ps[i].p[0]; cy += m * ps[i].p[1]; cz += m * ps[i].p[2]; });
      cx /= M; cy /= M; cz /= M;
      const r = [cx - c.x, cy - c.y, cz - c.z];
      const vc = [v.x + w.y * r[2] - w.z * r[1], v.y + w.z * r[0] - w.x * r[2], v.z + w.x * r[1] - w.y * r[0]];
      this.createBody(comp, { poses: ps, v: vc, w: [w.x, w.y, w.z], q: Q });
    }
    for (const att of atts) this._refreshAtt(att);
  }

  killShard(s, cause = 'blast') {
    if (s.state === DEAD) return;
    const pos = this.shardPos(s);
    if (s.state === STATIC) { this._dropStatic(s); }
    else if (s.state === DYNAMIC && s.body) {
      const rec = s.body;
      const m = this.st.modules[s.mod];
      if (m.dynCol && m.dynCol.rec === rec) this._unsolidDyn(m);
      if (s.collider) { this.colShard.delete(s.collider.handle); this.world.removeCollider(s.collider, true); }
      rec.split = true; rec.dirty = true;
    }
    s.state = DEAD; s.collider = null; s.body = null;
    this.strain.shardState(s.id, DEAD);
    for (const bid of s.bonds) { const b = this.st.bonds[bid]; if (!b.broken) { b.broken = true; this.strain.bondBroken(bid); } }
    this._touchAtts(s.id);
    this.events.push({ type: 'dust', p: pos, size: Math.cbrt(s.vol), glass: s.glass, color: s.def.core, mat: s.mat, cause });
  }

  // ------------------------------------------------------------------ gradual destruction: loose attachments
  _newAtt(o) {
    const st = this.st;
    const att = { id: this.atts.length, type: o.type, sideA: o.sideA, sideB: o.sideB, refA: o.refA, refB: o.refB, joints: [], rbA: null, rbB: null,
      active: false, broken: false, cap: o.cap, life: 1, bend: o.bend, length: o.length || 0, q0: null, load: 0, staticRef: -1, extSet: null };
    // store anchor points in the reference fragments' local frames, so they ride along with them
    const sa = st.shards[att.refA], sb = st.shards[att.refB];
    const pa = this.shardPose(sa), pb = this.shardPose(sb);
    att.locA = (o.ptsA || o.pts).map((p) => qRot(qConj(pa.q), sub(p, pa.p)));
    att.locB = (o.ptsB || o.pts).map((p) => qRot(qConj(pb.q), sub(p, pb.p)));
    this.atts.push(att);
    for (const id of att.sideA.concat(att.sideB)) { let set = this.shardAtts.get(id); if (!set) this.shardAtts.set(id, (set = new Set())); set.add(att); }
    this._refreshAtt(att);
    return att;
  }
  _touchAtts(id) { const set = this.shardAtts.get(id); if (set) for (const att of set) this._refreshAtt(att); }
  _pickRef(att, side, ref) {
    const st = this.st;
    const cur = st.shards[ref];
    if (cur && cur.state !== DEAD) return ref;
    const list = side === 0 ? att.sideA : att.sideB;
    const target = this.shardPos(cur);
    let best = -1, bd = Infinity;
    for (const id of list) { const s = st.shards[id]; if (s.state === DEAD) continue; const d = dist(this.shardPos(s), target); if (d < bd) { bd = d; best = id; } }
    return bd < 1.6 ? best : -1;
  }
  _refreshAtt(att) {
    if (att.broken) return;
    const st = this.st;
    const ra = this._pickRef(att, 0, att.refA), rb = this._pickRef(att, 1, att.refB);
    if (ra < 0 || rb < 0) { this._breakAtt(att); return; }
    if (ra !== att.refA) { const o = this.shardPose(st.shards[att.refA]); const n = this.shardPose(st.shards[ra]); att.locA = att.locA.map((l) => { const w = qRot(o.q, l); return qRot(qConj(n.q), [o.p[0] + w[0] - n.p[0], o.p[1] + w[1] - n.p[1], o.p[2] + w[2] - n.p[2]]); }); att.refA = ra; }
    if (rb !== att.refB) { const o = this.shardPose(st.shards[att.refB]); const n = this.shardPose(st.shards[rb]); att.locB = att.locB.map((l) => { const w = qRot(o.q, l); return qRot(qConj(n.q), [o.p[0] + w[0] - n.p[0], o.p[1] + w[1] - n.p[1], o.p[2] + w[2] - n.p[2]]); }); att.refB = rb; }
    const sA = st.shards[ra], sB = st.shards[rb];
    const bodyA = this._rbOf(sA), bodyB = this._rbOf(sB);
    const dynA = sA.state === DYNAMIC, dynB = sB.state === DYNAMIC;
    if (!bodyA || !bodyB || (!dynA && !dynB) || bodyA === bodyB) { this._dropJoints(att); return; }
    if (att.active && att.rbA === bodyA && att.rbB === bodyB) return;
    this._dropJoints(att);
    const R = this.R;
    const pa = this.shardPose(sA), pb = this.shardPose(sB);
    const tA = bodyA.translation(), qA = bodyA.rotation(), tB = bodyB.translation(), qB = bodyB.rotation();
    const QA = [qA.x, qA.y, qA.z, qA.w], QB = [qB.x, qB.y, qB.z, qB.w];
    const toLocal = (T, Q, p) => qRot(qConj(Q), [p[0] - T.x, p[1] - T.y, p[2] - T.z]);
    for (let i = 0; i < att.locA.length; i++) {
      const wa = qRot(pa.q, att.locA[i]); const PA = [pa.p[0] + wa[0], pa.p[1] + wa[1], pa.p[2] + wa[2]];
      let PB = PA;
      if (att.type === 'rope') { const wb = qRot(pb.q, att.locB[i]); PB = [pb.p[0] + wb[0], pb.p[1] + wb[1], pb.p[2] + wb[2]]; }
      const a1 = toLocal(tA, QA, PA), a2 = toLocal(tB, QB, PB);
      const jd = att.type === 'rope'
        ? R.JointData.rope(att.length, { x: a1[0], y: a1[1], z: a1[2] }, { x: a2[0], y: a2[1], z: a2[2] })
        : R.JointData.spherical({ x: a1[0], y: a1[1], z: a1[2] }, { x: a2[0], y: a2[1], z: a2[2] });
      const j = this.world.createImpulseJoint(jd, bodyA, bodyB, true);
      if (att.type !== 'rope') j.setContactsEnabled(false);
      att.joints.push({ j, a1, a2 });
    }
    att.rbA = bodyA; att.rbB = bodyB; att.active = true;
    att.q0 = qMul(qConj(QA), QB);
    if (dynA) sA.body.atts.add(att);
    if (dynB) sB.body.atts.add(att);
    this.events.push({ type: 'att+', att });
  }
  _dropJoints(att) {
    if (att.active) for (const { j } of att.joints) { try { if (this.world.getImpulseJoint(j.handle)) this.world.removeImpulseJoint(j, true); } catch (e) { /* already gone */ } }
    for (const id of [att.refA, att.refB]) { const s = this.st.shards[id]; if (s && s.body) s.body.atts.delete(att); }
    att.joints = []; att.active = false; att.rbA = att.rbB = null;
    this._clearExt(att);
  }
  _breakAtt(att) {
    if (att.broken) return;
    this._dropJoints(att);
    att.broken = true;
    for (const id of att.sideA.concat(att.sideB)) { const set = this.shardAtts.get(id); if (set) set.delete(att); }
    const s = this.st.shards[att.refA];
    if (s) this.events.push({ type: 'snap', p: this.shardPos(s), rope: att.type === 'rope' });
  }
  _clearExt(att) {
    if (att.staticRef >= 0) {
      const s = this.st.shards[att.staticRef];
      if (s.extF) { s.extF[1] -= att.extSet || 0; if (Math.abs(s.extF[1]) < 1e-3) s.extF = null; this.strain.extForce(s.id, s.extF); if (s.state === STATIC) this.strain.markDirty(s.region); }
      att.staticRef = -1; att.extSet = null;
    }
  }
  _updateAtts(dt) {
    const st = this.st;
    for (const att of this.atts) {
      if (!att.active || att.broken) continue;
      const sA = st.shards[att.refA], sB = st.shards[att.refB];
      const recA = sA.state === DYNAMIC ? sA.body : null, recB = sB.state === DYNAMIC ? sB.body : null;
      if (!recA && !recB) continue;
      const q1 = att.rbA.rotation(), q2 = att.rbB.rotation();
      const rel = qMul(qConj([q1.x, q1.y, q1.z, q1.w]), [q2.x, q2.y, q2.z, q2.w]);
      const bend = att.type === 'rope' ? 0 : qAngle(att.q0, rel);
      // load: the lighter dynamic side hangs from this attachment
      const rec = recA && recB ? (recA.mass < recB.mass ? recA : recB) : recA || recB;
      const n = Math.max(1, [...rec.atts].reduce((k, a) => k + (a.active ? a.joints.length : 0), 0));
      const lv = rec.rb.linvel(); const v2 = lv.x * lv.x + lv.y * lv.y + lv.z * lv.z;
      const load = (rec.rb.mass() * 9.81 / 1000) / n * (1 + v2 / (9.81 * 1.5)) * att.joints.length;
      att.load = load; att.bendNow = bend;
      const u = load / att.cap;
      att.life -= dt * (Math.max(0, u - 0.55) * 0.9 + 0.012 * u + (bend / att.bend) ** 2 * 0.25);
      // static side carries the hanging weight -> feed it back into Strain as an external load.
      // Only for quasi-static hanging (a falling chunk snaps its attachment instead) and never above capacity.
      const stat = !recA ? sA : !recB ? sB : null;
      if (stat && stat.state === STATIC && (this.tick % 15 === 0)) {
        const calm = v2 < 0.25 && u < 1.2;
        const want = calm ? -Math.min(att.cap, (rec.rb.mass() * 9.81 / 1000) / n * att.joints.length) : 0;
        if (att.staticRef !== stat.id || Math.abs((att.extSet || 0) - want) > 0.25 * Math.abs(want) + 0.5) {
          this._clearExt(att);
          if (want !== 0) {
            stat.extF = stat.extF || [0, 0, 0]; stat.extF[1] += want; att.extSet = want; att.staticRef = stat.id;
            this.strain.extForce(stat.id, stat.extF); this.strain.markDirty(stat.region);
          }
        }
      }
      if (att.life <= 0 || bend > att.bend) this._breakAtt(att);
    }
  }

  // ------------------------------------------------------------------ Strain results -> breaks / detach
  _applyStrain(res) {
    const st = this.st;
    this.regionViz[res.region] = res.viz;
    this.regionStats[res.region] = { ms: res.ms, nodes: res.nodes, conns: res.conns, nnz: res.nnz, maxU: res.maxU, epoch: res.epoch };
    this.stats.solves++; this.stats.lastSolveMs = res.ms; this.stats.solveMs = this.stats.solveMs * 0.8 + res.ms * 0.2; this.stats.nnz = res.nnz;
    this.events.push({ type: 'strain', region: res.region });
    // unsupported fragments fall (monotonic: unsupported stays unsupported, stale results are still valid)
    const det = [];
    for (const id of res.detached) if (st.shards[id].state === STATIC) det.push(id);
    if (det.length) this._detach(det);
    if (res.epoch !== this.strain.epoch[res.region]) return; // breaks only from a fresh solve
    for (const br of res.breaks) {
      if (this.breakKeys.has(br.key)) continue;
      this.breakKeys.add(br.key);
      const over = br.U / br.thr;
      const delay = 0.04 + this.rng() * 0.45 * Math.max(0, Math.min(1, 1.7 - over));
      this.breakQueue.push({ t: this.time + delay, br });
      this.events.push({ type: 'creak', p: br.p, k: Math.min(1, over - 0.9) });
    }
  }
  _processBreaks() {
    const st = this.st;
    for (let i = this.breakQueue.length - 1; i >= 0; i--) {
      const it = this.breakQueue[i];
      if (it.t > this.time) continue;
      this.breakQueue.splice(i, 1); this.breakKeys.delete(it.br.key);
      const br = it.br;
      let any = false; const sideA = new Set(), sideB = new Set();
      for (const bid of br.bonds) {
        const b = st.bonds[bid]; if (b.broken) continue;
        const sa = st.shards[b.a], sb = st.shards[b.b];
        if (sa.state !== STATIC && !sa.fixed) continue; if (sb.state !== STATIC && !sb.fixed) continue;
        b.broken = true; this.strain.bondBroken(bid); any = true;
        const aIsA = sa.mod === br.ma;
        (aIsA ? sideA : sideB).add(b.a); (aIsA ? sideB : sideA).add(b.b);
        this.strain.markDirty(sa.region); if (sb.region !== sa.region) this.strain.markDirty(sb.region);
      }
      if (!any) continue;
      this.stats.breaks++;
      this.events.push({ type: 'break', p: br.p, k: br.area });
      if (br.duct > 0.05 && sideA.size && sideB.size) {
        const hinge = br.h1 > 2.2 * br.h2 && br.h1 > 0.6;
        const pts = hinge ? [[br.p[0] + br.e1[0] * br.h1 * 0.6, br.p[1] + br.e1[1] * br.h1 * 0.6, br.p[2] + br.e1[2] * br.h1 * 0.6], [br.p[0] - br.e1[0] * br.h1 * 0.6, br.p[1] - br.e1[1] * br.h1 * 0.6, br.p[2] - br.e1[2] * br.h1 * 0.6]] : [br.p];
        const A = [...sideA], B = [...sideB];
        const near = (list, p) => list.reduce((best, id) => (dist(st.shards[id].c, p) < dist(st.shards[best].c, p) ? id : best), list[0]);
        const cap = br.duct * 0.12 * br.cap * (0.6 + this.rng() * 0.8);
        // gather the whole module side so the attachment survives the loss of the touching fragment
        const fullA = st.modules[br.ma].shards.slice(), fullB = br.mb >= 0 ? st.modules[br.mb].shards.slice() : B;
        this._newAtt({ type: hinge ? 'hinge' : 'ball', sideA: fullA, sideB: fullB, pts, refA: near(A, br.p), refB: near(B, br.p), cap: Math.max(2, cap), bend: (35 + 55 * br.duct) * Math.PI / 180 });
      }
    }
  }
  _detach(ids) {
    const st = this.st;
    const set = new Set(ids), seen = new Set();
    for (const s0 of ids) {
      if (seen.has(s0)) continue;
      const comp = [], stack = [s0]; seen.add(s0);
      while (stack.length) {
        const a = stack.pop(); comp.push(a);
        for (const bid of st.shards[a].bonds) {
          const b = st.bonds[bid]; if (b.broken) continue;
          const o = b.a === a ? b.b : b.a;
          if (set.has(o) && !seen.has(o)) { seen.add(o); stack.push(o); }
        }
      }
      this.stats.detached += comp.length;
      this.createBody(comp, { v: [0, -0.2, 0] });
    }
  }

  // ------------------------------------------------------------------ damage
  explode(p, R, P, o = {}) {
    const st = this.st;
    const push = o.push ?? 1;
    this.events.push({ type: 'boom', p, R, P, kind: o.kind || 'rpg' });
    const kill = [], eject = [], dent = [];
    const touched = new Set();
    for (const s of st.shards) {
      if (s.state !== STATIC || s.fixed) continue;
      const dx = s.c[0] - p[0], dy = s.c[1] - p[1], dz = s.c[2] - p[2];
      if (Math.abs(dx) > R + 2 || Math.abs(dy) > R + 2 || Math.abs(dz) > R + 2) continue;
      const d = Math.max(0, Math.hypot(dx, dy, dz) - s.r * 0.6);
      if (d >= R) continue;
      const f = Math.pow(1 - d / R, 1.25);
      s.dmg += P * f * (s.glass ? 40 : 1);
      touched.add(s.region);
      this.strain.shardDmg(s.id, s.dmg);
      if (s.dmg >= s.hp) { if (d < R * 0.36 || s.vol < 0.012 || s.glass) kill.push(s); else eject.push([s, d]); }
      else if (s.dmg > 0.45 * s.hp && s.def.duct > 0.3 && d > R * 0.4) dent.push(s);
    }
    eject.sort((a, b) => a[1] - b[1]);
    const room = Math.max(0, this.maxBodies - this.bodies.size);
    const maxEject = Math.min(o.maxEject ?? 30, room);
    for (let i = maxEject; i < eject.length; i++) kill.push(eject[i][0]);
    for (const s of kill) this.killShard(s, o.kind || 'blast');
    for (let i = 0; i < Math.min(maxEject, eject.length); i++) {
      const [s, d] = eject[i];
      const dir = norm([s.c[0] - p[0], s.c[1] - p[1] + 0.15, s.c[2] - p[2]]);
      const sp = (2.5 + 11 * (1 - d / R)) * push * (0.75 + this.rng() * 0.5);
      this.createBody([s.id], { v: [dir[0] * sp, dir[1] * sp + 1.5, dir[2] * sp], w: [(this.rng() - 0.5) * 9, (this.rng() - 0.5) * 9, (this.rng() - 0.5) * 9], ccd: true });
    }
    // BLAST WAVE: dent - damaged fragments in the outer ring bend out but stay hinged to the wall
    let dents = 0;
    for (const s of dent) {
      if (dents >= (o.maxDents ?? 8) || s.state !== STATIC) continue;
      const nbr = [];
      for (const bid of s.bonds) { const b = st.bonds[bid]; if (b.broken) continue; const ot = b.a === s.id ? b.b : b.a; const so = st.shards[ot]; if (so.state === STATIC && !so.glass) nbr.push([ot, b]); }
      if (!nbr.length) continue;
      nbr.sort((a, b) => b[1].area - a[1].area);
      for (const [, b] of nbr) { b.broken = true; this.strain.bondBroken(b.id); }
      for (const bid of s.bonds) { const b = st.bonds[bid]; if (!b.broken) { b.broken = true; this.strain.bondBroken(bid); } }
      const dir = norm([s.c[0] - p[0], s.c[1] - p[1], s.c[2] - p[2]]);
      const rec = this.createBody([s.id], { v: [dir[0] * 3 * push, dir[1] * 3 * push, dir[2] * 3 * push] });
      const [ot, b] = nbr[0];
      this._newAtt({ type: 'ball', sideA: [ot], sideB: [s.id], pts: [b.p], refA: ot, refB: s.id, cap: 2.5 + s.mass * 0.012, bend: 1.1 });
      dents++;
      void rec;
    }
    // dynamic debris: impulse + cracking
    const reach = R * 1.9;
    for (const rec of [...this.bodies.values()]) {
      if (!this.bodies.has(rec.id)) continue;
      const t = rec.rb.translation();
      const d = Math.hypot(t.x - p[0], t.y - p[1], t.z - p[2]);
      if (d > reach) continue;
      const f = 1 - d / reach;
      const dir = norm([t.x - p[0], t.y - p[1] + 0.3, t.z - p[2]]);
      const J = Math.min(rec.mass * 16, rec.mass * (5 + 5 * P) * f) * push;
      rec.rb.applyImpulseAtPoint({ x: dir[0] * J, y: dir[1] * J, z: dir[2] * J }, { x: t.x + (this.rng() - 0.5) * 0.4, y: t.y + (this.rng() - 0.5) * 0.4, z: t.z + (this.rng() - 0.5) * 0.4 }, true);
      if (d < R) {
        for (const id of rec.shards) {
          const s = st.shards[id]; if (s.body !== rec) continue;
          const sp = this.shardPos(s);
          const dd = Math.max(0, dist(sp, p) - s.r * 0.6); if (dd >= R) continue;
          const ff = Math.pow(1 - dd / R, 1.25);
          s.dmg += P * ff;
          if (s.dmg >= s.hp && dd < R * 0.4) { this.killShard(s, 'blast'); continue; }
          for (const bid of s.bonds) { const b = st.bonds[bid]; if (!b.broken) { b.dmg += P * ff * 0.9; if (b.dmg >= 1) { b.broken = true; this.strain.bondBroken(bid); rec.split = true; } } }
        }
      }
    }
    for (const pr of this.props) {
      if (pr.type !== 'canister' || !pr.alive) continue;
      const t = pr.rb.translation();
      const d = Math.hypot(t.x - p[0], t.y - p[1], t.z - p[2]);
      if (d < R * 1.15) this._igniteCanister(pr, 0.1 + this.rng() * 0.2);
      else if (d < R * 2.2) { const dir = norm([t.x - p[0], t.y - p[1] + 0.5, t.z - p[2]]); const J = 260 * (1 - d / (R * 2.2)) * push; pr.rb.applyImpulse({ x: dir[0] * J, y: dir[1] * J, z: dir[2] * J }, true); }
    }
    for (const att of this.atts) {
      if (att.broken) continue;
      const s = st.shards[att.refA]; if (!s || s.state === DEAD) continue;
      const d = dist(this.shardPos(s), p);
      if (d < R * 1.2) att.life -= (1 - d / (R * 1.2)) * (att.type === 'rope' ? 0.9 : 1.6) * P;
      if (att.life <= 0) this._breakAtt(att);
    }
    for (const r of touched) this.strain.markDirty(r);
  }

  _igniteCanister(pr, delay) {
    if (!pr.alive || pr.lit) return;
    pr.lit = true;
    this.delayed.push({ t: this.time + delay, fn: () => {
      if (!pr.alive) return;
      const t = pr.rb.translation();
      pr.alive = false; this.colProp.delete(pr.col.handle); this.world.removeRigidBody(pr.rb);
      this.events.push({ type: 'prop-', prop: pr });
      this.explode([t.x, t.y, t.z], 3.6, 2.4, { kind: 'canister', push: 1.1 });
    } });
  }

  // a sphere of damage (sledgehammer, charge'n'slam)
  smash(p, dir, R, P) {
    const st = this.st;
    const hit = [];
    for (const s of st.shards) {
      if (s.state !== STATIC || s.fixed) continue;
      const d = Math.max(0, dist(s.c, p) - s.r * 0.5); if (d >= R) continue;
      const f = 1 - d / R;
      s.dmg += P * f * (s.glass ? 40 : 1); this.strain.shardDmg(s.id, s.dmg); this.strain.markDirty(s.region);
      if (s.dmg >= s.hp) hit.push(s);
    }
    for (const s of hit) {
      if (s.vol < 0.03 || s.glass || this.bodies.size > this.maxBodies) this.killShard(s, 'smash');
      else this.createBody([s.id], { v: [dir[0] * 5 + (this.rng() - 0.5) * 2, dir[1] * 5 + 1, dir[2] * 5 + (this.rng() - 0.5) * 2], w: [(this.rng() - 0.5) * 6, (this.rng() - 0.5) * 6, (this.rng() - 0.5) * 6], ccd: true });
    }
    for (const rec of [...this.bodies.values()]) {
      const t = rec.rb.translation(); const d = Math.hypot(t.x - p[0], t.y - p[1], t.z - p[2]);
      if (d > R * 2) continue;
      const J = Math.min(rec.mass * 9, 900 * P) * (1 - d / (R * 2));
      rec.rb.applyImpulse({ x: dir[0] * J, y: dir[1] * J + J * 0.2, z: dir[2] * J }, true);
      for (const id of rec.shards) { const s = st.shards[id]; if (s.body !== rec) continue; if (dist(this.shardPos(s), p) < R) for (const bid of s.bonds) { const b = st.bonds[bid]; if (!b.broken) { b.dmg += P * 0.8; if (b.dmg >= 1) { b.broken = true; rec.split = true; } } } }
    }
    for (const pr of this.props) if (pr.type === 'canister' && pr.alive) { const t = pr.rb.translation(); if (Math.hypot(t.x - p[0], t.y - p[1], t.z - p[2]) < R + 0.4) { pr.rb.applyImpulse({ x: dir[0] * 300, y: 120, z: dir[2] * 300 }, true); } }
    this.events.push({ type: 'smash', p, n: hit.length });
    return hit.length;
  }

  raycast(o, d, maxDist = 300, exclude = null) {
    const R = this.R;
    const hit = this.world.castRayAndGetNormal(new R.Ray({ x: o[0], y: o[1], z: o[2] }, { x: d[0], y: d[1], z: d[2] }), maxDist, true, undefined, GROUPS.query, exclude || undefined);
    if (!hit) return null;
    const p = [o[0] + d[0] * hit.toi, o[1] + d[1] * hit.toi, o[2] + d[2] * hit.toi];
    const n = [hit.normal.x, hit.normal.y, hit.normal.z];
    const sid = this.resolveShard(hit.collider.handle, [p[0] - n[0] * 0.03, p[1] - n[1] * 0.03, p[2] - n[2] * 0.03]);
    const prop = this.colProp.get(hit.collider.handle);
    return { p, n, t: hit.toi, shard: sid, prop: prop || null, collider: hit.collider };
  }

  bullet(o, d, exclude) {
    const h = this.raycast(o, d, 250, exclude);
    if (!h) return null;
    if (h.shard >= 0) {
      const s = this.st.shards[h.shard];
      if (s.state === STATIC && !s.fixed) {
        if (s.glass) { for (const id of this.st.modules[s.mod].shards) { const g = this.st.shards[id]; if (g.state === STATIC) this.killShard(g, 'glass'); } }
        else if (s.def.bullet > 0) { s.dmg += s.def.bullet; this.strain.shardDmg(s.id, s.dmg); if (s.dmg >= s.hp) { this.killShard(s, 'bullet'); } else if (this.tick % 6 === 0) this.strain.markDirty(s.region); }
      } else if (s.state === DYNAMIC && s.body) {
        s.body.rb.applyImpulseAtPoint({ x: d[0] * 60, y: d[1] * 60, z: d[2] * 60 }, { x: h.p[0], y: h.p[1], z: h.p[2] }, true);
        if (s.glass) this.killShard(s, 'glass');
      }
    } else if (h.prop && h.prop.type === 'canister') {
      h.prop.hp -= 0.26; h.prop.rb.applyImpulseAtPoint({ x: d[0] * 40, y: d[1] * 40, z: d[2] * 40 }, { x: h.p[0], y: h.p[1], z: h.p[2] }, true);
      if (h.prop.hp <= 0) this._igniteCanister(h.prop, 0.05);
    } else if (h.prop && h.prop.type === 'ball') {
      h.prop.rb.applyImpulseAtPoint({ x: d[0] * 400, y: d[1] * 400, z: d[2] * 400 }, { x: h.p[0], y: h.p[1], z: h.p[2] }, true);
    }
    this.events.push({ type: 'hit', p: h.p, n: h.n, mat: h.shard >= 0 ? this.st.shards[h.shard].mat : 'ground' });
    return h;
  }

  spawnProjectile(kind, p, v, o = {}) {
    const pr = { kind, p: p.slice(), v: v.slice(), age: 0, fuse: o.fuse ?? 99, g: o.g ?? 9.81, stuck: null, alive: true, exclude: o.exclude || null, id: Math.random() };
    this.projectiles.push(pr);
    this.events.push({ type: 'proj+', proj: pr });
    return pr;
  }
  detonateC4() {
    let n = 0;
    for (const pr of this.projectiles) if (pr.kind === 'c4' && pr.alive) { pr.fuse = Math.min(pr.fuse, pr.age + 0.04 + n * 0.08); n++; }
    return n;
  }
  spawnBall(p, v) {
    const R = this.R;
    const rb = this.world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(p[0], p[1], p[2]).setLinvel(v[0], v[1], v[2]).setCcdEnabled(true).setCanSleep(true));
    const col = this.world.createCollider(R.ColliderDesc.ball(1.1).setDensity(5200).setFriction(0.6).setRestitution(0.1).setCollisionGroups(GROUPS.prop)
      .setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(20000), rb);
    const pr = { type: 'ball', rb, col, alive: true, age: 0, id: this.props.length };
    this.colProp.set(col.handle, pr); this.props.push(pr);
    this.events.push({ type: 'prop+', prop: pr });
    return pr;
  }

  _updateProjectiles(dt) {
    for (const pr of this.projectiles) {
      if (!pr.alive) continue;
      pr.age += dt;
      if (pr.stuck) {
        const s = this.st.shards[pr.stuck.shard];
        if (!s || s.state === DEAD) { pr.stuck = null; pr.v = [0, 0, 0]; }
        else { const ps = this.shardPose(s); const w = qRot(ps.q, pr.stuck.local); pr.p = [ps.p[0] + w[0], ps.p[1] + w[1], ps.p[2] + w[2]]; }
      } else {
        pr.v[1] -= pr.g * dt;
        const step = [pr.v[0] * dt, pr.v[1] * dt, pr.v[2] * dt];
        const L = Math.hypot(step[0], step[1], step[2]);
        if (L > 1e-6) {
          const d = [step[0] / L, step[1] / L, step[2] / L];
          const h = this.raycast(pr.p, d, L + 0.05, pr.exclude);
          if (h) {
            if (pr.kind === 'rpg' || pr.kind === 'meteor') { this._detonate(pr, [h.p[0] - d[0] * 0.08, h.p[1] - d[1] * 0.08, h.p[2] - d[2] * 0.08]); continue; }
            if (pr.kind === 'c4' && h.shard >= 0) {
              const s = this.st.shards[h.shard]; const ps = this.shardPose(s);
              pr.p = [h.p[0] + h.n[0] * 0.06, h.p[1] + h.n[1] * 0.06, h.p[2] + h.n[2] * 0.06];
              pr.stuck = { shard: h.shard, local: qRot(qConj(ps.q), sub(pr.p, ps.p)) }; pr.v = [0, 0, 0];
              this.events.push({ type: 'stick', p: pr.p });
              continue;
            }
            // bounce (grenades, C4 on ground)
            const n = h.n; const vn = pr.v[0] * n[0] + pr.v[1] * n[1] + pr.v[2] * n[2];
            pr.v = [(pr.v[0] - 2 * vn * n[0]) * 0.45, (pr.v[1] - 2 * vn * n[1]) * 0.45, (pr.v[2] - 2 * vn * n[2]) * 0.45];
            pr.p = [h.p[0] + n[0] * 0.05, h.p[1] + n[1] * 0.05, h.p[2] + n[2] * 0.05];
            if (Math.abs(vn) > 2) this.events.push({ type: 'bounce', p: pr.p });
            if (pr.kind === 'c4' && Math.hypot(pr.v[0], pr.v[1], pr.v[2]) < 1) pr.v = [0, 0, 0];
          } else { pr.p[0] += step[0]; pr.p[1] += step[1]; pr.p[2] += step[2]; }
        }
        if (pr.p[1] < -30) pr.alive = false;
      }
      if (pr.age >= pr.fuse) this._detonate(pr, pr.p);
      if (pr.kind === 'rpg' && pr.age > 6) this._detonate(pr, pr.p);
    }
    this.projectiles = this.projectiles.filter((p) => p.alive);
  }
  _detonate(pr, p) {
    if (!pr.alive) return;
    pr.alive = false;
    this.events.push({ type: 'proj-', proj: pr });
    const W = { rpg: [3.0, 3.1, 1.0], grenade: [2.7, 1.9, 1.0], c4: [4.4, 4.6, 1.25], meteor: [6.5, 6.0, 1.7] }[pr.kind] || [3, 3, 1];
    this.explode(p, W[0], W[1], { kind: pr.kind, push: W[2] });
  }

  // ------------------------------------------------------------------ impacts (debris -> world)
  _impacts(dt) {
    const st = this.st;
    const list = [];
    this.eq.drainContactForceEvents((e) => { const f = e.totalForceMagnitude(); if (f > 3000) list.push([e.collider1(), e.collider2(), f]); });
    if (!list.length) return;
    list.sort((a, b) => b[2] - a[2]);
    const n = Math.min(list.length, 40);
    for (let i = 0; i < n; i++) {
      const [h1, h2, f] = list[i];
      let cp = null;
      if ((this.colShard.get(h1) ?? 0) < 0 || (this.colShard.get(h2) ?? 0) < 0) {
        const c1 = this.world.getCollider(h1), c2 = this.world.getCollider(h2);
        if (c1 && c2) this.world.contactPair(c1, c2, (man) => { if (!cp && man.numSolverContacts() > 0) { const q = man.solverContactPoint(0); cp = [q.x, q.y, q.z]; } });
      }
      const r1 = this.resolveShard(h1, cp), r2 = this.resolveShard(h2, cp);
      const s1 = r1 >= 0 ? r1 : undefined, s2 = r2 >= 0 ? r2 : undefined;
      const p1 = this.colProp.get(h1), p2 = this.colProp.get(h2);
      const A = s1 !== undefined ? st.shards[s1] : null, B = s2 !== undefined ? st.shards[s2] : null;
      const J = f * dt; // N*s
      this.stats.impacts++;
      for (const pr of [p1, p2]) {
        if (pr && pr.type === 'canister' && pr.alive && J > 1400) this._igniteCanister(pr, 0.05);
      }
      const ball = (p1 && p1.type === 'ball') || (p2 && p2.type === 'ball');
      const dyn = [A, B].filter((s) => s && s.state === DYNAMIC);
      const stat = [A, B].filter((s) => s && s.state === STATIC && !s.fixed);
      // weight of whoever is falling: resting contacts do not count
      let rest = 0; for (const s of dyn) rest = Math.max(rest, s.body.mass * 9.81 * dt * 2.2);
      const Je = J - rest;
      if (Je < 350) continue;
      for (const s of stat) this._hitStatic(s, Je * (ball ? 1.4 : 1));
      for (const s of dyn) this._crack(s, Je / dyn.length);
      const pos = (dyn[0] && this.shardPos(dyn[0])) || (stat[0] && stat[0].c) || null;
      if (pos && Je > 900) this.events.push({ type: 'impact', p: pos, J: Je, mat: (dyn[0] || stat[0]).mat });
    }
  }
  _hitStatic(s, J) {
    const d = J / (s.def.impactRes * 1000);
    if (d < 0.02) return;
    s.dmg += d; this.strain.shardDmg(s.id, s.dmg);
    for (const bid of s.bonds) { const b = this.st.bonds[bid]; if (b.broken) continue; const o = this.st.shards[b.a === s.id ? b.b : b.a]; if (o.state === STATIC && !o.fixed) { o.dmg += d * 0.3; this.strain.shardDmg(o.id, o.dmg); if (o.dmg >= o.hp) this.killShard(o, 'impact'); } }
    if (s.dmg >= s.hp) {
      if (s.vol > 0.05 && this.bodies.size < this.maxBodies) this.createBody([s.id], { v: [0, -1.5, 0] });
      else this.killShard(s, 'impact');
    }
    if (d > 0.12) this.strain.markDirty(s.region);
  }
  _crack(s, J) {
    const rec = s.body; if (!rec) return;
    if (J / s.mass > 18 && s.vol < 0.04) { this.killShard(s, 'impact'); return; }
    for (const bid of s.bonds) {
      const b = this.st.bonds[bid]; if (b.broken) continue;
      const o = this.st.shards[b.a === s.id ? b.b : b.a]; if (o.body !== rec) continue;
      b.dmg += J / (b.area * s.def.bondImpact * 1000);
      if (b.dmg >= 1) { b.broken = true; rec.split = true; }
    }
  }

  // ------------------------------------------------------------------ main step
  step(dt = DT) {
    this.time += dt; this.tick++;
    for (let i = this.delayed.length - 1; i >= 0; i--) if (this.delayed[i].t <= this.time) { const d = this.delayed[i]; this.delayed.splice(i, 1); d.fn(); }
    this._updateProjectiles(dt);
    for (const res of this.strain.poll(5)) this._applyStrain(res);
    this._processBreaks();
    for (const rec of this.bodies.values()) { rec.prevP = rec.curP; rec.prevQ = rec.curQ; }
    this.world.step(this.eq);
    for (const rec of this.bodies.values()) this._snap(rec);
    this._impacts(dt);
    for (const rec of [...this.bodies.values()]) if (rec.split && this.bodies.has(rec.id)) this._split(rec);
    this._updateAtts(dt);
    if (this.tick % 12 === 0) this._checkRamps();
    this._lifecycle(dt);
    this.piles.update(this.time);
    this._net(dt);
    this.strain.flush();
  }

  _lifecycle(dt) {
    const over = this.bodies.size - this.maxBodies;
    let culled = 0;
    for (const rec of [...this.bodies.values()]) {
      rec.age += dt;
      const sleeping = rec.rb.isSleeping();
      rec.sleep = sleeping ? rec.sleep + dt : 0;
      const t = rec.curP;
      if (t[1] < -25) { this.removeBody(rec); continue; }
      const anchored = rec.atts.size > 0;
      if (rec.glass && rec.age > 3.5) { this.removeBody(rec); continue; }
      if (!anchored && rec.vol < 0.09 && (rec.sleep > 2.0 || rec.age > 16)) { this.removeBody(rec, true); continue; }
      if (!anchored && rec.vol < 0.6 && rec.sleep > 30) { this.removeBody(rec, true); continue; }
      if (over > 0 && culled < over && !anchored && rec.vol < 0.4 && rec.age > 1.5) { this.removeBody(rec, true); culled++; }
    }
    for (const pr of this.props) {
      if (pr.type === 'ball' && pr.alive) { pr.age += dt; const t = pr.rb.translation(); if (pr.age > 25 || t.y < -20) { pr.alive = false; this.colProp.delete(pr.col.handle); this.world.removeRigidBody(pr.rb); this.events.push({ type: 'prop-', prop: pr }); } }
      if (pr.type === 'canister' && pr.alive) { const t = pr.rb.translation(); if (t.y < -20) { pr.alive = false; this.colProp.delete(pr.col.handle); this.world.removeRigidBody(pr.rb); this.events.push({ type: 'prop-', prop: pr }); } }
    }
    this.props = this.props.filter((p) => p.alive);
  }

  // Replication estimate (THE FINALS GDC'24: ~400 -> ~175 kbit/s by quantising transforms inside a bounded
  // range and sending snapshot deltas). We do the same bookkeeping for a 30 Hz server tick.
  _net(dt) {
    this.net.acc += dt;
    if (this.net.acc < 1 / 30) return;
    this.net.acc = 0;
    let naive = 0, comp = 0;
    const prev = this.net.prev, next = new Map();
    for (const rec of this.bodies.values()) {
      if (rec.rb.isSleeping()) { next.set(rec.id, prev.get(rec.id)); continue; }
      const p = rec.curP, q = rec.curQ;
      const qp = [Math.round((p[0] + 64) * 512), Math.round((p[1] + 16) * 512), Math.round((p[2] + 64) * 512)];
      const qq = [Math.round(q[0] * 511), Math.round(q[1] * 511), Math.round(q[2] * 511)];
      const key = qp.join(',') + '|' + qq.join(',');
      naive += 2 + 12 + 16;
      if (prev.get(rec.id) !== key) comp += 2 + 6 + 4;
      next.set(rec.id, key);
    }
    this.net.prev = next;
    const k = 30 * 8 / 1000; // bytes/tick -> kbit/s
    this.stats.netNaive = this.stats.netNaive * 0.85 + naive * k * 0.15;
    this.stats.netComp = this.stats.netComp * 0.85 + comp * k * 0.15;
  }

  dispose() { this.strain.dispose(); try { this.world.free(); } catch (e) { /* noop */ } }
}
