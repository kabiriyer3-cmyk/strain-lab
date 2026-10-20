// Particles: dust, smoke, fire, sparks and small rubble bits. One soft-sprite shader, two blend modes.
import * as THREE from 'three';

const VS = `
attribute float size; attribute vec4 rgba; varying vec4 vC; varying float vR;
uniform float scale;
void main(){ vC = rgba; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = size * scale / -mv.z; vR = fract(position.x*13.1+position.z*7.7); gl_Position = projectionMatrix * mv; }`;
const FS = `
varying vec4 vC; varying float vR;
void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d); if (r > 0.5) discard;
  float n = 0.8 + 0.2 * sin((gl_PointCoord.x + vR) * 17.0) * sin((gl_PointCoord.y - vR) * 13.0);
  float a = smoothstep(0.5, 0.15, r) * vC.a * n; gl_FragColor = vec4(vC.rgb, a); }`;

class PointPool {
  constructor(scene, max, blending) {
    this.max = max; this.n = 0;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3); this.c = new Float32Array(max * 4);
    this.s = new Float32Array(max); this.life = new Float32Array(max); this.age = new Float32Array(max);
    this.grow = new Float32Array(max); this.drag = new Float32Array(max); this.g = new Float32Array(max); this.a0 = new Float32Array(max);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr); geo.setAttribute('rgba', this.colAttr); geo.setAttribute('size', this.sizeAttr);
    this.mat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: { scale: { value: 600 } }, transparent: true, depthWrite: false, blending });
    this.points = new THREE.Points(geo, this.mat); this.points.frustumCulled = false;
    this.points.renderOrder = blending === THREE.AdditiveBlending ? 6 : 5;
    scene.add(this.points);
  }
  spawn(p, v, color, alpha, size, life, grow = 0, drag = 0.5, g = 0) {
    let i = this.n;
    if (i >= this.max) { i = (Math.random() * this.max) | 0; } else this.n++;
    this.p.set(p, i * 3); this.v.set(v, i * 3);
    this.c[i * 4] = color.r; this.c[i * 4 + 1] = color.g; this.c[i * 4 + 2] = color.b; this.c[i * 4 + 3] = alpha; this.a0[i] = alpha;
    this.s[i] = size; this.life[i] = life; this.age[i] = 0; this.grow[i] = grow; this.drag[i] = drag; this.g[i] = g;
  }
  update(dt) {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const age = this.age[i] + dt;
      if (age >= this.life[i]) continue;
      const k = Math.exp(-this.drag[i] * dt);
      let vx = this.v[i * 3] * k, vy = this.v[i * 3 + 1] * k - this.g[i] * dt, vz = this.v[i * 3 + 2] * k;
      let px = this.p[i * 3] + vx * dt, py = this.p[i * 3 + 1] + vy * dt, pz = this.p[i * 3 + 2] + vz * dt;
      if (py < 0.05) { py = 0.05; vy = Math.abs(vy) * 0.2; }
      const t = age / this.life[i];
      if (w !== i) {
        this.c[w * 4] = this.c[i * 4]; this.c[w * 4 + 1] = this.c[i * 4 + 1]; this.c[w * 4 + 2] = this.c[i * 4 + 2];
        this.s[w] = this.s[i]; this.life[w] = this.life[i]; this.grow[w] = this.grow[i]; this.drag[w] = this.drag[i]; this.g[w] = this.g[i]; this.a0[w] = this.a0[i];
      }
      this.p[w * 3] = px; this.p[w * 3 + 1] = py; this.p[w * 3 + 2] = pz; this.v[w * 3] = vx; this.v[w * 3 + 1] = vy; this.v[w * 3 + 2] = vz;
      this.age[w] = age;
      this.s[w] += this.grow[w] * dt;
      this.c[w * 4 + 3] = this.a0[w] * (t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9);
      w++;
    }
    this.n = w;
    this.posAttr.array.set(this.p.subarray(0, w * 3)); this.colAttr.array.set(this.c.subarray(0, w * 4)); this.sizeAttr.array.set(this.s.subarray(0, w));
    this.posAttr.needsUpdate = true; this.colAttr.needsUpdate = true; this.sizeAttr.needsUpdate = true;
    this.points.geometry.setDrawRange(0, w);
  }
}

export class FX {
  constructor(scene, piles, opts = {}) {
    this.scene = scene; this.piles = piles; this.lite = !!opts.lite; this.hdr = opts.hdr ?? 1;
    const k = this.lite ? 0.5 : 1;
    this.soft = new PointPool(scene, Math.round(4500 * k), THREE.NormalBlending);
    this.glow = new PointPool(scene, Math.round(1800 * k), THREE.AdditiveBlending);
    // rubble bits
    this.maxBits = Math.round(900 * k);
    const bg = new THREE.IcosahedronGeometry(0.09, 0); bg.scale(1, 0.7, 1.2);
    this.bits = new THREE.InstancedMesh(bg, new THREE.MeshStandardMaterial({ roughness: 0.9 }), this.maxBits);
    this.bits.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.bits.count = 0; this.bits.castShadow = false; this.bits.frustumCulled = false;
    this.bitsData = []; scene.add(this.bits);
    this.lights = [0, 1, 2].map(() => { const l = new THREE.PointLight(0xffa64d, 0, 26, 1.6); scene.add(l); return { l, t: 1 }; });
    this.shake = 0;
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.e = new THREE.Euler(); this.sv = new THREE.Vector3();
    this.cTmp = new THREE.Color();
    this.camPos = new THREE.Vector3();
    // shock fronts (camera-facing flash ring + ground ring) and scorch decals on the ground
    this.ringGeo = new THREE.RingGeometry(0.82, 1, 48);
    this.rings = [];
    this.decals = []; this.decalMat = opts.scorch ? new THREE.MeshBasicMaterial({ map: opts.scorch, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, color: 0xffffff }) : null;
    this.decalGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  }
  shockwave(p, R, groundY = null) {
    const mk = (flat) => {
      const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: flat ? 0xd9cdb8 : 0xfff3d6, transparent: true, opacity: flat ? 0.45 : 0.7, depthWrite: false, side: THREE.DoubleSide, blending: flat ? THREE.NormalBlending : THREE.AdditiveBlending, fog: true }));
      m.renderOrder = 7; m.frustumCulled = false; this.scene.add(m); return m;
    };
    this.rings.push({ m: mk(false), p: p.slice(), t: 0, life: 0.22, r0: R * 0.25, r1: R * 2.1, flat: false });
    if (groundY !== null && p[1] - groundY < R) this.rings.push({ m: mk(true), p: [p[0], groundY + 0.05, p[2]], t: 0, life: 0.6, r0: R * 0.4, r1: R * 3.2, flat: true });
  }
  decal(p, size, normal) {
    if (!this.decalMat || (normal && normal[1] < 0.75)) return;
    let d = this.decals.length >= (this.lite ? 10 : 24) ? this.decals.shift() : null;
    if (!d) { d = new THREE.Mesh(this.decalGeo, this.decalMat); d.renderOrder = 1; d.receiveShadow = true; this.scene.add(d); }
    d.position.set(p[0], p[1] + 0.01, p[2]); d.rotation.y = Math.random() * 6.28; d.scale.setScalar(size * (0.85 + Math.random() * 0.3));
    this.decals.push(d);
  }
  setScale(h) { this.soft.mat.uniforms.scale.value = h * 0.9; this.glow.mat.uniforms.scale.value = h * 0.9; }
  rnd(a = 1) { return (Math.random() * 2 - 1) * a; }
  dust(p, size = 1, color = 0xa49c90, n = 6) {
    const c = this.cTmp.setHex(color).lerp(new THREE.Color(0xbdb4a6), 0.6);
    for (let i = 0; i < n; i++) this.soft.spawn([p[0] + this.rnd(size * 0.4), p[1] + this.rnd(size * 0.3), p[2] + this.rnd(size * 0.4)], [this.rnd(1.2), 0.4 + Math.random(), this.rnd(1.2)], c, 0.55, 1.2 + size * 1.4 + Math.random(), 2.2 + Math.random() * 2.5, 1.0 + size, 0.9, -0.05);
  }
  bitsAt(p, n, color, speed = 4) {
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      if (this.bitsData.length >= this.maxBits) this.bitsData.shift();
      const s = 0.5 + Math.random() * 1.6;
      this.bitsData.push({ p: [p[0], p[1], p[2]], v: [this.rnd(speed), Math.random() * speed * 0.9 + 1, this.rnd(speed)], r: [Math.random() * 6, Math.random() * 6, Math.random() * 6], w: [this.rnd(12), this.rnd(12), this.rnd(12)], s, life: 1.6 + Math.random() * 2.2, age: 0, c: c.clone().multiplyScalar(0.85 + Math.random() * 0.3) });
    }
  }
  explosion(p, R, kind) {
    const big = R / 3;
    const H = this.hdr;
    const flash = new THREE.Color(0xfff2c4).multiplyScalar(Math.max(1, H * 0.7)), fire = new THREE.Color(0xff8a2a).multiplyScalar(H), fire2 = new THREE.Color(0xffc24d).multiplyScalar(H), smoke = new THREE.Color(0x4a4744), dust = new THREE.Color(0xb7ad9e);
    this.glow.spawn(p, [0, 0, 0], flash, 1, 14 * big, 0.16, 30 * big, 0, 0);
    for (let i = 0; i < 22 * big; i++) this.glow.spawn([p[0] + this.rnd(0.6), p[1] + this.rnd(0.6), p[2] + this.rnd(0.6)], [this.rnd(6 * big), Math.random() * 5 * big, this.rnd(6 * big)], Math.random() < 0.5 ? fire : fire2, 0.9, 2 + Math.random() * 2.5 * big, 0.35 + Math.random() * 0.35, 3, 3.5, -1);
    for (let i = 0; i < 40 * big; i++) { const sp = 9 + Math.random() * 16; const d = [this.rnd(1), Math.random() * 0.9, this.rnd(1)]; const l = Math.hypot(...d) || 1; this.glow.spawn(p, [d[0] / l * sp, d[1] / l * sp, d[2] / l * sp], fire2, 1, 0.25 + Math.random() * 0.25, 0.4 + Math.random() * 0.5, -0.2, 1.2, 9); }
    for (let i = 0; i < 26 * big; i++) this.soft.spawn([p[0] + this.rnd(R * 0.4), p[1] + this.rnd(R * 0.3), p[2] + this.rnd(R * 0.4)], [this.rnd(2.5), 0.8 + Math.random() * 2.2, this.rnd(2.5)], Math.random() < 0.55 ? smoke : dust, 0.6, 2.5 + Math.random() * 3 * big, 3.5 + Math.random() * 4, 1.6 * big, 0.7, -0.15);
    // ground dust ring
    const gy = Math.max(0.3, Math.min(p[1], 1.5));
    if (p[1] < R + 1.5) for (let i = 0; i < 18 * big; i++) { const a = Math.random() * Math.PI * 2; this.soft.spawn([p[0], gy, p[2]], [Math.cos(a) * (6 + Math.random() * 5), 0.3, Math.sin(a) * (6 + Math.random() * 5)], dust, 0.5, 2 + Math.random() * 2, 2.5 + Math.random() * 2, 2, 1.4, 0); }
    this.bitsAt(p, Math.round(28 * big), 0x6d6860, 8 * big);
    const L = this.lights.reduce((a, b) => (a.t > b.t ? a : b));
    L.l.position.set(p[0], p[1] + 0.5, p[2]); L.t = 0; L.peak = 60 * big; L.l.distance = 10 + R * 5;
  }
  sparks(p, n = 6, color = 0xffd27a) { const c = new THREE.Color(color); for (let i = 0; i < n; i++) this.glow.spawn(p, [this.rnd(5), Math.random() * 4, this.rnd(5)], c, 1, 0.18 + Math.random() * 0.15, 0.2 + Math.random() * 0.3, 0, 2, 9); }
  glass(p) { const c = new THREE.Color(0xd8f3ff); for (let i = 0; i < 14; i++) this.glow.spawn([p[0] + this.rnd(0.5), p[1] + this.rnd(0.5), p[2] + this.rnd(0.5)], [this.rnd(2.5), Math.random() * 2, this.rnd(2.5)], c, 0.8, 0.12 + Math.random() * 0.12, 0.6 + Math.random() * 0.8, 0, 0.5, 9.8); }
  ceilingDust(p) { const c = new THREE.Color(0xc9c1b4); for (let i = 0; i < 7; i++) this.soft.spawn([p[0] + this.rnd(1.2), p[1] - 0.1, p[2] + this.rnd(1.2)], [this.rnd(0.2), -0.6 - Math.random(), this.rnd(0.2)], c, 0.45, 0.6 + Math.random() * 0.8, 2.5 + Math.random() * 2, 0.5, 0.4, 0.6); }
  trail(p, kind) {
    if (kind === 'meteor') { this.glow.spawn(p, [this.rnd(1), this.rnd(1), this.rnd(1)], new THREE.Color(0xff7a2a), 0.9, 3 + Math.random() * 2, 0.5, 2, 1, 0); this.soft.spawn(p, [this.rnd(0.5), 0.5, this.rnd(0.5)], new THREE.Color(0x3d3a37), 0.5, 3, 3, 1.5, 0.5, -0.1); }
    else { this.soft.spawn(p, [this.rnd(0.3), 0.3, this.rnd(0.3)], new THREE.Color(0xd9d4cc), 0.45, 0.5, 1.6, 1.4, 1.5, -0.1); this.glow.spawn(p, [0, 0, 0], new THREE.Color(0xffb35a), 0.9, 0.5, 0.06, 0, 0, 0); }
  }
  update(dt, cam) {
    this.soft.update(dt); this.glow.update(dt);
    const B = this.bitsData; let n = 0;
    for (let i = 0; i < B.length; i++) {
      const b = B[i]; b.age += dt; if (b.age > b.life) continue;
      b.v[1] -= 18 * dt;
      b.p[0] += b.v[0] * dt; b.p[1] += b.v[1] * dt; b.p[2] += b.v[2] * dt;
      const gy = (this.piles ? this.piles.heightAt(b.p[0], b.p[2]) : 0) + 0.05;
      if (b.p[1] < gy) { b.p[1] = gy; b.v[1] *= -0.3; b.v[0] *= 0.6; b.v[2] *= 0.6; b.w[0] *= 0.6; b.w[2] *= 0.6; }
      b.r[0] += b.w[0] * dt; b.r[1] += b.w[1] * dt; b.r[2] += b.w[2] * dt;
      const sc = b.s * Math.min(1, (b.life - b.age) * 2);
      this.q.setFromEuler(this.e.set(b.r[0], b.r[1], b.r[2]));
      this.m.compose(this.sv.set(b.p[0], b.p[1], b.p[2]), this.q, new THREE.Vector3(sc, sc, sc));
      this.bits.setMatrixAt(n, this.m); this.bits.setColorAt(n, b.c); B[n] = b; n++;
    }
    B.length = n; this.bits.count = n;
    this.bits.instanceMatrix.needsUpdate = true; if (this.bits.instanceColor) this.bits.instanceColor.needsUpdate = true;
    for (const L of this.lights) { L.t += dt; L.l.intensity = L.t < 0.6 ? (L.peak || 0) * Math.exp(-L.t * 7) : 0; }
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]; r.t += dt; const k = r.t / r.life;
      if (k >= 1) { this.scene.remove(r.m); r.m.material.dispose(); this.rings.splice(i, 1); continue; }
      const e = 1 - (1 - k) * (1 - k), rad = r.r0 + (r.r1 - r.r0) * e;
      r.m.position.set(r.p[0], r.p[1], r.p[2]); r.m.scale.setScalar(rad);
      if (r.flat) r.m.rotation.set(-Math.PI / 2, 0, 0); else if (cam) r.m.quaternion.copy(cam.quaternion);
      r.m.material.opacity = (r.flat ? 0.45 : 0.7) * (1 - k) * (1 - k);
    }
    this.shake *= Math.exp(-dt * 6);
  }
}
