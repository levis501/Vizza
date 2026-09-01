/**
 * Particle Life settings and state — a port of
 * `particle_life/settings.rs` (742 ln) and `particle_life/state.rs` (119 ln).
 *
 * GPU-free on purpose, like every other `settings.ts` in this tree: the
 * defaults, the enum tables, the uniform packing and the two clamps are all
 * unit-testable in node, and the L4 fake engine can serve real settings to the
 * Svelte menu with no device at all.
 *
 * The force matrix itself lives next door in `matrix.ts` (the 22 generators)
 * and `matrixOperations.ts` (the 11 pure transforms); this module only carries
 * it, sizes it and flattens it for upload.
 *
 * Two things here are unlike the other simulations:
 *
 *  - **`Settings` and `State` disagree about where a control lives.** Six of
 *    the controls `ParticleLifeMode.svelte` renders — cursor size, cursor
 *    strength, traces, trace fade, colour-scheme reversal and background colour
 *    mode — are `State` fields sent through `update_simulation_state`, and
 *    `ParticleLifeModel::update_state` (simulation.rs:3656) has exactly **one**
 *    arm, `color_scheme`. All six are therefore dead on the desktop build. They
 *    are wired here; see `updateParticleLifeState`.
 *  - **`State::default()` is not what the app runs.** `ParticleLifeModel::new`
 *    builds its own `State` literal (simulation.rs:650) whose values differ from
 *    `Default` in seven fields, and `State::default()` has no caller for this
 *    simulation. The constructor's values are the defaults here, because they
 *    are the ones a user has ever actually seen. Each divergence is noted at the
 *    field.
 */

import {
    MATRIX_GENERATORS,
    generateForceMatrix,
    parseMatrixGenerator,
    type MatrixGenerator,
} from './matrix';

export type { MatrixGenerator };
export { MATRIX_GENERATORS };

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * `shared/position_generators.rs:5`, all eleven variants.
 *
 * The codes below are `state.position_generator as u32` (simulation.rs:2218) —
 * the declaration discriminants, which `PositionGenerator::as_u32` also
 * returns, so unlike Gray-Scott's `MaskTarget` the two agree and there is no
 * off-by-one to correct.
 */
export type ParticleLifePositionGenerator =
    | 'Random'
    | 'Center'
    | 'UniformCircle'
    | 'CenteredCircle'
    | 'Ring'
    | 'RainbowRing'
    | 'ColorBattle'
    | 'ColorWheel'
    | 'Line'
    | 'Spiral'
    | 'RainbowSpiral';

export const POSITION_GENERATORS: readonly ParticleLifePositionGenerator[] = [
    'Random',
    'Center',
    'UniformCircle',
    'CenteredCircle',
    'Ring',
    'RainbowRing',
    'ColorBattle',
    'ColorWheel',
    'Line',
    'Spiral',
    'RainbowSpiral',
];

/**
 * `settings.rs:72`, all eleven variants.
 *
 * These are **GPU** logic, not CPU: every one is a function in `init.wgsl`
 * (`generate_radial_type` and friends) selected by the `switch` at
 * `init.wgsl:327`. Nothing on the CPU side assigns a species. That is why the
 * table lives beside the position generators here rather than in `matrix.ts`.
 */
export type ParticleLifeTypeGenerator =
    | 'Radial'
    | 'Polar'
    | 'StripesH'
    | 'StripesV'
    | 'Random'
    | 'LineH'
    | 'LineV'
    | 'Spiral'
    | 'Dithered'
    | 'WavyLineH'
    | 'WavyLineV';

export const TYPE_GENERATORS: readonly ParticleLifeTypeGenerator[] = [
    'Radial',
    'Polar',
    'StripesH',
    'StripesV',
    'Random',
    'LineH',
    'LineV',
    'Spiral',
    'Dithered',
    'WavyLineH',
    'WavyLineV',
];

/**
 * `shared/types.rs:67`. Note the serde rename: the wire spelling of
 * `ColorScheme` is **`"Color Scheme"`, with a space**, and that is what
 * `ParticleLifeMode.svelte`'s `<Selector>` offers and what `update_setting`
 * matches on (simulation.rs:3592).
 */
export type ParticleLifeBackgroundMode = 'Gray18' | 'White' | 'Black' | 'Color Scheme';

export const BACKGROUND_COLOR_MODES: readonly ParticleLifeBackgroundMode[] = [
    'Gray18',
    'White',
    'Black',
    'Color Scheme',
];

/** `init.wgsl:282` — the order the position `switch` tests. */
export const POSITION_GENERATOR_CODE: Record<ParticleLifePositionGenerator, number> =
    Object.fromEntries(POSITION_GENERATORS.map((name, index) => [name, index])) as Record<
        ParticleLifePositionGenerator,
        number
    >;

/** `init.wgsl:327` — the order the type `switch` tests. */
export const TYPE_GENERATOR_CODE: Record<ParticleLifeTypeGenerator, number> = Object.fromEntries(
    TYPE_GENERATORS.map((name, index) => [name, index])
) as Record<ParticleLifeTypeGenerator, number>;

/**
 * `simulation.rs:2508` — the `ColorMode.mode` discriminant.
 *
 * Uploaded for fidelity and read by nobody: `fragment.wgsl` declares
 * `color_mode` at group 1 binding 1 and its `main` never mentions it. See
 * `PARTICLE_LIFE_COLOR_MODE_BYTES`.
 */
export const BACKGROUND_COLOR_MODE_CODE: Record<ParticleLifeBackgroundMode, number> = {
    Gray18: 0,
    White: 1,
    Black: 2,
    'Color Scheme': 3,
};

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

/**
 * `species_count.clamp(2, 8)` (settings.rs:162, :170).
 *
 * The 8 is not a taste decision and cannot be raised from here: `fragment.wgsl`
 * declares `colors: array<vec4<f32>, 9>` — eight species plus the background —
 * and indexes it with the raw species id. A ninth species would read out of
 * bounds, which WGSL clamps rather than traps, so every particle past the
 * eighth would silently take species 8's colour. `particleLifeMaxSpecies()`
 * reads that 9 out of the shader text so the two cannot drift.
 */
export const PARTICLE_LIFE_MIN_SPECIES = 2;
export const PARTICLE_LIFE_MAX_SPECIES = 8;

/** 24 B per particle: `vec2 position, vec2 velocity, u32 species, u32 _pad`. */
export const PARTICLE_STRIDE = 24;

/**
 * `manager.rs:323` — the count the desktop app constructs with.
 *
 * `State::default()`'s 1000 is not it; that value has no caller here.
 */
export const PARTICLE_LIFE_DEFAULT_PARTICLES = 15_000;

/**
 * The desktop UI's own maximum (`ParticleLifeMode.svelte:216`), and the browser
 * ceiling too.
 *
 * Memory is not the constraint — 50,000 particles is 1.2 MB, under 1% of the
 * 128 MiB binding budget. **`compute.wgsl:144` is O(n²)**: every invocation
 * walks the whole array, so 50,000 particles is 2.5 billion pair evaluations
 * per frame. Raising this would not lose the device the way Slime Mold's agent
 * count does; it would wedge the GPU long enough for the browser to reset the
 * context, which looks the same to the user and is harder to diagnose. The
 * Rust's own `update_particle_count` clamps to 100,000 (simulation.rs:3984),
 * twice what its UI offers and four times what a frame budget allows.
 */
export const PARTICLE_LIFE_PARTICLE_CEILING = 50_000;

/**
 * The lower bound is the Rust's (`clamp(1000, 100000)`), kept because below a
 * few hundred particles the field never forms a structure and the screen looks
 * broken rather than sparse. The GPU tests pass their own count and are the
 * reason this is a separate exported constant rather than a literal.
 */
export const PARTICLE_LIFE_MIN_PARTICLES = 1_000;

/**
 * Clamp a requested particle count into what this device will actually run.
 *
 * Reduces rather than rejects, exactly as `clampSlimeMoldAgentCount` does: a
 * preset or a restored `localStorage` value asking for the impossible still
 * starts the simulation, at the largest count that works.
 */
export function clampParticleCount(count: unknown, cap: number): number {
    const n = typeof count === 'number' && Number.isFinite(count) ? Math.floor(count) : 0;
    const ceiling = Math.max(1, Math.min(cap, PARTICLE_LIFE_PARTICLE_CEILING));
    return Math.max(1, Math.min(Math.max(n, PARTICLE_LIFE_MIN_PARTICLES), ceiling));
}

/** `Settings::set_species_count`'s clamp, as a reusable function. */
export function clampSpeciesCount(count: unknown): number {
    const n = typeof count === 'number' && Number.isFinite(count) ? Math.floor(count) : 0;
    return Math.max(PARTICLE_LIFE_MIN_SPECIES, Math.min(PARTICLE_LIFE_MAX_SPECIES, n));
}

/**
 * The species ceiling `fragment.wgsl` actually permits, read from its text.
 *
 * Used by a test to pin `PARTICLE_LIFE_MAX_SPECIES` against the shader rather
 * than against a comment. Returns null if the declaration ever moves, so the
 * test fails loudly instead of silently passing on a default.
 */
export function particleLifeMaxSpecies(fragmentShaderSource: string): number | null {
    const match = /colors\s*:\s*array\s*<\s*vec4\s*<\s*f32\s*>\s*,\s*(\d+)\s*>/.exec(
        fragmentShaderSource
    );
    if (!match) return null;
    // One slot of the nine is the background colour (simulation.rs:1239).
    return Number(match[1]) - 1;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** `struct Settings` (settings.rs:7). Field names are the serde spellings. */
export interface ParticleLifeSettings {
    species_count: number;
    /** Row-major `[species_a][species_b]`, values in [-1, 1]. */
    force_matrix: number[][];
    max_force: number;
    friction: number;
    wrap_edges: boolean;
    force_beta: number;
    /** Stored, serialised, and read by nothing. See `PARTICLE_LIFE_DEAD_SETTINGS`. */
    repulsion_strength: number;
    /** Stored, serialised, and read by nothing. See `PARTICLE_LIFE_DEAD_SETTINGS`. */
    min_distance: number;
    max_distance: number;
    brownian_motion: number;
}

/**
 * Two `Settings` fields reach no shader on any build, and are carried anyway.
 *
 *  - **`min_distance`** has an `update_setting` arm (simulation.rs:3445) and is
 *    never packed into `SimParams` — there is no slot for it. `compute.wgsl:72`
 *    hardcodes `let min_dist = 0.001;`, and `:161` hardcodes the same number
 *    again as the singularity cutoff. The default happens to *be* 0.001, so
 *    nothing looks wrong until someone changes it.
 *  - **`repulsion_strength`** has no `update_setting` arm at all, so it cannot
 *    even be written; its doc comment promises to multiply the close-range
 *    repulsion, and `calculate_force`'s close branch multiplies by `max_force`.
 *
 * Neither has a control in `ParticleLifeMode.svelte`, so neither is a *dead
 * control* in the M7 `position_generator` sense — they are unexposed fields.
 * They stay in the type because they are in the serialised `Settings` a desktop
 * preset carries, and dropping them would make such a preset fail to round-trip.
 */
export const PARTICLE_LIFE_DEAD_SETTINGS = ['min_distance', 'repulsion_strength'] as const;

/** Exactly `impl Default for Settings` (settings.rs:118). */
export function defaultParticleLifeSettings(): ParticleLifeSettings {
    return {
        species_count: 4,
        // The literal 4x4 from settings.rs:124-142, not a generated matrix.
        force_matrix: [
            [-0.1, 0.2, -0.1, 0.1],
            [0.2, -0.1, 0.3, -0.1],
            [-0.1, 0.3, -0.1, 0.2],
            [0.1, -0.1, 0.2, -0.1],
        ],
        max_force: 0.5,
        friction: 0.5,
        wrap_edges: true,
        force_beta: 0.5,
        repulsion_strength: 1.0,
        min_distance: 0.001,
        max_distance: 0.05,
        brownian_motion: 0.5,
    };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** `struct State` (state.rs:16), minus `particles` — that lives on the GPU. */
export interface ParticleLifeState {
    particle_count: number;
    random_seed: number;
    dt: number;
    cursor_size: number;
    cursor_strength: number;
    traces_enabled: boolean;
    trace_fade: number;
    /** Stored, serialised, and read by no shader on any build. */
    edge_fade_strength: number;
    position_generator: ParticleLifePositionGenerator;
    type_generator: ParticleLifeTypeGenerator;
    matrix_generator: MatrixGenerator;
    current_color_scheme: string;
    color_scheme_reversed: boolean;
    background_color_mode: ParticleLifeBackgroundMode;
    /** Linear RGBA, species-first, background appended in Color Scheme mode. */
    species_colors: number[][];
    particle_size: number;
    /** `TrailMapFiltering` (settings.rs:47). Doubly dead — see `updateSetting`. */
    trail_map_filtering: 'Nearest' | 'Linear';
}

/**
 * The `State` literal `ParticleLifeModel::new` builds (simulation.rs:650), not
 * `State::default()` (state.rs:97).
 *
 * The two disagree in seven fields and the constructor is the one that runs, so
 * these are the numbers a desktop user has actually seen:
 *
 * | field | `State::default` | constructor | here |
 * |---|---|---|---|
 * | `particle_count` | 1000 | 15000 (manager.rs:323) | 15000 |
 * | `random_seed` | 42 | 0 | **random** |
 * | `cursor_size` | 0.1 | 0.5 | 0.5 |
 * | `cursor_strength` | 1.0 | 5.0 | 5.0 |
 * | `traces_enabled` | true | false | false |
 * | `trace_fade` | 0.95 | 0.48 | 0.48 |
 * | `edge_fade_strength` | 0.1 | 1.0 | 1.0 |
 * | `particle_size` | 0.01 | 4.0 | 4.0 |
 * | `current_color_scheme` | cubehelix | ocean | ocean |
 *
 * `random_seed` is the one deliberate divergence. The Rust constructs with 0,
 * and `init.wgsl`'s seed for particle *i* is `random_seed + i`, so particle 0
 * gets seed 0, `hash(0)` is 0, and it is placed at exactly (-1, -1) — the
 * bottom-left corner — on every fresh start. Seeding randomly costs nothing and
 * removes the artefact; `ParticleLifeSimulation.create` takes a `seed` option so
 * the GPU tests stay deterministic.
 */
export function defaultParticleLifeState(): ParticleLifeState {
    return {
        particle_count: PARTICLE_LIFE_DEFAULT_PARTICLES,
        random_seed: 0,
        dt: 0.016,
        cursor_size: 0.5,
        cursor_strength: 5.0,
        traces_enabled: false,
        trace_fade: 0.48,
        edge_fade_strength: 1.0,
        position_generator: 'Random',
        type_generator: 'Random',
        matrix_generator: 'Random',
        current_color_scheme: 'MATPLOTLIB_ocean',
        color_scheme_reversed: true,
        background_color_mode: 'Color Scheme',
        species_colors: [],
        particle_size: 4.0,
        trail_map_filtering: 'Nearest',
    };
}

/**
 * The document `get_state` produces, which is what `sync.ts` reads back.
 *
 * `camera_position` / `camera_zoom` are folded in by the caller, as Slime
 * Mold's `slimeMoldStateDocument` does, because the camera belongs to the host
 * rather than to any one simulation.
 */
export function particleLifeStateDocument(
    state: ParticleLifeState & { camera_position?: [number, number]; camera_zoom?: number }
): Record<string, unknown> {
    return { ...state };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function asFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asFloat(value: unknown, name: string): number {
    const n = asFiniteNumber(value);
    if (n === null) {
        throw new Error(`Setting "${name}" needs a finite number, got ${JSON.stringify(value)}`);
    }
    return n;
}

/** `value.as_bool()` — no coercion, so a stray `"false"` is rejected loudly. */
function asBool(value: unknown, name: string): boolean {
    if (typeof value !== 'boolean') {
        throw new Error(`Setting "${name}" needs a boolean, got ${JSON.stringify(value)}`);
    }
    return value;
}

/**
 * `_ => PositionGenerator::Random` (simulation.rs:3524), preserved.
 *
 * A fallback rather than a throw because the ButtonSelect in
 * `ParticleLifeMode.svelte` offers only **seven** of the eleven, so a value
 * arriving from a preset written against a build with more of them exposed
 * still has to land somewhere.
 */
export function parsePositionGenerator(value: unknown): ParticleLifePositionGenerator {
    return typeof value === 'string' && (POSITION_GENERATORS as readonly string[]).includes(value)
        ? (value as ParticleLifePositionGenerator)
        : 'Random';
}

/** `_ => TypeGenerator::Random` (simulation.rs:3545). */
export function parseTypeGenerator(value: unknown): ParticleLifeTypeGenerator {
    return typeof value === 'string' && (TYPE_GENERATORS as readonly string[]).includes(value)
        ? (value as ParticleLifeTypeGenerator)
        : 'Random';
}

/**
 * `_ => BackgroundColorMode::ColorScheme` (simulation.rs:3593).
 *
 * The serde spelling has a space; the `Display`-style `ColorScheme` is accepted
 * too, because `get_state` on an older build emitted whichever serde produced
 * and a preset may carry either. Same defensive move as Gray-Scott's mask
 * parsers, for the same reason.
 */
export function parseBackgroundColorMode(value: unknown): ParticleLifeBackgroundMode {
    const text = String(value ?? '').trim();
    const found = BACKGROUND_COLOR_MODES.find((mode) => mode.toLowerCase() === text.toLowerCase());
    if (found) return found;
    if (text.toLowerCase() === 'colorscheme') return 'Color Scheme';
    return 'Color Scheme';
}

/**
 * Coerce an arbitrary value into a square force matrix of `speciesCount` rows.
 *
 * A preset carries the matrix as nested JSON arrays and nothing on the wire
 * guarantees it is square, finite, or the right size — `update_setting`
 * (simulation.rs:3416) copies element-wise into whatever shape it already has
 * and silently drops the rest. Rebuilding to the declared size instead means an
 * undersized matrix is padded with zeroes (neutral) rather than leaving the
 * previous generator's values in the tail.
 */
export function normalizeForceMatrix(value: unknown, speciesCount: number): number[][] {
    const n = clampSpeciesCount(speciesCount);
    const rows = Array.isArray(value) ? (value as unknown[]) : [];
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
        const source = Array.isArray(rows[i]) ? (rows[i] as unknown[]) : [];
        const row = new Array<number>(n);
        for (let j = 0; j < n; j++) {
            const cell = asFiniteNumber(source[j]);
            // `Settings::set_force` clamps to [-1, 1] (settings.rs:684); the
            // direct `force_matrix` write path does not, so a hand-edited
            // preset could push a 50 into the force law. Clamped on both paths.
            row[j] = cell === null ? 0 : Math.max(-1, Math.min(1, cell));
        }
        out.push(row);
    }
    return out;
}

/**
 * Resize a matrix to a new species count, preserving the overlap.
 *
 * **Deliberately not `Settings::set_species_count`.** That resizes with zeroes
 * and then, for any count above 2, overwrites the *entire* matrix with a fresh
 * `MatrixGenerator::Random` draw (settings.rs:180) — so bumping the species
 * count from 4 to 5 discards a matrix the user tuned by hand. It is invisible
 * on the desktop only because every path that reaches it immediately sends its
 * own preserved matrix afterwards (`ParticleLifeMode.svelte:504`, and
 * `apply_settings` at simulation.rs:3832), which overwrites the random draw
 * before a frame is rendered. Preserving here makes the engine agree with what
 * the UI was already doing, and removes a randomisation nothing wanted.
 */
export function resizeForceMatrix(matrix: number[][], speciesCount: number): number[][] {
    const n = clampSpeciesCount(speciesCount);
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
        const row = new Array<number>(n).fill(0);
        for (let j = 0; j < n && i < matrix.length; j++) {
            const cell = asFiniteNumber(matrix[i]?.[j]);
            if (cell !== null) row[j] = Math.max(-1, Math.min(1, cell));
        }
        out.push(row);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Setting and state writes
// ---------------------------------------------------------------------------

/**
 * What the simulation has to do on the GPU once a write lands.
 *
 * `respawn` is the expensive one — it re-runs `init.wgsl` over the whole pool —
 * so it is only returned by the three writes that genuinely invalidate every
 * particle.
 */
export type ParticleLifeEffect =
    | 'none'
    | 'sim-params'
    | 'force-matrix'
    | 'species-count'
    | 'particle-count'
    | 'respawn'
    | 'recolor'
    | 'background';

const SETTING_FLOATS = [
    'max_force',
    'friction',
    'force_beta',
    'repulsion_strength',
    'min_distance',
    'max_distance',
] as const;

const SETTING_FLOAT_SET: ReadonlySet<string> = new Set<string>(SETTING_FLOATS);

/**
 * Port of `update_setting` (simulation.rs:3362).
 *
 * Divergences, all of them widening rather than narrowing:
 *
 *  - **`matrix_generator` regenerates the matrix *and says so*.** The Rust
 *    calls `randomize_force_matrix`, then `recreate_bind_groups_with_force_matrix`
 *    — which rebuilds a bind group pointing at the *same, unchanged* buffer —
 *    and then `update_sim_params`, which writes `SimParams`. At no point does
 *    the new matrix reach `force_matrix_buffer`. All 22 generators are therefore
 *    no-ops on the desktop unless "Randomize" is pressed afterwards, which takes
 *    a different path (`randomize_settings`, simulation.rs:3906) that does
 *    upload. Returning `'force-matrix'` here is the fix.
 *  - **`repulsion_strength` is accepted.** The Rust has no arm, so the field can
 *    be deserialised from a preset but never written. Nothing reads it either
 *    way (see `PARTICLE_LIFE_DEAD_SETTINGS`), but silently dropping a write is
 *    worse than storing one.
 *  - **an unknown name throws.** The Rust's `_ => {}` swallowed every typo, so a
 *    misspelled setting reported success and did nothing. `sync.ts` rolls back
 *    on a rejection, which is what makes the mistake visible.
 */
export function updateParticleLifeSetting(
    settings: ParticleLifeSettings,
    state: ParticleLifeState,
    name: string,
    value: unknown,
    rng: () => number = Math.random
): ParticleLifeEffect {
    if (SETTING_FLOAT_SET.has(name)) {
        settings[name as (typeof SETTING_FLOATS)[number]] = asFloat(value, name);
        return 'sim-params';
    }

    switch (name) {
        case 'brownian_motion':
            // simulation.rs:3467 is the one arm with a clamp.
            settings.brownian_motion = Math.max(0, Math.min(1, asFloat(value, name)));
            return 'sim-params';

        case 'wrap_edges':
            settings.wrap_edges = asBool(value, name);
            return 'sim-params';

        case 'species_count': {
            const next = clampSpeciesCount(asFloat(value, name));
            if (next === settings.species_count) return 'none';
            settings.species_count = next;
            settings.force_matrix = resizeForceMatrix(settings.force_matrix, next);
            return 'species-count';
        }

        case 'force_matrix':
            settings.force_matrix = normalizeForceMatrix(value, settings.species_count);
            return 'force-matrix';

        case 'particle_count':
            // Clamping happens at the sink, where `caps` is in scope.
            state.particle_count = Math.max(1, Math.floor(asFloat(value, name)));
            return 'particle-count';

        case 'matrix_generator':
            state.matrix_generator = parseMatrixGenerator(value);
            settings.force_matrix = generateForceMatrix(
                state.matrix_generator,
                settings.species_count,
                rng
            );
            return 'force-matrix';

        case 'position_generator':
            state.position_generator = parsePositionGenerator(value);
            return 'respawn';

        case 'type_generator':
            state.type_generator = parseTypeGenerator(value);
            return 'respawn';

        case 'dt':
            state.dt = asFloat(value, name);
            return 'sim-params';

        case 'random_seed':
            state.random_seed = Math.floor(asFloat(value, name)) >>> 0;
            return 'sim-params';

        case 'cursor_size':
            state.cursor_size = asFloat(value, name);
            return 'sim-params';

        case 'cursor_strength':
            // simulation.rs:3487.
            state.cursor_strength = Math.max(0, Math.min(10, asFloat(value, name)));
            return 'sim-params';

        case 'particle_size':
            state.particle_size = asFloat(value, name);
            return 'sim-params';

        case 'traces_enabled':
            state.traces_enabled = asBool(value, name);
            return 'none';

        case 'trace_fade':
            state.trace_fade = asFloat(value, name);
            return 'none';

        case 'edge_fade_strength':
            state.edge_fade_strength = asFloat(value, name);
            return 'none';

        case 'background_color_mode':
            state.background_color_mode = parseBackgroundColorMode(value);
            return 'background';

        case 'color_scheme':
            state.current_color_scheme = String(value ?? '');
            return 'recolor';

        case 'color_scheme_reversed':
            state.color_scheme_reversed = asBool(value, name);
            return 'recolor';

        case 'trail_map_filtering':
            // `TrailMapFiltering` is a `State` field with no `update_setting`
            // arm, no `update_state` arm, no control, and no reader. Accepted so
            // a desktop state document round-trips; it changes nothing, exactly
            // as on the desktop.
            state.trail_map_filtering = value === 'Linear' ? 'Linear' : 'Nearest';
            return 'none';

        default:
            throw new Error(`Unknown setting: ${name}`);
    }
}

/**
 * Port of `update_state` (simulation.rs:3656) — which has **one** arm.
 *
 * Six controls in `ParticleLifeMode.svelte` reach the backend only through
 * `syncManager.updateStateOptimistic`, i.e. `update_simulation_state`:
 * `cursor_size`, `cursor_strength`, `traces_enabled`, `trace_fade`,
 * `color_scheme_reversed` and `background_color_mode`. The Rust's `update_state`
 * matches `color_scheme` and warns on everything else, so all six move a widget
 * and change nothing on the desktop build — the same class of defect M3 found in
 * Moiré, at six controls rather than twelve.
 *
 * Every state name is routed to `updateParticleLifeSetting` here, which is where
 * they all live anyway: the Rust's own `update_setting` already had arms for
 * five of the six, so this is joining up two halves that were both already
 * written rather than inventing behaviour.
 */
export function updateParticleLifeState(
    settings: ParticleLifeSettings,
    state: ParticleLifeState,
    name: string,
    value: unknown,
    rng: () => number = Math.random
): ParticleLifeEffect {
    return updateParticleLifeSetting(settings, state, name, value, rng);
}

/**
 * Coerce an arbitrary document into a complete `ParticleLifeSettings`.
 *
 * `species_count` is applied **first**, whatever order the keys arrive in, so
 * that a `force_matrix` in the same document is normalised against the size the
 * document declares rather than against the previous one. The Rust's
 * `apply_settings` gets this right only because it hand-orders nine explicit
 * calls (simulation.rs:3829); a plain key loop would size the matrix wrongly
 * about half the time.
 */
export function normalizeParticleLifeSettings(input: unknown): ParticleLifeSettings {
    const settings = defaultParticleLifeSettings();
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return settings;
    }

    const document = input as Record<string, unknown>;
    const state = defaultParticleLifeState();

    if ('species_count' in document) {
        settings.species_count = clampSpeciesCount(asFiniteNumber(document.species_count) ?? 4);
        settings.force_matrix = resizeForceMatrix(settings.force_matrix, settings.species_count);
    }

    for (const [name, value] of Object.entries(document)) {
        if (name === 'species_count') continue;
        try {
            updateParticleLifeSetting(settings, state, name, value);
        } catch {
            // A preset from a newer build, or a hand-edited localStorage entry.
            console.warn(`[particle_life] ignoring unusable setting "${name}"`);
        }
    }

    // A document that named a species count but no matrix, or a malformed one,
    // still has to leave a square matrix behind.
    settings.force_matrix = normalizeForceMatrix(settings.force_matrix, settings.species_count);
    return settings;
}

/**
 * Port of `randomize_settings` (simulation.rs:3893).
 *
 * Only the force matrix moves, through the *currently selected* generator —
 * the physics parameters and both counts are deliberately preserved, which the
 * Rust comments on at :3919. That makes "Regenerate Matrix" a usable button
 * rather than a reset.
 */
export function randomizeParticleLifeSettings(
    settings: ParticleLifeSettings,
    state: ParticleLifeState,
    rng: () => number = Math.random
): void {
    settings.force_matrix = generateForceMatrix(
        state.matrix_generator,
        settings.species_count,
        rng
    );
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** 768 planar u32 entries — [R]x256, [G]x256, [B]x256. */
const LUT_ENTRIES = 768;

/** `srgb_to_linear` (color_scheme.rs:73), the sRGB EOTF. */
function srgbToLinear(srgb: number): number {
    return srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

/**
 * Port of `ColorScheme::get_colors` (color_scheme.rs:64) over a raw planar LUT.
 *
 * `n` equidistant stops with **integer** index arithmetic — `(i * 255) / (n - 1)`
 * truncating, not rounding — because that is what the Rust does and the stop
 * positions are visible as the species colours themselves.
 */
export function sampleLutColors(lut: Uint32Array, n: number): number[][] {
    if (lut.length !== LUT_ENTRIES) {
        throw new Error(`LUT must be ${LUT_ENTRIES} u32 entries, got ${lut.length}`);
    }
    const colors: number[][] = [];
    for (let i = 0; i < n; i++) {
        const index = Math.min(255, n === 1 ? 0 : Math.floor((i * 255) / (n - 1)));
        colors.push([
            srgbToLinear(lut[index] / 255),
            srgbToLinear(lut[256 + index] / 255),
            srgbToLinear(lut[512 + index] / 255),
            1.0,
        ]);
    }
    return colors;
}

/**
 * The `species_colors` vector `update_lut` builds (simulation.rs:2419).
 *
 * In **Color Scheme** mode the LUT is sampled at `speciesCount + 1` stops, the
 * first stop becomes the background and is moved to the *end*, and the rest are
 * the species in order. In the three flat modes the LUT is sampled at
 * `speciesCount` stops and the background is a constant, so the vector holds
 * species only. `fragment.wgsl` indexes it by raw species id in both cases,
 * which is why the background has to be last rather than first.
 */
export function particleLifeSpeciesColors(
    lut: Uint32Array,
    speciesCount: number,
    mode: ParticleLifeBackgroundMode
): number[][] {
    const n = clampSpeciesCount(speciesCount);
    if (mode !== 'Color Scheme') return sampleLutColors(lut, n);

    const raw = sampleLutColors(lut, n + 1);
    return [...raw.slice(1, n + 1), raw[0]];
}

/**
 * `update_background_params` (simulation.rs:2615) — the colour every render
 * target is cleared to.
 *
 * In Color Scheme mode the background is the entry at index `speciesCount`,
 * i.e. the one `particleLifeSpeciesColors` appended; the `min` guards a colours
 * vector that has not been rebuilt for the current species count yet.
 */
export function particleLifeBackgroundColor(
    state: Pick<ParticleLifeState, 'background_color_mode' | 'species_colors'>,
    speciesCount: number
): [number, number, number, number] {
    switch (state.background_color_mode) {
        case 'Black':
            return [0, 0, 0, 1];
        case 'White':
            return [1, 1, 1, 1];
        case 'Gray18':
            return [0.18, 0.18, 0.18, 1];
        case 'Color Scheme': {
            const colors = state.species_colors;
            if (colors.length === 0) return [0, 0, 0, 1];
            const index = Math.min(clampSpeciesCount(speciesCount), colors.length - 1);
            const [r, g, b, a] = colors[index];
            return [r, g, b, a ?? 1];
        }
    }
}

// ---------------------------------------------------------------------------
// Uniform packing
// ---------------------------------------------------------------------------

/** `struct SimParams` — 20 words, 80 B, pinned by `test_sim_params_size_and_alignment`. */
export const PARTICLE_LIFE_SIM_PARAM_BYTES = 80;

/** `struct InitParams` — 10 words, 40 B. */
export const PARTICLE_LIFE_INIT_PARAM_BYTES = 40;

/** `struct FadeUniforms` — one f32 plus three words of padding. */
export const PARTICLE_LIFE_FADE_PARAM_BYTES = 16;

/** `struct ViewportParams` — vec4 world_bounds, vec2 texture_size, 2 pads. */
export const PARTICLE_LIFE_VIEWPORT_PARAM_BYTES = 32;

/** `struct SpeciesColors` — `array<vec4<f32>, 9>` (fragment.wgsl:15). */
export const PARTICLE_LIFE_SPECIES_COLOR_BYTES = 9 * 16;

/** `struct ColorMode` — one u32 plus three words of padding, and read by nobody. */
export const PARTICLE_LIFE_COLOR_MODE_BYTES = 16;

export interface SimParamInputs {
    /** Display-texture size in pixels; `width`/`height` in the struct. */
    width: number;
    height: number;
    particleCount: number;
    /** 0 = inactive, 1 = attract, 2 = repel (compute.wgsl:177). */
    cursorActive: 0 | 1 | 2;
    cursorX: number;
    cursorY: number;
}

/**
 * Pack `SimParams`. Pure, so the field order can be pinned by a unit test.
 *
 * The struct is 20 words of mixed `u32` and `f32`, hence the two views over one
 * buffer rather than a single typed array.
 *
 * **Word 17 is `particle_size`.** `vertex.wgsl:28` and `simulation.rs:97` both
 * say so; `compute.wgsl:29` declared `aspect_ratio` there instead and shifted
 * its two pad words along, so the *same* 80 bytes were read as two different
 * structs. Nothing broke, because `compute.wgsl` names `aspect_ratio` in its
 * struct and reads it nowhere — but the next field anyone adds to that struct
 * would have silently read `particle_size`. The declaration in `compute.wgsl`
 * now matches the CPU struct; see the note in `index.ts`.
 *
 * **`cursor_strength` is scaled here, not stored scaled.** `update_sim_params`
 * (simulation.rs:2169) multiplies by `max_force * 10` only while the cursor is
 * held, so `get_state` keeps reporting the 0..10 the slider set.
 */
export function packParticleLifeSimParams(
    settings: ParticleLifeSettings,
    state: ParticleLifeState,
    inputs: SimParamInputs,
    out: ArrayBuffer = new ArrayBuffer(PARTICLE_LIFE_SIM_PARAM_BYTES)
): ArrayBuffer {
    const u = new Uint32Array(out);
    const f = new Float32Array(out);

    u[0] = Math.max(0, Math.floor(inputs.particleCount));
    u[1] = clampSpeciesCount(settings.species_count);
    f[2] = settings.max_force;
    f[3] = settings.max_distance;
    f[4] = settings.friction;
    u[5] = settings.wrap_edges ? 1 : 0;
    f[6] = inputs.width;
    f[7] = inputs.height;
    u[8] = state.random_seed >>> 0;
    f[9] = state.dt;
    f[10] = settings.force_beta;
    f[11] = inputs.cursorX;
    f[12] = inputs.cursorY;
    f[13] = state.cursor_size;
    f[14] =
        inputs.cursorActive > 0
            ? state.cursor_strength * settings.max_force * 10
            : state.cursor_strength;
    u[15] = inputs.cursorActive;
    f[16] = settings.brownian_motion;
    f[17] = state.particle_size;
    f[18] = inputs.height > 0 ? inputs.width / inputs.height : 1;
    u[19] = 0;

    return out;
}

export interface InitParamInputs {
    startIndex: number;
    spawnCount: number;
    width: number;
    height: number;
}

/**
 * Pack `InitParams` (simulation.rs:31).
 *
 * `width` and `height` are uploaded and read by nothing — `init.wgsl` works
 * entirely in the world's [-1, 1] box and never mentions either field. Kept so
 * the struct still matches the shader's declaration word for word.
 */
export function packParticleLifeInitParams(
    settings: ParticleLifeSettings,
    state: ParticleLifeState,
    inputs: InitParamInputs,
    out: ArrayBuffer = new ArrayBuffer(PARTICLE_LIFE_INIT_PARAM_BYTES)
): ArrayBuffer {
    const u = new Uint32Array(out);
    const f = new Float32Array(out);

    u[0] = Math.max(0, Math.floor(inputs.startIndex));
    u[1] = Math.max(0, Math.floor(inputs.spawnCount));
    u[2] = clampSpeciesCount(settings.species_count);
    f[3] = inputs.width;
    f[4] = inputs.height;
    u[5] = state.random_seed >>> 0;
    u[6] = POSITION_GENERATOR_CODE[state.position_generator];
    u[7] = TYPE_GENERATOR_CODE[state.type_generator];
    u[8] = 0;
    u[9] = 0;

    return out;
}

/**
 * `fade_amount` (simulation.rs:3185): `trace_fade` is inverted and scaled to an
 * alpha subtraction of at most 0.1 a frame, and a `trace_fade` of 1.0 means no
 * fade at all.
 *
 * Exported because the L3 fade test derives its expected decay from this rather
 * than from a constant written twice.
 */
export function particleLifeFadeAmount(traceFade: number): number {
    if (!Number.isFinite(traceFade) || traceFade >= 1) return 0;
    return (1 - Math.max(0, traceFade)) * 0.1;
}

/** Pack `FadeUniforms` (fade_fragment.wgsl:8). */
export function packParticleLifeFadeParams(
    traceFade: number,
    out: Float32Array = new Float32Array(PARTICLE_LIFE_FADE_PARAM_BYTES / 4)
): Float32Array {
    out[0] = particleLifeFadeAmount(traceFade);
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    return out;
}

/**
 * Pack `ViewportParams` (vertex.wgsl:40).
 *
 * `world_bounds` is the fixed [-1, 1] square every tile of the infinite canvas
 * represents (simulation.rs:2183), not the camera's view — the camera is applied
 * later, by the infinite renderer. `texture_size` is uploaded and read by
 * nothing, like `InitParams.width`.
 */
export function packParticleLifeViewportParams(
    width: number,
    height: number,
    out: Float32Array = new Float32Array(PARTICLE_LIFE_VIEWPORT_PARAM_BYTES / 4)
): Float32Array {
    out[0] = -1;
    out[1] = -1;
    out[2] = 1;
    out[3] = 1;
    out[4] = width;
    out[5] = height;
    out[6] = 0;
    out[7] = 0;
    return out;
}

/**
 * Pack the nine `vec4<f32>` slots `fragment.wgsl` indexes by species id.
 *
 * Slots past the colours supplied stay opaque black, which is what
 * `simulation.rs:1245` initialises them to.
 */
export function packParticleLifeSpeciesColors(
    colors: readonly number[][],
    out: Float32Array = new Float32Array(PARTICLE_LIFE_SPECIES_COLOR_BYTES / 4)
): Float32Array {
    out.fill(0);
    for (let i = 0; i < 9; i++) {
        out[i * 4 + 3] = 1;
        const color = colors[i];
        if (!color) continue;
        out[i * 4] = color[0] ?? 0;
        out[i * 4 + 1] = color[1] ?? 0;
        out[i * 4 + 2] = color[2] ?? 0;
        out[i * 4 + 3] = color[3] ?? 1;
    }
    return out;
}

/** Flatten the force matrix row-major, as `flatten_force_matrix` does. */
export function flattenForceMatrix(matrix: readonly (readonly number[])[]): Float32Array {
    const n = matrix.length;
    const out = new Float32Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) out[i * n + j] = matrix[i]?.[j] ?? 0;
    }
    return out;
}
