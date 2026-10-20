// Rendering of the destruction graph. Static fragments are merged into per-storey chunks (one draw call each,
// rebuilt when fragments leave), debris bodies get one merged mesh each, everything is lit by one sun.
import * as THREE from 'three';
import { STATIC, DYNAMIC } from '../core/structure.js';

const tmpC = new THREE.Color();
export const VIEW_MODES = ['normal', 'stress', 'fragments', 'nodes', 'groups'];
export const VIEW_LABEL = { normal: 'ОБЫЧНЫЙ', stress: 'НАГРУЗКА STRAIN', fragments: 'ФРАГМЕНТЫ', nodes: 'УЗЛЫ STRAIN', groups: 'ГРУППЫ STRAIN' };

function hashColor(i, out) { const h = ((i * 2654435761) >>> 0) / 4294967296; out.setHSL(h, 0.55 + ((i * 7) % 5) * 0.06, 0.55); return out; }
export function stressColor(u, out) {
  // calm blue -> hazard yellow -> broadcast red, matches the HUD
  if (u < 0.5) out.setRGB(0.18 + u * 0.4, 0.42 + u * 0.5, 0.95 - u * 0.6);
  else if (u < 0.85) { const t = (u - 0.5) / 0.35; out.setRGB(0.38 + t * 0.6, 0.67 + t * 0.2, 0.65 - t * 0.5); }
  else { const t = Math.min(1, (u - 0.85) / 0.3); out.setRGB(0.98, 0.87 - t * 0.65, 0.15 - t * 0.05); }
  return out;
}

export class View {
  constructor(renderer, sim, opts = {}) {
    this.renderer = renderer; this.sim = sim; this.st = sim.st;
    this.scene = new THREE.Scene();
    this.mode = 'normal'; this.graph = false; this.quality = opts.quality || 'high';
    this._setupWorld();
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.0 });
    this.glassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.08, metalness: 0.1, transparent: true, opacity: 0.38, depthWrite: false });
    this.debrisMat = this.mat;
    this._prepShards();
    this._buildChunks();
    this.bodyMeshes = new Map();
    this.propMeshes = new Map();
    this.projMeshes = new Map();
    this._buildProps();
    this._buildPiles();
    this.ropeLines = this._lines(0x1b1e22, 64, 1);
    this.attLines = this._lines(0xff9a1f, 2048, 0.95); this.attLines.visible = false;
    this.graphLines = null; this.graphPoints = null;
    this.graphDirty = true;
  }

  _setupWorld() {
    const S = this.scene;
    const sky = new THREE.Color(0x9ec6ea), horizon = new THREE.Color(0xe8dccb);
    S.background = horizon.clone();
    S.fog = new THREE.Fog(0xe2d9cb, 70, 210);
    // gradient sky dome
    const g = new THREE.SphereGeometry(400, 32, 16);
    const col = [];
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i) / 400; const t = Math.max(0, y); tmpC.copy(horizon).lerp(sky, Math.pow(t, 0.55)); col.push(tmpC.r, tmpC.g, tmpC.b); }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const dome = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    dome.renderOrder = -10; S.add(dome);
    const sun = new THREE.Mesh(new THREE.CircleGeometry(9, 32), new THREE.MeshBasicMaterial({ color: 0xfff4dc, fog: false }));
    sun.position.set(-160, 230, 120); sun.lookAt(0, 0, 0); S.add(sun);
    S.add(new THREE.HemisphereLight(0xd6e6ff, 0x8f7c66, 1.15));
    const d = new THREE.DirectionalLight(0xfff0d8, 2.6);
    d.position.set(-40, 60, 30);
    d.castShadow = true;
    const hq = this.quality === 'high';
    d.shadow.mapSize.set(hq ? 4096 : 2048, hq ? 4096 : 2048);
    const sc = d.shadow.camera; sc.left = -50; sc.right = 50; sc.top = 50; sc.bottom = -50; sc.near = 1; sc.far = 160;
    d.shadow.bias = -0.0004; d.shadow.normalBias = 0.03;
    S.add(d); S.add(d.target);
    this.sun = d;
    // ground: asphalt with a slightly lighter plaza
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0x55575a, roughness: 0.96 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; S.add(ground);
    const plaza = new THREE.Mesh(new THREE.PlaneGeometry(96, 80), new THREE.MeshStandardMaterial({ color: 0x77736c, roughness: 0.95 }));
    plaza.rotation.x = -Math.PI / 2; plaza.position.y = 0.005; plaza.receiveShadow = true; S.add(plaza);
    // painted lines: game-show arena markings
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xf2d24b });
    for (const z of [12.5, -14]) { const l = new THREE.Mesh(new THREE.PlaneGeometry(90, 0.25), lineMat); l.rotation.x = -Math.PI / 2; l.position.set(0, 0.012, z); S.add(l); }
  }

  // precompute per-fragment vertex data (shard-local) + base colours
  _prepShards() {
    const st = this.st;
    for (const s of st.shards) {
      const m = st.modules[s.mod];
      const ntri = s.triSide.length;
      const col = new Float32Array(ntri * 9);
      const core = tmpC.setHex(s.def.core).clone().multiplyScalar(s.tint);
      for (let t = 0; t < ntri; t++) {
        const side = s.triSide[t];
        const c = side >= 0 ? tmpC.setHex(m.colors[side]).multiplyScalar(0.97 + (s.tint - 1) * 0.35) : core;
        for (let k = 0; k < 3; k++) { col[t * 9 + k * 3] = c.r; col[t * 9 + k * 3 + 1] = c.g; col[t * 9 + k * 3 + 2] = c.b; }
      }
      s.vcol = col;
      s.vnrm = new Float32Array(ntri * 9);
      for (let t = 0; t < ntri; t++) for (let k = 0; k < 3; k++) s.vnrm.set([s.triN[t * 3], s.triN[t * 3 + 1], s.triN[t * 3 + 2]], t * 9 + k * 3);
    }
  }

  _buildChunks() {
    const st = this.st;
    const map = new Map(); this.chunks = [];
    for (const m of st.modules) {
      const key = m.region + ':' + (m.story ?? 0) + ':' + (m.def.glass ? 'g' : 'o');
      if (!map.has(key)) { map.set(key, this.chunks.length); this.chunks.push({ id: this.chunks.length, glass: !!m.def.glass, shards: [], verts: 0 }); }
      const ch = this.chunks[map.get(key)];
      m.chunk = ch.id;
      for (const sid of m.shards) { ch.shards.push(sid); ch.verts += st.shards[sid].triSide.length * 3; }
    }
    for (const ch of this.chunks) {
      const g = new THREE.BufferGeometry();
      const P = new Float32Array(ch.verts * 3), N = new Float32Array(ch.verts * 3), C = new Float32Array(ch.verts * 3);
      g.setAttribute('position', new THREE.BufferAttribute(P, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('normal', new THREE.BufferAttribute(N, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(C, 3).setUsage(THREE.DynamicDrawUsage));
      const mesh = new THREE.Mesh(g, ch.glass ? this.glassMat : this.mat);
      mesh.castShadow = !ch.glass; mesh.receiveShadow = true;
      ch.mesh = mesh; this.scene.add(mesh);
      this._fillChunk(ch, true);
      g.computeBoundingSphere();
    }
  }

  _shardColor(s, out) {
    const mode = this.mode;
    if (mode === 'fragments') return hashColor(s.id, out);
    const viz = this.sim.regionViz[s.region];
    if (mode === 'groups') return hashColor(s.region * 97 + 13, out);
    if (!viz) return null;
    const R = this.st.regions[s.region];
    if (!R._idx) { R._idx = new Map(); R.shards.forEach((id, i) => R._idx.set(id, i)); }
    const node = viz.shardNode[R._idx.get(s.id)];
    if (node === undefined || node < 0) return out.setRGB(0.35, 0.35, 0.38);
    if (mode === 'nodes') return hashColor(node * 31 + s.region * 1000, out);
    return stressColor(viz.nodeU[node], out);
  }

  _fillChunk(ch, all = false) {
    const st = this.st;
    const g = ch.mesh.geometry;
    const P = g.attributes.position.array, N = g.attributes.normal.array, C = g.attributes.color.array;
    let o = 0;
    const override = this.mode !== 'normal';
    for (const sid of ch.shards) {
      const s = st.shards[sid];
      if (s.state !== STATIC && !all) continue;
      if (s.state !== STATIC) continue;
      const T = s.tri, n = T.length;
      for (let i = 0; i < n; i += 3) { P[o + i] = T[i] + s.c[0]; P[o + i + 1] = T[i + 1] + s.c[1]; P[o + i + 2] = T[i + 2] + s.c[2]; }
      N.set(s.vnrm, o);
      const oc = override ? this._shardColor(s, tmpC) : null;
      if (oc) { const shade = s.vcol; for (let i = 0; i < n; i += 3) { const lum = 0.75 + 0.25 * (shade[i] + shade[i + 1] + shade[i + 2]) / 3; C[o + i] = oc.r * lum; C[o + i + 1] = oc.g * lum; C[o + i + 2] = oc.b * lum; } }
      else C.set(s.vcol, o);
      o += n;
    }
    g.setDrawRange(0, o / 3);
    for (const k of ['position', 'normal', 'color']) { const a = g.attributes[k]; a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(3, o)); a.needsUpdate = true; }
  }

  setMode(mode) { this.mode = mode; for (const ch of this.chunks) this._fillChunk(ch); }

  _bodyGeometry(rec, glass) {
    const st = this.st;
    let nv = 0;
    for (const id of rec.shards) { const s = st.shards[id]; if (s.state === DYNAMIC && s.body === rec && !!s.glass === glass) nv += s.triSide.length * 3; }
    if (!nv) return null;
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), C = new Float32Array(nv * 3);
    const q = new THREE.Quaternion(), v = new THREE.Vector3();
    let o = 0;
    for (const id of rec.shards) {
      const s = st.shards[id]; if (s.state !== DYNAMIC || s.body !== rec || !!s.glass !== glass) continue;
      q.set(s.lq[0], s.lq[1], s.lq[2], s.lq[3]);
      const T = s.tri;
      for (let i = 0; i < T.length; i += 3) {
        v.set(T[i], T[i + 1], T[i + 2]).applyQuaternion(q); P[o + i] = v.x + s.lp[0]; P[o + i + 1] = v.y + s.lp[1]; P[o + i + 2] = v.z + s.lp[2];
        v.set(s.vnrm[i], s.vnrm[i + 1], s.vnrm[i + 2]).applyQuaternion(q); N[o + i] = v.x; N[o + i + 1] = v.y; N[o + i + 2] = v.z;
      }
      C.set(s.vcol, o);
      o += T.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.BufferAttribute(C, 3));
    g.computeBoundingSphere();
    return g;
  }
  _syncBody(rec) {
    let grp = this.bodyMeshes.get(rec.id);
    if (grp) { for (const c of grp.children) c.geometry.dispose(); grp.clear(); }
    else { grp = new THREE.Group(); this.bodyMeshes.set(rec.id, grp); this.scene.add(grp); }
    const go = this._bodyGeometry(rec, false), gg = this._bodyGeometry(rec, true);
    if (go) { const m = new THREE.Mesh(go, this.debrisMat); m.castShadow = rec.vol > 0.02; m.receiveShadow = true; grp.add(m); }
    if (gg) { const m = new THREE.Mesh(gg, this.glassMat); grp.add(m); }
    rec.dirty = false;
  }

  _buildProps() {
    this.canGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.9, 16);
    const cg = this.canGeo, cc = [];
    for (let i = 0; i < cg.attributes.position.count; i++) { const y = cg.attributes.position.getY(i); (Math.abs(y) < 0.1 ? tmpC.setHex(0xf3efe6) : tmpC.setHex(0xd8261f)); cc.push(tmpC.r, tmpC.g, tmpC.b); }
    cg.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3));
    this.canMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.2 });
    this.ballMat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.35, metalness: 0.85 });
    const padMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, emissive: 0xffb000, emissiveIntensity: 0.35, roughness: 0.6 });
    for (const pr of this.sim.props) {
      if (pr.type === 'pad') {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.25, 0.18, 24), padMat);
        m.position.set(pr.p[0], 0.09, pr.p[2]); m.receiveShadow = true; this.scene.add(m);
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.75, 3), new THREE.MeshBasicMaterial({ color: 0x1b1e22 }));
        ring.rotation.x = -Math.PI / 2; ring.position.set(pr.p[0], 0.19, pr.p[2]); this.scene.add(ring);
      } else this._propMesh(pr);
    }
  }
  _propMesh(pr) {
    let m = null;
    if (pr.type === 'canister') m = new THREE.Mesh(this.canGeo, this.canMat);
    else if (pr.type === 'ball') m = new THREE.Mesh(new THREE.SphereGeometry(1.1, 28, 18), this.ballMat);
    if (!m) return;
    m.castShadow = true; m.receiveShadow = true;
    this.propMeshes.set(pr, m); this.scene.add(m);
  }

  _buildPiles() {
    const P = this.sim.piles;
    const g = new THREE.PlaneGeometry(P.sx, P.sz, P.ncols, P.nrows);
    g.rotateX(-Math.PI / 2);
    const cols = new Float32Array(g.attributes.position.count * 3);
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    this.pileMesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1 }));
    this.pileMesh.position.set(P.x0 + P.sx / 2, 0, P.z0 + P.sz / 2);
    this.pileMesh.receiveShadow = true; this.pileMesh.castShadow = true; this.pileMesh.visible = false;
    this.scene.add(this.pileMesh);
    this.pileVersion = 0;
  }
  _syncPiles() {
    const P = this.sim.piles; if (P.version === this.pileVersion) return;
    this.pileVersion = P.version;
    const g = this.pileMesh.geometry, pos = g.attributes.position, col = g.attributes.color;
    // PlaneGeometry vertex order: rows along -z..+z after rotation, columns along x
    for (let r = 0; r <= P.nrows; r++) for (let c = 0; c <= P.ncols; c++) {
      const i = r * (P.ncols + 1) + c;
      const h = P.h[P.idx(c, r)];
      pos.setY(i, h > 0.012 ? h : -0.05);
      const k = Math.min(1, h / 1.2);
      tmpC.setRGB(0.47 + 0.08 * k, 0.45 + 0.05 * k, 0.42 + 0.02 * k); col.setXYZ(i, tmpC.r, tmpC.g, tmpC.b);
    }
    pos.needsUpdate = true; col.needsUpdate = true; g.computeVertexNormals(); g.computeBoundingSphere();
    this.pileMesh.visible = true;
  }

  _lines(color, max, opacity) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 6), 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
    l.frustumCulled = false; this.scene.add(l); l.userData.max = max;
    return l;
  }

  setGraph(on) { this.graph = on; this.attLines.visible = on; this.graphDirty = true; if (this.graphLines) this.graphLines.visible = on; if (this.graphPoints) this.graphPoints.visible = on; }

  _rebuildGraph() {
    this.graphDirty = false;
    if (!this.graph) return;
    const pos = [], col = [], apos = [];
    for (const viz of this.sim.regionViz) {
      if (!viz) continue;
      const { nodeCom, connA, connB, connP, connU, connThr } = viz;
      for (let i = 0; i < connA.length; i++) {
        const u = connU[i] / connThr[i];
        stressColor(Math.min(1.2, u), tmpC);
        const a = connA[i] * 3, p = i * 3;
        if (connB[i] < 0) { apos.push(connP[p], connP[p + 1], connP[p + 2]); }
        pos.push(nodeCom[a], nodeCom[a + 1], nodeCom[a + 2], connP[p], connP[p + 1], connP[p + 2]); col.push(tmpC.r, tmpC.g, tmpC.b, tmpC.r, tmpC.g, tmpC.b);
        if (connB[i] >= 0) { const b = connB[i] * 3; pos.push(connP[p], connP[p + 1], connP[p + 2], nodeCom[b], nodeCom[b + 1], nodeCom[b + 2]); col.push(tmpC.r, tmpC.g, tmpC.b, tmpC.r, tmpC.g, tmpC.b); }
      }
    }
    if (this.graphLines) { this.scene.remove(this.graphLines); this.graphLines.geometry.dispose(); }
    if (this.graphPoints) { this.scene.remove(this.graphPoints); this.graphPoints.geometry.dispose(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.graphLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.85 }));
    this.graphLines.renderOrder = 20; this.graphLines.frustumCulled = false; this.scene.add(this.graphLines);
    const gp = new THREE.BufferGeometry(); gp.setAttribute('position', new THREE.Float32BufferAttribute(apos, 3));
    this.graphPoints = new THREE.Points(gp, new THREE.PointsMaterial({ color: 0xff3b2f, size: 7, sizeAttenuation: false, depthTest: false }));
    this.graphPoints.renderOrder = 21; this.graphPoints.frustumCulled = false; this.scene.add(this.graphPoints);
  }

  _syncLines(alpha) {
    const sim = this.sim;
    const fill = (line, list) => {
      const a = line.geometry.attributes.position.array; let n = 0;
      for (const [p, q] of list) { if (n >= line.userData.max) break; a.set(p, n * 6); a.set(q, n * 6 + 3); n++; }
      line.geometry.setDrawRange(0, n * 2); line.geometry.attributes.position.needsUpdate = true;
    };
    const ropes = [], atts = [];
    for (const att of sim.atts) {
      if (att.broken) continue;
      const sA = sim.st.shards[att.refA], sB = sim.st.shards[att.refB];
      const pa = this._shardWorldPoint(sA, att.locA[0], alpha), pb = this._shardWorldPoint(sB, att.locB[0], alpha);
      if (att.type === 'rope') ropes.push([pa, pb]);
      else if (this.graph && att.active) { atts.push([pa, pb]); const c = this._shardWorldPoint(sA, [0, 0, 0], alpha), d = this._shardWorldPoint(sB, [0, 0, 0], alpha); atts.push([c, pa]); atts.push([pb, d]); }
    }
    fill(this.ropeLines, ropes);
    if (this.graph) fill(this.attLines, atts);
  }
  _shardWorldPoint(s, local, alpha) {
    if (s.state === DYNAMIC && s.body) {
      const g = this.bodyMeshes.get(s.body.id);
      const P = s.body.curP, Q = s.body.curQ;
      const q = g ? g.quaternion : new THREE.Quaternion(Q[0], Q[1], Q[2], Q[3]);
      const t = g ? g.position : new THREE.Vector3(P[0], P[1], P[2]);
      const v = new THREE.Vector3(local[0], local[1], local[2]).applyQuaternion(new THREE.Quaternion(s.lq[0], s.lq[1], s.lq[2], s.lq[3])).add(new THREE.Vector3(s.lp[0], s.lp[1], s.lp[2])).applyQuaternion(q).add(t);
      return [v.x, v.y, v.z];
    }
    return [s.c[0] + local[0], s.c[1] + local[1], s.c[2] + local[2]];
  }

  // consume simulation events relevant to geometry
  handle(ev) {
    switch (ev.type) {
      case 'body+': this._syncBody(ev.body); break;
      case 'body-': { const g = this.bodyMeshes.get(ev.body.id); if (g) { for (const c of g.children) c.geometry.dispose(); this.scene.remove(g); this.bodyMeshes.delete(ev.body.id); } break; }
      case 'body~': ev.body.dirty = true; break;
      case 'prop+': this._propMesh(ev.prop); break;
      case 'prop-': { const m = this.propMeshes.get(ev.prop); if (m) { this.scene.remove(m); this.propMeshes.delete(ev.prop); } break; }
      case 'strain': if (this.mode !== 'normal' && this.mode !== 'fragments' && this.mode !== 'groups') this._regionRecolor.add(ev.region); this.graphDirty = true; break;
      default: break;
    }
  }

  update(alpha) {
    const sim = this.sim;
    if (!this._regionRecolor) this._regionRecolor = new Set();
    // static chunks (budgeted)
    let budget = 6;
    for (const id of sim.dirtyChunks) { if (budget-- <= 0) break; this._fillChunk(this.chunks[id]); sim.dirtyChunks.delete(id); }
    if (this._regionRecolor.size) { for (const ch of this.chunks) { const s0 = this.st.shards[ch.shards[0]]; if (this._regionRecolor.has(s0.region)) this._fillChunk(ch); } this._regionRecolor.clear(); }
    const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
    for (const rec of sim.bodies.values()) {
      if (rec.dirty || !this.bodyMeshes.has(rec.id)) this._syncBody(rec);
      const g = this.bodyMeshes.get(rec.id);
      const a = rec.prevP, b = rec.curP;
      g.position.set(a[0] + (b[0] - a[0]) * alpha, a[1] + (b[1] - a[1]) * alpha, a[2] + (b[2] - a[2]) * alpha);
      qa.set(rec.prevQ[0], rec.prevQ[1], rec.prevQ[2], rec.prevQ[3]); qb.set(rec.curQ[0], rec.curQ[1], rec.curQ[2], rec.curQ[3]);
      g.quaternion.copy(qa).slerp(qb, alpha);
    }
    for (const [pr, m] of this.propMeshes) { const t = pr.rb.translation(), q = pr.rb.rotation(); m.position.set(t.x, t.y, t.z); m.quaternion.set(q.x, q.y, q.z, q.w); }
    this._syncPiles();
    this._syncLines(alpha);
    if (this.graph && this.graphDirty) this._rebuildGraph();
  }

  dispose() {
    this.scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.mat.dispose(); this.glassMat.dispose();
  }
}
