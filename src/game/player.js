// First-person contestant: kinematic character controller (walk, sprint, double jump, jump pads) or noclip fly.
import { GROUPS } from '../sim/sim.js';

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
    this.charge = null; this.padCooldown = 0;
  }
  forward() { const cp = Math.cos(this.pitch); return [-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp]; }
  eyePos() { return [this.pos[0], this.pos[1] + this.eye, this.pos[2]]; }
  setFly(f) { this.fly = f; this.vel = [0, 0, 0]; }
  respawn(p) { this.pos = p.slice(); this.vel = [0, 0, 0]; this.body.setNextKinematicTranslation({ x: p[0], y: p[1], z: p[2] }); this.body.setTranslation({ x: p[0], y: p[1], z: p[2] }, true); }
  update(dt, input, events) {
    const k = input.keys;
    const f = [-Math.sin(this.yaw), 0, -Math.cos(this.yaw)], r = [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
    let mx = 0, mz = 0;
    if (k.KeyW) mz += 1; if (k.KeyS) mz -= 1; if (k.KeyD) mx += 1; if (k.KeyA) mx -= 1;
    const len = Math.hypot(mx, mz) || 1; mx /= len; mz /= len;
    if (this.fly) {
      const fw = this.forward();
      const sp = (k.ShiftLeft || k.ShiftRight ? 34 : 13);
      const up = (k.Space ? 1 : 0) - (k.KeyC || k.ControlLeft ? 1 : 0);
      for (let i = 0; i < 3; i++) this.pos[i] += (fw[i] * mz + r[i] * mx) * sp * dt;
      this.pos[1] += up * sp * dt;
      this.pos[1] = Math.max(0.6, this.pos[1]);
      this.body.setNextKinematicTranslation({ x: this.pos[0], y: this.pos[1], z: this.pos[2] });
      return;
    }
    // charge'n'slam overrides steering
    let speed = k.ShiftLeft || k.ShiftRight ? 9.8 : 6.4;
    let wish = [f[0] * mz + r[0] * mx, 0, f[2] * mz + r[2] * mx];
    if (this.charge) { const d = this.charge.dir; wish = [d[0], 0, d[2]]; speed = 15.5; }
    const accel = this.grounded ? 14 : 4;
    this.vel[0] += (wish[0] * speed - this.vel[0]) * Math.min(1, accel * dt);
    this.vel[2] += (wish[2] * speed - this.vel[2]) * Math.min(1, accel * dt);
    this.vel[1] -= 19 * dt;
    if (input.pressed.Space) {
      if (this.grounded) { this.vel[1] = 7.2; this.jumps = 1; }
      else if (this.jumps < 2) { this.vel[1] = 6.6; this.jumps = 2; events.push({ type: 'djump' }); }
    }
    // jump pads (THE FINALS staple)
    this.padCooldown -= dt;
    for (const pr of this.sim.props) if (pr.type === 'pad' && this.padCooldown <= 0 && Math.hypot(this.pos[0] - pr.p[0], this.pos[2] - pr.p[2]) < 1.15 && this.pos[1] < 1.6) { this.vel[1] = 17.5; this.padCooldown = 0.6; this.jumps = 1; events.push({ type: 'pad' }); }
    const desired = { x: this.vel[0] * dt, y: this.vel[1] * dt, z: this.vel[2] * dt };
    this.cc.computeColliderMovement(this.collider, desired, undefined, GROUPS.player);
    const m = this.cc.computedMovement();
    const wasGrounded = this.grounded;
    this.grounded = this.cc.computedGrounded();
    if (this.grounded) { if (this.vel[1] < 0) this.vel[1] = 0; this.jumps = 0; if (!wasGrounded) events.push({ type: 'land' }); }
    if (m.y > desired.y + 1e-4 && this.vel[1] > 0 && !this.grounded) this.vel[1] = 0; // bumped head
    this.pos[0] += m.x; this.pos[1] += m.y; this.pos[2] += m.z;
    if (Math.abs(m.x) < Math.abs(desired.x) * 0.3) this.vel[0] *= 0.5;
    if (Math.abs(m.z) < Math.abs(desired.z) * 0.3) this.vel[2] *= 0.5;
    this.body.setNextKinematicTranslation({ x: this.pos[0], y: this.pos[1], z: this.pos[2] });
    if (this.pos[1] < -15) events.push({ type: 'fell' });
  }
}
