// First-person contestant: kinematic character controller (walk, sprint, double jump, jump pads), ladders,
// ziplines, or noclip fly. Input comes from the keyboard and/or the touch stick (input.move = [x, forward]).
import { GROUPS } from '../sim/sim.js';
import { STATIC } from '../core/structure.js';

const RIDE = 11.5, CLIMB = 4.2, HANG = 1.23; // m/s along a zipline, ladder climb speed, cable -> capsule centre

export class Player {
  constructor(sim, spawn, look) {
    this.sim = sim; const R = sim.R;
    this.pos = spawn.slice(); this.vel = [0, 0, 0];
    const dx = look[0] - spawn[0], dz = look[2] - spawn[2], dy = look[1] - spawn[1];
    this.yaw = Math.atan2(-dx, -dz); this.pitch = Math.atan2(dy, Math.hypot(dx, dz)) * 0.6;
    this.fly = false; this.grounded = false; this.jumps = 0; this.eye = 0.68;
    this.body = sim.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn[0], spawn[1], spawn[2]));
    this.collider = sim.world.createCollider(R.ColliderDesc.capsule(0.55, 0.35).setCollisionGroups(GROUPS.player), this.body);
    this.cc = sim.world.createCharacterController(0.03);
    this.cc.setUp({ x: 0, y: 1, z: 0 });
    this.cc.enableAutostep(0.45, 0.2, true);
    this.cc.enableSnapToGround(0.35);
    this.cc.setMaxSlopeClimbAngle((55 * Math.PI) / 180);
    this.cc.setMinSlopeSlideAngle((65 * Math.PI) / 180);
    this.cc.setApplyImpulsesToDynamicBodies(true);
    this.cc.setCharacterMass(90);
    this.charge = null; this.padCooldown = 0; this.stepAcc = 0; this.zip = null; this.ladder = null; this.near = null;
    // traversal anchors: a zipline / ladder dies with the fragment it is bolted to
    const st = sim.st;
    const refShard = (mid, p) => {
      if (mid < 0) return -1; const m = st.modules[mid]; if (m.fixed) return -1;
      let best = -1, bd = Infinity;
      for (const sid of m.shards) { const s = st.shards[sid]; const d = (s.c[0] - p[0]) ** 2 + (s.c[2] - p[2]) ** 2; if (d < bd) { bd = d; best = sid; } }
      return best;
    };
    this.lines = (sim.def.ziplines || []).map((z, i) => {
      const ab = [z.b[0] - z.a[0], z.b[1] - z.a[1], z.b[2] - z.a[2]];
      return { id: i, a: z.a, b: z.b, ab, L: Math.hypot(ab[0], ab[1], ab[2]), refs: [refShard(z.ma, z.a), refShard(z.mb, z.b)], ma: z.ma, mb: z.mb, alive: true };
    });
    this.ladders = (sim.def.ladders || []).map((l, i) => ({ id: i, ...l, t: [-l.n[1], l.n[0]], ref: refShard(l.mod, [l.p[0] - l.n[0] * 0.6, 0, l.p[1] - l.n[1] * 0.6]), alive: true }));
  }
  forward() { const cp = Math.cos(this.pitch); return [-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp]; }
  eyePos() { return [this.pos[0], this.pos[1] + this.eye, this.pos[2]]; }
  setFly(f) { this.fly = f; this.vel = [0, 0, 0]; this._leave(); }
  respawn(p) { this._leave(); this.pos = p.slice(); this.vel = [0, 0, 0]; this.body.setNextKinematicTranslation({ x: p[0], y: p[1], z: p[2] }); this.body.setTranslation({ x: p[0], y: p[1], z: p[2] }, true); }
  _leave() { this.zip = null; this.ladder = null; }

  // check anchors (cheap: one fragment each); returns ids of traversal objects that just died
  checkAnchors() {
    const st = this.sim.st, dead = [];
    for (const l of this.lines) if (l.alive && l.refs.some((r) => r >= 0 && st.shards[r].state !== STATIC)) { l.alive = false; dead.push({ type: 'zip', obj: l }); }
    for (const l of this.ladders) if (l.alive && l.ref >= 0 && st.shards[l.ref].state !== STATIC) { l.alive = false; dead.push({ type: 'ladder', obj: l }); }
    return dead;
  }
  _closestLine(eye) {
    let best = null, bd = 2.9;
    for (const l of this.lines) {
      if (!l.alive) continue;
      const ap = [eye[0] - l.a[0], eye[1] - l.a[1], eye[2] - l.a[2]];
      const t = Math.max(0.01, Math.min(0.99, (ap[0] * l.ab[0] + ap[1] * l.ab[1] + ap[2] * l.ab[2]) / (l.L * l.L)));
      const c = [l.a[0] + l.ab[0] * t, l.a[1] + l.ab[1] * t, l.a[2] + l.ab[2] * t];
      const d = Math.hypot(eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]);
      if (d < bd && c[1] > eye[1] - 0.6) { bd = d; best = { l, t }; }
    }
    return best;
  }
  _ladderAt(wish, strict) {
    const feet = this.pos[1] - 0.9;
    for (const L of this.ladders) {
      if (!L.alive) continue;
      const rx = this.pos[0] - L.p[0], rz = this.pos[2] - L.p[1];
      const dn = rx * L.n[0] + rz * L.n[1], dl = rx * L.t[0] + rz * L.t[1];
      if (dn < -0.1 || dn > 1.0 || Math.abs(dl) > L.w || feet < L.y0 - 0.4 || feet > L.y1 - 0.3) continue;
      if (!strict || (wish[0] * -L.n[0] + wish[2] * -L.n[1]) > 0.45) return L;
    }
    return null;
  }

  update(dt, input, events) {
    const k = input.keys;
    const f = [-Math.sin(this.yaw), 0, -Math.cos(this.yaw)], r = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
    let mx = 0, mz = 0;
    if (k.KeyW) mz += 1; if (k.KeyS) mz -= 1; if (k.KeyD) mx += 1; if (k.KeyA) mx -= 1;
    if (input.move) { mx += input.move[0]; mz += input.move[1]; }
    const len = Math.hypot(mx, mz); if (len > 1) { mx /= len; mz /= len; }
    const jump = input.pressed.Space || input.jumpPressed, use = input.pressed.KeyE || input.usePressed;
    const sprint = k.ShiftLeft || k.ShiftRight || input.sprint;
    const eye = this.eyePos();
    this.near = this.zip || this.ladder ? null : (this._closestLine(eye) ? 'zip' : null);
    if (this.fly) {
      const fw = this.forward();
      const sp = (sprint ? 34 : 13);
      const up = (k.Space || input.jumpHeld ? 1 : 0) - (k.KeyC || k.ControlLeft ? 1 : 0);
      for (let i = 0; i < 3; i++) this.pos[i] += (fw[i] * mz + r[i] * mx) * sp * dt;
      this.pos[1] += up * sp * dt;
      this.pos[1] = Math.max(0.6, this.pos[1]);
      this.body.setNextKinematicTranslation({ x: this.pos[0], y: this.pos[1], z: this.pos[2] });
      return;
    }
    // ---------------------------------------------------------------- zipline
    if (!this.zip && use && !this.charge) {
      const hit = this._closestLine(eye);
      if (hit) {
        const l = hit.l, h = Math.hypot(l.ab[0], l.ab[2]) || 1;
        const along = (f[0] * l.ab[0] + f[2] * l.ab[2]) / h;
        this.zip = { l, t: hit.t, dir: along >= 0 ? 1 : -1, s: Math.max(6, Math.hypot(this.vel[0], this.vel[2])) };
        this.ladder = null; events.push({ type: 'zip+' });
        return this._ride(dt, events, false, false);
      }
    }
    if (this.zip) return this._ride(dt, events, jump, use);
    // ---------------------------------------------------------------- ladder
    const wish = [f[0] * mz + r[0] * mx, 0, f[2] * mz + r[2] * mx];
    if (!this.ladder && !this.charge && (this._ladderAt(wish, !use) && (use || mz > 0.3))) { this.ladder = this._ladderAt(wish, false); this.climbAcc = 0; events.push({ type: 'ladder+' }); }
    if (this.ladder) return this._climb(dt, mx, mz, jump, use, events);
    // ---------------------------------------------------------------- walking
    // charge'n'slam overrides steering
    let speed = sprint ? 9.8 : 6.4;
    let wv = wish;
    if (this.charge) { const d = this.charge.dir; wv = [d[0], 0, d[2]]; speed = 15.5; }
    const accel = this.grounded ? 14 : 4;
    this.vel[0] += (wv[0] * speed - this.vel[0]) * Math.min(1, accel * dt);
    this.vel[2] += (wv[2] * speed - this.vel[2]) * Math.min(1, accel * dt);
    this.vel[1] -= 19 * dt;
    if (jump) {
      if (this.grounded) { this.vel[1] = 7.2; this.jumps = 1; }
      else if (this.jumps < 2) { this.vel[1] = 6.6; this.jumps = 2; events.push({ type: 'djump' }); }
    }
    // jump pads (THE FINALS staple)
    this.padCooldown -= dt;
    for (const pr of this.sim.props) if (pr.type === 'pad' && this.padCooldown <= 0 && Math.hypot(this.pos[0] - pr.p[0], this.pos[2] - pr.p[2]) < 1.15 && this.pos[1] - pr.p[1] < 1.5) { this.vel[1] = 19.5; this.padCooldown = 0.6; this.jumps = 1; events.push({ type: 'pad' }); }
    const vy0 = this.vel[1];
    this._move(dt);
    const wasGrounded = this.grounded;
    this.grounded = this.cc.computedGrounded();
    if (this.grounded) { if (this.vel[1] < 0) this.vel[1] = 0; this.jumps = 0; if (!wasGrounded && vy0 < -3) events.push({ type: 'land', v: -vy0 }); }
    // footsteps
    const hs = Math.hypot(this.vel[0], this.vel[2]);
    if (this.grounded && hs > 1.2) {
      this.stepAcc += hs * dt;
      if (this.stepAcc > (sprint ? 2.5 : 2.0)) { this.stepAcc = 0; events.push({ type: 'step', mat: this._surface() }); }
    }
    if (this.pos[1] < -15) events.push({ type: 'fell' });
  }
  _move(dt) {
    const desired = { x: this.vel[0] * dt, y: this.vel[1] * dt, z: this.vel[2] * dt };
    this.cc.computeColliderMovement(this.collider, desired, undefined, GROUPS.player);
    const m = this.cc.computedMovement();
    if (m.y > desired.y + 1e-4 && this.vel[1] > 0 && !this.cc.computedGrounded()) this.vel[1] = 0; // bumped head
    this.pos[0] += m.x; this.pos[1] += m.y; this.pos[2] += m.z;
    if (Math.abs(m.x) < Math.abs(desired.x) * 0.3) this.vel[0] *= 0.5;
    if (Math.abs(m.z) < Math.abs(desired.z) * 0.3) this.vel[2] *= 0.5;
    this.body.setNextKinematicTranslation({ x: this.pos[0], y: this.pos[1], z: this.pos[2] });
    return m;
  }
  _surface() {
    const h = this.sim.raycast([this.pos[0], this.pos[1], this.pos[2]], [0, -1, 0], 1.6, this.collider);
    if (!h || h.shard < 0) return 'concrete';
    const mat = this.sim.st.shards[h.shard].mat;
    return mat === 'wood' || mat === 'crate' ? 'wood' : mat === 'steel' || mat === 'rail' ? 'metal' : 'concrete';
  }
  _ride(dt, events, jump, use) {
    const z = this.zip, l = z.l;
    const dirv = [l.ab[0] / l.L * z.dir, l.ab[1] / l.L * z.dir, l.ab[2] / l.L * z.dir];
    const off = () => { this.zip = null; events.push({ type: 'zip-' }); };
    if (!l.alive) { this.vel = [dirv[0] * z.s * 0.6, Math.min(0, dirv[1] * z.s), dirv[2] * z.s * 0.6]; off(); return; }
    if (jump) { this.vel = [dirv[0] * z.s * 0.75, 6.2, dirv[2] * z.s * 0.75]; this.jumps = 1; off(); return; }
    if (use) { this.vel = [dirv[0] * z.s * 0.5, 0, dirv[2] * z.s * 0.5]; off(); return; }
    z.s += (RIDE - z.s) * Math.min(1, 2.5 * dt);
    z.t += (z.dir * z.s * dt) / l.L;
    const end = z.t >= 1 || z.t <= 0;
    z.t = Math.max(0, Math.min(1, z.t));
    const c = [l.a[0] + l.ab[0] * z.t, l.a[1] + l.ab[1] * z.t, l.a[2] + l.ab[2] * z.t];
    this.pos = [c[0], c[1] - HANG, c[2]];
    this.vel = [dirv[0] * z.s, dirv[1] * z.s, dirv[2] * z.s];
    this.body.setNextKinematicTranslation({ x: this.pos[0], y: this.pos[1], z: this.pos[2] });
    this.grounded = false; this.jumps = 1;
    if (end) { const h = Math.hypot(dirv[0], dirv[2]) || 1; this.vel = [dirv[0] / h * 3.5, 2.5, dirv[2] / h * 3.5]; off(); }
  }
  _climb(dt, mx, mz, jump, use, events) {
    const L = this.ladder;
    const feet = this.pos[1] - 0.9;
    const rx = this.pos[0] - L.p[0], rz = this.pos[2] - L.p[1];
    const dn = rx * L.n[0] + rz * L.n[1], dl = rx * L.t[0] + rz * L.t[1];
    const off = (v) => { this.ladder = null; this.vel = v; events.push({ type: 'ladder-' }); };
    if (!L.alive) return off([0, 0, 0]);
    if (jump) { this.jumps = 1; return off([L.n[0] * 4.5, 5.5, L.n[1] * 4.5]); }
    if (use || Math.abs(dl) > L.w + 0.35 || dn > 1.3) return off([0, 0, 0]);
    if (feet >= L.y1 - 0.15) return off([-L.n[0] * 3.2, 2.6, -L.n[1] * 3.2]);
    const top = feet > L.y1 - 1.5;
    const vy = CLIMB * mz;
    const pull = top && mz > 0 ? -2.0 : (0.42 - dn) * 6;
    this.vel = [L.n[0] * pull + L.t[0] * mx * 1.6, vy, L.n[1] * pull + L.t[1] * mx * 1.6];
    const y0 = this.pos[1];
    this._move(dt);
    this.grounded = this.cc.computedGrounded(); this.jumps = 0;
    if (mz < -0.3 && this.grounded && feet < L.y0 + 0.3) return off([0, 0, 0]);
    this.climbAcc += Math.abs(this.pos[1] - y0);
    if (this.climbAcc > 0.62) { this.climbAcc = 0; events.push({ type: 'step', mat: 'metal' }); }
  }
}
