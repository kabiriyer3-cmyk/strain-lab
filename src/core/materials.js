// Material table. Strengths are game-tuned (kN/m^2), not textbook values: the goal is THE FINALS feel,
// where a building survives a few RPGs but folds when its supports are mostly gone.
//  E, G      relative stiffness (only ratios matter for how load is shared)
//  sigT/C    tension / compression strength, tau = shear strength
//  duct      ductility -> how strong the loose "gradual destruction" attachment is after a break (0 = snaps clean)
//  hp        damage needed to destroy one fragment, frac = fragments per m^3
//  impactRes kN*s of debris impulse per hp, bondImpact = kN*s per m^2 of bond to crack a falling chunk
export const MATERIALS = {
  concrete: { label: 'бетон', density: 2400, E: 1.0, G: 0.42, sigT: 2600, sigC: 6000, tau: 2200, duct: 0.45, hp: 1.0, frac: 7.5, maxSeeds: 14, core: 0x9b968d, impactRes: 6, bondImpact: 22, bullet: 0.012 },
  brick: { label: 'кирпич', density: 1900, E: 0.7, G: 0.3, sigT: 520, sigC: 2400, tau: 950, duct: 0.15, hp: 0.7, frac: 10, maxSeeds: 16, core: 0xa65a3c, impactRes: 3.5, bondImpact: 12, bullet: 0.025 },
  wood: { label: 'дерево', density: 650, E: 0.35, G: 0.14, sigT: 900, sigC: 1500, tau: 620, duct: 0.85, hp: 0.45, frac: 6, maxSeeds: 10, core: 0xc28c50, impactRes: 2.0, bondImpact: 7, bullet: 0.07 },
  steel: { label: 'сталь', density: 7850, E: 6.0, G: 2.4, sigT: 9000, sigC: 9000, tau: 5200, duct: 1.0, hp: 2.6, frac: 1.6, maxSeeds: 6, core: 0x55606b, impactRes: 18, bondImpact: 80, bullet: 0 },
  rail: { label: 'ограждение', density: 900, E: 1.5, G: 0.6, sigT: 6000, sigC: 6000, tau: 4000, duct: 1.0, hp: 1.2, frac: 1.2, maxSeeds: 4, core: 0x3a4148, impactRes: 6, bondImpact: 30, bullet: 0 },
  panel: { label: 'панель', density: 700, E: 0.8, G: 0.3, sigT: 2500, sigC: 2500, tau: 1500, duct: 0.7, hp: 0.6, frac: 3, maxSeeds: 14, core: 0x2b2f36, impactRes: 1.6, bondImpact: 6, bullet: 0.05 },
  glass: { label: 'стекло', density: 2500, E: 0.02, G: 0.01, sigT: 60, sigC: 60, tau: 60, duct: 0, hp: 0.03, frac: 40, maxSeeds: 4, core: 0xbfe6f2, impactRes: 0.05, bondImpact: 0.3, bullet: 1, glass: true },
  base: { label: 'основание', density: 2600, E: 1.0, G: 0.42, sigT: 1e9, sigC: 1e9, tau: 1e9, duct: 0, hp: Infinity, frac: 0, maxSeeds: 1, core: 0x77736b, impactRes: 1e12, bondImpact: 1e12, bullet: 0 },
};
export const matOf = (k) => MATERIALS[k] || MATERIALS.concrete;
// Non-structural members are modelled soft, so they hang on the frame instead of attracting load
// through compatibility (the way engineers treat infill): lower stiffness, same strength.
export const KIND_STIFF = { sill: 0.5, lintel: 1.0, partition: 0.05, parapet: 0.3, rail: 0.4, glass: 0.01 };
