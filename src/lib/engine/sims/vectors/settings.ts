/**
 * Vectors settings, runtime state and grid geometry — a port of
 * src-tauri/src/simulations/vectors/{settings.rs,state.rs} plus the CPU half of
 * `update_geometry` (simulation.rs:261).
 *
 * GPU-free on purpose, exactly as `sims/moire/settings.ts` and
 * `sims/grayScott/settings.ts` are: defaults, the four enums, the grid
 * arithmetic and the clear colour are then unit-testable in node, and
 * `sims/vectors/index.ts` is left holding nothing but buffers and pipelines.
 *
 * Field names are the snake_case strings `VectorsMode.svelte` sends through
 * `update_simulation_setting`, and the serialized enum values are what serde
 * produced — a preset written by the desktop app must load here unchanged.
 *
 * **No numeric clamping.** `settings.rs` declares none and neither does
 * `update_setting` (simulation.rs:667), so clamping to the drag-box ranges in
 * `VectorsMode.svelte` would be a silent behaviour change. What *is* enforced is
 * type soundness — a non-finite `noise_scale` would make every sample position
 * NaN and the whole field would collapse to a single degenerate quad.
 *
 * The one arithmetic guard that is not in the Rust lives in
 * `vectorsGridExtent`; see `VECTORS_MAX_LINES` for why it has to be here.
 */

import {
    DEFAULT_IMAGE_FIT_MODE,
    parseImageFitMode,
    type ImageFitMode,
} from '$lib/engine/resources/imageUpload';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * settings.rs:52. Two variants, and — unusually for this codebase — the serde
 * spelling, the `<Selector>` option list and the `update_setting` match arms all
 * agree already, so nothing had to be re-spelled here.
 *
 * `update_setting` (simulation.rs:678) additionally accepts the lowercase
 * `"noise"` / `"image"`; `parseVectorFieldType` keeps that latitude.
 */
export type VectorFieldType = 'Noise' | 'Image';

export const VECTOR_FIELD_TYPES: readonly VectorFieldType[] = ['Noise', 'Image'];

/**
 * settings.rs:65. **The serde spelling is canonical here, not the display name.**
 *
 * Every variant carries two spellings in the Rust and they disagree for five of
 * the eleven:
 *
 *   variant        serde / `get_settings`   `Display` (settings.rs:79)
 *   Fbm            "Fbm"                    "FBM"
 *   FBMBillow      "FBMBillow"              "FBM Billow"
 *   FBMClouds      "FBMClouds"              "FBM Clouds"
 *   FBMRidged      "FBMRidged"              "FBM Ridged"
 *   RidgedMulti    "RidgedMulti"            "Ridged Multi"
 *
 * This is the same shape as the Gray-Scott mask enums, which *were* a live
 * round-trip bug — but Vectors happens to land on the working side of it:
 * `VectorsMode.svelte:119` lists the **serde** spellings, `update_setting`'s
 * `"noise_type"` arm (simulation.rs:723) matches the serde spellings, and
 * `get_settings` emits them. So the control round-trips today, and the
 * `Display` impl has no caller anywhere in the tree.
 *
 * Canonicalising on the display name — as M4 did for Gray-Scott — would
 * therefore *break* a working control rather than fix a broken one, so the
 * serde spelling stays canonical. `NOISE_TYPE_LABELS` carries the display names
 * for a UI that wants to show "FBM Billow" instead of "FBMBillow", and
 * `parseNoiseType` accepts either spelling so the two can never diverge into a
 * failure again.
 *
 * The inconsistent casing (`Fbm` beside `FBMBillow`) is the Rust's and is
 * load-bearing: `update_setting`'s arm ends in `_ => self.settings.noise_type`,
 * which silently keeps the previous value on any unrecognised string. A
 * one-character casing slip there is invisible — the selector snaps back on the
 * next sync and nothing is logged. `parseNoiseType` throws instead.
 */
export type NoiseType =
    | 'OpenSimplex'
    | 'Worley'
    | 'Value'
    | 'Fbm'
    | 'FBMBillow'
    | 'FBMClouds'
    | 'FBMRidged'
    | 'Billow'
    | 'RidgedMulti'
    | 'Cylinders'
    | 'Checkerboard';

/** Declaration order (settings.rs:65), which is also `NOISE_TYPE_CODE`'s order. */
export const NOISE_TYPES: readonly NoiseType[] = [
    'OpenSimplex',
    'Worley',
    'Value',
    'Fbm',
    'FBMBillow',
    'FBMClouds',
    'FBMRidged',
    'Billow',
    'RidgedMulti',
    'Cylinders',
    'Checkerboard',
];

/**
 * `impl Display for NoiseType` (settings.rs:79) — presentation only.
 *
 * Nothing sends or stores these; they exist so a `<Selector>` can show
 * "FBM Billow" while still exchanging `"FBMBillow"` with the engine. Keep them
 * out of the wire format: a preset holding `"FBM Billow"` still loads, because
 * `parseNoiseType` accepts it, but writing one is how the two spellings drift
 * apart again.
 */
export const NOISE_TYPE_LABELS: Record<NoiseType, string> = {
    OpenSimplex: 'OpenSimplex',
    Worley: 'Worley',
    Value: 'Value',
    Fbm: 'FBM',
    FBMBillow: 'FBM Billow',
    FBMClouds: 'FBM Clouds',
    FBMRidged: 'FBM Ridged',
    Billow: 'Billow',
    RidgedMulti: 'Ridged Multi',
    Cylinders: 'Cylinders',
    Checkerboard: 'Checkerboard',
};

/**
 * The u32 the noise compute shader switches on.
 *
 * The desktop build has no such table: `noise_helper.rs:13` matches the enum
 * straight onto `noise` crate generators on the CPU, one boxed `NoiseFn` per
 * geometry rebuild. The port moves that sampling into WGSL (WEB_PORT.md, M5),
 * which needs a numeric code, so this is the bridge between the two halves —
 * `shaders/noise.wgsl` reads it and `sims/vectors/index.ts` writes it.
 *
 * **Declaration order, 0..10.** Nothing in the Rust assigns these numbers, so
 * there is no upstream ordering to be faithful to; declaration order is the one
 * choice both sides can rederive from `settings.rs` without a lookup table, and
 * `randomize_settings` (simulation.rs:891) already indexes the variants that way
 * with its `rng.random_range(0..11)`. Pinned by a unit test so a reordering of
 * the union above cannot silently renumber the shader.
 */
export const NOISE_TYPE_CODE: Record<NoiseType, number> = {
    OpenSimplex: 0,
    Worley: 1,
    Value: 2,
    Fbm: 3,
    FBMBillow: 4,
    FBMClouds: 5,
    FBMRidged: 6,
    Billow: 7,
    RidgedMulti: 8,
    Cylinders: 9,
    Checkerboard: 10,
};

/**
 * The octave count each variant's generator is built with
 * (`build_cached_generator`, noise_helper.rs:13).
 *
 * Exported because it is the *only* place the distinction between several of
 * these variants lives: `Fbm`, `FBMClouds` and `Billow`/`FBMBillow` differ from
 * one another by nothing but their octave count, so a shader that ignores this
 * table collapses eleven visibly different fields into six.
 *
 * `OpenSimplex`, `Worley`, `Value`, `Cylinders` and `Checkerboard` are
 * single-octave base generators — the Rust builds them with `::default()` and no
 * `set_octaves` — so they carry 1.
 */
export const NOISE_TYPE_OCTAVES: Record<NoiseType, number> = {
    OpenSimplex: 1,
    Worley: 1,
    Value: 1,
    Fbm: 6,
    FBMBillow: 8,
    FBMClouds: 4,
    FBMRidged: 10,
    Billow: 6,
    RidgedMulti: 6,
    Cylinders: 1,
    Checkerboard: 1,
};

/**
 * shared/types.rs:67, `BackgroundColorMode`.
 *
 * Shared with Flow, Pellets, Particle Life and Primordial Particles in the Rust;
 * Vectors is the first of the five to be ported, so the type lands here rather
 * than in a `shared/` module that would currently have one caller. **Lift it out
 * when the second one arrives** (M9 or M10) — see WEB_PORT.md's M14 item about
 * consolidating the per-mode types.
 *
 * `ColorScheme` is `#[serde(rename = "Color Scheme")]`, so the serde spelling
 * and the `<Selector>` option list agree; the other three have no rename and
 * agree trivially.
 */
export type BackgroundColorMode = 'Black' | 'White' | 'Gray18' | 'Color Scheme';

/**
 * The order every mode's `<Selector>` lists them in, which is **not** the
 * declaration order (`Gray18, White, Black, ColorScheme`, types.rs:67).
 *
 * Nothing indexes this enum numerically — the clear colour is a match, not a
 * table lookup — so the difference is purely presentational and the UI order is
 * the useful one to export.
 */
export const BACKGROUND_COLOR_MODES: readonly BackgroundColorMode[] = [
    'Black',
    'White',
    'Gray18',
    'Color Scheme',
];

/** Fold every accepted spelling of an enum value onto one lookup key. */
function enumKey(value: unknown): string {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '');
}

function byKey<T extends string>(values: readonly T[]): ReadonlyMap<string, T> {
    return new Map(values.map((value) => [enumKey(value), value] as const));
}

const VECTOR_FIELD_TYPE_BY_KEY = byKey(VECTOR_FIELD_TYPES);

/**
 * Both spellings of every variant, folded together.
 *
 * `enumKey` strips the spaces, so `"FBM Billow"` and `"FBMBillow"` collapse onto
 * the same key and the display names need no separate branch. The only variant
 * whose two spellings do not already collide that way is `Fbm`/`FBM`, and
 * lowercasing settles that one too.
 */
const NOISE_TYPE_BY_KEY: ReadonlyMap<string, NoiseType> = new Map([
    ...NOISE_TYPES.map((type) => [enumKey(type), type] as const),
    ...NOISE_TYPES.map((type) => [enumKey(NOISE_TYPE_LABELS[type]), type] as const),
]);

const BACKGROUND_COLOR_MODE_BY_KEY = byKey(BACKGROUND_COLOR_MODES);

/** `update_setting`'s `"vector_field_type"` arm (simulation.rs:677), minus its silent fallback. */
export function parseVectorFieldType(value: unknown): VectorFieldType {
    const found = VECTOR_FIELD_TYPE_BY_KEY.get(enumKey(value));
    if (found) return found;
    throw new Error(
        `Invalid VectorFieldType: '${String(value)}'. Expected one of ${VECTOR_FIELD_TYPES.join(', ')}`
    );
}

/**
 * `update_setting`'s `"noise_type"` arm (simulation.rs:723), minus its silent
 * fallback.
 *
 * That fallback — `_ => self.settings.noise_type` — is exactly how a casing
 * mismatch hides: an unrecognised string leaves the old value in place, the
 * command still resolves `Ok`, and the selector snaps back one sync later with
 * nothing logged anywhere. Throwing lets `sync.ts` roll the optimistic update
 * back and puts the bad spelling in the console.
 */
export function parseNoiseType(value: unknown): NoiseType {
    const found = NOISE_TYPE_BY_KEY.get(enumKey(value));
    if (found) return found;
    throw new Error(
        `Invalid NoiseType: '${String(value)}'. Expected one of ${NOISE_TYPES.join(', ')}`
    );
}

/** `update_setting`'s `"background_color_mode"` arm (simulation.rs:771). */
export function parseBackgroundColorMode(value: unknown): BackgroundColorMode {
    const found = BACKGROUND_COLOR_MODE_BY_KEY.get(enumKey(value));
    if (found) return found;
    throw new Error(
        `Invalid BackgroundColorMode: '${String(value)}'. Expected one of ${BACKGROUND_COLOR_MODES.join(', ')}`
    );
}

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
 * settings.rs:8. Thirteen fields; serde names identical to the field names.
 *
 * The last five carry `#[serde(default)]`, so a preset written before they
 * existed still deserializes on the desktop side. `normalizeVectorsSettings`
 * gives the same guarantee here, for every field rather than those five — see
 * its note.
 */
export interface VectorsSettings {
    vector_field_type: VectorFieldType;
    noise_type: NoiseType;
    /** `u32` in the Rust; see `asU32` for what that costs a JSON number. */
    noise_seed: number;
    /** `f64`, and the only f64 in the struct — it multiplies world coordinates. */
    noise_scale: number;
    noise_dt_multiplier: number;
    density: number;
    line_length: number;
    line_width: number;

    // `#[serde(default)]` from here down.
    background_color_mode: BackgroundColorMode;
    image_fit_mode: ImageFitMode;
    image_mirror_horizontal: boolean;
    image_mirror_vertical: boolean;
    image_invert_tone: boolean;
}

/** Exactly `impl Default for Settings` (settings.rs:31). */
export function defaultVectorsSettings(): VectorsSettings {
    return {
        vector_field_type: 'Noise',
        noise_type: 'OpenSimplex',
        noise_seed: 0,
        noise_scale: 5.0,
        noise_dt_multiplier: 1.0,
        density: 0.02,
        line_length: 0.03,
        line_width: 0.001,
        background_color_mode: 'Black',
        // ImageFitMode::default() — Stretch, and spelled out in the Rust's
        // Default impl too (settings.rs:43) rather than left to the derive.
        image_fit_mode: DEFAULT_IMAGE_FIT_MODE,
        image_mirror_horizontal: false,
        image_mirror_vertical: false,
        image_invert_tone: false,
    };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Port of `struct State` (state.rs:2).
 *
 * The last four fields are a dirty-check cache for `geometry_dirty`
 * (simulation.rs:393), not state anybody sets — they are the camera and noise
 * scale the current vertex buffer was built from. They are in the struct on both
 * sides, and deliberately **not** in the state document; see
 * `vectorsStateDocument`.
 */
export interface VectorsState extends Record<string, unknown> {
    current_color_scheme: string;
    color_scheme_reversed: boolean;
    gui_visible: boolean;
    simulation_time: number;
    is_running: boolean;

    // Geometry cache
    last_camera_x: number;
    last_camera_y: number;
    last_camera_zoom: number;
    last_noise_scale: number;
}

/** Exactly `impl Default for State` (state.rs:15). */
export function defaultVectorsState(): VectorsState {
    return {
        current_color_scheme: 'MATPLOTLIB_viridis',
        color_scheme_reversed: false,
        gui_visible: true,
        simulation_time: 0.0,
        is_running: true,
        last_camera_x: 0.0,
        last_camera_y: 0.0,
        last_camera_zoom: 1.0,
        // Not 0: the cache starts at `Settings::default().noise_scale` so the
        // first frame after construction does not count as dirty on its own.
        last_noise_scale: 5.0,
    };
}

/** The four `geometry_dirty` cache fields, stripped from the state document. */
const GEOMETRY_CACHE_KEYS = [
    'last_camera_x',
    'last_camera_y',
    'last_camera_zoom',
    'last_noise_scale',
] as const;

/**
 * What `getState()` hands out.
 *
 * `get_state` (simulation.rs:812) is hand-written and returns **only**
 * `current_color_scheme` and `color_scheme_reversed` — the other seven fields of
 * `State` never crossed the bridge at all. Three of those seven are ordinary
 * state that every other ported simulation does expose (`gui_visible`,
 * `simulation_time`, `is_running`), so they are included here; the four
 * geometry-cache fields are not, because they are an implementation detail of
 * the dirty check that changes on literally every frame and would make each
 * state sync report a different document for no reason.
 *
 * `VectorsMode.svelte` reads only the two colour-scheme fields, so the extra
 * three are additive and cannot break it.
 */
export function vectorsStateDocument(state: VectorsState): Record<string, unknown> {
    const doc: Record<string, unknown> = { ...state };
    for (const key of GEOMETRY_CACHE_KEYS) delete doc[key];
    return doc;
}

// ---------------------------------------------------------------------------
// update_setting / update_state
// ---------------------------------------------------------------------------

/**
 * What the caller has to redo on the GPU once a field changed.
 *
 * The Rust ends *every* `update_setting` arm with a single unconditional
 * `self.update_geometry(device, queue)` (simulation.rs:782), including the arm
 * for `background_color_mode` — which changes nothing but the render pass's
 * clear colour, and rebuilds and re-uploads the whole vertex and index buffer to
 * do it. At the default density that is ~14,600 line quads and two buffer writes
 * to change one `wgpu::Color`; at the UI's minimum density it is millions.
 * Distinguishing the effects here is a deliberate divergence, and a free one —
 * no output pixel differs.
 *
 * `refit-image` additionally implies `geometry`: the Rust guards
 * `reprocess_vector_field_image` on `vector_field_type == Image` and then falls
 * through to the same unconditional rebuild, so the caller must treat a refit as
 * a superset. Kept as one value rather than a set because the caller does the
 * two in a fixed order anyway.
 */
export type VectorsSettingEffect =
    | 'none'
    | 'geometry'
    | 'refit-image'
    | 'clear-color'
    | 'reload-lut';

/**
 * `value.as_f64()` — a JSON *number* only, and finite.
 *
 * No coercion. `Number(null)` and `Number('')` are both 0, and `density: 0` is
 * not a harmless value here: `vectorsGridSpacing` floors it at 0.001, so a
 * coerced null would silently produce the densest, slowest field the app can
 * draw rather than being rejected.
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

/**
 * `value.as_u64().map(|n| n as u32)` (simulation.rs:740).
 *
 * `as u32` in Rust is a wrapping truncation, and `noise_seed` is the one field
 * where that is reachable from the UI: `NumberDragBox` is given
 * `max={4294967295}`, and the seed is meaningless arithmetically — every bit
 * pattern is as good as any other — so wrapping is the faithful behaviour rather
 * than a clamp. `>>> 0` is the same operation on the low 32 bits.
 *
 * `as_u64` rejects a negative or fractional JSON number outright, so those are
 * errors rather than something to truncate.
 */
function asU32(value: unknown, name: string): number {
    const n = asFiniteNumber(value);
    if (n === null || n < 0 || !Number.isInteger(n)) {
        throw new Error(
            `Setting "${name}" needs a non-negative integer, got ${JSON.stringify(value)}`
        );
    }
    return n >>> 0;
}

/** `value.as_bool()`. */
function asBool(value: unknown): boolean {
    return value === true;
}

/**
 * Port of `update_setting` (simulation.rs:667).
 *
 * All thirteen names `VectorsMode.svelte` sends have a match arm in the Rust —
 * unlike Gray-Scott, where three did not — so nothing had to be added. Two
 * things are deliberately not reproduced:
 *
 *   - **the silent fallbacks.** Three arms end in `_ => self.settings.<field>`
 *     and every arm is wrapped in an `if let Some(..)`, so a wrong type or a
 *     misspelled enum value is indistinguishable from success. Here they throw,
 *     which is what lets `sync.ts` roll the optimistic update back.
 *   - **`webcam_capture.stop_capture()`** on switching to `Noise`
 *     (simulation.rs:679). Webcam is an omitted feature of this port
 *     (WEB_PORT.md, "Omitted features"), so there is no capture to stop.
 *
 * An unknown name throws where the Rust's `_ => {}` (simulation.rs:780) ignored
 * it — same call Moiré and Gray-Scott make.
 */
export function updateVectorsSetting(
    settings: VectorsSettings,
    name: string,
    value: unknown
): VectorsSettingEffect {
    switch (name) {
        case 'vector_field_type':
            settings.vector_field_type = parseVectorFieldType(value);
            return 'geometry';
        case 'noise_type':
            settings.noise_type = parseNoiseType(value);
            return 'geometry';
        case 'noise_seed':
            settings.noise_seed = asU32(value, name);
            return 'geometry';
        case 'noise_scale':
            settings.noise_scale = asFloat(value, name);
            return 'geometry';
        case 'noise_dt_multiplier':
            settings.noise_dt_multiplier = asFloat(value, name);
            return 'geometry';
        case 'density':
            settings.density = asFloat(value, name);
            return 'geometry';
        case 'line_length':
            settings.line_length = asFloat(value, name);
            return 'geometry';
        case 'line_width':
            settings.line_width = asFloat(value, name);
            return 'geometry';

        case 'background_color_mode':
            settings.background_color_mode = parseBackgroundColorMode(value);
            return 'clear-color';

        // The image group. The Rust refits only when the field type is already
        // Image; the caller does the same check, because a refit of an image
        // that is not being sampled is wasted work either way.
        case 'image_fit_mode':
            settings.image_fit_mode = parseFitMode(value);
            return 'refit-image';
        case 'image_mirror_horizontal':
            settings.image_mirror_horizontal = asBool(value);
            return 'refit-image';
        case 'image_mirror_vertical':
            settings.image_mirror_vertical = asBool(value);
            return 'refit-image';
        case 'image_invert_tone':
            settings.image_invert_tone = asBool(value);
            return 'refit-image';

        default:
            throw new Error(`Unknown setting: ${name}`);
    }
}

/**
 * Port of `update_state` (simulation.rs:785).
 *
 * The Rust matches exactly two names and ignores everything else, and those two
 * are the only ones `VectorsMode.svelte` can produce — it reaches the colour
 * scheme through `apply_color_scheme_by_name` / `toggle_color_scheme_reversed`,
 * which land here via `handlers/colorSchemes.ts`.
 */
export function updateVectorsState(
    state: VectorsState,
    name: string,
    value: unknown
): VectorsSettingEffect {
    switch (name) {
        case 'current_color_scheme':
            state.current_color_scheme = String(value);
            return 'reload-lut';
        case 'color_scheme_reversed':
            state.color_scheme_reversed = asBool(value);
            return 'reload-lut';
        default:
            throw new Error(`Unknown state: ${name}`);
    }
}

/**
 * Coerce an arbitrary document into a complete `VectorsSettings`.
 *
 * `apply_settings` (simulation.rs:862) deserialized straight into the struct and
 * — this is the interesting part — `if let Ok(s)` **swallowed the failure**, so
 * a preset missing any of the eight non-`#[serde(default)]` fields was silently
 * ignored and the simulation kept its previous settings with no error anywhere.
 *
 * A partial document is normal here rather than exceptional: `PresetStore`
 * stores built-ins as overrides only, exactly as `Settings { .., ..default() }`
 * wrote them. So every field falls back to its default, which extends the
 * `#[serde(default)]` guarantee the five image/background fields have to all
 * thirteen — and that is the forward-compatible direction. A document from a
 * newer build carrying a field this version has never heard of keeps the rest.
 */
export function normalizeVectorsSettings(input: unknown): VectorsSettings {
    const settings = defaultVectorsSettings();
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return settings;
    }

    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
        try {
            updateVectorsSetting(settings, name, value);
        } catch {
            // A preset from a newer build, or a hand-edited localStorage entry.
            // Keeping the default for that one field beats refusing the preset.
            console.warn(`[vectors] ignoring unusable setting "${name}"`);
        }
    }
    return settings;
}

/**
 * Port of `randomize_settings` (simulation.rs:884).
 *
 * Three of the thirteen fields move, and the ranges are transcribed rather than
 * reconciled — **`noise_scale` is randomized into `0.001..0.1`, two to four
 * orders of magnitude below its own default of 5.0.**
 *
 * That is almost certainly an upstream bug rather than a taste: `noise_scale`
 * multiplies the world coordinate before sampling (simulation.rs:304), and the
 * visible field spans 2.4/zoom world units, so at 0.1 the whole screen samples a
 * noise interval of width 0.24 and at 0.001 an interval of 0.0024. Every line
 * ends up at very nearly the same angle, length and colour — Randomize reliably
 * produces a near-uniform comb, and never anything resembling the default view.
 *
 * It is reproduced anyway, because unlike M4's four Gray-Scott fixes this one
 * cannot be derived from the code being self-contradictory: no shader, no
 * comment and no second impl says what the range was meant to be, so any
 * "corrected" range would be invented. Changing it is a visual-parity decision
 * for M14, and it is asserted as-is by a test that fails if the range moves.
 *
 * `rng` is injected purely so the ranges are testable without sampling. Note
 * `rand::rng().random::<u32>()` for the seed is the full u32 range, unlike the
 * half-open `random_range` used for the other two.
 */
export function randomizeVectorsSettings(
    settings: VectorsSettings,
    rng: () => number = Math.random
): void {
    settings.noise_type = NOISE_TYPES[Math.min(NOISE_TYPES.length - 1, Math.floor(rng() * 11))];
    settings.noise_seed = Math.floor(rng() * 4294967296) >>> 0;
    settings.noise_scale = 0.001 + rng() * (0.1 - 0.001);
}

// ---------------------------------------------------------------------------
// Clear colour
// ---------------------------------------------------------------------------

/** Linear-space RGBA, in the order a `GPURenderPassColorAttachment` wants it. */
export type ClearColor = [r: number, g: number, b: number, a: number];

/**
 * Port of `get_clear_color` (simulation.rs:367).
 *
 * `firstLutColor` is `ColorScheme::get_first_color()` — the caller has the LUT,
 * this module does not. The Rust falls back to black when the scheme cannot be
 * found or has no first colour, and so does this.
 *
 * Note 0.18 is used literally for Gray18 on both sides. It is an 18% *linear*
 * grey, not sRGB 18%, which renders noticeably darker than the "18% grey" a
 * photographer means — faithful, and worth knowing before anyone "fixes" it.
 */
export function vectorsClearColor(
    mode: BackgroundColorMode,
    firstLutColor?: readonly number[] | null
): ClearColor {
    switch (mode) {
        case 'White':
            return [1, 1, 1, 1];
        case 'Gray18':
            return [0.18, 0.18, 0.18, 1];
        case 'Color Scheme':
            if (!firstLutColor) return [0, 0, 0, 1];
            return [firstLutColor[0] ?? 0, firstLutColor[1] ?? 0, firstLutColor[2] ?? 0, 1];
        case 'Black':
        default:
            return [0, 0, 0, 1];
    }
}

// ---------------------------------------------------------------------------
// Grid geometry — the CPU half of update_geometry
// ---------------------------------------------------------------------------

/**
 * simulation.rs:266 — `let half_span = 1.2 / zoom;`
 *
 * The visible extent plus a margin: the camera shows [-1, 1] at zoom 1, and the
 * extra 0.2 keeps lines whose origin is just off-screen from popping in.
 */
export const VECTORS_VIEW_HALF_SPAN = 1.2;

/** simulation.rs:274 — `density.max(0.001)`. */
export const VECTORS_MIN_SPACING = 0.001;

/**
 * Ceiling on the number of line quads one geometry rebuild may produce.
 *
 * **Not in the Rust, and it has to be here.** `update_geometry` walks the whole
 * view at `spacing = density.max(0.001)` with no cap, and `geometry_dirty` is
 * true on every frame the clock advances — so the grid is rebuilt every frame.
 * `VectorsMode.svelte:165` puts the density minimum at exactly 0.001, which at
 * zoom 1 is a 2401 x 2401 grid: 5.77 M lines, 23 M vertices at 12 B and 34.6 M
 * indices at 4 B, i.e. a **277 MB vertex buffer and a 138 MB index buffer**.
 * `maxBufferSize` on the reference device is the spec default of 256 MiB
 * (WEB_PORT.md, "Reference device"), so the vertex allocation fails outright and
 * takes the device with it — and that is before 5.77 M noise samples per frame.
 *
 * 512 x 512 = 262,144 lines is 18.9 MB of vertices and 6.3 MB of indices, which
 * leaves the buffers an order of magnitude inside every limit while still being
 * far denser than anything legible. Zooming out past the cap coarsens the grid
 * rather than truncating it — see `vectorsGridExtent`.
 */
export const VECTORS_MAX_LINES = 512 * 512;

/** simulation.rs:274. The floor is the Rust's, not a port concession. */
export function vectorsGridSpacing(density: number): number {
    return Math.max(density, VECTORS_MIN_SPACING);
}

export interface VectorsGridExtent {
    /** World-space step between adjacent sample points, after any clamp. */
    spacing: number;
    minX: number;
    minY: number;
    countX: number;
    countY: number;
    /** `countX * countY` — one line quad per point. */
    count: number;
    /** True when `VECTORS_MAX_LINES` forced the spacing up. */
    clamped: boolean;
}

/**
 * The sample grid for one frame — port of the two `while` loops at
 * simulation.rs:284-322, as arithmetic rather than accumulation.
 *
 * The Rust walks `x` from `min_x` in `spacing` steps while `x <= max_x`, so the
 * count is `floor(span / spacing) + 1`. Computing it instead of accumulating
 * also removes a real wobble: repeatedly adding a float `spacing` drifts, so the
 * last column is included or dropped depending on rounding, and the vertex count
 * changes by a whole row for no visible reason.
 *
 * When the grid would exceed `VECTORS_MAX_LINES` the **spacing is raised**, not
 * the extent trimmed: the field keeps covering the whole view and merely gets
 * coarser, which is what a viewer reads as "zoomed out" rather than as "the
 * simulation stopped half way across the screen".
 */
export function vectorsGridExtent(
    cameraX: number,
    cameraY: number,
    zoom: number,
    density: number
): VectorsGridExtent {
    const halfSpan = VECTORS_VIEW_HALF_SPAN / (zoom || 1);
    const span = 2 * halfSpan;

    let spacing = vectorsGridSpacing(density);
    // One axis of the square budget: N points per side is N² lines.
    const maxPerAxis = Math.floor(Math.sqrt(VECTORS_MAX_LINES));
    const minSpacing = span / Math.max(1, maxPerAxis - 1);
    const clamped = spacing < minSpacing;
    if (clamped) spacing = minSpacing;

    const perAxis = Math.floor(span / spacing) + 1;
    return {
        spacing,
        minX: cameraX - halfSpan,
        minY: cameraY - halfSpan,
        countX: perAxis,
        countY: perAxis,
        count: perAxis * perAxis,
        clamped,
    };
}

/**
 * simulation.rs:312 — one sample value becomes one line segment.
 *
 * `value` is the noise or luminance sample already normalized to [0, 1]
 * (`sample_cached` does `(v + 1) * 0.5`; the image path divides by 255). The
 * angle is the full turn and the length runs from half `line_length` to all of
 * it, so a sample of 0 and a sample of 1 both point along +x but differ in
 * length — which is why a field with no variation reads as a comb.
 *
 * Pure, and the exact arithmetic the noise compute shader has to reproduce, so a
 * test can pin the two against each other.
 */
export function vectorsLineSegment(
    x: number,
    y: number,
    value: number,
    lineLength: number
): [x0: number, y0: number, x1: number, y1: number] {
    const angle = value * Math.PI * 2;
    const len = lineLength * (0.5 + value * 0.5);
    return [x, y, x + Math.cos(angle) * len, y + Math.sin(angle) * len];
}

/**
 * simulation.rs:222 — one segment becomes four vertices of a quad, offset along
 * the segment normal by half the line width.
 *
 * Returned as the flat `[x, y, value] * 4` a `LineVertex` vertex buffer wants.
 * The `max(1e-6)` on the length is the Rust's guard against a zero-length
 * segment, which happens whenever `line_length` is 0.
 */
export function vectorsLineQuad(
    segment: readonly [number, number, number, number],
    value: number,
    lineWidth: number
): number[] {
    const [x0, y0, x1, y1] = segment;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.max(Math.hypot(dx, dy), 1e-6);
    const px = (-dy / len) * (lineWidth * 0.5);
    const py = (dx / len) * (lineWidth * 0.5);
    return [
        x0 - px,
        y0 - py,
        value,
        x0 + px,
        y0 + py,
        value,
        x1 + px,
        y1 + py,
        value,
        x1 - px,
        y1 - py,
        value,
    ];
}

/** simulation.rs:255 — two triangles per quad, from the quad's base index. */
export function vectorsQuadIndices(quadIndex: number): number[] {
    const base = quadIndex * 4;
    return [base, base + 1, base + 2, base, base + 2, base + 3];
}
