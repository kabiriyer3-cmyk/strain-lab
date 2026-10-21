// Procedural, seamlessly tiling detail textures (no image assets): one RGBA8 DataArrayTexture, one layer per
// surface type. RGB multiplies the vertex colour (0.5 = neutral), A modulates roughness (0.5 = neutral).
import * as THREE from 'three';

export const LAYER = { paint: 0, concrete: 1, brick: 2, wood: 3, metal: 4, core: 5, tiles: 6, hazard: 7, roof: 8 };
export const EMISSIVE = 16; // add to a layer index to make the surface glow (screens)
// texture repeats per metre, baked into the per-vertex uv
export const UV_SCALE = [0.5, 0.42, 0.85, 0.6, 0.8, 0.9, 0.5, 1.2, 0.35];
const NL = 9;

function hash(x, y, s) { let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0; h = (h ^ (h >>> 13)) * 1274126177; h ^= h >>> 16; return (h >>> 0) / 4294967296; }
// periodic value noise: period p (lattice cells across the tile)
function vnoise(u, v, p, s) {
  const x = u * p, y = v * p, xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const m = (a) => ((a % p) + p) % p;
  const a = hash(m(xi), m(yi), s), b = hash(m(xi + 1), m(yi), s), c = hash(m(xi), m(yi + 1), s), d = hash(m(xi + 1), m(yi + 1), s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(u, v, p, oct, s) { let t = 0, w = 0.5, n = 0; for (let o = 0; o < oct; o++) { t += vnoise(u, v, p << o, s + o * 31) * w; n += w; w *= 0.5; } return t / n; }
const clamp = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

function layerPixel(L, u, v, S) {
  // returns [r, g, b, a] in 0..1
  switch (L) {
    case 0: { // paint / plaster: soft mottling + faint vertical rain streaks
      const n = fbm(u, v, 4, 4, 11), st = vnoise(u * 1, v * 0.08, 24, 5);
      const g = 0.5 + (n - 0.5) * 0.08 - Math.max(0, st - 0.66) * 0.05;
      return [g, g, g * 0.995, 0.5 + (n - 0.5) * 0.2];
    }
    case 1: { // exposed concrete: formwork panels, tie holes, pores, stains
      const n = fbm(u, v, 4, 5, 21), fine = vnoise(u, v, 128, 3);
      let g = 0.47 + (n - 0.5) * 0.16 + (fine - 0.5) * 0.06;
      const pv = (v * 4) % 1, pu = (u * 2) % 1;
      if (pv < 0.008 || pu < 0.004) g -= 0.06;                                   // panel joints
      const tu = (u * 4 + 0.5) % 1, tv = (v * 4 + 0.5) % 1;
      if ((tu - 0.5) ** 2 + (tv - 0.5) ** 2 < 0.0009) g -= 0.18;                // tie holes
      if (hash(Math.floor(u * 256), Math.floor(v * 256), 9) > 0.985) g -= 0.12; // pores
      g -= Math.max(0, vnoise(u, v * 0.3, 8, 77) - 0.62) * 0.25;                // stains
      return [g, g * 0.99, g * 0.97, 0.55 + (n - 0.5) * 0.3];
    }
    case 2: { // brick: 16 courses x 5 bricks, running bond
      const rows = 16, row = Math.floor(v * rows), fv = v * rows - row;
      const off = row % 2 ? 0.5 : 0, cu = u * 5 + off, col = Math.floor(cu), fu = cu - col;
      const mortar = fv < 0.11 || fu < 0.035;
      const tone = hash(((col % 5) + 5) % 5, row, 13), n = fbm(u, v, 8, 3, 41);
      if (mortar) { const g = 0.62 + (n - 0.5) * 0.08; return [g, g * 0.98, g * 0.94, 0.75]; }
      const g = 0.43 + tone * 0.12 + (n - 0.5) * 0.12;
      return [g * 1.04, g * 0.97, g * 0.92, 0.55];
    }
    case 3: { // wood planks along u with grain, gaps and staggered butt joints
      const planks = 10, pl = Math.floor(v * planks), fv = v * planks - pl;
      const joint = (u + hash(pl, 1, 5)) % 1;
      const grain = vnoise(u * 0.25 + hash(pl, 2, 6), v * 4, 64, 7);
      const ring = Math.sin((v * planks * 6 + grain * 5 + u * 3) * Math.PI) * 0.5 + 0.5;
      let g = 0.46 + (hash(pl, 3, 8) - 0.5) * 0.14 + (ring - 0.5) * 0.09 + (fbm(u, v, 8, 3, 9) - 0.5) * 0.08;
      if (fv < 0.05 || joint < 0.006) g -= 0.2;
      return [g * 1.03, g, g * 0.95, 0.6 + (ring - 0.5) * 0.2];
    }
    case 4: { // brushed metal with panel seams
      const br = vnoise(u * 0.5, v * 16, 32, 15), n = fbm(u, v, 4, 3, 17);
      let g = 0.5 + (br - 0.5) * 0.07 + (n - 0.5) * 0.08;
      if ((u * 2) % 1 < 0.006 || (v * 2) % 1 < 0.006) g -= 0.12;
      return [g, g, g * 1.01, 0.3 + (n - 0.5) * 0.25];
    }
    case 5: { // fracture surface: rubble, aggregate speckles
      const n = fbm(u, v, 8, 5, 51), sp = hash(Math.floor(u * 128), Math.floor(v * 128), 61);
      let g = 0.5 + (n - 0.5) * 0.42;
      if (sp > 0.93) g += 0.14; else if (sp < 0.06) g -= 0.16;
      return [g, g * 0.98, g * 0.95, 0.85];
    }
    case 6: { // square pavers 5x5 with grout and wear
      const cu = u * 5, cv = v * 5, iu = Math.floor(cu), iv = Math.floor(cv), fu = cu - iu, fv = cv - iv;
      const e = Math.min(fu, fv, 1 - fu, 1 - fv);
      const n = fbm(u, v, 8, 4, 71), tone = hash(iu, iv, 73);
      let g = 0.5 + (tone - 0.5) * 0.1 + (n - 0.5) * 0.12;
      if (e < 0.025) g = 0.3 + n * 0.1; else if (e < 0.06) g -= 0.04;
      return [g, g * 0.99, g * 0.97, e < 0.025 ? 0.8 : 0.6];
    }
    case 7: { // hazard chevrons: 45 degree yellow/black stripes, grimy
      const s = ((u + v) * 4) % 1, n = fbm(u, v, 4, 4, 81);
      const y = s < 0.5;
      const dirt = (n - 0.5) * 0.12 - Math.max(0, vnoise(u, v, 16, 83) - 0.7) * 0.3;
      return y ? [clamp(0.5 + dirt), clamp(0.41 + dirt), clamp(0.06 + dirt * 0.3), 0.55] : [clamp(0.06 + dirt * 0.3), clamp(0.06 + dirt * 0.3), clamp(0.065 + dirt * 0.3), 0.5];
    }
    case 8: { // roof: bitumen + gravel
      const n = fbm(u, v, 4, 4, 91), sp = hash(Math.floor(u * 256), Math.floor(v * 256), 93);
      let g = 0.47 + (n - 0.5) * 0.12 + (sp - 0.5) * 0.12;
      return [g, g * 0.99, g * 0.98, 0.75];
    }
    default: return [0.5, 0.5, 0.5, 0.5];
  }
}

export function makeDetailTexture(size = 256) {
  const data = new Uint8Array(size * size * NL * 4);
  for (let L = 0; L < NL; L++) for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const p = layerPixel(L, x / size, y / size, size);
    const o = ((L * size + y) * size + x) * 4;
    data[o] = clamp(p[0]) * 255; data[o + 1] = clamp(p[1]) * 255; data[o + 2] = clamp(p[2]) * 255; data[o + 3] = clamp(p[3]) * 255;
  }
  const tex = new THREE.DataArrayTexture(data, size, size, NL);
  tex.format = THREE.RGBAFormat; tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true; tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// Patch a MeshStandardMaterial so it reads per-vertex `tuv` (box-projected rest-space uv) and `tmat` (layer).
export function withDetail(mat, tex, strength = 1) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: tex }; sh.uniforms.detailMix = { value: strength };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 tuv; attribute float tmat; varying vec2 vTuv; varying float vTmat;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTuv = tuv; vTmat = tmat;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform highp sampler2DArray detailMap; uniform float detailMix; varying vec2 vTuv; varying float vTmat;')
      .replace('#include <color_fragment>', '#include <color_fragment>\nfloat dLayer = mod(vTmat + 0.5, 16.0) - 0.5; vec4 dTex = texture(detailMap, vec3(vTuv, floor(dLayer + 0.5)));\ndiffuseColor.rgb *= mix(vec3(1.0), dTex.rgb * 2.0, detailMix);')
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor * mix(1.0, 0.45 + dTex.a * 1.1, detailMix), 0.04, 1.0);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\nif (vTmat > 15.5) totalEmissiveRadiance += diffuseColor.rgb * 1.6;');
  };
  mat.customProgramCacheKey = () => 'detail-v1';
  return mat;
}
