/**
 * Slime Mold settings and runtime state — a port of
 * src-tauri/src/simulations/slime_mold/{settings.rs,state.rs}, plus the
 * settings/state/preset half of simulation.rs.
 *
 * Deliberately GPU-free, exactly as `sims/grayScott/settings.ts` is: the
 * defaults, the five enums, the three uniform packers, the randomizer and the
 * agent-count clamp are then unit testable in node, and
 * `sims/slimeMold/index.ts` is left holding nothing but pipelines and buffers.
 *
 * Field names are the snake_case strings `SlimeMoldMode.svelte` sends through
 * `update_simulation_setting` / `update_simulation_state`, and the serialized
 * values are what serde produced — a preset written by the desktop app must
 * load here unchanged.
 *
 * **No numeric clamping on the simulation parameters.** settings.rs declares
 * none and neither does `update_setting` (simulation.rs:1181), so clamping to
 * the ranges `SlimeMoldMode.svelte` puts on its drag boxes would be a silent
 * behaviour change. What *is* clamped is the pair the Rust itself clamps
 * (`cursor_size`, `cursor_strength`, simulation.rs:1404/1411) and the agent
 * count, which is the one number in this simulation that can lose the device.
 *
 * **`workgroup_optimizer.rs` (242 ln) does not port.** It picks 1D and 2D
 * workgroup sizes from the GPU *vendor* string (Nvidia / AMD / Intel / Apple),
 * and WebGPU deliberately does not expose the vendor reliably —
 * `GPUAdapterInfo.vendor` is empty on Chrome unless the origin is explicitly
 * allowlisted. The browser build uses a fixed size derived from
 * `device.limits.maxComputeWorkgroupSizeX` instead; that choice belongs to
 * `index.ts`, not here. **No setting in this file depends on the workgroup
 * size** — it is a pure dispatch-shape parameter, consumed only by
 * `foldDispatch` (gpu/limits.ts) and the `@workgroup_size` attributes in the
 * WGSL — so nothing below has to be revisited when it changes.
 */

import { parseImageFitMode, type ImageFitMode } from '$lib/engine/resources/imageUpload';

// ---------------------------------------------------------------------------
// Agent count
// ---------------------------------------------------------------------------

/**
 * The desktop app's agent count, hardcoded at both construction sites
 * (simulation/manager.rs:266 and simulations/traits.rs:266).
 *
 * At the 16-byte stride that is **160 MB** in one storage buffer, against a
 * 128 MiB (134,217,728 B) default `maxStorageBufferBindingSize`. The reference
 * device grants exactly the spec defaults, so the desktop default does not fit
 * in a browser at all — this constant exists to be *compared against*, not to
 * be used.
 */
export const SLIME_MOLD_DESKTOP_AGENTS = 10_000_000;

/**
 * The browser default, per WEB_PORT.md's M7 entry ("drop the default to ~1M").
 *
 * 1 M agents is 16 MB — 12% of the default binding budget, and enough to fill a
 * 4K trail map densely. The desktop's 10 M was never a considered number: it is
 * the same literal in two files with no comment.
 */
export const SLIME_MOLD_DEFAULT_AGENTS = 1_000_000;

/**
 * Hard floor. A zero-length storage buffer is not a legal binding in WebGPU,
 * and `create_agent_buffer` (simulation.rs:2826) would happily ask for one —
 * `update_agent_count` takes a bare `u32` straight into
 * `self.agent_count = count as usize` with no validation anywhere in the path
 * (commands/slime_mold.rs:55 → simulation.rs:1485).
 */
export const SLIME_MOLD_MIN_AGENTS = 1;

/**
 * Reduce a requested agent count to something the device can actually bind.
 *
 * Pure, and takes the cap as a parameter rather than reading `caps` — the whole
 * point is that it can be exercised at cap, cap+1, 0 and negative without a
 * GPU. `caps.slimeMoldAgents` (gpu/limits.ts) is what production passes.
 *
 * **Reduces, never rejects.** A preset, a `localStorage` entry or a desktop
 * settings file asking for 10 M has to keep working; refusing it would strand
 * the user on a mode that will not start. The Rust has no equivalent — its only
 * ceiling is the UI's `max={100}` (in millions), i.e. **1.6 GB**, which is a
 * guaranteed device loss rather than an error.
 *
 * Fractional input is floored, because `AgentCountInput` works in millions with
 * a 0.1 step and 0.1 M is exact but 1/3 M is not.
 */
export function clampSlimeMoldAgentCount(requested: unknown, cap: number): number {
    // A cap below the floor would otherwise invert the clamp and return 0.
    const ceiling = Math.max(SLIME_MOLD_MIN_AGENTS, Math.floor(cap));
    if (typeof requested !== 'number' || !Number.isFinite(requested)) {
        // Garbage in a stored document, not a user action: fall back to the
        // default rather than to the floor, which would look like a hang.
        return Math.min(SLIME_MOLD_DEFAULT_AGENTS, ceiling);
    }
    return Math.min(ceiling, Math.max(SLIME_MOLD_MIN_AGENTS, Math.floor(requested)));
}

/**
 * The `max` `AgentCountInput` should carry, in millions.
 *
 * `SlimeMoldMode.svelte:295` hardcodes `max={100}`. Rounded *down* to a tenth
 * so the widget's own 0.1 step can never produce a value above the cap.
 */
export function slimeMoldAgentMaxMillions(cap: number): number {
    return Math.floor(cap / 100_000) / 10;
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Fold any accepted spelling onto one lookup key.
 *
 * `"Diagonal Gradient"`, `"DiagonalGradient"` and `"diagonal_gradient"` all
 * collapse to `diagonalgradient`, which is what lets one table accept serde
 * output, display names and underscore forms without three branches.
 */
function enumKey(value: unknown): string {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '');
}

function buildParser<T extends string>(
    label: string,
    variants: readonly T[],
    extraAliases: readonly (readonly [string, T])[] = []
): (value: unknown) => T {
    const byKey = new Map<string, T>([
        ...variants.map((variant) => [enumKey(variant), variant] as const),
        ...extraAliases.map(([alias, variant]) => [enumKey(alias), variant] as const),
    ]);
    return (value: unknown): T => {
        const found = byKey.get(enumKey(value));
        if (found) return found;
        throw new Error(
            `Invalid ${label}: '${String(value)}'. Expected one of ${variants.join(', ')}`
        );
    };
}

// --- MaskPattern (9 variants) ----------------------------------------------

/**
 * state.rs:24. **The display spelling is canonical**, and here that is the
 * spelling the whole live path already agrees on.
 *
 * Three spellings exist in the Rust, as they do in Gray-Scott:
 *
 *   - serde's, from the bare `#[derive(Serialize)]` on a unit enum —
 *     `"DiagonalGradient"`;
 *   - `as_str()`'s display name (state.rs:56) — `"Diagonal Gradient"`;
 *   - `from_str` (state.rs:70) accepts **only** the display names, unlike
 *     Gray-Scott's, whose comment says "Snake-case conversions removed; we
 *     standardize on display-case strings".
 *
 * **The M4 round-trip bug does not exist here, and that is worth stating
 * explicitly rather than assuming it transfers.** Gray-Scott's `get_state`
 * emitted serde's spelling into a `<Selector>` listing display names, so the
 * control fell back to its placeholder after every sync. Slime Mold's
 * `get_state` (simulation.rs:2654) emits `self.state.mask_pattern.as_str()` —
 * the *display* name — and `SlimeMoldMode.svelte:457` lists the same display
 * names. That round trip is intact on the desktop build; canonicalising on
 * anything else would break it, exactly as M5 found in Vectors.
 *
 * The parser below still accepts the serde spelling, because `State` derives
 * `Serialize` and a preset or state document written through serde rather than
 * through `get_state` carries it.
 */
export type MaskPattern =
    | 'Disabled'
    | 'Checkerboard'
    | 'Diagonal Gradient'
    | 'Radial Gradient'
    | 'Vertical Stripes'
    | 'Horizontal Stripes'
    | 'Wave Function'
    | 'Cosine Grid'
    | 'Image';

/** Declaration order, which is also the shader's switch order. */
export const MASK_PATTERNS: readonly MaskPattern[] = [
    'Disabled',
    'Checkerboard',
    'Diagonal Gradient',
    'Radial Gradient',
    'Vertical Stripes',
    'Horizontal Stripes',
    'Wave Function',
    'Cosine Grid',
    'Image',
];

/**
 * `slime_mold/shaders/gradient.wgsl:35-43` — the `MASK_*` constants, and the
 * `switch (sim_size.mask_pattern)` arms at :68.
 *
 * 0..8 in declaration order. Unlike Gray-Scott's target codes there is **no
 * off-by-one to fix**: `SimSizeUniform::new` (simulation.rs:71) uploads
 * `u32::from(state.mask_pattern)`, the `From` impl (state.rs:123) produces
 * 0..8, and the shader's named constants agree. Checked rather than assumed —
 * M4's defect was exactly an unused `From` impl beside a live `as u32`.
 */
export const MASK_PATTERN_CODE: Record<MaskPattern, number> = {
    Disabled: 0,
    Checkerboard: 1,
    'Diagonal Gradient': 2,
    'Radial Gradient': 3,
    'Vertical Stripes': 4,
    'Horizontal Stripes': 5,
    'Wave Function': 6,
    'Cosine Grid': 7,
    Image: 8,
};

/** `MaskPattern::from_str` (state.rs:70), minus the silent `None`. */
export const parseMaskPattern = buildParser('MaskPattern', MASK_PATTERNS);

// --- MaskTarget (7 variants) -----------------------------------------------

/** state.rs:37. Same three-spelling story as `MaskPattern`; see above. */
export type MaskTarget =
    | 'Pheromone Deposition'
    | 'Pheromone Decay'
    | 'Pheromone Diffusion'
    | 'Agent Speed'
    | 'Agent Turn Rate'
    | 'Agent Sensor Distance'
    | 'Trail Map';

export const MASK_TARGETS: readonly MaskTarget[] = [
    'Pheromone Deposition',
    'Pheromone Decay',
    'Pheromone Diffusion',
    'Agent Speed',
    'Agent Turn Rate',
    'Agent Sensor Distance',
    'Trail Map',
];

/**
 * `slime_mold/shaders/compute.wgsl` — the mask-target branches at :203 (agent
 * update), :353 (decay) and :386 (diffusion), **0..6**.
 *
 * The three branch sets are disjoint and each carries a per-variant comment, so
 * between them they name every code from 0 to 6. `u32::from(state.mask_target)`
 * (state.rs:139) produces 0..6 and `SimSizeUniform::new` uses it, so upload and
 * shader agree — the Gray-Scott hazard (a live `as u32` giving 0..4 beside an
 * uncalled `From` giving 1..5 against a shader switching on 1..5) is **absent
 * here**. Transcribed, then pinned against the WGSL text by a test.
 */
export const MASK_TARGET_CODE: Record<MaskTarget, number> = {
    'Pheromone Deposition': 0,
    'Pheromone Decay': 1,
    'Pheromone Diffusion': 2,
    'Agent Speed': 3,
    'Agent Turn Rate': 4,
    'Agent Sensor Distance': 5,
    'Trail Map': 6,
};

/** `MaskTarget::from_str` (state.rs:107), minus the silent `None`. */
export const parseMaskTarget = buildParser('MaskTarget', MASK_TARGETS);

// --- SlimeMoldPositionGenerator (8 variants) --------------------------------

/**
 * `shared/position_generators.rs:22`. Display spelling canonical, again
 * matching the live path: `get_state` emits `as_str()` (= `display_name()`),
 * `from_str` (position_generators.rs:155) accepts only display names, and
 * `SlimeMoldMode.svelte:124` lists... **serde's** spelling
 * (`'UniformCircle'`, `'CenteredCircle'`), which is a real mismatch — see the
 * note on `updateSlimeMoldState`.
 */
export type PositionGenerator =
    | 'Random'
    | 'Center'
    | 'Uniform Circle'
    | 'Centered Circle'
    | 'Ring'
    | 'Line'
    | 'Spiral'
    | 'Image';

export const POSITION_GENERATORS: readonly PositionGenerator[] = [
    'Random',
    'Center',
    'Uniform Circle',
    'Centered Circle',
    'Ring',
    'Line',
    'Spiral',
    'Image',
];

/**
 * `compute.wgsl:573` — `switch (sim_size.position_generator)`, cases 0..7 with
 * per-variant comments. Matches `SlimeMoldPositionGenerator::as_u32`
 * (position_generators.rs:107).
 *
 * Note this is **not** the same table as the 11-variant `PositionGenerator`
 * that Particle Life uses (position_generators.rs:34): that one numbers `Line`
 * 8 and `Spiral` 9. Two enums, two tables; do not share them in M8.
 */
export const POSITION_GENERATOR_CODE: Record<PositionGenerator, number> = {
    Random: 0,
    Center: 1,
    'Uniform Circle': 2,
    'Centered Circle': 3,
    Ring: 4,
    Line: 5,
    Spiral: 6,
    Image: 7,
};

/**
 * `SlimeMoldPositionGenerator::from_str` (position_generators.rs:155).
 *
 * Accepts serde's compact spelling too, which the Rust does not — the
 * `ButtonSelect` in `SlimeMoldMode.svelte:127` sends `'UniformCircle'` and
 * `'CenteredCircle'`, and `from_str` returns `None` for both. On the desktop
 * that lands in `update_setting`'s fallback (simulation.rs:1450), which
 * silently resets the generator to `Random`. Accepting the compact form here
 * makes those two options work rather than quietly meaning "Random".
 */
export const parsePositionGenerator = buildParser('PositionGenerator', POSITION_GENERATORS);

// --- BackgroundMode (2 variants) -------------------------------------------

/**
 * settings.rs:75. **Serde's spelling is canonical here, not the display one** —
 * the opposite choice from the mask enums, and for a concrete reason.
 *
 * Three spellings again: serde's `"Black"`/`"White"` (this is a *settings*
 * field, so `get_settings()` — which is a plain `serde_json::to_value`,
 * simulation.rs:2639 — emits it, and `apply_settings` deserializes it),
 * `as_str()`'s lowercase `"black"`/`"white"` (settings.rs:81), and
 * `update_slime_mold_background_mode`'s lowercase match arm
 * (commands/slime_mold.rs:234).
 *
 * The load-bearing path is the preset/settings document, and that is serde's.
 * `SlimeMoldMode.svelte:672` types the field as `'black' | 'white'`, which is
 * therefore wrong about what the backend actually returns — but nothing renders
 * it, so no control breaks either way. The parser accepts both.
 */
export type BackgroundMode = 'Black' | 'White';

export const BACKGROUND_MODES: readonly BackgroundMode[] = ['Black', 'White'];

/**
 * `background_render.wgsl:38` — `background_type == 0u` is black, `1u` white.
 * Matches `From<BackgroundMode> for u32` (settings.rs:97).
 */
export const BACKGROUND_MODE_CODE: Record<BackgroundMode, number> = { Black: 0, White: 1 };

export const parseBackgroundMode = buildParser('BackgroundMode', BACKGROUND_MODES);

// --- TrailMapFiltering (2 variants) ----------------------------------------

/**
 * settings.rs:107. The one enum in this simulation whose four spellings all
 * agree — serde, `as_str`, `Display` and `from_str` are identical.
 *
 * It is *not* a `Settings` field despite living in settings.rs: it is a plain
 * field on `SlimeMoldModel` (simulation.rs), reached by
 * `update_setting("trailMapFiltering", …)` — camelCase, the only such name in
 * the whole match (simulation.rs:1455) — and emitted by `get_state` under the
 * snake_case key `"trail_map_filtering"` (simulation.rs:2653). No `.svelte`
 * sends either spelling today, so the control does not exist; both names are
 * accepted below so that whichever one M14 wires up works.
 */
export type TrailMapFiltering = 'Nearest' | 'Linear';

export const TRAIL_MAP_FILTERINGS: readonly TrailMapFiltering[] = ['Nearest', 'Linear'];

export const parseTrailMapFiltering = buildParser('TrailMapFiltering', TRAIL_MAP_FILTERINGS);

// --- ImageFitMode ----------------------------------------------------------

/** `ImageFitMode::from_str` (shared/types.rs:40), reusing the shared parser. */
export function parseFitMode(value: unknown): ImageFitMode {
    const parsed = parseImageFitMode(String(value ?? ''));
    if (!parsed) throw new Error(`Invalid ImageFitMode: '${String(value)}'`);
    return parsed;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * settings.rs:7. Fifteen fields, serde names identical to the field names,
 * listed in declaration order.
 */
export interface SlimeMoldSettings {
    agent_jitter: number;
    /**
     * `Range<f32>`, serialized as a two-element tuple by `serialize_range`
     * (settings.rs:149) — so `[0, 360]`, not `{ start, end }`.
     */
    agent_possible_starting_headings: [number, number];
    /** Radians. `SlimeMoldMode.svelte:413` converts from degrees before sending. */
    agent_sensor_angle: number;
    agent_sensor_distance: number;
    agent_speed_max: number;
    agent_speed_min: number;
    /** Radians per second. Also converted from degrees in the UI (:366). */
    agent_turn_rate: number;
    pheromone_decay_rate: number;
    pheromone_deposition_rate: number;
    pheromone_diffusion_rate: number;
    position_image_fit_mode: ImageFitMode;
    diffusion_frequency: number;
    decay_frequency: number;
    random_seed: number;
    background_mode: BackgroundMode;
}

/**
 * Exactly `impl Default for Settings` (settings.rs:166).
 *
 * **Do not take these from the doc comments directly above each field.** Four
 * of them are stale: `pheromone_decay_rate` is documented "Defaults to 1.0" and
 * is 10.0; `pheromone_deposition_rate` and `pheromone_diffusion_rate` are both
 * documented 1.0 and are 100.0; `position_image_fit_mode` is documented
 * `ImageFitMode::Stretch` and is `FitV`. The `impl` is the model, the prose
 * drifted — the same trap M4 hit with `GrayScottDiagram.svelte`'s prop
 * defaults.
 */
export function defaultSlimeMoldSettings(): SlimeMoldSettings {
    return {
        agent_jitter: 0.04,
        agent_possible_starting_headings: [0.0, 360.0],
        agent_sensor_angle: 0.3,
        agent_sensor_distance: 20.0,
        agent_speed_max: 60.0,
        agent_speed_min: 30.0,
        agent_turn_rate: 0.43, // ~25 degrees
        pheromone_decay_rate: 10.0,
        pheromone_deposition_rate: 100.0,
        pheromone_diffusion_rate: 100.0,
        // settings.rs:179 — `ImageFitMode::FitV`, which is *not*
        // `ImageFitMode::default()` (Stretch). The mask image's fit mode, on
        // the state side below, is the default one. They really do differ.
        position_image_fit_mode: 'Fit V',
        diffusion_frequency: 1,
        decay_frequency: 1,
        random_seed: 0,
        background_mode: 'Black',
    };
}

/** The float settings, all of which take any finite value. */
const SETTING_FLOAT_KEYS = [
    'agent_jitter',
    'agent_sensor_angle',
    'agent_sensor_distance',
    'agent_speed_max',
    'agent_speed_min',
    'agent_turn_rate',
    'pheromone_decay_rate',
    'pheromone_deposition_rate',
    'pheromone_diffusion_rate',
] as const;

type SettingFloatKey = (typeof SETTING_FLOAT_KEYS)[number];

const SETTING_FLOAT_KEY_SET: ReadonlySet<string> = new Set<string>(SETTING_FLOAT_KEYS);

/** The `u32` settings — `value.as_u64()` in the Rust, so integral and >= 0. */
const SETTING_U32_KEYS = ['diffusion_frequency', 'decay_frequency', 'random_seed'] as const;

type SettingU32Key = (typeof SETTING_U32_KEYS)[number];

const SETTING_U32_KEY_SET: ReadonlySet<string> = new Set<string>(SETTING_U32_KEYS);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Cursor clamps from `update_setting` (simulation.rs:1404, :1411). */
export const SLIME_MOLD_CURSOR_SIZE_RANGE: readonly [number, number] = [10, 500];
export const SLIME_MOLD_CURSOR_STRENGTH_RANGE: readonly [number, number] = [0, 50];

/**
 * Port of `struct State` (state.rs:154), plus the three model-level fields that
 * `get_state` folds in and the UI binds.
 *
 * **`mask_image_base` and `mask_image_raw` are deliberately absent**, for the
 * reason M4 gives in `grayScott/settings.ts`: they are `Option<Vec<f32>>` of
 * width x height *inside the serialized state*, and a `get_state` on a 4K field
 * would put eight million JSON numbers across the bridge. The decoded mask
 * pixels belong on the simulation object next to the GPU buffer they feed.
 *
 * `position_generator`, `trail_map_filtering` and `agent_count` are **not** in
 * the Rust `State` — they are bare fields on `SlimeMoldModel`. But `get_state`
 * (simulation.rs:2642) emits all three, `SlimeMoldMode.svelte` binds
 * `state.position_generator`, and keeping them anywhere else would mean two
 * state objects with no clear rule for which holds what. One object, matching
 * what the RPC layer actually hands the UI.
 */
export interface SlimeMoldState extends Record<string, unknown> {
    // Mask system (state.rs:156)
    mask_pattern: MaskPattern;
    mask_target: MaskTarget;
    mask_strength: number;
    mask_curve: number;
    /**
     * Inert, and faithfully so — the same dead field Gray-Scott has.
     *
     * `mask_reversed` is stored, defaulted, serialized by `get_state` and
     * written by `update_setting` (simulation.rs:1314) — and read by nothing.
     * `SimSizeUniform` has no such member and no shader mentions it, so
     * reversing a mask has never done anything on any build. Ported for
     * state-shape compatibility; **do not** wire it into `packSlimeMoldSimSize`
     * on the assumption that its absence there is an oversight.
     */
    mask_reversed: boolean;
    mask_image_fit_mode: ImageFitMode;
    mask_mirror_horizontal: boolean;
    mask_mirror_vertical: boolean;
    mask_invert_tone: boolean;
    /** Set when a decoded mask is waiting for the next queue submission. */
    mask_image_needs_upload: boolean;

    // Pointer (state.rs:167)
    mouse_pressed: boolean;
    mouse_position: [number, number];
    mouse_screen_position: [number, number];

    // Cursor — see `defaultSlimeMoldState` for why these are not state.rs's.
    cursor_size: number;
    cursor_strength: number;

    // Colour scheme (state.rs:176)
    current_color_scheme: string;
    color_scheme_reversed: boolean;

    // UI (state.rs:180)
    gui_visible: boolean;

    // Model-level, folded in by get_state — see the interface comment.
    position_generator: PositionGenerator;
    trail_map_filtering: TrailMapFiltering;
    agent_count: number;

    /**
     * Also inert. `State::camera_position` / `camera_zoom` are never read or
     * written by the model — the real camera is `self.camera`, and
     * `get_camera_state` (simulation.rs:2747) reads that directly. Kept so the
     * state document has the shape the desktop app produced.
     *
     * Note `get_state` nests them as `camera: { position, zoom }`
     * (simulation.rs:2663) while `State` and the UI's own `State` type spell
     * them flat. Nothing reads either, so the flat spelling — state.rs's —
     * wins here.
     */
    camera_position: [number, number];
    camera_zoom: number;

    // Runtime (state.rs:192)
    simulation_time: number;
    is_running: boolean;
}

/**
 * `impl Default for State` (state.rs:196), **with two deliberate corrections**.
 *
 * **`cursor_size` is 300 and `cursor_strength` is 5, not state.rs's 0.20 and
 * 1.0.** `State::cursor_size` is dead: every live read and write goes through
 * `SlimeMoldModel`'s own `cursor_size` field, which is initialised to 300.0 /
 * 5.0 at simulation.rs:522-523, clamped to 10..500 / 0..50 by `update_setting`
 * (:1404), written by `update_state` (:2620), emitted by `get_state` (:2650)
 * and packed into `CursorParams` (:1601). `state.cursor_size` is written by
 * nothing and read by nothing.
 *
 * The size is in **simulation pixels**, which is why 300 rather than 0.2 — and
 * `SlimeMoldMode.svelte:71` gives the slider `sizeMin={10} sizeMax={500}`. A
 * naive transcription of state.rs would put the handle hard against the left
 * stop with a brush 1500x too small, which is exactly the class of defect this
 * milestone exists to catch. (Gray-Scott's 0.20 *is* live, and is a normalized
 * radius — the two simulations genuinely use different units.)
 */
export function defaultSlimeMoldState(): SlimeMoldState {
    return {
        mask_pattern: 'Disabled',
        mask_target: 'Pheromone Deposition',
        mask_strength: 0.5,
        mask_curve: 1.0,
        mask_reversed: false,
        // state.rs:205 — `ImageFitMode::default()`, i.e. Stretch. The
        // *position* image's fit mode defaults to 'Fit V' instead; see
        // `defaultSlimeMoldSettings`.
        mask_image_fit_mode: 'Stretch',
        mask_mirror_horizontal: false,
        mask_mirror_vertical: false,
        mask_invert_tone: false,
        mask_image_needs_upload: false,
        mouse_pressed: false,
        mouse_position: [0, 0],
        mouse_screen_position: [0, 0],
        cursor_size: 300.0,
        cursor_strength: 5.0,
        current_color_scheme: 'MATPLOTLIB_prism',
        // Reversed by default, which is unusual and is what
        // example-slime-mold.png was captured with.
        color_scheme_reversed: true,
        gui_visible: true,
        position_generator: 'Random',
        trail_map_filtering: 'Nearest',
        // Not the desktop's 10 M — see SLIME_MOLD_DEFAULT_AGENTS.
        agent_count: SLIME_MOLD_DEFAULT_AGENTS,
        camera_position: [0, 0],
        camera_zoom: 1.0,
        simulation_time: 0.0,
        is_running: true,
    };
}

/** Field names the mask pixel buffers had in the Rust state. */
const MASK_IMAGE_KEYS = ['mask_image_base', 'mask_image_raw'] as const;

/**
 * The document `getState()` hands out: a shallow copy, with the mask pixel
 * arrays stripped if anything ever puts them back.
 *
 * Defensive rather than decorative — `SlimeMoldState` has an index signature
 * (the `Simulation` contract wants `Record<string, unknown>`), so a stray
 * `state.mask_image_raw = pixels` type-checks.
 */
export function slimeMoldStateDocument(state: SlimeMoldState): Record<string, unknown> {
    const doc: Record<string, unknown> = { ...state };
    for (const key of MASK_IMAGE_KEYS) delete doc[key];
    return doc;
}

/**
 * `Simulation::reset_runtime_state` (simulation.rs:2766) — for Slime Mold this
 * is *not* a no-op, unlike Gray-Scott's: it calls `reset_trails`, blanking the
 * trail map. Kept as a named effect rather than a function because the work is
 * a `queue.writeBuffer` of zeroes, which belongs in `index.ts`.
 */
export const SLIME_MOLD_RUNTIME_RESET = 'clear-trails' as const;

// ---------------------------------------------------------------------------
// update_setting / update_state
// ---------------------------------------------------------------------------

/**
 * What the caller has to do on the GPU once a setting or state field changed.
 *
 * Larger than Gray-Scott's set because Slime Mold keeps four uniform buffers
 * (sim size, cursor, background, camera), two image slots and a compute pass
 * whose only trigger is a settings change.
 */
export type SlimeMoldSettingEffect =
    /** Nothing to upload — the field feeds agent initialization or is inert. */
    | 'none'
    /** Rewrite `SimSizeUniform`. */
    | 'sim-params'
    /** Rewrite `SimSizeUniform`, then re-dispatch `update_agent_speeds`. */
    | 'agent-speeds'
    /** Rewrite `SimSizeUniform`, then re-dispatch the `generate_mask` pass. */
    | 'regenerate-mask'
    /** Rewrite `BackgroundParams`. */
    | 'background-params'
    /** Rewrite `CursorParams`. */
    | 'cursor-params'
    /** Re-fit the already-decoded mask image at the new fit mode. */
    | 'refit-mask-image'
    /** Re-fit the already-decoded position image, then re-seed the agents. */
    | 'refit-position-image'
    /** Re-upload the LUT. */
    | 'reload-lut'
    /** Recreate the display sampler at the new filter. */
    | 'display-sampler';

/**
 * `value.as_f64()` — a JSON *number* only, and finite.
 *
 * No coercion: `Number(null)` and `Number('')` are both 0, so a coercing
 * version would accept a null the Rust ignored and write a plausible zero into
 * the uniform. `agent_jitter: 0` is a reachable value, so that would be
 * invisible. And one NaN in `agent_speed_max` puts every agent's position at
 * NaN within a frame, from which the trail map never recovers.
 */
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

/** `value.as_u64()` — integral, non-negative, and inside `u32`. */
function asU32(value: unknown, name: string): number {
    const n = asFiniteNumber(value);
    if (n === null || !Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
        throw new Error(
            `Setting "${name}" needs an unsigned 32-bit integer, got ${JSON.stringify(value)}`
        );
    }
    return n;
}

/** `value.as_bool().unwrap_or(false)`. */
function asBool(value: unknown): boolean {
    return value === true;
}

/** The serialized form of `Range<f32>` — `(start, end)` (settings.rs:149). */
function asRange(value: unknown, name: string): [number, number] {
    if (Array.isArray(value) && value.length === 2) {
        return [asFloat(value[0], name), asFloat(value[1], name)];
    }
    throw new Error(
        `Setting "${name}" needs a [start, end] pair of finite numbers, got ${JSON.stringify(value)}`
    );
}

function clampToRange(value: number, [lo, hi]: readonly [number, number]): number {
    return Math.min(hi, Math.max(lo, value));
}

/**
 * Port of `update_setting` (simulation.rs:1181).
 *
 * **Four deliberate divergences.**
 *
 * 1. **`agent_possible_starting_headings` and `background_mode` get arms.**
 *    Both are `Settings` fields with no match arm at all, so on the desktop
 *    `update_setting` returns `Err("Unknown setting: …")` for either. That is
 *    reachable here in a way it is not there: `normalizeSlimeMoldSettings`
 *    replays a stored document through this function, and without the arms a
 *    preset carrying a heading range or a white background would silently lose
 *    it. `background_mode` does have a dedicated command
 *    (`update_slime_mold_background_mode`, commands/slime_mold.rs:224) — which
 *    **no `.svelte` file calls**, so the white background is unreachable on the
 *    desktop build.
 *
 * 2. **`position_image_fit_mode` no longer panics.** simulation.rs:1418 matches
 *    four literal spellings and ends in `_ => unreachable!()`, so any other
 *    string aborts the process. The two mask enums do the same via
 *    `.expect("Invalid mask pattern")` at :1252 and :1271. Here they throw, and
 *    `invoke` rejects, which `sync.ts` already rolls back.
 *
 * 3. **`cursor_size` / `cursor_strength` keep the Rust's clamps.** The values
 *    are clamped to 10..500 and 0..50 exactly as simulation.rs:1404/1411 does —
 *    note `update_state`, which is the path the UI actually uses, clamps
 *    *neither*. See `updateSlimeMoldState`.
 *
 * 4. **An unknown name throws**, where the Rust returns an `Err` that the
 *    command layer logs and drops. Throwing is what lets `syncStore` roll an
 *    optimistic update back instead of showing a value the engine never took.
 *
 * The mask and cursor names are accepted here as well as in
 * `updateSlimeMoldState`, because the Rust accepts them on both commands and
 * `ImageSelector`/`ControlsPanel` do not agree on which to use.
 */
export function updateSlimeMoldSetting(
    settings: SlimeMoldSettings,
    state: SlimeMoldState,
    name: string,
    value: unknown
): SlimeMoldSettingEffect {
    if (SETTING_FLOAT_KEY_SET.has(name)) {
        settings[name as SettingFloatKey] = asFloat(value, name);
        // simulation.rs:1218/1225 — changing either speed bound re-randomizes
        // every agent's speed inside the new range on the GPU.
        return name === 'agent_speed_min' || name === 'agent_speed_max'
            ? 'agent-speeds'
            : 'sim-params';
    }
    if (SETTING_U32_KEY_SET.has(name)) {
        settings[name as SettingU32Key] = asU32(value, name);
        // decay_frequency / diffusion_frequency are pass-schedule counters read
        // straight off `settings` each frame and are in no uniform; random_seed
        // is slot 18 of SimSizeUniform. The Rust re-uploads for all three
        // (simulation.rs:1471), so this is faithful and costs one 80-byte write.
        return 'sim-params';
    }

    switch (name) {
        case 'agent_possible_starting_headings':
            // Divergence 1. Consumed only by the agent-init compute pass, which
            // runs on Reset Agents, so nothing to upload now.
            settings.agent_possible_starting_headings = asRange(value, name);
            return 'none';

        case 'background_mode':
            // Divergence 1.
            settings.background_mode = parseBackgroundMode(value);
            return 'background-params';

        case 'position_image_fit_mode':
            // Divergence 2. simulation.rs:1427 only re-fits when the generator
            // is Image and an image is loaded; that guard lives with the image.
            settings.position_image_fit_mode = parseFitMode(value);
            return 'refit-position-image';

        // --- names the Rust routes through the settings command into State ---
        case 'mask_pattern':
        case 'mask_target':
        case 'mask_strength':
        case 'mask_curve':
        case 'mask_reversed':
        case 'mask_mirror_horizontal':
        case 'mask_mirror_vertical':
        case 'mask_invert_tone':
        case 'mask_image_fit_mode':
        case 'cursor_size':
        case 'cursor_strength':
        case 'position_generator':
        case 'trailMapFiltering':
        case 'trail_map_filtering':
            return updateSlimeMoldState(state, name, value);

        default:
            throw new Error(`Unknown setting: ${name}`);
    }
}

/**
 * Port of `update_state` (simulation.rs:2464).
 *
 * **Five names the Rust's `update_state` does not have** are accepted here:
 *
 * - **`position_generator`. This is a live defect on the desktop build.**
 *   `SlimeMoldMode.svelte:148` sends it through `update_simulation_state`, and
 *   `update_state` has no arm for it — it falls into the `_ =>` warn at
 *   simulation.rs:2630. The generator only exists in `update_setting`
 *   (simulation.rs:1441), which nothing calls with that name. So the whole
 *   "Agent Position Generator" selector changes nothing: every reset re-seeds
 *   with `Random`, and the Image position generator — with its own file picker,
 *   fit-mode control and `load_slime_mold_position_image` command — cannot be
 *   selected at all. Same class as M4's three dropped Gray-Scott names.
 * - `mask_reversed` and `mask_image_fit_mode`, which the Rust has only on the
 *   settings command; `ImageSelector` uses a dedicated
 *   `set_slime_mold_mask_image_fit_mode` command instead.
 * - `trailMapFiltering` / `trail_map_filtering`, per the enum's note.
 *
 * **The cursor pair is clamped here, unlike the Rust.** `update_state`
 * (simulation.rs:2620) assigns raw while `update_setting` (:1404) clamps, and
 * the UI uses `update_state` — so on the desktop a preset or a scripted call
 * can put an arbitrary radius into `CursorParams`. The UI's own slider bounds
 * are already 10..500 and 0..50, so clamping changes nothing reachable by hand
 * and closes the other door.
 */
export function updateSlimeMoldState(
    state: SlimeMoldState,
    name: string,
    value: unknown
): SlimeMoldSettingEffect {
    switch (name) {
        case 'mask_pattern':
            state.mask_pattern = parseMaskPattern(value);
            return 'regenerate-mask';
        case 'mask_target':
            state.mask_target = parseMaskTarget(value);
            return 'sim-params';
        case 'mask_strength':
            state.mask_strength = asFloat(value, name);
            return 'sim-params';
        case 'mask_curve':
            state.mask_curve = asFloat(value, name);
            return 'sim-params';

        case 'mask_mirror_horizontal':
            state.mask_mirror_horizontal = asBool(value);
            return 'regenerate-mask';
        case 'mask_mirror_vertical':
            state.mask_mirror_vertical = asBool(value);
            return 'regenerate-mask';
        case 'mask_invert_tone':
            // simulation.rs:1368 also rewrites BackgroundParams here. That
            // cannot change a pixel: `background_render.wgsl` declares a
            // one-field `BackgroundParams` and reads only `background_type`, so
            // the other seven members the Rust writes are dead. Folded into
            // 'regenerate-mask' rather than given its own effect.
            state.mask_invert_tone = asBool(value);
            return 'regenerate-mask';

        case 'mask_reversed':
            // Stored so the state document round-trips; no uniform carries it.
            // The Rust re-uploads SimSizeUniform here, which cannot change a
            // byte of it.
            state.mask_reversed = asBool(value);
            return 'none';

        case 'mask_image_fit_mode':
            state.mask_image_fit_mode = parseFitMode(value);
            return 'refit-mask-image';

        case 'cursor_size':
            state.cursor_size = clampToRange(asFloat(value, name), SLIME_MOLD_CURSOR_SIZE_RANGE);
            return 'cursor-params';
        case 'cursor_strength':
            state.cursor_strength = clampToRange(
                asFloat(value, name),
                SLIME_MOLD_CURSOR_STRENGTH_RANGE
            );
            return 'cursor-params';

        case 'current_color_scheme':
            state.current_color_scheme = String(value);
            return 'reload-lut';
        case 'color_scheme_reversed':
            state.color_scheme_reversed = asBool(value);
            return 'reload-lut';

        case 'position_generator':
            state.position_generator = parsePositionGenerator(value);
            // Slot 19 of SimSizeUniform; the agents are only re-seeded when the
            // user presses Reset Agents, which is a separate command.
            return 'sim-params';

        case 'trailMapFiltering':
        case 'trail_map_filtering':
            state.trail_map_filtering = parseTrailMapFiltering(value);
            return 'display-sampler';

        default:
            throw new Error(`Unknown state: ${name}`);
    }
}

/**
 * Coerce an arbitrary document into a complete `SlimeMoldSettings`.
 *
 * `apply_settings` (simulation.rs:2793) deserialized straight into the struct,
 * so serde rejected a partial document outright. A partial one is normal here:
 * `PresetStore` stores built-ins as overrides only, exactly as
 * `Settings { .., ..Settings::default() }` wrote them, so anything absent comes
 * from the defaults — the same value the Rust preset would have carried.
 *
 * A throwaway state object absorbs any mask/cursor names a hand-edited document
 * carries; they are state, not settings, so they are dropped rather than
 * written into the returned settings.
 */
export function normalizeSlimeMoldSettings(input: unknown): SlimeMoldSettings {
    const settings = defaultSlimeMoldSettings();
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return settings;
    }

    const scratch = defaultSlimeMoldState();
    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
        try {
            updateSlimeMoldSetting(settings, scratch, name, value);
        } catch {
            // A preset from a newer build, or a hand-edited localStorage entry.
            // Keeping the default for that one field beats refusing the preset.
            console.warn(`[slimeMold] ignoring unusable setting "${name}"`);
        }
    }
    return settings;
}

/**
 * Port of `Settings::randomize` (settings.rs:190).
 *
 * Nine of the fifteen fields are assigned; only **eight can move**, because
 * `pheromone_deposition_rate` and `pheromone_diffusion_rate` are pinned to
 * 100.0, which is already their default. `diffusion_frequency` and
 * `decay_frequency` are pinned to 1, also their default. So the observable
 * effect on a fresh `Settings` is: six agent parameters, the heading range, the
 * seed — and `pheromone_decay_rate`, which jumps 10 -> 100.
 *
 * That decay jump is **not reversible from the UI's Randomize button**: nothing
 * ever writes 10.0 back except loading a preset. Faithful, and worth knowing.
 *
 * `agent_speed_max` is drawn *above* the freshly drawn minimum
 * (`min + r * (500 - min)`), so the pair is always ordered — the one piece of
 * validation in the whole file that the Rust also does.
 *
 * `rng` is injected purely so the ranges are testable without sampling. The
 * Rust draws from `rand::random::<f32>()` for everything but the seed, which
 * uses `rng.random()`; both are uniform, so one source maps across.
 */
export function randomizeSlimeMoldSettings(
    settings: SlimeMoldSettings,
    rng: () => number = Math.random
): void {
    const degToRad = Math.PI / 180;

    settings.agent_speed_min = rng() * 500.0;
    settings.agent_speed_max =
        settings.agent_speed_min + rng() * (500.0 - settings.agent_speed_min);
    settings.agent_turn_rate = rng() * 360.0 * degToRad;
    settings.agent_jitter = rng();
    settings.agent_sensor_angle = rng() * 180.0 * degToRad;
    settings.agent_sensor_distance = rng() * 500.0;
    settings.pheromone_decay_rate = 100.0;
    settings.pheromone_deposition_rate = 100.0;
    settings.pheromone_diffusion_rate = 100.0;

    // settings.rs:208 — `end = start + r * (360 - start)`, so the range is
    // always ordered and always inside [0, 360].
    const start = rng() * 360.0;
    const end = start + rng() * (360.0 - start);
    settings.agent_possible_starting_headings = [start, end];

    settings.diffusion_frequency = 1;
    settings.decay_frequency = 1;
    // `rng.random::<u32>()`. `Math.floor` of a [0,1) draw scaled by 2^32 can
    // never reach 2^32 itself.
    settings.random_seed = Math.floor(rng() * 0x1_0000_0000);
}

// ---------------------------------------------------------------------------
// Uniform packing
// ---------------------------------------------------------------------------

/**
 * `struct SimSizeUniform` (simulation.rs:23, and `compute.wgsl:6`) — 20
 * four-byte scalars, 80 bytes, no padding needed since every member is a scalar
 * and 80 is a multiple of 16.
 *
 * **Take the order from `compute.wgsl` only.** Two other copies of this struct
 * exist in the corpus and neither is current:
 *
 *  - `gradient.wgsl:9` stops at 19 members, naming slot 18 `_pad1` where the
 *    Rust writes `random_seed` and omitting `position_generator` entirely. It
 *    reads neither, so it is inert — but it is one edit away from looking
 *    authoritative.
 *  - `display.wgsl:4` is worse: slots 11..17 are named `gradient_enabled`,
 *    `gradient_type`, `gradient_strength`, `gradient_center_x/y`,
 *    `gradient_size`, `gradient_angle` — a stale struct from a feature that no
 *    longer exists, sitting exactly where `mask_pattern` … `mask_invert_tone`
 *    are uploaded. `display.wgsl` reads only `width` and `height`, so again
 *    nothing is broken today, and again a future reader has to be told.
 *
 * Neither is edited here: they are shared with the Rust build, they compile,
 * and renaming dead members is not this milestone's business.
 */
export const SLIME_MOLD_SIM_SIZE_SCALARS = 20;
export const SLIME_MOLD_SIM_SIZE_BYTES = SLIME_MOLD_SIM_SIZE_SCALARS * 4;

export interface SlimeMoldSimSizeInputs {
    /** Trail-map width in simulation pixels, not the surface width. */
    width: number;
    height: number;
}

/**
 * Pack `SimSizeUniform`. Pure, so the field order can be pinned by a unit test
 * — a misordered uniform here is not a crash, it is agents that turn at the
 * jitter rate and deposit at the sensor distance.
 *
 * The struct mixes f32 and u32, so it needs both views over one buffer; a
 * `Float32Array` alone would write `1.0` where the shader reads `u32` and see
 * 1065353216.
 *
 * Slot 2 is `decay_rate`, which `SimSizeUniform::new` takes as an explicit
 * argument (simulation.rs:54) — every one of its five call sites passes
 * `settings.pheromone_decay_rate`, so it is read from settings here rather than
 * given a parameter nobody would vary.
 */
export function packSlimeMoldSimSize(
    settings: SlimeMoldSettings,
    state: SlimeMoldState,
    inputs: SlimeMoldSimSizeInputs,
    out: ArrayBuffer = new ArrayBuffer(SLIME_MOLD_SIM_SIZE_BYTES)
): ArrayBuffer {
    const f32 = new Float32Array(out);
    const u32 = new Uint32Array(out);

    u32[0] = inputs.width;
    u32[1] = inputs.height;
    f32[2] = settings.pheromone_decay_rate;
    f32[3] = settings.agent_jitter;
    f32[4] = settings.agent_speed_min;
    f32[5] = settings.agent_speed_max;
    f32[6] = settings.agent_turn_rate;
    f32[7] = settings.agent_sensor_angle;
    f32[8] = settings.agent_sensor_distance;
    // `diffusion_rate` in the shader; the names differ on the two sides and
    // nothing translates them but this line.
    f32[9] = settings.pheromone_diffusion_rate;
    f32[10] = settings.pheromone_deposition_rate;
    u32[11] = MASK_PATTERN_CODE[state.mask_pattern];
    u32[12] = MASK_TARGET_CODE[state.mask_target];
    f32[13] = state.mask_strength;
    f32[14] = state.mask_curve;
    u32[15] = state.mask_mirror_horizontal ? 1 : 0;
    u32[16] = state.mask_mirror_vertical ? 1 : 0;
    u32[17] = state.mask_invert_tone ? 1 : 0;
    u32[18] = settings.random_seed;
    u32[19] = POSITION_GENERATOR_CODE[state.position_generator];

    return out;
}

/**
 * `struct CursorParams` (simulation.rs:84) — 5 live scalars plus three pad
 * words, 32 bytes. `compute.wgsl:27` declares only `_pad1`/`_pad2`, which pads
 * to the same 32 for a uniform; the Rust's third pad word is what makes the two
 * agree explicitly.
 */
export const SLIME_MOLD_CURSOR_PARAM_BYTES = 32;

export interface SlimeMoldCursorInputs {
    /** 0 = inactive, 1 = attract (left button), 2 = repel (right button). */
    mode: 0 | 1 | 2;
    /** Simulation pixels, from `handle_mouse_interaction` (simulation.rs:2692). */
    x: number;
    y: number;
}

export function packSlimeMoldCursorParams(
    state: SlimeMoldState,
    inputs: SlimeMoldCursorInputs,
    out: ArrayBuffer = new ArrayBuffer(SLIME_MOLD_CURSOR_PARAM_BYTES)
): ArrayBuffer {
    const f32 = new Float32Array(out);
    const u32 = new Uint32Array(out);

    u32[0] = inputs.mode;
    f32[1] = inputs.x;
    f32[2] = inputs.y;
    f32[3] = state.cursor_strength;
    f32[4] = state.cursor_size;
    u32[5] = 0;
    u32[6] = 0;
    u32[7] = 0;

    return out;
}

/**
 * `struct BackgroundParams` (simulation.rs:100) — 8 scalars, 32 bytes.
 *
 * **Only slot 0 is ever read.** `background_render.wgsl:1` declares a
 * `BackgroundParams` with exactly one member, `background_type`; the seven the
 * Rust writes after it are consumed by no shader in the corpus. They are packed
 * anyway so the buffer keeps the size the Rust allocated and a future
 * background pass that wants the mask has it — but do not conclude from
 * `update_background_params` (simulation.rs:2235) that toggling a mirror flag
 * changes the background, because it does not.
 */
export const SLIME_MOLD_BACKGROUND_PARAM_BYTES = 32;

export function packSlimeMoldBackgroundParams(
    settings: SlimeMoldSettings,
    state: SlimeMoldState,
    out: ArrayBuffer = new ArrayBuffer(SLIME_MOLD_BACKGROUND_PARAM_BYTES)
): ArrayBuffer {
    const f32 = new Float32Array(out);
    const u32 = new Uint32Array(out);

    u32[0] = BACKGROUND_MODE_CODE[settings.background_mode];
    u32[1] = state.mask_pattern === 'Disabled' ? 0 : 1;
    u32[2] = MASK_PATTERN_CODE[state.mask_pattern];
    f32[3] = state.mask_strength;
    u32[4] = state.mask_mirror_horizontal ? 1 : 0;
    u32[5] = state.mask_mirror_vertical ? 1 : 0;
    u32[6] = state.mask_invert_tone ? 1 : 0;
    u32[7] = 0;

    return out;
}
