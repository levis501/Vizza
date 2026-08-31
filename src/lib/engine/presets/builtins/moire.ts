/**
 * Moiré's built-in presets, transcribed from
 * src-tauri/src/simulations/moire/mod.rs:14.
 *
 * Each entry lists **only** the fields that differ from `Settings::default()`,
 * which is precisely what `Settings { base_freq: 30.0, ..Settings::default() }`
 * expresses on the Rust side. `PresetStore` merges them over the simulation's
 * defaults at load time, so adding a setting later does not invalidate these.
 *
 * Exported as data rather than self-registering: `./index` owns the registry,
 * and a module that both imports the registry and is imported by it would
 * evaluate its `registerBuiltinPresets` call while the registry's own `const`
 * is still in the temporal dead zone.
 */

import type { BuiltinPreset } from './index';

export const MOIRE_BUILTIN_PRESETS: readonly BuiltinPreset[] = [
    // mod.rs:18 — `Preset::new("Default", Settings::default())`, so no overrides.
    { name: 'Default', settings: {} },
    {
        name: 'Classic Moiré',
        settings: {
            base_freq: 30.0,
            moire_amount: 0.8,
            moire_rotation: 0.1,
            moire_scale: 1.02,
            moire_interference: 0.7,
            advect_strength: 0.1,
        },
    },
    {
        name: 'Psychedelic',
        settings: {
            base_freq: 20.0,
            moire_amount: 0.5,
            moire_rotation: 0.3,
            moire_scale: 1.1,
            moire_interference: 0.5,
            advect_strength: 0.4,
        },
    },
    {
        name: 'Subtle',
        settings: {
            base_freq: 40.0,
            moire_amount: 0.3,
            moire_rotation: 0.05,
            moire_scale: 1.01,
            moire_interference: 0.3,
            advect_strength: 0.2,
        },
    },
];
