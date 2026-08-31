/**
 * Settings and state commands.
 *
 * Per .cursorrules: argument *keys* are camelCase and get normalised to
 * snake_case in invoke.ts, but the string *values* of `settingName` /
 * `stateName` are already snake_case and must pass through untouched.
 */

import { register } from '../registry';
import { getEngineContext, hasEngineContext } from '../context';

/**
 * Modes render their loading overlay as `loading={loading || !settings}`, so a
 * getter that throws leaves the screen permanently covered — and the overlay
 * swallows pointer events, including "Back to Menu". Returning an empty object
 * is what lets a browser without WebGPU still navigate the UI.
 */
async function settingsOr<T extends Record<string, unknown>>(
    read: () => Promise<T>,
    fallback: T
): Promise<T> {
    return hasEngineContext() ? read() : fallback;
}

/**
 * Mutations are simply dropped when there is nothing to mutate.
 *
 * Both halves of the guard are load-bearing. `hasEngineContext()` says a host
 * exists; `SimulationHost.updateSetting` / `updateState` then go through
 * `requireSimulation()`, which *throws* "No simulation is running" — so a
 * control whose write lands after teardown rejected, and every mode turns that
 * into a `console.error`. The getters above have always degraded (`?? {}`);
 * the setters did not, which made the pair inconsistent as well as noisy.
 *
 * M6 found the same missing second half in `colorSchemes.ts:applyToSimulation`,
 * reached by the gradient editor's debounced preview firing after a
 * navigation. The window is not narrow: an in-flight optimistic update, an
 * auto-hide timer and a queued preset apply all land there.
 *
 * A *bad value* still rejects, because the simulation's own model throws — and
 * that path has to stay open for `sync.ts` to roll an optimistic update back.
 */
async function applyIfReady(fn: () => Promise<void>): Promise<null> {
    if (!hasEngineContext()) return null;
    if (getEngineContext().currentSimulation() === null) return null;
    await fn();
    return null;
}

export function registerSettingsHandlers(): void {
    register('get_current_settings', async () =>
        settingsOr(() => getEngineContext().getSettings(), {})
    );
    register('get_current_state', async () => settingsOr(() => getEngineContext().getState(), {}));

    register('update_simulation_setting', async (args) =>
        applyIfReady(() => getEngineContext().updateSetting(String(args.setting_name), args.value))
    );

    register('update_simulation_state', async (args) =>
        applyIfReady(() => getEngineContext().updateState(String(args.state_name), args.value))
    );

    /**
     * Particle Life's InteractionMatrix has its own command purely because the
     * Rust needed a distinct entry point; the semantics are identical.
     */
    register('update_particle_life_setting', async (args) =>
        applyIfReady(() => getEngineContext().updateSetting(String(args.setting_name), args.value))
    );

    register('update_cursor_size', async (args) =>
        applyIfReady(() => getEngineContext().updateState('cursor_size', Number(args.size)))
    );

    register('update_cursor_strength', async (args) =>
        applyIfReady(() => getEngineContext().updateState('cursor_strength', Number(args.strength)))
    );

    register('update_pellets_trails_state', async (args) =>
        applyIfReady(async () => {
            const ctx = getEngineContext();
            await ctx.updateState('trails_enabled', Boolean(args.enabled));
            await ctx.updateState('trail_fade', Number(args.fade));
        })
    );
}
