// Sound manifest. Every file is a CC0 recording from a public GitHub mirror, pinned to a commit.
// `npm run build` downloads them into dist/sfx/ (see build.mjs); at runtime the game loads the local copy
// and falls back to the raw GitHub URL (handy when the page is opened straight from the source tree).
export const SOURCES = {
  kenney: { repo: 'Mcamento8/open-game-sfx-index', sha: '34bbe8b525b5ceff3804915ea745532af11f6055', dir: 'audio/',
    credit: 'Kenney (kenney.nl): Impact, Sci-fi, RPG, Interface Sounds; artisticdude: RPG Sound Pack (OpenGameArt)', license: 'CC0 1.0' },
  duck: { repo: 'fighter-435/Break-the-Battle-Formation', sha: 'cc899ce7e9eeb2e127d677b24f0bc2420452142c', dir: 'sci-fi-fps/assets/audios/sfx_breaking_and_falling/',
    credit: 'rubberduck: 75 CC0 breaking / falling / hit sfx (OpenGameArt)', license: 'CC0 1.0' },
  asimov: { repo: 'TP-Coltec-UFMG/2026-303-Asimov', sha: 'b30e395fd33925ef53c17cc2a5c84228cbad8dc9', dir: 'Sounds/Effects/',
    credit: 'unfa: Weapons_Handgun_Shot (Freesound #565130); Spring Spring: mechanical explosion (OpenGameArt)', license: 'CC0 1.0' },
};

const seq = (pre, a, b, pad = 3, ext = '.ogg') => Array.from({ length: b - a + 1 }, (_, i) => pre + String(a + i).padStart(pad, '0') + ext);
const BFH = (name, a, b) => seq('bfh1_' + name + '_', a, b, 2);
const OGA = 'oga-rpg-pack/RPG Sound Pack/battle/';

// prio: 0 = needed for the first shot, 1 = soon, 2 = whenever. low: how many variants weak devices keep.
export const BANKS = {
  boom: { src: 'kenney', prio: 0, files: seq('sci-fi-sounds/explosionCrunch_', 0, 4) },
  boomLow: { src: 'kenney', prio: 0, files: seq('sci-fi-sounds/lowFrequency_explosion_', 0, 1) },
  gun: { src: 'asimov', prio: 0, files: ['gunshot_unfa_cc0.ogg'] },
  launch: { src: 'kenney', prio: 0, files: seq('sci-fi-sounds/thrusterFire_', 0, 0) },
  crumble: { src: 'duck', prio: 0, files: [...BFH('rock_breaking', 1, 3), ...BFH('breaking', 1, 3)] },
  rubble: { src: 'duck', prio: 0, low: 4, files: BFH('rock_falling', 1, 9) },
  glass: { src: 'duck', prio: 0, low: 3, files: BFH('glass_breaking', 1, 6) },
  hitRock: { src: 'duck', prio: 1, low: 6, files: [...BFH('hit', 1, 13), 'bfh1_rock_hit_01.ogg'] },
  bulletRock: { src: 'kenney', prio: 0, files: seq('impact-sounds/impactMining_', 0, 4) },
  bulletWood: { src: 'kenney', prio: 1, files: seq('impact-sounds/impactPlank_medium_', 0, 4) },
  bulletMetal: { src: 'kenney', prio: 1, files: seq('impact-sounds/impactMetal_light_', 0, 4) },
  bulletGlass: { src: 'kenney', prio: 1, files: seq('impact-sounds/impactGlass_light_', 0, 4) },
  creak: { src: 'kenney', prio: 1, files: ['rpg-audio/creak1.ogg', 'rpg-audio/creak2.ogg', 'rpg-audio/creak3.ogg'] },
  fall: { src: 'duck', prio: 1, low: 3, files: BFH('falling', 1, 7) },
  woodBreak: { src: 'duck', prio: 1, files: [...BFH('wood_breaking', 1, 4), ...BFH('wood_falling', 1, 2)] },
  hitWood: { src: 'duck', prio: 1, files: BFH('wood_hit', 1, 3) },
  hitMetal: { src: 'duck', prio: 1, low: 3, files: BFH('metal_hit', 1, 6) },
  metalFall: { src: 'duck', prio: 2, low: 2, files: BFH('metal_falling', 1, 5) },
  glassFall: { src: 'duck', prio: 2, low: 2, files: BFH('glass_falling', 1, 4) },
  hitGlass: { src: 'duck', prio: 2, files: BFH('glass_hit', 1, 2) },
  heavyMetal: { src: 'kenney', prio: 1, low: 3, files: seq('impact-sounds/impactMetal_heavy_', 0, 4) },
  punch: { src: 'kenney', prio: 0, low: 3, files: seq('impact-sounds/impactPunch_heavy_', 0, 4) },
  boomBig: { src: 'asimov', prio: 1, low: 0, files: ['mechanical_explosion_spring_spring.wav'] },
  swing: { src: 'kenney', prio: 1, files: [OGA + 'swing.wav', OGA + 'swing2.wav', OGA + 'swing3.wav'] },
  soft: { src: 'kenney', prio: 1, low: 3, files: seq('impact-sounds/impactSoft_heavy_', 0, 4) },
  land: { src: 'kenney', prio: 1, low: 3, files: seq('impact-sounds/impactSoft_medium_', 0, 4) },
  stepConcrete: { src: 'kenney', prio: 1, files: seq('impact-sounds/footstep_concrete_', 0, 4) },
  stepWood: { src: 'kenney', prio: 2, files: seq('impact-sounds/footstep_wood_', 0, 4) },
  stepMetal: { src: 'kenney', prio: 2, low: 3, files: seq('impact-sounds/impactMetal_medium_', 0, 4) },
  tick: { src: 'kenney', prio: 1, files: ['interface-sounds/tick_001.ogg', 'interface-sounds/tick_002.ogg'] },
  arm: { src: 'kenney', prio: 1, files: ['interface-sounds/switch_003.ogg'] },
  latch: { src: 'kenney', prio: 1, files: ['rpg-audio/metalLatch.ogg', 'rpg-audio/metalClick.ogg'] },
  equip: { src: 'kenney', prio: 1, files: ['rpg-audio/beltHandle1.ogg', 'rpg-audio/beltHandle2.ogg'] },
  zip: { src: 'kenney', prio: 2, files: ['sci-fi-sounds/forceField_001.ogg'] },
  ui: { src: 'kenney', prio: 0, files: ['interface-sounds/click_002.ogg', 'interface-sounds/click_003.ogg'] },
  uiOk: { src: 'kenney', prio: 0, files: ['interface-sounds/confirmation_002.ogg'] },
};

export const rawUrl = (src, file) => { const s = SOURCES[src]; return `https://raw.githubusercontent.com/${s.repo}/${s.sha}/${encodeURI(s.dir + file)}`; };
export const localName = (src, file) => (src + '_' + file).replace(/[^A-Za-z0-9._-]+/g, '_');
export function allFiles() {
  const seen = new Map();
  for (const b of Object.values(BANKS)) for (const f of b.files) seen.set(localName(b.src, f), { src: b.src, file: f, url: rawUrl(b.src, f), name: localName(b.src, f) });
  return [...seen.values()];
}
