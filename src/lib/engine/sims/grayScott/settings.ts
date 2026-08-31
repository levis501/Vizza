/**
 * Gray-Scott settings and runtime state — a port of
 * src-tauri/src/simulations/gray_scott/{settings.rs,state.rs}.
 *
 * Deliberately GPU-free, exactly as `sims/moire/settings.ts` is: the defaults,
 * the two mask enums, the uniform packing and the texture sizing are then unit
 * testable in node, and `sims/grayScott/index.ts` is left holding nothing but
 * pipelines and buffers.
 *
 * Field names are the snake_case strings `GrayScottMode.svelte` sends through
 * `update_simulation_setting` / `update_simulation_state`, and the serialized
 * values are what serde produced — a preset written by the desktop app must
 * load here unchanged.
 *
 * **No numeric clamping.** settings.rs declares none and neither does
 * `update_setting` (simulation.rs:1148), so clamping to the ranges
 * `GrayScottMode.svelte` puts on its drag boxes would be a silent behaviour
 * change. What is enforced instead is *type* soundness — a non-finite number
 * must never reach the uniform, because one NaN in `feed_rate` turns both
 * concentration textures into NaN inside a frame and the field never recovers.
 */

import {
    DEFAULT_IMAGE_FIT_MODE,
    parseImageFitMode,
    type ImageFitMode,
} from '$lib/engine/resources/imageUpload';
import { computeBackingSize } from '$lib/engine/gpu/surface';

// ---------------------------------------------------------------------------
// Texture sizing
// ---------------------------------------------------------------------------

/**
 * Ceiling on the concentration pair, independent of surface size and DPR.
 *
 * simulation.rs:715 sizes both textures to the surface with `.max(256)` per
 * axis and **no upper bound at all**. A 4K display at an unclamped 3x DPR is
 * 11520x6480; two rgba16float textures of that are ~1.2 GB, for a reaction
 * whose features are tens of pixels across. 2048² x2 is 33 MB.
 */
export const GRAY_SCOTT_MAX_DIM = 2048;

/** simulation.rs:715 — `new_config.width.max(256)`, per axis. */
export const GRAY_SCOTT_MIN_DIM = 256;

/**
 * Simulation-texture size for a given surface: floored, capped, aspect
 * preserved in between.
 *
 * The 256 floor is the Rust's and it *does* distort a smaller surface — it is
 * applied per axis, so a 400x200 window gets a 400x256 field. That is
 * deliberate on both sides: the reaction needs room for a pattern to develop,
 * and the infinite renderer samples the field with a wrap, so a mismatched
 * aspect tiles rather than stretches.
 */
export function grayScottTextureSize(
    width: number,
    height: number,
    maxTextureDimension2D: number
): [width: number, height: number] {
    const cap = Math.min(GRAY_SCOTT_MAX_DIM, maxTextureDimension2D);
    const [cappedWidth, cappedHeight] = computeBackingSize(width, height, 1, cap);
    // The floor can never be allowed to push past the device's own limit, which
    // is why it is itself clamped rather than applied raw.
    const floor = Math.min(GRAY_SCOTT_MIN_DIM, cap);
    return [Math.max(floor, cappedWidth), Math.max(floor, cappedHeight)];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** settings.rs:4. Eight fields, serde names identical to the field names. */
export interface GrayScottSettings {
    feed_rate: number;
    kill_rate: number;
    diffusion_rate_u: number;
    diffusion_rate_v: number;
    timestep: number;

    // Adaptive-timestep group
    max_timestep: number;
    stability_factor: number;
    enable_adaptive_timestep: boolean;
}

/**
 * Exactly `impl Default for Settings` (settings.rs:17).
 *
 * Do not take these from `GrayScottDiagram.svelte:116` — its Svelte *prop*
 * defaults say `diffusionRateU = 0.1` and `timestep = 1.0`, which is a
 * documentation drawing that drifted, not the model.
 */
export function defaultGrayScottSettings(): GrayScottSettings {
    return {
        feed_rate: 0.055,
        kill_rate: 0.062,
        diffusion_rate_u: 0.16,
        diffusion_rate_v: 0.08,
        timestep: 2.5,
        max_timestep: 4.0,
        stability_factor: 0.9,
        enable_adaptive_timestep: false,
    };
}

const SETTING_NUMERIC_KEYS = [
    'feed_rate',
    'kill_rate',
    'diffusion_rate_u',
    'diffusion_rate_v',
    'timestep',
    'max_timestep',
    'stability_factor',
] as const;

type SettingNumericKey = (typeof SETTING_NUMERIC_KEYS)[number];

const SETTING_NUMERIC_KEY_SET: ReadonlySet<string> = new Set<string>(SETTING_NUMERIC_KEYS);

// ---------------------------------------------------------------------------
// Mask enums
// ---------------------------------------------------------------------------

/**
 * state.rs:24. **The display spelling is canonical here, not serde's.**
 *
 * The Rust carries three competing spellings for every one of these variants:
 *
 *   - serde's, from the bare `#[derive(Serialize)]` on a unit enum — PascalCase
 *     with no separator, `"DiagonalGradient"`; this is what `get_state` emits;
 *   - `as_str()`'s display name, `"Diagonal Gradient"`; this is what
 *     `GrayScottMode.svelte:417` lists in its `<Selector>` and what
 *     `updateMaskPattern` sends back;
 *   - the lowercase/underscore forms `from_str` additionally accepts.
 *
 * That is a live round-trip bug on the desktop build: the UI sends
 * `"Diagonal Gradient"`, `from_str` accepts it, `get_state` returns
 * `"DiagonalGradient"`, and the `<Selector>` — whose options are the display
 * names — then matches nothing and falls back to its placeholder. Six of the
 * nine patterns and all five targets are affected (the ones whose two
 * spellings coincide, `Disabled`/`Checkerboard`/`Image`, are not).
 *
 * Choosing the display spelling as the single canonical value fixes it in the
 * direction that needs no UI change, and `parseMaskPattern` still accepts all
 * three spellings so a preset or a state document from either build loads.
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

/** state.rs:37. Same three-spelling story as `MaskPattern`; see above. */
export type MaskTarget =
    | 'Feed Rate'
    | 'Kill Rate'
    | 'Diffusion U'
    | 'Diffusion V'
    | 'UV Concentration';

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

export const MASK_TARGETS: readonly MaskTarget[] = [
    'Feed Rate',
    'Kill Rate',
    'Diffusion U',
    'Diffusion V',
    'UV Concentration',
];

/**
 * reaction_diffusion.wgsl:230 — the `switch (params.mask_pattern)` arms.
 *
 * 0..8 in declaration order. The Rust's `as u32` discriminants, its
 * `From<MaskPattern> for u32` impl (state.rs:150) and the shader all agree
 * here, unlike the target codes below.
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

/**
 * reaction_diffusion.wgsl:305 — the `switch (params.mask_target)` arms, **1..5**.
 *
 * This table is a deliberate bug fix, not a transcription. The Rust uploads
 * `state.mask_target as u32` (simulation.rs:1243), i.e. the declaration
 * discriminants 0..4, while the shader switches on 1..5 and treats everything
 * else as "no mask". The `From<MaskTarget> for u32` impl at state.rs:166 does
 * produce 1..5 — and has no callers anywhere in the tree.
 *
 * So on the desktop build the whole target selector is off by one: "Feed Rate"
 * uploads 0 and applies no mask at all, and the default "UV Concentration"
 * uploads 4 and silently runs the Diffusion-V branch. The shader's arms are
 * individually commented with the variant they mean, so the shader is the
 * documented contract and the upload is what is wrong.
 */
export const MASK_TARGET_CODE: Record<MaskTarget, number> = {
    'Feed Rate': 1,
    'Kill Rate': 2,
    'Diffusion U': 3,
    'Diffusion V': 4,
    'UV Concentration': 5,
};

/**
 * Fold any of the three spellings onto one lookup key.
 *
 * `"Diagonal Gradient"`, `"DiagonalGradient"` and `"diagonal_gradient"` all
 * collapse to `diagonalgradient`, which is what lets one table accept serde
 * output, display names and the Rust's underscore forms without three
 * branches. Slightly more permissive than `from_str` (it would reject
 * `"DIAGONALGRADIENT"`); nothing depends on rejecting that.
 */
function enumKey(value: unknown): string {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, '');
}

const MASK_PATTERN_BY_KEY: ReadonlyMap<string, MaskPattern> = new Map<string, MaskPattern>([
    ...MASK_PATTERNS.map((pattern) => [enumKey(pattern), pattern] as const),
    // from_str's extra alias for the image pattern (state.rs:98). "Image"
    // itself is already covered by the display name above.
    ['imagegradient', 'Image'],
]);

const MASK_TARGET_BY_KEY: ReadonlyMap<string, MaskTarget> = new Map<string, MaskTarget>(
    MASK_TARGETS.map((target) => [enumKey(target), target] as const)
);

/** `MaskPattern::from_str` (state.rs:68), minus the silent `None`. */
export function parseMaskPattern(value: unknown): MaskPattern {
    const found = MASK_PATTERN_BY_KEY.get(enumKey(value));
    if (found) return found;
    throw new Error(
        `Invalid MaskPattern: '${String(value)}'. Expected one of ${MASK_PATTERNS.join(', ')}`
    );
}

/** `MaskTarget::from_str` (state.rs:121), minus the silent `None`. */
export function parseMaskTarget(value: unknown): MaskTarget {
    const found = MASK_TARGET_BY_KEY.get(enumKey(value));
    if (found) return found;
    throw new Error(
        `Invalid MaskTarget: '${String(value)}'. Expected one of ${MASK_TARGETS.join(', ')}`
    );
}

/** `ImageFitMode::from_str` (shared/types.rs:40), reusing the shared parser. */
export function parseFitMode(value: unknown): ImageFitMode {
    const parsed = parseImageFitMode(String(value ?? ''));
    if (!parsed) throw new Error(`Invalid ImageFitMode: '${String(value)}'`);
    return parsed;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Port of `struct State` (state.rs:179) — everything `get_state` returned,
 * minus two fields.
 *
 * **`mask_image_base` and `mask_image_raw` are deliberately absent.** In the
 * Rust they are `Option<Vec<f32>>` of width x height, and they sit inside the
 * serialized state, so a single `get_state` on a 2048² field would push four
 * million JSON numbers — tens of megabytes of text — across the bridge, and
 * `GrayScottMode.svelte` syncs state after most interactions. The decoded mask
 * pixels belong on the simulation object, next to the GPU buffer they feed.
 * `grayScottStateDocument` exists to keep that guarantee enforceable.
 */
export interface GrayScottState extends Record<string, unknown> {
    // Mask system
    mask_pattern: MaskPattern;
    mask_target: MaskTarget;
    mask_strength: number;
    /**
     * Inert, and faithfully so.
     *
     * `mask_reversed` is stored, serialized, reset and updated by both the
     * settings and the state command — and read by nothing. `SimulationParams`
     * has no such field and no shader mentions it, so reversing a mask has
     * never done anything on any build. Ported for state-shape compatibility;
     * **do not** wire it into `packGrayScottParams` on the assumption that its
     * absence is an oversight here.
     */
    mask_reversed: boolean;
    mask_image_fit_mode: ImageFitMode;
    mask_mirror_horizontal: boolean;
    mask_mirror_vertical: boolean;
    mask_invert_tone: boolean;
    /** Set when a decoded mask is waiting for the next queue submission. */
    mask_image_needs_upload: boolean;

    // Pointer
    mouse_pressed: boolean;
    mouse_position: [number, number];
    mouse_screen_position: [number, number];

    // Cursor
    cursor_size: number;
    cursor_strength: number;

    // Colour scheme
    current_color_scheme: string;
    color_scheme_reversed: boolean;

    // UI
    gui_visible: boolean;

    /**
     * Also inert. `State::camera_position` / `camera_zoom` are never read or
     * written by the model — the real camera is `self.camera`, and
     * `get_camera_state` (simulation.rs:1889) reads that directly. Kept so the
     * state document has the same shape the desktop app produced; the Camera is
     * the only source of truth for the viewport.
     */
    camera_position: [number, number];
    camera_zoom: number;

    // Runtime
    simulation_time: number;
    is_running: boolean;
}

/** Exactly `impl Default for State` (state.rs:220). */
export function defaultGrayScottState(): GrayScottState {
    return {
        mask_pattern: 'Disabled',
        mask_target: 'UV Concentration',
        mask_strength: 0.5,
        mask_reversed: false,
        // state.rs:228 — `ImageFitMode::default()`, which is Stretch. Moiré's
        // own default is 'Fit V'; these are per-simulation, not shared.
        mask_image_fit_mode: DEFAULT_IMAGE_FIT_MODE,
        mask_mirror_horizontal: false,
        mask_mirror_vertical: false,
        mask_invert_tone: false,
        mask_image_needs_upload: false,
        mouse_pressed: false,
        mouse_position: [0, 0],
        mouse_screen_position: [0, 0],
        cursor_size: 0.2,
        cursor_strength: 1.0,
        current_color_scheme: 'MATPLOTLIB_prism',
        // Reversed by default, which is unusual and is what the preset
        // screenshots were taken with.
        color_scheme_reversed: true,
        gui_visible: true,
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
 * The strip is defensive rather than decorative — `GrayScottState` is an index
 * signature (the `Simulation` contract wants `Record<string, unknown>`), so a
 * stray `state.mask_image_raw = pixels` type-checks. This is the one place that
 * can stop several million floats being serialized on every state sync.
 */
export function grayScottStateDocument(state: GrayScottState): Record<string, unknown> {
    const doc: Record<string, unknown> = { ...state };
    for (const key of MASK_IMAGE_KEYS) delete doc[key];
    return doc;
}

// --- resets ----------------------------------------------------------------

/** `State::reset_mask` (state.rs:290). The pixel buffers are the caller's. */
export function resetGrayScottMask(state: GrayScottState): void {
    state.mask_pattern = 'Disabled';
    state.mask_target = 'UV Concentration';
    state.mask_strength = 0.5;
    state.mask_reversed = false;
    state.mask_image_needs_upload = false;
}

/**
 * `State::reset_mouse` (state.rs:281).
 *
 * Note `cursor_size = 0.1`, which is **not** the 0.20 `State::default` sets.
 * Transcribed rather than reconciled: the two really do disagree in the Rust,
 * so a reset shrinks the brush and a fresh simulation does not.
 */
export function resetGrayScottMouse(state: GrayScottState): void {
    state.mouse_pressed = false;
    state.mouse_position = [0, 0];
    state.mouse_screen_position = [0, 0];
    state.cursor_size = 0.1;
    state.cursor_strength = 1.0;
}

/** `State::reset_camera` (state.rs:275) — on the inert copy; see the field docs. */
export function resetGrayScottCamera(state: GrayScottState): void {
    state.camera_position = [0, 0];
    state.camera_zoom = 1.0;
}

/** `State::reset` (state.rs:267). */
export function resetGrayScottState(state: GrayScottState): void {
    resetGrayScottMask(state);
    resetGrayScottCamera(state);
    resetGrayScottMouse(state);
    state.simulation_time = 0;
}

/**
 * `Simulation::reset_runtime_state` (simulation.rs:1919) — a literal no-op.
 *
 * Kept as a real function rather than dropped, because the distinction is
 * load-bearing: the "Reset" button in `GrayScottMode.svelte` calls the separate
 * `reset_simulation` command, which routes to `GrayScottModel::reset`
 * (simulation.rs:915) and blanks the concentration field. `reset_runtime_state`
 * is the trait hook the preset/settings path calls, and Gray-Scott
 * deliberately does nothing there — clearing the field on every preset change
 * would throw away the pattern the user is watching develop. Field clearing
 * belongs in the simulation's own `reset()`.
 */
export function resetGrayScottRuntimeState(): void {
    // Intentionally empty.
}

// ---------------------------------------------------------------------------
// update_setting / update_state
// ---------------------------------------------------------------------------

/**
 * What the caller has to do on the GPU once a setting or state field changed.
 *
 * Richer than Moiré's two-valued version because Gray-Scott keeps two uniform
 * buffers whose contents overlap: the compute pass's `SimulationParams` and the
 * render/cursor params. A mask flag lives in both.
 */
export type GrayScottSettingEffect =
    | 'none'
    | 'sim-params'
    | 'render-params'
    | 'both-params'
    | 'refit-image'
    | 'reload-lut';

/**
 * `value.as_f64()` — a JSON *number* only, and finite.
 *
 * No coercion: `Number(null)` and `Number('')` are both 0, so a coercing
 * version would accept a null the Rust ignored and write a plausible zero into
 * the uniform. `feed_rate: 0` is a perfectly reachable value, so that mistake
 * would be invisible.
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

/** `value.as_bool().unwrap_or(false)`. */
function asBool(value: unknown): boolean {
    return value === true;
}

/**
 * Port of `update_setting` (simulation.rs:1148), restricted to actual settings.
 *
 * Two deliberate divergences.
 *
 * **The three adaptive-timestep names now stick.** The Rust has no match arm
 * for `max_timestep`, `stability_factor` or `enable_adaptive_timestep` even
 * though `GrayScottMode.svelte:170-177` sends all three by those exact names,
 * so on the desktop build the drag box moves, the local `settings` object
 * updates, the backend drops the value on the floor, and the next state sync
 * snaps the box back. The arms are added here.
 *
 * **The mask and cursor names are not accepted by this function.** The Rust
 * routes eight of them — `mask_pattern`, `mask_target`, `mask_strength`,
 * `mask_reversed`, `image_fit_mode`, `mask_mirror_horizontal`, `cursor_size`,
 * `cursor_strength` — through the *settings* command into `State`, which is
 * both confusing and incomplete (`mask_mirror_vertical` and `mask_invert_tone`
 * are missing from it). The Svelte UI never uses that path: every one of those
 * goes through `update_simulation_state`. So they live in
 * `updateGrayScottState` alone, and the dead settings-command aliases are not
 * reproduced.
 *
 * An unknown name throws, where the Rust's `_ => {}` (simulation.rs:1235)
 * silently ignored it — same call as Moiré makes, and it is what lets
 * `syncStore` roll an optimistic update back instead of showing a value the
 * engine never took.
 */
export function updateGrayScottSetting(
    settings: GrayScottSettings,
    name: string,
    value: unknown
): GrayScottSettingEffect {
    if (SETTING_NUMERIC_KEY_SET.has(name)) {
        settings[name as SettingNumericKey] = asFloat(value, name);
        return 'sim-params';
    }
    if (name === 'enable_adaptive_timestep') {
        settings.enable_adaptive_timestep = asBool(value);
        return 'sim-params';
    }
    throw new Error(`Unknown setting: ${name}`);
}

/**
 * Port of `update_state` (simulation.rs:1652).
 *
 * `image_fit_mode` is accepted alongside `mask_image_fit_mode` because the
 * settings command spelled it the short way (simulation.rs:1205) while
 * `ImageSelector` sends the long one; both spellings reach the same field.
 */
export function updateGrayScottState(
    state: GrayScottState,
    name: string,
    value: unknown
): GrayScottSettingEffect {
    switch (name) {
        case 'mask_pattern':
            state.mask_pattern = parseMaskPattern(value);
            return 'both-params';
        case 'mask_target':
            state.mask_target = parseMaskTarget(value);
            return 'both-params';
        case 'mask_strength':
            state.mask_strength = asFloat(value, name);
            return 'both-params';
        case 'mask_mirror_horizontal':
            state.mask_mirror_horizontal = asBool(value);
            return 'both-params';
        case 'mask_mirror_vertical':
            state.mask_mirror_vertical = asBool(value);
            return 'both-params';
        case 'mask_invert_tone':
            state.mask_invert_tone = asBool(value);
            return 'both-params';

        case 'mask_reversed':
            // Stored so the state document round-trips, but no uniform carries
            // it — see the field comment. The Rust re-uploads both param
            // buffers here, which cannot change a byte of either.
            state.mask_reversed = asBool(value);
            return 'none';

        case 'mask_image_fit_mode':
        case 'image_fit_mode':
            state.mask_image_fit_mode = parseFitMode(value);
            return 'refit-image';

        case 'cursor_size':
            state.cursor_size = asFloat(value, name);
            return 'render-params';
        case 'cursor_strength':
            state.cursor_strength = asFloat(value, name);
            return 'render-params';

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
 * Coerce an arbitrary document into a complete `GrayScottSettings`.
 *
 * `apply_settings` (simulation.rs:1895) deserialized straight into the struct,
 * so serde rejected a partial document outright. A partial one is normal here:
 * `PresetStore` stores built-ins as overrides only, exactly as
 * `Settings { .., ..Settings::default() }` wrote them, so anything absent comes
 * from the defaults — the same value the Rust preset would have carried.
 */
export function normalizeGrayScottSettings(input: unknown): GrayScottSettings {
    const settings = defaultGrayScottSettings();
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return settings;
    }

    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
        try {
            updateGrayScottSetting(settings, name, value);
        } catch {
            // A preset from a newer build, or a hand-edited localStorage entry.
            // Keeping the default for that one field beats refusing the preset.
            console.warn(`[grayScott] ignoring unusable setting "${name}"`);
        }
    }
    return settings;
}

/**
 * Port of `Settings::randomize` (settings.rs:36).
 *
 * Five of the eight fields move; the adaptive-timestep group is left alone,
 * which matters because `max_timestep` below the randomized `timestep` would
 * quietly cap it. `rand::rng().random_range(a..b)` is half-open, so `rng()`
 * being `[0,1)` maps across directly.
 *
 * `rng` is injected purely so the ranges are testable without sampling.
 */
export function randomizeGrayScottSettings(
    settings: GrayScottSettings,
    rng: () => number = Math.random
): void {
    settings.feed_rate = 0.02 + rng() * (0.08 - 0.02);
    settings.kill_rate = 0.04 + rng() * (0.08 - 0.04);
    settings.diffusion_rate_u = 0.1 + rng() * (0.3 - 0.1);
    settings.diffusion_rate_v = 0.05 + rng() * (0.15 - 0.05);
    settings.timestep = 0.5 + rng() * (2.0 - 0.5);
}

// ---------------------------------------------------------------------------
// Uniform packing
// ---------------------------------------------------------------------------

/**
 * `struct SimulationParams` (reaction_diffusion.wgsl:1) — 16 four-byte scalars,
 * no padding needed since every member is a scalar and the struct is a multiple
 * of 16 bytes.
 */
export const GRAY_SCOTT_PARAM_SCALARS = 16;
export const GRAY_SCOTT_PARAM_BYTES = GRAY_SCOTT_PARAM_SCALARS * 4;

export interface GrayScottParamInputs {
    /** Simulation texture width, not the surface width. */
    width: number;
    height: number;
}

/**
 * Pack `SimulationParams`. Pure, so the field order can be pinned by a unit
 * test — a misordered uniform here is not a crash, it is a reaction that runs
 * with the kill rate in the diffusion slot and looks merely wrong.
 *
 * The struct mixes f32 and u32, so it needs both views over one buffer; a
 * `Float32Array` alone would write `1.0` where the shader reads `u32` and see
 * 1065353216. **Take the order from the WGSL declaration only** — the struct
 * literals in `gray_scott/tests.rs` list `mask_invert_tone` before the two
 * mirror flags, which is not the real layout.
 */
export function packGrayScottParams(
    settings: GrayScottSettings,
    state: GrayScottState,
    inputs: GrayScottParamInputs,
    out: ArrayBuffer = new ArrayBuffer(GRAY_SCOTT_PARAM_BYTES)
): ArrayBuffer {
    const f32 = new Float32Array(out);
    const u32 = new Uint32Array(out);

    f32[0] = settings.feed_rate;
    f32[1] = settings.kill_rate;
    // delta_u / delta_v in the shader are the diffusion rates; the names differ
    // on the two sides and nothing translates them but this line.
    f32[2] = settings.diffusion_rate_u;
    f32[3] = settings.diffusion_rate_v;
    f32[4] = settings.timestep;
    u32[5] = inputs.width;
    u32[6] = inputs.height;
    u32[7] = MASK_PATTERN_CODE[state.mask_pattern];
    u32[8] = MASK_TARGET_CODE[state.mask_target];
    f32[9] = state.mask_strength;
    u32[10] = state.mask_mirror_horizontal ? 1 : 0;
    u32[11] = state.mask_mirror_vertical ? 1 : 0;
    u32[12] = state.mask_invert_tone ? 1 : 0;
    // Never read: `calculate_adaptive_timestep` clamps against `timestep`, not
    // against this. Positionally load-bearing all the same — dropping it would
    // shift stability_factor and enable_adaptive_timestep down a slot.
    f32[13] = settings.max_timestep;
    f32[14] = settings.stability_factor;
    u32[15] = settings.enable_adaptive_timestep ? 1 : 0;

    return out;
}
