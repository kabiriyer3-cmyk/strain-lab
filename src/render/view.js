// Rendering of the destruction graph. Static fragments are merged into per-storey chunks (one draw call each,
// rebuilt when fragments leave), debris bodies get one merged mesh each. Look: Preetham sky baked into a cube
// background + image-based lighting, procedural detail textures on every fragment (box-projected in rest space,
// so the texture rides along with the debris), scorch marks, a dressed street and a city skyline.
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { STATIC, DYNAMIC, DEAD } from '../core/structure.js';
import { makeDetailTexture, withDetail, LAYER, EMISSIVE, UV_SCALE } from './textures.js';

const tmpC = new THREE.Color();
const PLASTER = 0xefebe3, FLOOR = 0xb89f80;
export const VIEW_MODES = ['normal', 'stress', 'fragments', 'nodes', 'groups'];
export const VIEW_LABEL = { normal: 'ОБЫЧНЫЙ', stress: 'НАГРУЗКА STRAIN', fragments: 'ФРАГМЕНТЫ', nodes: 'УЗЛЫ STRAIN', groups: 'ГРУППЫ STRAIN' };
export const SUN_DIR = new THREE.Vector3(-0.62, 0.6, 0.48).normalize();

function hashColor(i, out) { const h = ((i * 2654435761) >>> 0) / 4294967296; out.setHSL(h, 0.55 + ((i * 7) % 5) * 0.06, 0.55); return out; }
export function stressColor(u, out) {
  // calm blue -> hazard yellow -> broadcast red, matches the HUD
  if (u < 0.5) out.setRGB(0.18 + u * 0.4, 0.42 + u * 0.5, 0.95 - u * 0.6);
  else if (u < 0.85) { const t = (u - 0.5) / 0.35; out.setRGB(0.38 + t * 0.6, 0.67 + t * 0.2, 0.65 - t * 0.5); }
  else { const t = Math.min(1, (u - 0.85) / 0.3); out.setRGB(0.98, 0.87 - t * 0.65, 0.15 - t * 0.05); }
  return out;
}

// which detail layer a fragment face gets (side: -1 = fracture surface, 0..5 = box faces -x,+x,-y,+y,-z,+z)
function layerFor(m, side) {
  const mat = m.mat, kind = m.kind;
  const woody = mat === 'wood' || mat === 'crate', metal = mat === 'steel' || mat === 'rail' || mat === 'panel';
  if (side < 0) return woody ? LAYER.wood : metal ? LAYER.metal : mat === 'brick' ? LAYER.brick : LAYER.core;
  switch (kind) {
    case 'pavement': return side === 3 ? LAYER.tiles : LAYER.concrete;
    case 'base': case 'footing': case 'post': return LAYER.concrete;
    case 'cashout': return m.screen && (side === 4 || side === 5) ? EMISSIVE + LAYER.metal : LAYER.metal;
    case 'jumbotron': return side === 4 || side === 5 ? EMISSIVE + LAYER.metal : LAYER.metal;
    case 'barrier': return side === 2 || side === 3 ? LAYER.concrete : LAYER.hazard;
    case 'roof': return side === 3 ? LAYER.roof : LAYER.paint;
    case 'slab': case 'balcony': return side === 3 ? (m.colors[3] === FLOOR || woody ? LAYER.wood : LAYER.concrete) : LAYER.paint;
    case 'bridge': return side === 3 ? LAYER.concrete : LAYER.paint;
    case 'stair': case 'crate': return LAYER.wood;
    case 'column': case 'beam': return woody ? LAYER.wood : LAYER.concrete;
    case 'partition': return woody ? LAYER.wood : LAYER.paint;
    default: break;
  }
  if (metal || kind === 'lamp' || kind === 'gantry') return LAYER.metal;
  if (mat === 'brick') return m.colors[side] !== PLASTER ? LAYER.brick : LAYER.paint;
  if (woody) return LAYER.wood;
  return LAYER.paint;
}

// ---------------------------------------------------------------- cached procedural textures
const cache = {};
function canvasTex(key, size, draw, srgb = true) {
  if (cache[key]) return cache[key];
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4; cache[key] = t; return t;
}
function asphaltTex() {
  return canvasTex('asphalt', 512, (g, S) => {
    g.fillStyle = '#5a5c5f'; g.fillRect(0, 0, S, S);
    const img = g.getImageData(0, 0, S, S), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 34 + (Math.random() < 0.02 ? 28 : 0); d[i] += n; d[i + 1] += n; d[i + 2] += n * 0.95; }
    g.putImageData(img, 0, 0);
    const wrap = (fn) => { for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) { g.save(); g.translate(ox, oy); fn(); g.restore(); } };
    for (let k = 0; k < 14; k++) { // patches and oil stains
      const x = Math.random() * S, y = Math.random() * S, r = 20 + Math.random() * 70, dark = Math.random() < 0.6;
      wrap(() => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, dark ? 'rgba(25,25,28,0.22)' : 'rgba(150,150,150,0.12)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r); });
    }
    g.lineCap = 'round';
    for (let k = 0; k < 9; k++) { // cracks
      let x = Math.random() * S, y = Math.random() * S, a = Math.random() * 6.28; const pts = [[x, y]];
      for (let s = 0; s < 18; s++) { a += (Math.random() - 0.5) * 1.2; x += Math.cos(a) * 9; y += Math.sin(a) * 9; pts.push([x, y]); }
      wrap(() => { g.strokeStyle = 'rgba(22,22,24,0.55)'; g.lineWidth = 1 + Math.random() * 1.4; g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.stroke(); });
    }
  });
}
function windowTex() {
  return canvasTex('windows', 256, (g, S) => {
    g.fillStyle = '#f0ede6'; g.fillRect(0, 0, S, S);
    const n = 2, cell = S / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const x = i * cell + cell * 0.16, y = j * cell + cell * 0.2, w = cell * 0.68, h = cell * 0.56;
      const gr = g.createLinearGradient(0, y, 0, y + h); gr.addColorStop(0, '#9fb6c8'); gr.addColorStop(0.55, '#4f6577'); gr.addColorStop(1, '#2c3a46');
      g.fillStyle = gr; g.fillRect(x, y, w, h);
      g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(x + w * 0.08, y + h * 0.08, w * 0.25, h * 0.84);
      g.fillStyle = '#d9d4cb'; g.fillRect(x + w / 2 - 2, y, 4, h); g.fillRect(x, y + h * 0.42, w, 3);
      g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x - 3, y + h, w + 6, 6);
    }
    g.fillStyle = 'rgba(0,0,0,0.07)'; g.fillRect(0, S / 2 - 3, S, 6); g.fillRect(0, S - 3, S, 3);
  });
}
function scorchTex() {
  return canvasTex('scorch', 128, (g, S) => {
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, 'rgba(10,9,8,0.92)'); gr.addColorStop(0.45, 'rgba(18,16,14,0.7)'); gr.addColorStop(0.8, 'rgba(30,27,24,0.25)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    for (let k = 0; k < 60; k++) { const a = Math.random() * 6.28, r = S * (0.2 + Math.random() * 0.3); g.fillStyle = 'rgba(12,10,9,0.35)'; g.beginPath(); g.arc(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 1 + Math.random() * 4, 0, 6.28); g.fill(); }
  });
}
export { scorchTex };

export class View {
  constructor(renderer, sim, opts = {}) {
    this.renderer = renderer; this.sim = sim; this.st = sim.st;
    this.scene = new THREE.Scene();
    this.mode = 'normal'; this.graph = false; this.quality = opts.quality || 'high'; this.hq = this.quality === 'high';
    const ds = this.hq ? 256 : 128;
    this.detail = cache['detail' + ds] || (cache['detail' + ds] = makeDetailTexture(ds));
    this.detail.anisotropy = this.hq ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 2;
    this._setupWorld();
    this.mat = withDetail(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.0, envMapIntensity: 0.7 }), this.detail);
    this.glassMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.04, metalness: 0.35, transparent: true, opacity: 0.34, depthWrite: false, envMapIntensity: 1.4 });
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
    this.traverse = [];
  }

  _setupWorld() {
    const S = this.scene, hq = this.hq, R = this.renderer;
    // sky: rendered once into a cube (background) and a prefiltered environment map (image-based lighting)
    const sky = new Sky(); sky.scale.setScalar(1000);
    const u = sky.material.uniforms;
    u.turbidity.value = 4.2; u.rayleigh.value = 1.25; u.mieCoefficient.value = 0.0045; u.mieDirectionalG.value = 0.87;
    u.sunPosition.value.copy(SUN_DIR).multiplyScalar(1000);
    // the analytic sun disc is ~1e4 bright: it overflows half floats (Inf -> NaN in IBL and bloom), so it is
    // left out of both bakes and drawn as a sprite instead
    if (u.showSunDisc) u.showSunDisc.value = false;
    const skyScene = new THREE.Scene(); skyScene.add(sky);
    this.cubeRT = new THREE.WebGLCubeRenderTarget(hq ? 512 : 256, { type: THREE.HalfFloatType });
    new THREE.CubeCamera(1, 3000, this.cubeRT).update(R, skyScene);
    S.background = this.cubeRT.texture;
    const pm = new THREE.PMREMGenerator(R);
    this.envRT = pm.fromScene(skyScene, 0.03, 1, 3000, { size: hq ? 256 : 128 });
    pm.dispose(); sky.geometry.dispose(); sky.material.dispose();
    const sun = new THREE.Mesh(new THREE.CircleGeometry(14, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 0.96, 0.86).multiplyScalar(6), fog: false, toneMapped: true }));
    sun.position.copy(SUN_DIR).multiplyScalar(800); sun.lookAt(0, 0, 0); sun.renderOrder = -5; S.add(sun);
    S.environment = this.envRT.texture; S.environmentIntensity = 0.55;
    S.fog = new THREE.Fog(0xbfcad3, 70, 420);
    S.add(new THREE.HemisphereLight(0xdde8ff, 0x8a7a66, 0.22));
    const d = new THREE.DirectionalLight(0xffeed6, 3.3);
    d.castShadow = true;
    const ms = hq ? 4096 : 1024; d.shadow.mapSize.set(ms, ms);
    this.shadowExt = hq ? 46 : 30;
    const sc = d.shadow.camera; sc.left = -this.shadowExt; sc.right = this.shadowExt; sc.top = this.shadowExt; sc.bottom = -this.shadowExt; sc.near = 1; sc.far = 220;
    d.shadow.bias = -0.0003; d.shadow.normalBias = hq ? 0.025 : 0.05; d.shadow.radius = hq ? 2.2 : 1;
    S.add(d); S.add(d.target);
    this.sun = d; this.followShadow(new THREE.Vector3(0, 0, 0));
    this._ground();
    const def = this.sim.def;
    if (def.skyline) this._skyline(def.skyline);
  }
  followShadow(p) {
    const texel = (2 * this.shadowExt) / this.sun.shadow.mapSize.x;
    const x = Math.round(p.x / texel / 8) * texel * 8, z = Math.round(p.z / texel / 8) * texel * 8;
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x + SUN_DIR.x * 110, SUN_DIR.y * 110, z + SUN_DIR.z * 110);
  }

  _ground() {
    const S = this.scene, def = this.sim.def;
    const at = asphaltTex(); at.repeat.set(70, 70);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(700, 700), new THREE.MeshStandardMaterial({ map: at, roughness: 0.95, metalness: 0, envMapIntensity: 0.35 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; S.add(ground);
    const pos = [], col = [];
    const quad = (x0, z0, x1, z1, hex, y = 0.008) => {
      tmpC.setHex(hex);
      pos.push(x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0);
      for (let i = 0; i < 6; i++) col.push(tmpC.r, tmpC.g, tmpC.b);
    };
    const st = def.street;
    if (st) {
      quad(st.x0, st.z0 + 0.25, st.x1, st.z0 + 0.4, 0xe9e6dd); quad(st.x0, st.z1 - 0.4, st.x1, st.z1 - 0.25, 0xe9e6dd);
      const zc = (st.z0 + st.z1) / 2;
      for (let x = st.x0 + 1; x < st.x1 - 3; x += 7) if (!st.crossings.some((c) => Math.abs(x + 1.5 - c) < 4.5)) quad(x, zc - 0.08, x + 3, zc + 0.08, 0xf0d25a);
      for (const cx of st.crossings) for (let z = st.z0 + 0.8; z < st.z1 - 1; z += 1.0) quad(cx - 2.2, z, cx + 2.2, z + 0.5, 0xeeebe2);
    } else {
      for (const z of [12.5, -14]) quad(-45, z - 0.12, 45, z + 0.12, 0xf2d24b);
    }
    if (pos.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
      m.receiveShadow = true; S.add(m);
    }
  }

  _skyline(boxes) {
    const P = [], N = [], U = [], C = [], I = [];
    const face = (o, ex, ey, n, w, h, color, roof) => {
      const b = P.length / 3;
      for (const [a, c] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        P.push(o[0] + ex[0] * a + ey[0] * c, o[1] + ex[1] * a + ey[1] * c, o[2] + ex[2] * a + ey[2] * c);
        N.push(n[0], n[1], n[2]);
        if (roof) U.push(0.02, 0.02); else U.push((a * w) / 6, (c * h) / 6);
        tmpC.setHex(color); if (roof) tmpC.multiplyScalar(0.62); C.push(tmpC.r, tmpC.g, tmpC.b);
      }
      I.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    for (const bx of boxes) {
      const [x0, y0, z0] = bx.min, [x1, y1, z1] = bx.max, w = x1 - x0, d = z1 - z0, h = y1 - y0, c = bx.color;
      face([x0, y0, z1], [w, 0, 0], [0, h, 0], [0, 0, 1], w, h, c);
      face([x1, y0, z0], [-w, 0, 0], [0, h, 0], [0, 0, -1], w, h, c);
      face([x1, y0, z1], [0, 0, -d], [0, h, 0], [1, 0, 0], d, h, c);
      face([x0, y0, z0], [0, 0, d], [0, h, 0], [-1, 0, 0], d, h, c);
      face([x0, y1, z1], [w, 0, 0], [0, 0, -d], [0, 1, 0], w, d, c, true);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); g.setIndex(I);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: windowTex(), vertexColors: true, roughness: 0.6, metalness: 0.05, envMapIntensity: 1.0 }));
    m.receiveShadow = true; this.scene.add(m);
  }

  // precompute per-fragment vertex data (shard-local) + base colours + detail uv/layer
  _prepShards() {
    const st = this.st;
    for (const s of st.shards) {
      const m = st.modules[s.mod];
      const ntri = s.triSide.length;
      const col = new Float32Array(ntri * 9), uv = new Float32Array(ntri * 6), lay = new Uint8Array(ntri * 3), nrm = new Float32Array(ntri * 9);
      const core = new THREE.Color().setHex(s.def.core).multiplyScalar(s.tint);
      for (let t = 0; t < ntri; t++) {
        const side = s.triSide[t];
        const c = side >= 0 ? tmpC.setHex(m.colors[side]).multiplyScalar(0.97 + (s.tint - 1) * 0.35) : core;
        const L = layerFor(m, side), sc = UV_SCALE[L % EMISSIVE];
        const nx = s.triN[t * 3], ny = s.triN[t * 3 + 1], nz = s.triN[t * 3 + 2];
        const ax = Math.abs(nx) >= Math.abs(ny) ? (Math.abs(nx) >= Math.abs(nz) ? 0 : 2) : (Math.abs(ny) >= Math.abs(nz) ? 1 : 2);
        for (let k = 0; k < 3; k++) {
          const i = t * 9 + k * 3, j = (t * 3 + k) * 2;
          col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b;
          nrm[i] = nx; nrm[i + 1] = ny; nrm[i + 2] = nz;
          const wx = s.tri[i] + s.c[0], wy = s.tri[i + 1] + s.c[1], wz = s.tri[i + 2] + s.c[2];
          const uu = ax === 0 ? wz : wx, vv = ax === 1 ? wz : wy;
          uv[j] = uu * sc; uv[j + 1] = vv * sc;
          lay[t * 3 + k] = L;
        }
      }
      s.vcol = col; s.vnrm = nrm; s.vuv = uv; s.vlay = lay; s.scorch = 1;
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
      const g = new THREE.BufferGeometry(), n = ch.verts;
      const dyn = (a, k) => new THREE.BufferAttribute(a, k).setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('position', dyn(new Float32Array(n * 3), 3));
      g.setAttribute('normal', dyn(new Float32Array(n * 3), 3));
      g.setAttribute('color', dyn(new Float32Array(n * 3), 3));
      if (!ch.glass) { g.setAttribute('tuv', dyn(new Float32Array(n * 2), 2)); g.setAttribute('tmat', dyn(new Uint8Array(n), 1)); }
      const mesh = new THREE.Mesh(g, ch.glass ? this.glassMat : this.mat);
      mesh.castShadow = !ch.glass; mesh.receiveShadow = true;
      ch.mesh = mesh; this.scene.add(mesh);
      this._fillChunk(ch);
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

  _fillChunk(ch) {
    const st = this.st;
    const g = ch.mesh.geometry, A = g.attributes;
    const P = A.position.array, N = A.normal.array, C = A.color.array, UV = A.tuv ? A.tuv.array : null, T = A.tmat ? A.tmat.array : null;
    let o = 0;
    const override = this.mode !== 'normal';
    for (const sid of ch.shards) {
      const s = st.shards[sid];
      if (s.state !== STATIC) continue;
      const Tr = s.tri, n = Tr.length;
      for (let i = 0; i < n; i += 3) { P[o + i] = Tr[i] + s.c[0]; P[o + i + 1] = Tr[i + 1] + s.c[1]; P[o + i + 2] = Tr[i + 2] + s.c[2]; }
      N.set(s.vnrm, o);
      const oc = override ? this._shardColor(s, tmpC) : null;
      if (oc) { const shade = s.vcol; for (let i = 0; i < n; i += 3) { const lum = 0.75 + 0.25 * (shade[i] + shade[i + 1] + shade[i + 2]) / 3; C[o + i] = oc.r * lum; C[o + i + 1] = oc.g * lum; C[o + i + 2] = oc.b * lum; } }
      else C.set(s.vcol, o);
      if (UV) { UV.set(s.vuv, (o / 3) * 2); T.set(s.vlay, o / 3); if (override) T.fill(LAYER.paint, o / 3, o / 3 + n / 3); }
      o += n;
    }
    g.setDrawRange(0, o / 3);
    for (const [k, w] of [['position', 3], ['normal', 3], ['color', 3], ['tuv', 2], ['tmat', 1]]) {
      const a = A[k]; if (!a) continue;
      a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(w, (o / 3) * w)); a.needsUpdate = true;
    }
  }

  setMode(mode) { this.mode = mode; for (const ch of this.chunks) this._fillChunk(ch); for (const rec of this.sim.bodies.values()) rec.dirty = true; }

  _bodyGeometry(rec, glass) {
    const st = this.st;
    let nv = 0;
    for (const id of rec.shards) { const s = st.shards[id]; if (s.state === DYNAMIC && s.body === rec && !!s.glass === glass) nv += s.triSide.length * 3; }
    if (!nv) return null;
    const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), C = new Float32Array(nv * 3);
    const UV = glass ? null : new Float32Array(nv * 2), T = glass ? null : new Uint8Array(nv);
    const q = new THREE.Quaternion(), v = new THREE.Vector3();
    let o = 0;
    for (const id of rec.shards) {
      const s = st.shards[id]; if (s.state !== DYNAMIC || s.body !== rec || !!s.glass !== glass) continue;
      q.set(s.lq[0], s.lq[1], s.lq[2], s.lq[3]);
      const Tr = s.tri;
      for (let i = 0; i < Tr.length; i += 3) {
        v.set(Tr[i], Tr[i + 1], Tr[i + 2]).applyQuaternion(q); P[o + i] = v.x + s.lp[0]; P[o + i + 1] = v.y + s.lp[1]; P[o + i + 2] = v.z + s.lp[2];
        v.set(s.vnrm[i], s.vnrm[i + 1], s.vnrm[i + 2]).applyQuaternion(q); N[o + i] = v.x; N[o + i + 1] = v.y; N[o + i + 2] = v.z;
      }
      const oc = this.mode !== 'normal' && this.mode !== 'stress' && this.mode !== 'nodes' ? this._shardColor(s, tmpC) : null;
      if (oc) for (let i = 0; i < Tr.length; i += 3) { C[o + i] = oc.r; C[o + i + 1] = oc.g; C[o + i + 2] = oc.b; } else C.set(s.vcol, o);
      if (UV) { UV.set(s.vuv, (o / 3) * 2); T.set(s.vlay, o / 3); }
      o += Tr.length;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('color', new THREE.BufferAttribute(C, 3));
    if (UV) { g.setAttribute('tuv', new THREE.BufferAttribute(UV, 2)); g.setAttribute('tmat', new THREE.BufferAttribute(T, 1)); }
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

  // explosions blacken what they touch (fragment colours are multiplied down, debris inherits the soot)
  scorch(p, R) {
    const st = this.st, R2 = R * 1.45;
    for (const s of st.shards) {
      if (s.state === DEAD || s.fixed || s.glass) continue;
      const c = s.state === DYNAMIC ? this.sim.shardPos(s) : s.c;
      const dx = c[0] - p[0], dy = c[1] - p[1], dz = c[2] - p[2];
      if (Math.abs(dx) > R2 + s.r || Math.abs(dy) > R2 + s.r || Math.abs(dz) > R2 + s.r) continue;
      const d = Math.max(0, Math.hypot(dx, dy, dz) - s.r * 0.7);
      if (d >= R2) continue;
      const nv = Math.max(0.2, s.scorch * (0.34 + 0.66 * Math.pow(d / R2, 0.75))), ratio = nv / s.scorch;
      if (ratio > 0.985) continue;
      s.scorch = nv;
      const v = s.vcol; for (let i = 0; i < v.length; i++) v[i] *= ratio;
      if (s.state === STATIC) this.sim.dirtyChunks.add(st.modules[s.mod].chunk); else if (s.body) s.body.dirty = true;
    }
  }

  _buildProps() {
    this.canGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.9, 18);
    const cg = this.canGeo, cc = [];
    for (let i = 0; i < cg.attributes.position.count; i++) { const y = cg.attributes.position.getY(i); (Math.abs(y) < 0.1 ? tmpC.setHex(0xf3efe6) : y > 0.4 ? tmpC.setHex(0x2a2d31) : tmpC.setHex(0xd8261f)); cc.push(tmpC.r, tmpC.g, tmpC.b); }
    cg.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3));
    this.canMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.35 });
    this.ballMat = new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.3, metalness: 0.9 });
    const padMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.5, metalness: 0.2 });
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x111316, emissive: 0xffc21a, emissiveIntensity: 1.6, roughness: 0.4 });
    for (const pr of this.sim.props) {
      if (pr.type === 'pad') {
        const y = pr.p[1];
        const m = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.25, 0.18, 28), padMat);
        m.position.set(pr.p[0], y + 0.09, pr.p[2]); m.receiveShadow = true; m.castShadow = true; this.scene.add(m);
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.72, 0.88, 32), ringMat);
        ring.rotation.x = -Math.PI / 2; ring.position.set(pr.p[0], y + 0.185, pr.p[2]); this.scene.add(ring);
        const tri = new THREE.Mesh(new THREE.CircleGeometry(0.45, 3), new THREE.MeshStandardMaterial({ color: 0x1b1e22, roughness: 0.7 }));
        tri.rotation.x = -Math.PI / 2; tri.position.set(pr.p[0], y + 0.186, pr.p[2]); this.scene.add(tri);
      } else this._propMesh(pr);
    }
  }
  _propMesh(pr) {
    let m = null;
    if (pr.type === 'canister') m = new THREE.Mesh(this.canGeo, this.canMat);
    else if (pr.type === 'ball') m = new THREE.Mesh(this._ballGeo || (this._ballGeo = new THREE.SphereGeometry(1.1, 28, 18)), this.ballMat);
    if (!m) return;
    m.castShadow = true; m.receiveShadow = true;
    this.propMeshes.set(pr, m); this.scene.add(m);
  }

  // ziplines (cable + yellow masts) and ladders, hidden once the fragment they are bolted to is gone
  buildTraverse(lines, ladders) {
    const steel = new THREE.MeshStandardMaterial({ color: 0x24282d, roughness: 0.35, metalness: 0.85 });
    const mast = new THREE.MeshStandardMaterial({ color: 0xffc928, roughness: 0.5, metalness: 0.3 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.6, metalness: 0.4 });
    const up = new THREE.Vector3(0, 1, 0);
    for (const l of lines) {
      const g = new THREE.Group();
      const dir = new THREE.Vector3(l.ab[0], l.ab[1], l.ab[2]).normalize();
      const cab = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, l.L, 6, 1), steel);
      cab.position.set((l.a[0] + l.b[0]) / 2, (l.a[1] + l.b[1]) / 2, (l.a[2] + l.b[2]) / 2); cab.quaternion.setFromUnitVectors(up, dir); cab.castShadow = true;
      g.add(cab);
      for (const [end, mid] of [[l.a, l.ma], [l.b, l.mb]]) {
        const base = mid >= 0 ? this.st.modules[mid].max[1] : 0, h = end[1] + 0.35 - base;
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, h, 10), mast);
        pole.position.set(end[0], base + h / 2, end[2]); pole.castShadow = true; g.add(pole);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.34), dark); head.position.set(end[0], end[1] + 0.2, end[2]); g.add(head);
        const foot = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.5), dark); foot.position.set(end[0], base + 0.04, end[2]); g.add(foot);
      }
      this.scene.add(g); this.traverse.push({ obj: l, g });
    }
    for (const L of ladders) {
      const parts = [], h = L.y1 - L.y0, ox = L.p[0] + L.n[0] * 0.08, oz = L.p[1] + L.n[1] * 0.08;
      for (const s of [-1, 1]) { const b = new THREE.BoxGeometry(0.06, h, 0.06); b.translate(ox + L.t[0] * 0.27 * s, L.y0 + h / 2, oz + L.t[1] * 0.27 * s); parts.push(b); }
      for (let y = L.y0 + 0.3; y < L.y1 - 0.05; y += 0.3) {
        const r = new THREE.CylinderGeometry(0.022, 0.022, 0.54, 6); r.rotateZ(Math.PI / 2); if (Math.abs(L.t[1]) > 0.5) r.rotateY(Math.PI / 2);
        r.translate(ox, y, oz); parts.push(r);
      }
      const m = new THREE.Mesh(mergeGeometries(parts.map((p) => p.toNonIndexed())), mast);
      parts.forEach((p) => p.dispose());
      m.castShadow = true; m.receiveShadow = true;
      this.scene.add(m); this.traverse.push({ obj: L, g: m });
    }
  }

  _buildPiles() {
    const P = this.sim.piles;
    const g = new THREE.PlaneGeometry(P.sx, P.sz, P.ncols, P.nrows);
    g.rotateX(-Math.PI / 2);
    const cols = new Float32Array(g.attributes.position.count * 3);
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const n = g.attributes.position.count, uv = new Float32Array(n * 2), lay = new Uint8Array(n).fill(LAYER.core);
    for (let i = 0; i < n; i++) { uv[i * 2] = g.attributes.position.getX(i) * 0.9; uv[i * 2 + 1] = g.attributes.position.getZ(i) * 0.9; }
    g.setAttribute('tuv', new THREE.BufferAttribute(uv, 2)); g.setAttribute('tmat', new THREE.BufferAttribute(lay, 1));
    const mat = withDetail(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1 }), this.detail);
    this.pileMesh = new THREE.Mesh(g, mat);
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
      tmpC.setRGB(0.5 + 0.08 * k, 0.48 + 0.05 * k, 0.45 + 0.02 * k); col.setXYZ(i, tmpC.r, tmpC.g, tmpC.b);
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
    this.graphLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.85, fog: false }));
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
      case 'boom': this.scorch(ev.p, ev.R); break;
      case 'body+': this._syncBody(ev.body); break;
      case 'body-': { const g = this.bodyMeshes.get(ev.body.id); if (g) { for (const c of g.children) c.geometry.dispose(); this.scene.remove(g); this.bodyMeshes.delete(ev.body.id); } break; }
      case 'body~': ev.body.dirty = true; break;
      case 'prop+': this._propMesh(ev.prop); break;
      case 'prop-': { const m = this.propMeshes.get(ev.prop); if (m) { this.scene.remove(m); this.propMeshes.delete(ev.prop); } break; }
      case 'strain': if (this.mode !== 'normal' && this.mode !== 'fragments' && this.mode !== 'groups') this._regionRecolor.add(ev.region); this.graphDirty = true; break;
      default: break;
    }
  }

  update(alpha, focus) {
    const sim = this.sim;
    if (!this._regionRecolor) this._regionRecolor = new Set();
    if (focus) this.followShadow(focus);
    // static chunks (budgeted)
    let budget = 6;
    for (const id of sim.dirtyChunks) { if (budget-- <= 0) break; this._fillChunk(this.chunks[id]); sim.dirtyChunks.delete(id); }
    if (this._regionRecolor.size) { for (const ch of this.chunks) { const s0 = this.st.shards[ch.shards[0]]; if (this._regionRecolor.has(s0.region)) this._fillChunk(ch); } this._regionRecolor.clear(); }
    const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
    let rebuilt = 0;
    for (const rec of sim.bodies.values()) {
      if (!this.bodyMeshes.has(rec.id) || (rec.dirty && rebuilt++ < 40)) this._syncBody(rec);
      const g = this.bodyMeshes.get(rec.id);
      const a = rec.prevP, b = rec.curP;
      g.position.set(a[0] + (b[0] - a[0]) * alpha, a[1] + (b[1] - a[1]) * alpha, a[2] + (b[2] - a[2]) * alpha);
      qa.set(rec.prevQ[0], rec.prevQ[1], rec.prevQ[2], rec.prevQ[3]); qb.set(rec.curQ[0], rec.curQ[1], rec.curQ[2], rec.curQ[3]);
      g.quaternion.copy(qa).slerp(qb, alpha);
    }
    for (const [pr, m] of this.propMeshes) { const t = pr.rb.translation(), q = pr.rb.rotation(); m.position.set(t.x, t.y, t.z); m.quaternion.set(q.x, q.y, q.z, q.w); }
    for (const t of this.traverse) t.g.visible = t.obj.alive;
    this._syncPiles();
    this._syncLines(alpha);
    if (this.graph && this.graphDirty) this._rebuildGraph();
  }

  dispose() {
    this.scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material !== this.mat) { const ms = Array.isArray(o.material) ? o.material : [o.material]; for (const m of ms) if (!m.map || !Object.values(cache).includes(m.map)) m.dispose(); } });
    this.mat.dispose(); this.glassMat.dispose();
    this.cubeRT.dispose(); this.envRT.dispose();
  }
}
