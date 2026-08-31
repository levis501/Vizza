/**
 * Colour-scheme commands.
 *
 * ColorSchemeSelector.svelte is imported by 9 of the 10 mode components, so
 * this is the highest fan-in surface in the app — every simulation milestone
 * depends on it already working.
 */

import { register } from '../registry';
import { getEngineContext, hasEngineContext } from '../context';
import { colorSchemeManager } from '$lib/engine/color/ColorSchemeManager';
import { ColorScheme } from '$lib/engine/color/ColorScheme';

/**
 * Push the active scheme at the running simulation, if there is one.
 *
 * "If there is one" needs both checks. `hasEngineContext()` only says a host
 * exists; `SimulationHost.updateColorScheme` goes through `requireSimulation()`
 * (SimulationHost.ts:401), which throws "No simulation is running" when nothing
 * has been constructed yet. Two ordinary sequences hit that window: a mode's
 * `onMount` racing `start_simulation`, and the gradient editor's debounced
 * `update_gradient_preview` landing just after the user has navigated away and
 * the simulation has been torn down. Both callers only `console.error` what
 * they catch, so the throw became console noise and, in the editor's case, a
 * preview that appeared to stop working.
 */
function applyToSimulation(scheme: ColorScheme, reversed: boolean): void {
    if (!hasEngineContext()) return;
    const engine = getEngineContext();
    if (engine.currentSimulation() === null) return;
    engine.updateColorScheme(scheme.toU32Buffer(), reversed);
}

/**
 * The `color_scheme_data: Vec<u8>` argument, as `serde` would have taken it.
 *
 * Both gradient editors send `Array.from(lut)` — 768 plain numbers — so the
 * only thing worth checking on this side is that the argument arrived at all.
 * `ColorScheme.fromBytes(undefined)` throws "Invalid LUT data size … undefined
 * bytes", which sends the reader looking at the LUT rather than at the call.
 */
function requireLutData(value: unknown, command: string): ArrayLike<number> {
    if (value == null || typeof (value as ArrayLike<number>).length !== 'number') {
        throw new Error(`${command} was called without color_scheme_data.`);
    }
    return value as ArrayLike<number>;
}

export function registerColorSchemeHandlers(): void {
    register('get_available_color_schemes', async () => {
        await colorSchemeManager.load();
        return colorSchemeManager.allColorSchemes();
    });

    register('apply_color_scheme_by_name', async (args) => {
        await colorSchemeManager.load();
        const scheme = colorSchemeManager.setCurrent(String(args.color_scheme_name));
        applyToSimulation(scheme, colorSchemeManager.reversed);
        return null;
    });

    register('toggle_color_scheme_reversed', async () => {
        await colorSchemeManager.load();
        const scheme = colorSchemeManager.toggleReversed();
        applyToSimulation(scheme, colorSchemeManager.reversed);
        return null;
    });

    /**
     * The load() is not optional: `saveCustom` refuses a built-in's name, and
     * before the packed blob has arrived it does not know any built-in names.
     * Returns the trimmed name the scheme was actually stored under, which is
     * the name the caller must select by (the Rust returns a status string
     * here, which no caller reads either).
     */
    register('save_custom_color_scheme', async (args) => {
        await colorSchemeManager.load();
        const data = requireLutData(args.color_scheme_data, 'save_custom_color_scheme');
        return colorSchemeManager.saveCustom(String(args.name), data).name;
    });

    /**
     * The gradient editor previews an unsaved LUT. It goes straight to the
     * simulation without touching the manager's persisted state.
     */
    register('update_gradient_preview', async (args) => {
        const data = requireLutData(args.color_scheme_data, 'update_gradient_preview');
        const scheme = ColorScheme.fromBytes('preview', data);
        applyToSimulation(scheme, false);
        return null;
    });

    register('get_species_colors', async (args) => {
        await colorSchemeManager.load();
        const count = Number(args.count ?? args.species_count ?? 4);
        return colorSchemeManager.current().getColors(count);
    });
}
