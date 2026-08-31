/**
 * Built-in presets.
 *
 * In the desktop app these are Rust source, not data files: every simulation's
 * `mod.rs` has an `init_presets()` that pushes `Preset::new(name, Settings {
 * .., ..Settings::default() })` into its manager (slime_mold 13, gray_scott 9,
 * moire 4, one "Default" each for the rest).
 *
 * They are transcribed **per simulation milestone**, not here: a preset is only
 * meaningful next to the `Settings` type it configures, and transcribing 30-odd
 * of them against types that do not exist yet would be unverifiable. M2 owns
 * the mechanism; each sim brings its own data.
 *
 * The pattern each milestone follows:
 *
 *   1. add `src/lib/engine/presets/builtins/<sim>.ts`;
 *   2. export a `readonly BuiltinPreset[]` from it, listing **only the fields
 *      that differ from the simulation's defaults** — the store merges each
 *      entry over `defaults`, which is exactly what Rust's
 *      `..Settings::default()` does;
 *   3. import that array here and register it at the bottom of this file.
 *
 * Step 2 is data rather than a self-registering call because the two modules
 * would otherwise form an import cycle: `<sim>.ts` needs
 * `registerBuiltinPresets`, this file needs `<sim>.ts` evaluated, and whichever
 * runs first would touch `builtins` below while it is still in its temporal
 * dead zone. A `import type` of `BuiltinPreset` is erased, so it does not.
 *
 * Moiré is the worked example — see ./moire.ts.
 */

import type { SimulationId } from '../../types';
import type { PresetSettings } from '../PresetStore';
import { GRAY_SCOTT_BUILTIN_PRESETS } from './grayScott';
import { MOIRE_BUILTIN_PRESETS } from './moire';

export interface BuiltinPreset {
    name: string;
    /** Partial — merged over the simulation's defaults at load time. */
    settings: PresetSettings;
}

const builtins = new Map<SimulationId, BuiltinPreset[]>();

/**
 * Register a simulation's built-in presets, replacing any previous set.
 *
 * Replacing rather than appending keeps a hot-module reload from stacking
 * duplicates, which would then shadow same-named user presets.
 */
export function registerBuiltinPresets(
    simulation: SimulationId,
    presets: readonly BuiltinPreset[]
): void {
    builtins.set(
        simulation,
        presets.map((preset) => ({ ...preset }))
    );
}

/** Registration order, which is the order the Rust manager listed them in. */
export function getBuiltinPresets(simulation: SimulationId): readonly BuiltinPreset[] {
    return builtins.get(simulation) ?? [];
}

export function isBuiltinPreset(simulation: SimulationId, name: string): boolean {
    return getBuiltinPresets(simulation).some((preset) => preset.name === name);
}

/** Test seam — drops every registration. */
export function clearBuiltinPresets(): void {
    builtins.clear();
}

// --- Registrations, one line per ported simulation --------------------------
registerBuiltinPresets('moire', MOIRE_BUILTIN_PRESETS);
registerBuiltinPresets('gray_scott', GRAY_SCOTT_BUILTIN_PRESETS);
