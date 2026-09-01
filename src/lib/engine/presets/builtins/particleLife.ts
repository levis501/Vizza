/**
 * Particle Life's built-in presets, transcribed from
 * src-tauri/src/simulations/particle_life/mod.rs:19.
 *
 * There is exactly one — `vec![("Default", Settings::default())]` — so it
 * carries no overrides at all, and `PresetStore` merging it over
 * `defaultParticleLifeSettings()` reproduces it field for field. Vectors' and
 * Moiré's "Default" entries have the same shape and ./vectors.ts explains why
 * an empty settings object is the point rather than an omission.
 *
 * Worth knowing for M13 and for anyone adding a second preset here: a Particle
 * Life preset carries the **force matrix**, which is the only variable-shaped
 * value in any simulation's `Settings`. `normalizeParticleLifeSettings` applies
 * `species_count` before anything else precisely so that a preset naming both
 * gets its matrix sized against the count it declares rather than the count
 * that happened to be loaded.
 *
 * Exported as data rather than self-registering: see the note in ./index.ts.
 */

import type { BuiltinPreset } from './index';

export const PARTICLE_LIFE_BUILTIN_PRESETS: readonly BuiltinPreset[] = [
    { name: 'Default', settings: {} },
];
