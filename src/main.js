// STRAIN LAB - THE FINALS-style destruction, rebuilt for the browser.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Sim, DT } from './sim/sim.js';
import { SCENES } from './core/scenes.js';
import { View, VIEW_MODES, VIEW_LABEL, scorchTex } from './render/view.js';
import { FX } from './render/fx.js';
import { Post } from './render/post.js';
import { Audio } from './game/audio.js';
import { Player } from './game/player.js';
import { Weapons, WEAPONS } from './game/weapons.js';
import { HUD } from './game/hud.js';
import { Touch } from './game/touch.js';
import { STATIC } from './core/structure.js';

/* global __STRAIN_WORKER__ */
const params = new URLSearchParams(location.search);
const workerFactory = typeof __STRAIN_WORKER__ !== 'undefined' && params.get('worker') !== '0'
  ? () => new Worker(URL.createObjectURL(new Blob([__STRAIN_WORKER__], { type: 'text/javascript' })))
  : null;
const mq = (q) => window.matchMedia && window.matchMedia(q).matches;
const TOUCH = params.get('touch') === '1' || (params.get('touch') !== '0' && (mq('(pointer: coarse)') || (navigator.maxTouchPoints > 0 && !mq('(pointer: fine)'))));
const KEYS = { KeyB: 'view', KeyG: 'graph', KeyT: 'slow', KeyP: 'phys', KeyV: 'fly', KeyR: 'reset', KeyM: 'mute', KeyF: 'alt', KeyH: 'help' };

class Game {
  constructor() {
    this.canvas = document.getElementById('c');
    this.touch = TOUCH;
    this.quality = params.get('quality') || localStorage.getItem('sl-quality') || (TOUCH ? 'low' : 'high');
    this.hq = this.quality === 'high';
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.pr = Math.min(window.devicePixelRatio || 1, this.hq ? 1.75 : TOUCH ? 1.5 : 1);
    this.renderer.setPixelRatio(this.pr);
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = this.hq ? 0.8 : 0.82;
    this.camera = new THREE.PerspectiveCamera(74, 1, 0.05, 900);
    this.audio = new Audio({ lite: !this.hq });
    this.hud = new HUD(document.getElementById('hud'));
    this.hud.setTouch(TOUCH); this.hud.onSelect = (i) => this.selectWeapon(i);
    this.input = { keys: {}, pressed: {}, lmb: false, lmbPressed: false, rmbPressed: false, move: null, sprint: false, jumpPressed: false, jumpHeld: false, usePressed: false };
    this.timeScale = 1; this.paused = false; this.physMs = 0; this.fps = 60; this.acc = 0; this.lastT = performance.now();
    this.running = false; this.modeIdx = 0; this.graph = false; this.orbit = 0;
    this.adapt = { on: params.get('adapt') !== '0', t: 0, low: 0 };
    this.projMeshes = new Map();
    if (TOUCH) { document.body.classList.add('touch'); this.touchUI = new Touch(this); }
    this._bindInput(); this._bindMenu();
    window.addEventListener('resize', () => this._resize());
    this.frame = this.frame.bind(this);
  }
  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.fov = w < h ? 88 : h < 500 ? 78 : 74; this.camera.updateProjectionMatrix();
    if (this.fx) this.fx.setScale(h * this.renderer.getPixelRatio());
    if (this.post) this.post.setSize(w, h);
  }

  load(key) {
    this.sceneKey = key;
    if (this.sim) { this.sim.dispose(); this.view.dispose(); for (const m of this.projMeshes.values()) this.view.scene.remove(m); this.projMeshes.clear(); this.audio.zip(false); }
    const t0 = performance.now();
    this.sim = new Sim(RAPIER, key, { workerFactory, fracScale: this.hq ? 1 : 0.6, maxBodies: this.hq ? 520 : 240 });
    this.view = new View(this.renderer, this.sim, { quality: this.quality });
    this.view.scene.add(this.camera);
    this.fx = new FX(this.view.scene, this.sim.piles, { lite: !this.hq, scorch: scorchTex(), hdr: this.hq ? 2.2 : 1 });
    const d = this.sim.def;
    this.player = new Player(this.sim, d.spawn, d.look);
    this.view.buildTraverse(this.player.lines, this.player.ladders);
    this.prevEye = this.player.eyePos();
    if (this.weapons) this.camera.remove(this.weapons.holder);
    const keep = this.weapons ? this.weapons.index : 0;
    this.weapons = new Weapons(this); this.weapons.select(keep); this.hud.setWeapon(this.weapons.index, this.weapons.current);
    this.hud.setScene(SCENES[key].title);
    this.view.setMode(VIEW_MODES[this.modeIdx]); this.view.setGraph(this.graph);
    if (this.hq) {
      try { if (this.post) this.post.setScene(this.view.scene); else this.post = new Post(this.renderer, this.view.scene, this.camera); }
      catch (e) { console.warn('[strain-lab] post-processing unavailable:', e); this.post = null; }
    }
    this._resize();
    this.loadMs = performance.now() - t0;
    console.log(`[strain-lab] ${key}: ${this.sim.st.shards.length} fragments, ${this.sim.st.bonds.length} bonds, ${this.sim.st.regions.length} strain groups, built in ${this.loadMs.toFixed(0)} ms, strain=${this.sim.strain.backend}, quality=${this.quality}${TOUCH ? ', touch' : ''}`);
    this.acc = 0;
  }

  selectWeapon(i) { if (!this.weapons) return; this.weapons.select(i); this.hud.setWeapon(this.weapons.index, this.weapons.current); }
  action(a) {
    if (!this.sim) return;
    const hud = this.hud;
    switch (a) {
      case 'menu': this.pause(); break;
      case 'view': { this.modeIdx = (this.modeIdx + 1) % VIEW_MODES.length; const m = VIEW_MODES[this.modeIdx]; this.view.setMode(m); hud.setMode('ВИД: ' + VIEW_LABEL[m], m !== 'normal'); break; }
      case 'graph': this.graph = !this.graph; this.view.setGraph(this.graph); hud.toast(this.graph ? 'Граф Strain: связи, опоры, шарниры' : 'Граф скрыт'); break;
      case 'slow': this.timeScale = this.timeScale < 1 ? 1 : 0.25; hud.toast(this.timeScale < 1 ? 'Слоумо ×0.25' : 'Реальное время'); break;
      case 'phys': this.paused = !this.paused; hud.toast(this.paused ? 'Физика на паузе' : 'Физика идёт'); break;
      case 'fly': this.player.setFly(!this.player.fly); this.audio.zip(false); hud.toast(this.player.fly ? (TOUCH ? 'Полёт: ПРЫЖОК держи — вверх' : 'Полёт (Space/C — вверх/вниз)') : 'Ходьба'); break;
      case 'reset': this.load(this.sceneKey); hud.toast('Арена восстановлена'); break;
      case 'mute': this.audio.setMuted(!this.audio.muted); hud.toast(this.audio.muted ? 'Звук выкл' : 'Звук вкл'); break;
      case 'alt': this.weapons.alt(); break;
      case 'help': document.body.classList.toggle('help'); break;
      default: break;
    }
  }

  _bindInput() {
    const I = this.input;
    window.addEventListener('keydown', (e) => {
      if (e.repeat) { I.keys[e.code] = true; return; }
      I.keys[e.code] = true; I.pressed[e.code] = true;
      if (['Space', 'Tab'].includes(e.code)) e.preventDefault();
      if (!this.running) return;
      if (e.code.startsWith('Digit')) { const n = +e.code.slice(5) - 1; if (n >= 0 && n < WEAPONS.length) this.selectWeapon(n); }
      if (KEYS[e.code]) this.action(KEYS[e.code]);
    });
    window.addEventListener('keyup', (e) => { I.keys[e.code] = false; });
    window.addEventListener('blur', () => { I.keys = {}; I.lmb = false; });
    window.addEventListener('mousedown', (e) => { if (!this.running || TOUCH) return; if (e.button === 0) { I.lmb = true; I.lmbPressed = true; } if (e.button === 2) I.rmbPressed = true; });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) I.lmb = false; });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => { if (!this.running) return; this.weapons.cycle(e.deltaY > 0 ? 1 : -1); this.hud.setWeapon(this.weapons.index, this.weapons.current); }, { passive: true });
    document.addEventListener('mousemove', (e) => {
      if (!this.running || document.pointerLockElement !== this.canvas) return;
      const s = 0.0022 * (this.camera.fov / 74); this.player.yaw -= e.movementX * s; this.player.pitch = Math.max(-1.5, Math.min(1.5, this.player.pitch - e.movementY * s));
    });
    document.addEventListener('pointerlockchange', () => { if (document.pointerLockElement !== this.canvas && this.running && !this.noLock) this.pause(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.running) this.pause(); });
    this.canvas.addEventListener('click', () => { if (this.running && !TOUCH && document.pointerLockElement !== this.canvas && !this.noLock) this._lock(); });
  }
  _lock() { try { const r = this.canvas.requestPointerLock(); if (r && r.catch) r.catch(() => { this.noLock = true; this.hud.toast('Мышь не захвачена — смотрите стрелками'); }); } catch (e) { this.noLock = true; } }
  _fullscreen() {
    const d = document.documentElement;
    try {
      if (document.fullscreenElement || !d.requestFullscreen) return;
      const p = d.requestFullscreen({ navigationUI: 'hide' });
      if (p && p.then) p.then(() => { try { const o = screen.orientation && screen.orientation.lock && screen.orientation.lock('landscape'); if (o && o.catch) o.catch(() => {}); } catch (e) { /* not allowed */ } }).catch(() => {});
    } catch (e) { /* iOS Safari: no element fullscreen */ }
  }

  _bindMenu() {
    this.menu = document.getElementById('menu');
    const cards = document.getElementById('scenes');
    cards.innerHTML = Object.entries(SCENES).map(([k, s]) => `<button class="card" data-scene="${k}"><b>${s.title}</b><span>${s.sub}</span></button>`).join('');
    cards.addEventListener('click', (e) => { const b = e.target.closest('[data-scene]'); if (!b) return; this.audio.init(); this.audio.ui(); if (b.dataset.scene !== this.sceneKey) { this._loading(() => this.load(b.dataset.scene)); } this._markScene(); });
    document.getElementById('play').addEventListener('click', () => this.play());
    for (const b of document.querySelectorAll('[data-quality]')) b.addEventListener('click', () => { localStorage.setItem('sl-quality', b.dataset.quality); const q = new URLSearchParams(location.search); q.set('scene', this.sceneKey); q.set('quality', b.dataset.quality); location.search = q.toString(); });
    for (const b of document.querySelectorAll('[data-quality]')) b.classList.toggle('on', b.dataset.quality === this.quality);
  }
  _markScene() { for (const b of document.querySelectorAll('[data-scene]')) b.classList.toggle('on', b.dataset.scene === this.sceneKey); }
  _loading(fn) { document.body.classList.add('loading'); setTimeout(() => { fn(); this._markScene(); document.body.classList.remove('loading'); }, 40); }
  play() {
    this.audio.init(); this.audio.ui(true);
    this.running = true; document.body.classList.add('playing');
    this.noLock = TOUCH;
    if (TOUCH) this._fullscreen(); else this._lock();
  }
  pause() {
    this.running = false; document.body.classList.remove('playing');
    const I = this.input; I.lmb = false; I.keys = {}; I.move = null; I.sprint = false; I.jumpHeld = false;
    if (this.touchUI) this.touchUI.reset();
    this.audio.zip(false);
    document.getElementById('play').textContent = 'ПРОДОЛЖИТЬ';
  }

  _events() {
    const fx = this.fx, au = this.audio, pl = this.player, eye = pl.eyePos();
    au.setListener(eye, pl.yaw);
    for (const ev of this.sim.events) {
      this.view.handle(ev);
      switch (ev.type) {
        case 'boom': {
          fx.explosion(ev.p, ev.R, ev.kind); au.boom(ev.p, ev.R / 3, ev.kind);
          const gy = this.sim.piles.heightAt(ev.p[0], ev.p[2]);
          fx.shockwave(ev.p, ev.R, ev.p[1] - gy < ev.R ? gy : null);
          if (ev.p[1] - gy < 1.2) fx.decal([ev.p[0], gy, ev.p[2]], ev.R * 1.25);
          const d = Math.hypot(ev.p[0] - eye[0], ev.p[1] - eye[1], ev.p[2] - eye[2]); fx.shake += Math.min(1.2, (ev.R * 6) / (d * d + 4)); this.hud.pulse('p');
          break;
        }
        case 'dust':
          if (ev.glass) { fx.glass(ev.p); au.glass(ev.p); }
          else { if (Math.random() < 0.7) fx.dust(ev.p, ev.size, ev.color, ev.cause === 'blast' ? 2 : 3); fx.bitsAt(ev.p, 2 + Math.round(ev.size * 6), ev.color, 3); au.crumble(ev.p, ev.size, ev.mat); }
          break;
        case 'impact': fx.dust(ev.p, Math.min(1.6, Math.log10(1 + ev.J / 500)), 0xaaa194, 4); au.impact(ev.p, ev.J, ev.mat); break;
        case 'creak': fx.ceilingDust(ev.p); au.creak(ev.p, ev.k); this.hud.pulse('s'); break;
        case 'break': au.crack(ev.p); fx.dust(ev.p, 0.6, 0xb8afa2, 3); this.hud.pulse('s'); break;
        case 'att+': this.hud.pulse('g'); break;
        case 'snap': au.snap(ev.p, ev.rope); fx.sparks(ev.p, ev.rope ? 10 : 4); if (ev.rope) this.hud.toast('Трос оборван'); break;
        case 'hit': fx.sparks(ev.p, 3, ev.mat === 'glass' ? 0xd8f3ff : 0xffd27a); fx.dust(ev.p, 0.2, 0xb0a89c, 1); au.bullet(ev.p, ev.mat); break;
        case 'stick': au.arm(ev.p); break;
        case 'bounce': au.impact(ev.p, 1500, 'steel'); break;
        case 'body+': if (ev.body.shards.length > 120) { this.hud.toast(`ОБРУШЕНИЕ · ${ev.body.shards.length} фрагментов`, 'red'); au.collapse(ev.body.curP, ev.body.shards.length); } break;
        case 'proj+': this._projMesh(ev.proj); break;
        case 'proj-': { const m = this.projMeshes.get(ev.proj); if (m) { this.view.scene.remove(m); if (ev.proj.kind === 'c4') m.material.dispose(); this.projMeshes.delete(ev.proj); } break; }
        default: break;
      }
    }
    this.sim.events.length = 0;
    for (const pe of this.pevents || []) {
      switch (pe.type) {
        case 'pad': au.pad(); this.hud.toast('Прыжковая площадка'); break;
        case 'fell': pl.respawn(this.sim.def.spawn); this.hud.toast('Респаун'); break;
        case 'step': au.step(pe.mat); break;
        case 'land': au.land(pe.v || 4); break;
        case 'djump': au.djump(); break;
        case 'zip+': au.zip(true); break;
        case 'zip-': au.zip(false); break;
        case 'ladder+': au.step('metal'); break;
        default: break;
      }
    }
    this.pevents = [];
    if (pl.zip) au.zip(true, pl.zip.s);
    if ((this._ac = (this._ac || 0) + 1) % 20 === 0) {
      for (const dd of pl.checkAnchors()) {
        const o = dd.obj, p = dd.type === 'zip' ? o.b : [o.p[0], o.y1, o.p[1]];
        fx.sparks(p, 12); au.snap(p, true);
        this.hud.toast(dd.type === 'zip' ? 'Зиплайн оборван' : 'Лестница сорвана');
      }
    }
  }
  _projMesh(p) {
    // shared geometry/material per projectile kind: no per-shot allocations, nothing to leak
    const A = this._projAssets || (this._projAssets = {
      rpg: [new THREE.CylinderGeometry(0.05, 0.05, 0.6, 8).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x59603f, emissive: 0x331a00 })],
      grenade: [new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshStandardMaterial({ color: 0x4b5232 })],
      c4: [new THREE.BoxGeometry(0.22, 0.1, 0.16), new THREE.MeshStandardMaterial({ color: 0xd9cfae, emissive: 0xff2010, emissiveIntensity: 0 })],
      meteor: [new THREE.IcosahedronGeometry(1.1, 1), new THREE.MeshStandardMaterial({ color: 0x3a2a22, emissive: 0xff5a1a, emissiveIntensity: 1.4 })],
    });
    const a = A[p.kind]; if (!a) return;
    const m = new THREE.Mesh(a[0], p.kind === 'c4' ? a[1].clone() : a[1]); // C4 blinks on its own
    m.castShadow = true; this.view.scene.add(m); this.projMeshes.set(p, m);
  }
  _syncProj(dt) {
    for (const [p, m] of this.projMeshes) {
      m.position.set(p.p[0], p.p[1], p.p[2]);
      const v = p.v; if (Math.hypot(v[0], v[1], v[2]) > 0.5) m.lookAt(p.p[0] + v[0], p.p[1] + v[1], p.p[2] + v[2]);
      if (p.kind === 'rpg' || p.kind === 'meteor') this.fx.trail(p.p, p.kind);
      if (p.kind === 'c4') { const on = Math.sin(performance.now() / 120) > 0.6; m.material.emissiveIntensity = on ? 2 : 0; if (on && !p._blink) this.audio.beep(); p._blink = on; }
    }
    void dt;
  }

  _inspect() {
    const pl = this.player; const h = this.sim.raycast(pl.eyePos(), pl.forward(), 60, pl.collider);
    if (!h || h.shard < 0) return this.hud.inspector(null);
    const s = this.sim.st.shards[h.shard]; if (s.state !== STATIC || s.fixed) return this.hud.inspector(null);
    const viz = this.sim.regionViz[s.region]; if (!viz) return this.hud.inspector(null);
    const R = this.sim.st.regions[s.region];
    if (!R._idx) { R._idx = new Map(); R.shards.forEach((id, i) => R._idx.set(id, i)); }
    const node = viz.shardNode[R._idx.get(s.id)]; if (node === undefined || node < 0) return this.hud.inspector(null);
    let best = -1, bu = -1;
    for (let i = 0; i < viz.connA.length; i++) if (viz.connA[i] === node || viz.connB[i] === node) { const u = viz.connU[i] / viz.connThr[i]; if (u > bu) { bu = u; best = i; } }
    if (best < 0) return this.hud.inspector(null);
    const M = this.sim.st.modules;
    this.hud.inspector({ U: viz.connU[best], thr: viz.connThr[best], ax: viz.connAx[best], be: viz.connBe[best], sh: viz.connSh[best], ka: M[viz.connMa[best]].kind, kb: viz.connMb[best] >= 0 ? M[viz.connMb[best]].kind : null });
  }
  _prompt() {
    const pl = this.player;
    if (!this.running || TOUCH) return this.hud.prompt('');
    if (pl.zip) return this.hud.prompt('SPACE прыжок · E отцепиться');
    if (pl.ladder) return this.hud.prompt('W / S лезть · SPACE спрыгнуть');
    this.hud.prompt(pl.near === 'zip' ? 'E · ЗИПЛАЙН' : '');
  }
  // only ever lowers quality: drop AO, then resolution, when the frame rate stays low
  _adapt(dt) {
    const A = this.adapt; if (!A.on || !this.running || this.paused) return;
    A.t += dt; if (this.fps < (TOUCH ? 34 : 40)) A.low += dt;
    if (A.t < 4) return;
    if (A.low > 3) {
      if (this.post && this.post.ao.enabled) { this.post.setAO(false); this.hud.toast('Авто: AO выключен ради FPS'); }
      else if (this.pr > 1) { this.pr = Math.max(1, this.pr - 0.25); this.renderer.setPixelRatio(this.pr); this._resize(); this.hud.toast(`Авто: разрешение ×${this.pr.toFixed(2)}`); }
    }
    A.t = 0; A.low = 0;
  }

  frame(t) {
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (t - this.lastT) / 1000); this.lastT = t;
    if (dt > 0) this.fps = this.fps * 0.92 + (1 / dt) * 0.08;
    if (!this.sim) return;
    const I = this.input;
    this.pevents = this.pevents || [];
    if (this.running) {
      if (I.keys.ArrowLeft) this.player.yaw += dt * 2.2; if (I.keys.ArrowRight) this.player.yaw -= dt * 2.2;
      if (I.keys.ArrowUp) this.player.pitch = Math.min(1.5, this.player.pitch + dt * 1.6); if (I.keys.ArrowDown) this.player.pitch = Math.max(-1.5, this.player.pitch - dt * 1.6);
      const w = this.weapons.current;
      if ((w.auto && I.lmb) || I.lmbPressed) this.weapons.fire();
      if (I.rmbPressed) this.weapons.alt();
    }
    I.lmbPressed = false; I.rmbPressed = false;
    const t0 = performance.now();
    let steps = 0;
    if (!this.paused) {
      this.acc += dt * this.timeScale;
      while (this.acc >= DT && steps < 4) {
        this.prevEye = this.player.eyePos();
        if (this.running) this.player.update(DT, I, this.pevents);
        this.weapons.update(DT);
        I.pressed = {}; I.jumpPressed = false; I.usePressed = false;
        this.sim.step(DT);
        this.acc -= DT; steps++;
      }
      if (steps >= 4) this.acc = 0;
    } else { I.pressed = {}; I.jumpPressed = false; I.usePressed = false; }
    if (steps) this.physMs = this.physMs * 0.9 + ((performance.now() - t0) / steps) * 0.1;
    this._events();
    const alpha = this.paused ? 1 : this.acc / DT;
    // camera
    const e1 = this.player.eyePos(), e0 = this.prevEye || e1;
    if (this.running) {
      this.camera.position.set(e0[0] + (e1[0] - e0[0]) * alpha, e0[1] + (e1[1] - e0[1]) * alpha, e0[2] + (e1[2] - e0[2]) * alpha);
      this.camera.rotation.set(this.player.pitch, this.player.yaw, 0, 'YXZ');
    } else {
      // idle broadcast camera: slow crane around the arena
      this.orbit += dt * 0.05;
      const L = this.sim.def.look, r = 36;
      this.camera.position.set(L[0] + Math.sin(this.orbit) * r, 14 + Math.sin(this.orbit * 0.7) * 3, L[2] + Math.cos(this.orbit) * r);
      this.camera.lookAt(L[0], L[1] + 2, L[2]);
    }
    const fwd = this.camera.getWorldDirection(this._fv || (this._fv = new THREE.Vector3()));
    const focus = (this._fp || (this._fp = new THREE.Vector3())).copy(this.camera.position).addScaledVector(fwd.setY(0).normalize(), this.running ? 14 : 30);
    this.view.update(alpha, focus);
    this._syncProj(dt);
    this.fx.update(dt * (this.paused ? 0 : this.timeScale), this.camera);
    if (this.fx.shake > 0.002) { const s = this.fx.shake * 0.06; this.camera.position.x += (Math.random() - 0.5) * s; this.camera.position.y += (Math.random() - 0.5) * s; this.camera.position.z += (Math.random() - 0.5) * s; }
    this.weapons.holder.visible = this.running && !this.player.zip;
    if ((this._ic = (this._ic || 0) + 1) % 5 === 0 && this.running) this._inspect();
    if (!this.running) this.hud.inspector(null);
    this._prompt();
    if (this.touchUI) this.touchUI.update();
    this.hud.update(this, this.fps);
    this._adapt(dt);
    if (this.post) this.post.render(dt); else this.renderer.render(this.view.scene, this.camera);
  }
}

async function boot() {
  const status = document.getElementById('status');
  try {
    status.textContent = 'запуск физики…';
    await RAPIER.init();
    const game = new Game();
    window.__game = game;
    const key = SCENES[params.get('scene')] ? params.get('scene') : 'district';
    status.textContent = 'собираем арену…';
    await new Promise((r) => setTimeout(r, 30));
    game.load(key); game._markScene();
    document.body.classList.add('ready');
    requestAnimationFrame(game.frame);
    if (params.get('autoplay') === '1') { game.running = true; document.body.classList.add('playing'); game.noLock = true; }
  } catch (err) {
    console.error(err);
    status.textContent = 'Ошибка запуска: ' + (err && err.message ? err.message : err) + ' — нужен браузер с WebGL2.';
  }
}
boot();
