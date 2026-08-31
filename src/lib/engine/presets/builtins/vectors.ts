/**
 * Vectors' built-in presets, transcribed from
 * src-tauri/src/simulations/vectors/mod.rs:11.
 *
 * There is exactly one — `Preset::new("Default", Settings::default())` — so it
 * carries no overrides at all, and `PresetStore` merging it over
 * `defaultVectorsSettings()` reproduces it byte for byte. Moiré's "Default"
 * entry is the same shape.
 *
 * An empty settings object is the point rather than an omission: the preset has
 * to *exist* so `PresetFieldset` has something to list and so "Default" behaves
 * as a built-in (built-ins win a name clash against a user preset,
 * preset_manager.rs:113), but it must not pin any value, or a later change to
 * `Settings::default()` would stop being reflected in it.
 *
 * Exported as data rather than self-registering: see the note in ./index.ts.
 */

import type { BuiltinPreset } from './index';

export const VECTORS_BUILTIN_PRESETS: readonly BuiltinPreset[] = [
    { name: 'Default', settings: {} },
];
