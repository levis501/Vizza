/**
 * `SimulationId -> SimulationFactory`.
 *
 * Mirrors the `match simulation_type { ... }` at
 * src-tauri/src/simulations/traits.rs:236, with one structural change: the Rust
 * matched on a string and constructed inline, so every simulation was linked
 * into the binary whether or not it was ever run. Here each entry is a lazy
 * `import()`, so an unported simulation contributes nothing to the bundle and a
 * ported one is fetched on first use.
 *
 * Resolution goes through `import.meta.glob`, which Vite turns into a static
 * map of dynamic imports at build time. That matters for the "not ported yet"
 * case: a bare `import('$lib/engine/sims/moire')` for a directory that does not
 * exist is a **build** failure ("Failed to resolve import"), which would mean
 * the whole app stops building until all eleven sims land. The glob simply does
 * not match, and asking for that id throws a clear runtime error instead.
 *
 * Nothing here imports a GPU type at module scope, so this file loads in node.
 */

import type { GpuContext, Simulation, SimulationFactory, SimulationId } from '../types';
import { assertSimulationId } from './Simulation';

/**
 * Directory (or file) name under `sims/` for each id.
 *
 * The names follow WEB_PORT.md's "Engine core" tree, which is camelCase on disk
 * while the ids are the snake_case strings the Svelte components send. Only
 * `main_menu` exists today; the rest are the hooks each later milestone fills
 * in by creating the directory — no edit to this file is needed for that.
 */
export const SIMULATION_MODULE_NAMES: Record<SimulationId, string> = {
    slime_mold: 'slimeMold',
    gray_scott: 'grayScott',
    particle_life: 'particleLife',
    flow: 'flow',
    pellets: 'pellets',
    main_menu: 'mainMenu',
    gradient: 'gradient',
    voronoi_ca: 'voronoiCa',
    moire: 'moire',
    primordial_particles: 'primordial',
    vectors: 'vectors',
};

/**
 * What a simulation module must export: a `SimulationFactory`, under any of
 *
 *   - `createSimulation` (canonical),
 *   - the default export,
 *   - a single `create<Name>` export — e.g. `sims/mainMenu` exports
 *     `createMainMenu`, which reads better at its own call sites.
 *
 * Three accepted spellings rather than one because the sims land across eleven
 * milestones and a naming mismatch would surface as a runtime failure in the
 * one milestone that cannot easily be tested without a GPU.
 */
interface SimulationModule {
    default?: SimulationFactory;
    createSimulation?: SimulationFactory;
    [exportName: string]: unknown;
}

/**
 * Both layouts are globbed — `sims/mainMenu/index.ts` and `sims/mainMenu.ts` —
 * because a one-file sim has no reason to be a directory. Vite requires literal
 * patterns here, hence the array rather than a computed string.
 */
const simModules = import.meta.glob<SimulationModule>(['../sims/*/index.ts', '../sims/*.ts']);

/** Explicit registrations win over the glob. Tests and fakes go here. */
const overrides = new Map<SimulationId, SimulationFactory>();

/** Resolved modules, so a second `start()` of the same sim does not refetch. */
const resolved = new Map<SimulationId, SimulationFactory>();

/**
 * Register a factory directly, bypassing the module loader.
 *
 * Used by the DOM tests' fake engine (WEB_PORT.md "L4 runs against a fake
 * engine") and by the leak test, neither of which wants a real sim module.
 */
export function register(id: SimulationId, factory: SimulationFactory): void {
    overrides.set(id, factory);
}

/** Drop a registration made by `register`. The glob entry, if any, comes back. */
export function unregister(id: SimulationId): void {
    overrides.delete(id);
}

/** Test helper — drops every override and every cached module. */
export function resetRegistry(): void {
    overrides.clear();
    resolved.clear();
}

/** True if this id can be constructed: registered directly, or a module exists. */
export function has(id: SimulationId): boolean {
    return overrides.has(id) || moduleLoader(id) !== null;
}

/** Every id that can currently be constructed. */
export function available(): SimulationId[] {
    return (Object.keys(SIMULATION_MODULE_NAMES) as SimulationId[]).filter(has);
}

/**
 * Load (and cache) the factory for an id.
 *
 * Rejects with a readable message for both failure modes an operator will
 * actually hit: an id that is not a simulation at all, and a simulation whose
 * milestone has not landed.
 */
export async function resolve(id: SimulationId): Promise<SimulationFactory> {
    const override = overrides.get(id);
    if (override) return override;

    const cached = resolved.get(id);
    if (cached) return cached;

    const loader = moduleLoader(id);
    if (!loader) {
        throw new Error(
            `Simulation "${id}" is not ported yet — expected a module at ` +
                `$lib/engine/sims/${SIMULATION_MODULE_NAMES[id]}`
        );
    }

    const module = await loader();
    const factory = pickFactory(module);
    if (!factory) {
        throw new Error(
            `Simulation module for "${id}" exports no factory — it must export ` +
                `\`createSimulation\`, a default export, or a single \`create*\` ` +
                `function of type SimulationFactory`
        );
    }

    resolved.set(id, factory);
    return factory;
}

function pickFactory(module: SimulationModule): SimulationFactory | null {
    if (typeof module.createSimulation === 'function') return module.createSimulation;
    if (typeof module.default === 'function') return module.default;

    // Sorted so the choice is deterministic if a module ever exports two.
    const createExports = Object.keys(module)
        .filter((name) => /^create[A-Z]/.test(name) && typeof module[name] === 'function')
        .sort();

    return createExports.length > 0 ? (module[createExports[0]] as SimulationFactory) : null;
}

/** Resolve and construct in one step. `id` may be an untrusted string. */
export async function create(id: string, gpu: GpuContext): Promise<Simulation> {
    const factory = await resolve(assertSimulationId(id));
    return factory(gpu);
}

function moduleLoader(id: SimulationId): (() => Promise<SimulationModule>) | null {
    const name = SIMULATION_MODULE_NAMES[id];
    return simModules[`../sims/${name}/index.ts`] ?? simModules[`../sims/${name}.ts`] ?? null;
}
