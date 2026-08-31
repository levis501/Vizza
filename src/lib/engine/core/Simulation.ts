/**
 * The porting contract every simulation implements.
 *
 * `src/lib/engine/types.ts` is the source of truth for these types — it is
 * pinned so the GPU layer, the rpc handlers, and the sims can be built in
 * parallel against a stable seam. This module re-exports them under the path
 * the `core/` layer is imported from, and adds the small shared helpers that
 * would otherwise be duplicated in every sim.
 *
 * Do not redeclare any of these here. Change types.ts instead.
 */

export type {
    Simulation,
    SimulationId,
    SimulationFactory,
    GpuContext,
    Caps,
    CameraState,
    ColorScheme,
    GpuFailure,
} from '../types';

import type { SimulationId } from '../types';

/**
 * Every simulation id, mirroring the `SimulationType` variants at
 * src-tauri/src/simulations/traits.rs:233.
 *
 * Declared `satisfies` the union so adding a variant to types.ts without adding
 * it here is a compile error, not a mysteriously missing menu entry. Ordered as
 * the Rust enum is.
 */
export const SIMULATION_IDS = [
    'slime_mold',
    'gray_scott',
    'particle_life',
    'flow',
    'pellets',
    'main_menu',
    'gradient',
    'voronoi_ca',
    'moire',
    'primordial_particles',
    'vectors',
] as const satisfies readonly SimulationId[];

const ID_SET: ReadonlySet<string> = new Set<string>(SIMULATION_IDS);

/**
 * Narrow an untrusted string to a `SimulationId`.
 *
 * The rpc surface is string-keyed all the way from the Svelte components, so
 * every id crossing that boundary is untrusted until this says otherwise.
 */
export function isSimulationId(value: unknown): value is SimulationId {
    return typeof value === 'string' && ID_SET.has(value);
}

/** Throwing form, for call sites that have nothing useful to do with a `false`. */
export function assertSimulationId(value: unknown): SimulationId {
    if (!isSimulationId(value)) {
        throw new Error(`Unknown simulation type: ${JSON.stringify(value)}`);
    }
    return value;
}
