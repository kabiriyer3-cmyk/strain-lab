// Build: bundles the Strain worker into a string, then the game into one classic script (works from file:// too).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const minify = !process.argv.includes('--dev');
const worker = await esbuild.build({ entryPoints: ['src/sim/strain.worker.js'], bundle: true, format: 'iife', minify, write: false, target: ['es2020'] });
const workerCode = worker.outputFiles[0].text;
await esbuild.build({
  entryPoints: ['src/main.js'], bundle: true, format: 'iife', minify, sourcemap: false, target: ['es2020'],
  outfile: path.join(out, 'game.js'), define: { __STRAIN_WORKER__: JSON.stringify(workerCode) }, logLevel: 'info', legalComments: 'none',
});
for (const f of fs.readdirSync('public')) fs.copyFileSync(path.join('public', f), path.join(out, f));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
const kb = (f) => (fs.statSync(path.join(out, f)).size / 1024).toFixed(0) + ' KB';
console.log('dist ready:', fs.readdirSync(out).map((f) => `${f} (${kb(f)})`).join(', '));
