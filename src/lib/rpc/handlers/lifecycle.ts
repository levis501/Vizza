/**
 * Lifecycle, GUI and camera commands.
 *
 * Each handler is a thin adapter over the typed engine API — the string-keyed
 * surface exists so the 319 existing call sites keep working, not because the
 * engine itself is stringly-typed.
 */

import { register } from '../registry';
import { getEngineContext, hasEngineContext } from '../context';
import { emit } from '../events';

/** Maps the per-simulation start commands onto SimulationId. */
const START_COMMANDS: Record<string, string> = {
    start_slime_mold_simulation: 'slime_mold',
    start_gray_scott_simulation: 'gray_scott',
    start_particle_life_simulation: 'particle_life',
    start_pellets_simulation: 'pellets',
    start_moire_simulation: 'moire',
    start_primordial_particles_simulation: 'primordial_particles',
};

/**
 * The frontend passes hyphenated AppMode values in some places and snake_case
 * SimulationId in others (`start_simulation({simulationType: 'voronoi_ca'})`
 * vs the menu's 'voronoi-ca'). Normalise rather than chase every call site.
 */
function normalizeId(value: unknown): string {
    return String(value ?? '').replace(/-/g, '_');
}

/**
 * Signal readiness even when there is no engine.
 *
 * Modes gate their loading overlay on `simulation-initialized`, and the overlay
 * intercepts pointer events — so a browser without WebGPU would show a
 * permanently-covered screen with an unclickable "Back to Menu". The UI must
 * degrade to "no picture" rather than "no app", which also keeps the shell
 * navigable while the failure message is on screen.
 */
function announceReady(): void {
    queueMicrotask(() => {
        emit('simulation-initialized', null);
        emit('simulation-resumed', null);
    });
}

/** Apply to the engine if it booted, else no-op. */
function ifReady(fn: (ctx: ReturnType<typeof getEngineContext>) => void): null {
    if (hasEngineContext()) fn(getEngineContext());
    return null;
}

/**
 * As `ifReady`, but also requires a *constructed simulation*.
 *
 * `hasEngineContext()` only says a host exists. Every host method below goes
 * through `SimulationHost.requireSimulation()`, which throws "No simulation is
 * running" — so between navigating away and the next `start`, a click on any of
 * these buttons rejected its promise and the mode logged it. M6 found the same
 * two-part guard missing in `handlers/colorSchemes.ts:applyToSimulation` and
 * fixed it there; this is the rest of that fix. The window is real and not
 * narrow: the auto-hide timer, a queued preset apply and a debounced control
 * can all land after teardown.
 */
function ifRunning(fn: (ctx: ReturnType<typeof getEngineContext>) => void): null {
    if (!hasEngineContext()) return null;
    const ctx = getEngineContext();
    if (ctx.currentSimulation() === null) return null;
    fn(ctx);
    return null;
}

/** Run against the engine if it booted; otherwise degrade without throwing. */
async function startOrDegrade(id: string): Promise<null> {
    if (!hasEngineContext()) {
        announceReady();
        return null;
    }
    await getEngineContext().start(id);
    return null;
}

export function registerLifecycleHandlers(): void {
    register('start_simulation', async (args) => startOrDegrade(normalizeId(args.simulation_type)));

    for (const [command, id] of Object.entries(START_COMMANDS)) {
        register(command, async () => startOrDegrade(id));
    }

    register('destroy_simulation', async () => {
        // Navigating to the menu destroys before the engine may exist.
        if (hasEngineContext()) await getEngineContext().destroy();
        return null;
    });

    register('pause_simulation', async () => ifReady((c) => c.pause()));

    register('resume_simulation', async () => {
        ifReady((c) => c.resume());
        emit('simulation-resumed', null);
        return null;
    });

    register('step_simulation', async () => ifReady((c) => c.step()));

    register('reset_runtime_state', async () => ifRunning((c) => c.resetRuntimeState()));

    register('reset_simulation', async () => ifRunning((c) => c.resetSimulation()));

    /**
     * Slime Mold's "Clear Trails" — and its `reset_runtime_state`, which the
     * Rust routes straight to `reset_trails` (slime_mold/simulation.rs:2766),
     * so the two really are one operation rather than two that happen to agree.
     * Flow and Pellets reuse the command in M10/M12.
     */
    register('reset_trails', async () => ifRunning((c) => c.resetRuntimeState()));

    register('reset_agents', async () => ifRunning((c) => c.resetAgents()));

    register('seed_random_noise', async () => ifRunning((c) => c.seedRandomNoise()));

    register('randomize_settings', async () => ifRunning((c) => c.randomizeSettings()));

    /**
     * In the Rust this tore down poisoned global GPU state. Here the host's
     * destroy() already releases everything the simulation owned, and the
     * ResourceLedger is what proves it.
     */
    register('reset_graphics_resources', async () => {
        if (hasEngineContext()) await getEngineContext().destroy();
        return null;
    });

    /**
     * The Rust drove rendering from a tokio loop and exposed render_frame only
     * for the idle menu background. Here the RenderLoop owns the rAF chain, so
     * this is just a redraw request.
     */
    register('render_frame', async () => null);

    register('handle_window_resize', async () => {
        // The canvas owns its own size through a ResizeObserver; the window
        // event the frontend debounces is redundant here.
        return null;
    });

    register('set_fps_limit', async (args) =>
        ifReady((c) => {
            const enabled = args.enabled !== false;
            const limit = Number(args.limit);
            c.setFpsLimit(enabled && limit > 0 ? limit : null);
        })
    );
}
