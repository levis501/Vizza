/**
 * Preset commands.
 *
 * Built-in presets are Rust source code rather than data files — each sim's
 * mod.rs has an init_presets(). They are transcribed per-simulation in
 * $lib/engine/presets/builtins, so until a sim is ported its list is just
 * whatever the user saved.
 */

import { register } from '../registry';
import { getEngineContext, hasEngineContext } from '../context';
import { presetStore } from '$lib/engine/presets/PresetStore';
import type { SimulationId } from '$lib/engine/types';
import { isSimulationId } from '$lib/engine/core/Simulation';

function activeSimulation(): SimulationId | null {
    if (!hasEngineContext()) return null;
    const id = getEngineContext().currentSimulation();
    return id && isSimulationId(id) ? id : null;
}

function resolveSimulation(arg: unknown): SimulationId | null {
    const raw = String(arg ?? '').replace(/-/g, '_');
    if (isSimulationId(raw)) return raw;
    return activeSimulation();
}

export function registerPresetHandlers(): void {
    register('get_available_presets', async () => {
        const sim = activeSimulation();
        return sim ? presetStore.names(sim) : [];
    });

    register('get_presets_for_simulation_type', async (args) => {
        const sim = resolveSimulation(args.simulation_type);
        return sim ? presetStore.names(sim) : [];
    });

    register('apply_preset', async (args) => {
        const sim = activeSimulation();
        if (!sim) return null;
        const preset = presetStore.get(sim, String(args.preset_name));
        if (!preset) throw new Error(`No such preset: ${args.preset_name}`);

        const ctx = getEngineContext();
        ctx.applySettings(preset.settings);
        // The Rust calls reset_runtime_state() after apply_settings().
        ctx.resetRuntimeState();
        return null;
    });

    register('save_preset', async (args) => {
        const sim = activeSimulation();
        if (!sim) throw new Error('No simulation running');
        const settings = await getEngineContext().getSettings();
        presetStore.save(sim, String(args.preset_name), settings);
        return null;
    });

    register('delete_preset', async (args) => {
        const sim = activeSimulation();
        if (!sim) return null;
        presetStore.delete(sim, String(args.preset_name));
        return null;
    });
}
