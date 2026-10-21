// Build: bundles the Strain worker into a string, then the game into one classic script (works from file:// too),
// and downloads the CC0 sound banks listed in src/game/sfx.js into dist/sfx/ (cached in .sfx-cache/).
//   node build.mjs            production build
//   node build.mjs --dev      unminified
//   node build.mjs --no-sfx   skip the sound download (the game then streams them from GitHub)
//   SFX_MIRROR=http://host/   fetch the sound files from a mirror of raw.githubusercontent.com (offline testing)
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { allFiles, SOURCES } from './src/game/sfx.js';

const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const minify = !process.argv.includes('--dev');
const worker = await esbuild.build({ entryPoints: ['src/sim/strain.worker.js'], bundle: true, format: 'iife', minify, write: false, target: ['es2020'] });
const workerCode = worker.outputFiles[0].text;
await esbuild.build({
  entryPoints: ['src/main.js'], bundle: true, format: 'iife', minify, sourcemap: false, target: ['es2020', 'safari15'],
  outfile: path.join(out, 'game.js'), define: { __STRAIN_WORKER__: JSON.stringify(workerCode) }, logLevel: 'info', legalComments: 'none',
});
fs.cpSync('public', out, { recursive: true });
fs.writeFileSync(path.join(out, '.nojekyll'), '');

async function fetchSounds() {
  const files = allFiles(), dir = path.join(out, 'sfx'), cache = '.sfx-cache';
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(cache, { recursive: true });
  const okNames = [];
  let i = 0, fetched = 0, cached = 0, failed = 0, bytes = 0;
  const one = async (f) => {
    const c = path.join(cache, f.name);
    if (fs.existsSync(c) && fs.statSync(c).size > 0) { fs.copyFileSync(c, path.join(dir, f.name)); okNames.push(f.name); cached++; bytes += fs.statSync(c).size; return; }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const url = process.env.SFX_MIRROR ? f.url.replace('https://raw.githubusercontent.com/', process.env.SFX_MIRROR) : f.url;
        const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const b = Buffer.from(await r.arrayBuffer());
        fs.writeFileSync(c, b); fs.writeFileSync(path.join(dir, f.name), b);
        okNames.push(f.name); fetched++; bytes += b.length; return;
      } catch (e) { if (attempt) { failed++; if (failed <= 3) console.warn('sfx: could not fetch', f.url, '-', e.message); } }
    }
  };
  await Promise.all(Array.from({ length: 6 }, async () => { while (i < files.length) await one(files[i++]); }));
  okNames.sort();
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ files: okNames }));
  const credits = Object.values(SOURCES).map((s) => `${s.credit} - ${s.license}\n  https://github.com/${s.repo}/tree/${s.sha}/${s.dir}`).join('\n');
  fs.writeFileSync(path.join(dir, 'CREDITS.txt'), 'STRAIN LAB sound effects (all CC0 / public domain)\n\n' + credits + '\n');
  console.log(`sfx: ${okNames.length}/${files.length} files (${fetched} downloaded, ${cached} cached, ${failed} failed), ${(bytes / 1048576).toFixed(1)} MB`);
}
if (!process.argv.includes('--no-sfx') && process.env.SFX !== '0') await fetchSounds();

const size = (p) => { const s = fs.statSync(p); return s.isDirectory() ? fs.readdirSync(p).reduce((a, f) => a + size(path.join(p, f)), 0) : s.size; };
console.log('dist ready:', fs.readdirSync(out).map((f) => `${f} (${(size(path.join(out, f)) / 1024).toFixed(0)} KB)`).join(', '));
