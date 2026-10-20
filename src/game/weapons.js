// The arsenal: THE FINALS destruction tools + two sandbox toys.
import * as THREE from 'three';

export const WEAPONS = [
  { id: 'rpg', name: 'RPG-7', tag: 'HEAVY', cd: 1.1, hint: 'ракета · радиус 3 м' },
  { id: 'sledge', name: 'КУВАЛДА', tag: 'HEAVY', cd: 0.62, hint: 'ближний бой · пробивает стены' },
  { id: 'c4', name: 'C4', tag: 'HEAVY', cd: 0.45, hint: 'липкий заряд · ПКМ — подрыв' },
  { id: 'frag', name: 'ГРАНАТА', tag: 'ALL', cd: 0.85, hint: 'отскакивает · 2.2 с' },
  { id: 'akm', name: 'AKM', tag: 'MEDIUM', cd: 0.085, auto: true, hint: 'стекло, дерево, баллоны' },
  { id: 'cns', name: "CHARGE'N'SLAM", tag: 'HEAVY', cd: 2.4, hint: 'таран сквозь стены' },
  { id: 'meteor', name: 'МЕТЕОР', tag: 'EVENT', cd: 1.4, hint: 'удар с неба в точку прицела' },
  { id: 'ball', name: 'ШАР-ТАРАН', tag: 'SANDBOX', cd: 0.9, hint: '57 т стали · урон от удара' },
];

function vm(id) {
  const g = new THREE.Group();
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.5, metalness: 0.6 });
  const olive = new THREE.MeshStandardMaterial({ color: 0x5c6440, roughness: 0.8 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.7 });
  const red = new THREE.MeshStandardMaterial({ color: 0xd8261f, roughness: 0.5 });
  const yel = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.6, emissive: 0x332200 });
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); g.add(m); return m; };
  if (id === 'rpg') { add(new THREE.CylinderGeometry(0.05, 0.05, 1.0, 12), olive, 0, 0, -0.2, Math.PI / 2); add(new THREE.ConeGeometry(0.085, 0.28, 12), olive, 0, 0, -0.84, -Math.PI / 2); add(new THREE.BoxGeometry(0.05, 0.14, 0.06), wood, 0, -0.1, 0.05); }
  else if (id === 'sledge') { add(new THREE.CylinderGeometry(0.022, 0.026, 0.9, 8), wood, 0, 0.05, -0.15, 0.25); add(new THREE.BoxGeometry(0.28, 0.13, 0.13), dark, 0, 0.47, -0.27, 0.25); }
  else if (id === 'c4') { add(new THREE.BoxGeometry(0.16, 0.08, 0.22), new THREE.MeshStandardMaterial({ color: 0xd9cfae, roughness: 0.9 }), 0, 0, -0.1); add(new THREE.BoxGeometry(0.05, 0.03, 0.05), red, 0.04, 0.055, -0.05); }
  else if (id === 'frag') { add(new THREE.SphereGeometry(0.07, 14, 10), olive, 0, 0, -0.1); add(new THREE.BoxGeometry(0.03, 0.06, 0.02), dark, 0, 0.08, -0.1); }
  else if (id === 'akm') { add(new THREE.BoxGeometry(0.07, 0.11, 0.55), dark, 0, 0, -0.25); add(new THREE.CylinderGeometry(0.016, 0.016, 0.4, 8), dark, 0, 0.03, -0.7, Math.PI / 2); add(new THREE.BoxGeometry(0.05, 0.18, 0.08), wood, 0, -0.13, -0.32, 0.35); add(new THREE.BoxGeometry(0.06, 0.12, 0.2), wood, 0, -0.03, 0.08); }
  else if (id === 'cns') { add(new THREE.BoxGeometry(0.4, 0.5, 0.06), dark, -0.05, 0.05, -0.35, 0, 0.3); add(new THREE.BoxGeometry(0.42, 0.06, 0.07), yel, -0.05, 0.27, -0.35, 0, 0.3); }
  else if (id === 'meteor') { add(new THREE.BoxGeometry(0.2, 0.13, 0.03), dark, 0, 0, -0.1, -0.5); add(new THREE.PlaneGeometry(0.17, 0.1), new THREE.MeshBasicMaterial({ color: 0xff5a2a }), 0, 0.009, -0.115, -0.5 - Math.PI / 2 + Math.PI / 2); }
  else if (id === 'ball') { add(new THREE.SphereGeometry(0.1, 16, 12), new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.35, metalness: 0.85 }), 0, 0, -0.15); }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.renderOrder = 30; } });
  return g;
}

export class Weapons {
  constructor(game) {
    this.g = game; this.index = 0; this.cool = 0; this.anim = 0; this.swap = 0;
    this.holder = new THREE.Group(); game.camera.add(this.holder);
    this.models = WEAPONS.map((w) => { const m = vm(w.id); m.visible = false; this.holder.add(m); return m; });
    this.models[0].visible = true;
    this.tracers = [];
    const tg = new THREE.BufferGeometry(); tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6 * 32), 3));
    this.tracerLine = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0.8 }));
    this.tracerLine.frustumCulled = false; game.view.scene.add(this.tracerLine);
  }
  get current() { return WEAPONS[this.index]; }
  select(i) { if (i === this.index || i < 0 || i >= WEAPONS.length) return; this.models[this.index].visible = false; this.index = i; this.models[i].visible = true; this.swap = 1; this.cool = Math.max(this.cool, 0.2); }
  cycle(d) { this.select((this.index + d + WEAPONS.length) % WEAPONS.length); }
  fire() {
    if (this.cool > 0 || this.g.player.charge) return;
    const w = this.current, g = this.g, sim = g.sim, pl = g.player;
    const eye = pl.eyePos(), dir = pl.forward();
    const right = [Math.cos(pl.yaw), 0, -Math.sin(pl.yaw)];
    const muzzle = [eye[0] + dir[0] * 0.7 + right[0] * 0.18, eye[1] + dir[1] * 0.7 - 0.12, eye[2] + dir[2] * 0.7 + right[2] * 0.18];
    this.cool = w.cd; this.anim = 1;
    const ex = pl.collider;
    switch (w.id) {
      case 'rpg': sim.spawnProjectile('rpg', muzzle, [dir[0] * 52, dir[1] * 52, dir[2] * 52], { g: 1.2, exclude: ex }); g.audio.launch(); g.fx.shake += 0.15; break;
      case 'sledge': {
        g.audio.swing();
        setTimeout(() => {
          const e2 = pl.eyePos(), d2 = pl.forward();
          const h = sim.raycast(e2, d2, 2.9, pl.collider);
          if (h) { sim.smash(h.p, d2, 0.85, 1.3); g.audio.thud(h.p); g.fx.shake += 0.25; g.fx.dust(h.p, 0.6, 0xb5ab9c, 6); }
        }, 120);
        break;
      }
      case 'c4': { const n = sim.projectiles.filter((p) => p.kind === 'c4').length; if (n >= 4) { g.hud.toast('Максимум 4 заряда C4 — ПКМ для подрыва'); this.cool = 0.3; return; } sim.spawnProjectile('c4', muzzle, [dir[0] * 15 + pl.vel[0], dir[1] * 15 + 2.5, dir[2] * 15 + pl.vel[2]], { fuse: 999, exclude: ex }); g.audio.beep(); break; }
      case 'frag': sim.spawnProjectile('grenade', muzzle, [dir[0] * 17 + pl.vel[0], dir[1] * 17 + 3, dir[2] * 17 + pl.vel[2]], { fuse: 2.2, exclude: ex }); break;
      case 'akm': {
        const sp = 0.012; const d = [dir[0] + (Math.random() - 0.5) * sp, dir[1] + (Math.random() - 0.5) * sp, dir[2] + (Math.random() - 0.5) * sp];
        const h = sim.bullet(eye, d, ex); g.audio.gun(); g.fx.shake += 0.03;
        this.tracers.push({ a: muzzle, b: h ? h.p : [eye[0] + d[0] * 120, eye[1] + d[1] * 120, eye[2] + d[2] * 120], t: 0.05 });
        break;
      }
      case 'cns': {
        if (pl.fly) { g.hud.toast("Charge'N'Slam работает в режиме ходьбы (V)"); this.cool = 0.3; return; }
        pl.charge = { t: 0, dir: [dir[0], 0, dir[2]].map((v, i, a) => v / (Math.hypot(a[0], a[2]) || 1)), last: 0 };
        g.audio.launch(); break;
      }
      case 'meteor': {
        const h = sim.raycast(eye, dir, 400, ex);
        const tgt = h ? h.p : [eye[0] + dir[0] * 60, 0, eye[2] + dir[2] * 60];
        const from = [tgt[0] - 26, tgt[1] + 78, tgt[2] - 14]; const L = Math.hypot(26, 78, 14);
        sim.spawnProjectile('meteor', from, [26 / L * 62, -78 / L * 62, 14 / L * 62], { g: 0 });
        g.hud.toast('МЕТЕОР В ПУТИ'); break;
      }
      case 'ball': sim.spawnBall([eye[0] + dir[0] * 3, eye[1] + dir[1] * 3, eye[2] + dir[2] * 3], [dir[0] * 27, dir[1] * 27 + 2, dir[2] * 27]); g.audio.launch(); break;
      default: break;
    }
  }
  alt() { if (this.current.id === 'c4') { const n = this.g.sim.detonateC4(); if (n) this.g.audio.beep(); } }
  update(dt) {
    this.cool -= dt; this.anim = Math.max(0, this.anim - dt * (this.current.id === 'sledge' ? 2.6 : 5)); this.swap = Math.max(0, this.swap - dt * 4);
    const pl = this.g.player;
    // charge'n'slam: smash what is in front while charging, slam at the end
    if (pl.charge) {
      const c = pl.charge; c.t += dt; c.last -= dt;
      const p = pl.pos;
      if (c.last <= 0) { c.last = 0.07; const hit = this.g.sim.smash([p[0] + c.dir[0] * 1.0, p[1] + 0.4, p[2] + c.dir[2] * 1.0], c.dir, 1.35, 0.75); if (hit) { this.g.fx.shake += 0.2; this.g.audio.crumble(p, 1); } }
      if (c.t > 1.05) { pl.charge = null; this.g.sim.explode([p[0] + c.dir[0] * 0.8, p[1] - 0.2, p[2] + c.dir[2] * 0.8], 2.6, 1.7, { kind: 'slam', push: 0.8 }); pl.vel[1] = 3; }
    }
    const m = this.models[this.index];
    const bob = Math.sin(performance.now() / 160) * 0.006 * Math.min(1, Math.hypot(pl.vel[0], pl.vel[2]) / 6);
    let rx = 0, z = 0, y = 0;
    if (this.current.id === 'sledge') { const a = this.anim; rx = a > 0.6 ? (1 - a) / 0.4 * 0.9 : a / 0.6 * -1.6; }
    else { z = this.anim * 0.08; rx = this.anim * 0.12; }
    if (pl.charge) { y = -0.05; z = -0.12; }
    m.position.set(0.24, -0.22 - this.swap * 0.3 + bob + y, -0.42 + z);
    m.rotation.set(rx, 0.06, 0);
    // tracers
    const a = this.tracerLine.geometry.attributes.position.array; let n = 0;
    for (const t of this.tracers) { t.t -= dt; if (t.t > 0 && n < 32) { a.set(t.a, n * 6); a.set(t.b, n * 6 + 3); n++; } }
    this.tracers = this.tracers.filter((t) => t.t > 0);
    this.tracerLine.geometry.setDrawRange(0, n * 2); this.tracerLine.geometry.attributes.position.needsUpdate = true;
  }
}
