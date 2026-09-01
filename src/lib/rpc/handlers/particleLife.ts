/**
 * Particle Life's one browser-only command.
 *
 * `get_particle_count_limit` has no `#[tauri::command]` behind it, exactly as
 * `get_agent_count_limit` does not — both exist because a ceiling that comes
 * from the device cannot be a literal in a Svelte file. The two differ in what
 * the ceiling protects against:
 *
 *  - Slime Mold's is **memory**. 100 million agents at 16 B is 1.6 GB against a
 *    128 MiB binding size, and an oversized `createBuffer` in a browser loses
 *    the device rather than rejecting.
 *  - Particle Life's is **time**. 50,000 particles is 1.2 MB, under 1% of the
 *    same budget, but `particle_life/compute.wgsl:144` walks the whole array
 *    per invocation with no spatial grid — 2.5 billion pair evaluations a
 *    frame at the cap. Past it the GPU does not fail, it stalls until the
 *    browser resets the context, which the user cannot tell from a crash.
 *
 * So on any device that meets the WebGPU spec minimums this returns exactly
 * `PARTICLE_LIFE_CEILING`, and the two device-derived bounds inside
 * `particleLifeCap` (the storage binding, and the un-foldable 1D dispatch) are
 * computed anyway rather than assumed — see gpu/limits.ts for why the dispatch
 * one cannot be folded away.
 *
 * The three-place clamp M7 established applies here too, and each place still
 * earns it: the `NumberDragBox` in `ParticleLifeMode` clamps so the user is
 * *told*, the mode clamps so a restored or preset value never reaches the
 * command, and the simulation clamps at the `createBuffer` itself.
 */

import { register } from '../registry';
import { getEngineContext, hasEngineContext } from '../context';
import { PARTICLE_LIFE_CEILING } from '$lib/engine/gpu/limits';

export function registerParticleLifeHandlers(): void {
    register('get_particle_count_limit', async () => {
        if (!hasEngineContext()) return PARTICLE_LIFE_CEILING;
        return getEngineContext().caps().particleLife;
    });
}
