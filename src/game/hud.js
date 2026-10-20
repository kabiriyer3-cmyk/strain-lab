// Broadcast-style HUD: LIVE tag, weapon rack, stats, toasts and the Strain "diamond" inspector
// (the threshold envelope from Embark's GDC'24 slides: white diamond = limit, red dot = current load).
import { WEAPONS } from './weapons.js';

const KIND_RU = { wall: 'стена', sill: 'подоконник', lintel: 'перемычка', slab: 'плита', roof: 'кровля', column: 'колонна', partition: 'перегородка', balcony: 'балкон', rail: 'ограждение', parapet: 'парапет', bridge: 'мост', gantry: 'ферма', beam: 'балка', glass: 'стекло', jumbotron: 'экран', base: 'основание' };
export class HUD {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div id="tag"><span class="live">LIVE</span><b>STRAIN LAB</b><i id="sceneName"></i></div>
      <div id="layers"><span data-l="s">STRAIN</span><span data-l="g">GRADUAL</span><span data-l="p">PHYSICS</span></div>
      <div id="stats"></div>
      <div id="cross"></div>
      <div id="mode"></div>
      <div id="insp"><canvas width="176" height="176"></canvas><div class="it"></div></div>
      <div id="toasts"></div>
      <div id="rack">${WEAPONS.map((w, i) => `<div class="slot" data-i="${i}"><em>${i + 1}</em><b>${w.name}</b><small>${w.tag}</small></div>`).join('')}</div>
      <div id="hint"></div>`;
    this.stats = root.querySelector('#stats'); this.rack = [...root.querySelectorAll('.slot')];
    this.hint = root.querySelector('#hint'); this.toasts = root.querySelector('#toasts'); this.modeEl = root.querySelector('#mode');
    this.insp = root.querySelector('#insp'); this.ictx = this.insp.querySelector('canvas').getContext('2d'); this.itext = this.insp.querySelector('.it');
    this.layers = Object.fromEntries([...root.querySelectorAll('#layers span')].map((e) => [e.dataset.l, e]));
    this.sceneName = root.querySelector('#sceneName');
    this.lastStats = 0;
  }
  setScene(t) { this.sceneName.textContent = t; }
  setWeapon(i, w) { this.rack.forEach((e, k) => e.classList.toggle('on', k === i)); this.hint.innerHTML = `<b>${w.name}</b> · ${w.hint} <span>ЛКМ огонь · ПКМ альт · B вид · G граф · T слоумо · V полёт · R сброс · H помощь</span>`; }
  setMode(label, on) { this.modeEl.textContent = label; this.modeEl.classList.toggle('show', on); }
  toast(msg, kind = '') {
    const e = document.createElement('div'); e.className = 'toast ' + kind; e.textContent = msg;
    this.toasts.prepend(e); setTimeout(() => e.classList.add('out'), 2600); setTimeout(() => e.remove(), 3200);
    while (this.toasts.children.length > 4) this.toasts.lastChild.remove();
  }
  pulse(layer) { const e = this.layers[layer]; if (!e) return; e.classList.remove('hit'); void e.offsetWidth; e.classList.add('hit'); }
  update(game, fps) {
    const now = performance.now(); if (now - this.lastStats < 250) return; this.lastStats = now;
    const s = game.sim, st = s.stats;
    let stat = 0, dyn = 0; for (const sh of s.st.shards) { if (sh.state === 0) stat++; else if (sh.state === 1) dyn++; }
    const joints = s.atts.reduce((k, a) => k + (a.active && !a.broken && a.type !== 'rope' ? 1 : 0), 0);
    this.stats.innerHTML = `
      <div><span>FPS</span><b>${fps.toFixed(0)}</b><span>ФИЗИКА</span><b>${game.physMs.toFixed(1)}<i>мс</i></b></div>
      <div><span>STRAIN</span><b>${st.solveMs.toFixed(1)}<i>мс</i></b><span>${s.strain.backend === 'worker' ? 'поток' : 'inline'}</span><b>${st.solves}</b></div>
      <div><span>ФРАГМЕНТЫ</span><b>${stat}</b><span>ОБЛОМКИ</span><b>${s.bodies.size}<i>/${dyn}</i></b></div>
      <div><span>ШАРНИРЫ</span><b>${joints}</b><span>РАЗРЫВЫ</span><b>${st.breaks}</b></div>
      <div><span>РЕПЛИКАЦИЯ</span><b>${st.netComp.toFixed(0)}<i>/${st.netNaive.toFixed(0)} кбит/с</i></b></div>`;
  }
  inspector(info) {
    const c = this.ictx, W = 176, H = 176;
    if (!info) { this.insp.classList.remove('show'); return; }
    this.insp.classList.add('show');
    c.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2, r = 70;
    c.strokeStyle = 'rgba(243,239,230,0.22)'; c.lineWidth = 1;
    c.beginPath(); c.moveTo(cx - r - 6, cy); c.lineTo(cx + r + 6, cy); c.moveTo(cx, cy - r - 6); c.lineTo(cx, cy + r + 6); c.stroke();
    const t = info.thr;
    c.strokeStyle = '#f3efe6'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(cx + r * t, cy); c.lineTo(cx, cy - r * t); c.lineTo(cx - r * t, cy); c.lineTo(cx, cy + r * t); c.closePath(); c.stroke();
    const x = Math.max(-1.6, Math.min(1.6, info.ax)), y = Math.min(1.6, info.be + info.sh);
    const over = info.U > t;
    c.fillStyle = over ? '#ff3b2f' : info.U > 0.8 * t ? '#ffd23f' : '#3d7bff';
    c.beginPath(); c.arc(cx + x * r, cy - y * r, 6, 0, Math.PI * 2); c.fill();
    c.font = '600 12px "IBM Plex Mono", monospace'; c.fillStyle = 'rgba(243,239,230,0.7)';
    c.fillText('сжатие', 6, cy - 6); c.fillText('растяж.', W - 58, cy - 6); c.fillText('изгиб+сдвиг', cx + 6, 14);
    this.itext.innerHTML = `<b>${KIND_RU[info.ka] || info.ka} → ${info.kb ? KIND_RU[info.kb] || info.kb : 'опора'}</b><span>U ${info.U.toFixed(2)} / ${t.toFixed(2)}</span><small>осев. ${Math.abs(info.ax).toFixed(2)} · изгиб ${info.be.toFixed(2)} · сдвиг ${info.sh.toFixed(2)}</small>`;
  }
}
