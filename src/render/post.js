// "High" quality post chain: MSAA scene target -> GTAO (contact shadows in corners, under slabs and debris)
// -> soft bloom (explosions, screens, sun glints) -> ACES output. Low quality renders straight to the screen.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer; this.camera = camera;
    const size = renderer.getSize(new THREE.Vector2()), pr = renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType, samples: renderer.capabilities.isWebGL2 ? 4 : 0 });
    this.composer = new EffectComposer(renderer, rt);
    this.render0 = new RenderPass(scene, camera);
    this.ao = new GTAOPass(scene, camera, size.x * pr, size.y * pr);
    this.ao.blendIntensity = 0.9;
    this.ao.updateGtaoMaterial({ radius: 0.55, distanceExponent: 1.6, thickness: 1.2, scale: 1.0, samples: 12, distanceFallOff: 1.0 });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    // linear HDR input: sunlit walls sit around 1, the sky up to ~3, so only fire, screens and the sun bloom
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x * pr * 0.5, size.y * pr * 0.5), 0.22, 0.4, 3.2);
    this.out = new OutputPass();
    for (const p of [this.render0, this.ao, this.bloom, this.out]) this.composer.addPass(p);
    this.setSize(size.x, size.y);
  }
  setScene(scene) { this.render0.scene = scene; this.ao.scene = scene; }
  setSize(w, h) { this.composer.setPixelRatio(this.renderer.getPixelRatio()); this.composer.setSize(w, h); }
  setAO(on) { this.ao.enabled = on; }
  render(dt) { this.composer.render(dt); }
  dispose() { this.composer.dispose(); this.ao.dispose?.(); this.bloom.dispose?.(); }
}
