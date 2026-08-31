/**
 * Gray-Scott's built-in presets, transcribed from
 * src-tauri/src/simulations/gray_scott/mod.rs:14.
 *
 * Unlike Moiré's, the Rust loop writes a **complete** `Settings` literal with
 * no `..Settings::default()` — one struct built from a `(name, (feed, kill))`
 * table with every other field spelled out. Three of those spelled-out values
 * disagree with `Settings::default()`:
 *
 *     timestep         1.0  (default 2.5)
 *     max_timestep     2.0  (default 4.0)
 *     stability_factor 0.8  (default 0.9)
 *
 * so all three have to appear in every entry below. The house rule here is
 * "only the fields that differ from the defaults", and obeying it *without*
 * noticing those three would give every preset a 2.5x faster reaction than the
 * desktop app — visible as patterns that blow past the state they were tuned
 * for. `diffusion_rate_u: 0.16`, `diffusion_rate_v: 0.08` and
 * `enable_adaptive_timestep: false` are also spelled out in the Rust but equal
 * the defaults, so they are correctly omitted.
 *
 * There is **no "Default" preset** for Gray-Scott, unlike every other
 * simulation — the nine below are the whole list.
 *
 * Exported as data rather than self-registering: see the note in ./index.ts.
 */

import type { BuiltinPreset } from './index';

/** The three non-default optimization values every entry shares (mod.rs:36-41). */
const SHARED = {
    timestep: 1.0,
    max_timestep: 2.0,
    stability_factor: 0.8,
} as const;

export const GRAY_SCOTT_BUILTIN_PRESETS: readonly BuiltinPreset[] = [
    // mod.rs:18. Byte-identical to Fingerprint below — that duplication is in
    // the Rust table, not a slip in transcription, and the preset list really
    // does offer the same simulation under two names.
    { name: 'Brain Coral', settings: { feed_rate: 0.0545, kill_rate: 0.062, ...SHARED } },
    { name: 'Fingerprint', settings: { feed_rate: 0.0545, kill_rate: 0.062, ...SHARED } },
    { name: 'Mitosis', settings: { feed_rate: 0.0367, kill_rate: 0.0649, ...SHARED } },
    { name: 'Ripples', settings: { feed_rate: 0.018, kill_rate: 0.051, ...SHARED } },
    { name: 'Soliton Collapse', settings: { feed_rate: 0.022, kill_rate: 0.06, ...SHARED } },
    { name: 'U-Skate World', settings: { feed_rate: 0.062, kill_rate: 0.061, ...SHARED } },
    { name: 'Undulating', settings: { feed_rate: 0.026, kill_rate: 0.051, ...SHARED } },
    { name: 'Worms', settings: { feed_rate: 0.078, kill_rate: 0.061, ...SHARED } },
    // "Custom" is a built-in *name* here, so `PresetStore.list` permanently
    // shadows a user preset saved under it — built-ins win on a name clash
    // (preset_manager.rs:113). Faithful to the Rust, and a trap worth knowing.
    { name: 'Custom', settings: { feed_rate: 0.035, kill_rate: 0.058, ...SHARED } },
];
