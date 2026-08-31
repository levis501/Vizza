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

/** Push the active scheme at the running simulation, if there is one. */
function applyToSimulation(scheme: ColorScheme, reversed: boolean): void {
    if (!hasEngineContext()) return;
    getEngineContext().updateColorScheme(scheme.toU32Buffer(), reversed);
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

    register('save_custom_color_scheme', async (args) => {
        await colorSchemeManager.load();
        const data = args.color_scheme_data as ArrayLike<number>;
        colorSchemeManager.saveCustom(String(args.name), data);
        return null;
    });

    /**
     * The gradient editor previews an unsaved LUT. It goes straight to the
     * simulation without touching the manager's persisted state.
     */
    register('update_gradient_preview', async (args) => {
        const data = args.color_scheme_data as ArrayLike<number>;
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
