/**
 * Moiré settings — a port of src-tauri/src/simulations/moire/settings.rs.
 *
 * Deliberately GPU-free so the defaults, the enum parsing and the uniform
 * packing can be unit-tested in node, and so the L4 fake engine can serve real
 * settings to the Svelte menu without a device.
 *
 * Field names are the snake_case strings `MoireMode.svelte` sends through
 * `update_simulation_setting`, and the serialized values are what serde
 * produced on the Rust side — a preset written by the desktop app must load
 * here unchanged.
 *
 * **No numeric clamping.** settings.rs declares none, and clamping to the
 * ranges `MoireMode.svelte` puts on its drag boxes would be actively wrong:
 * two of the four built-in presets set `base_freq` to 30 and 40 against a UI
 * maximum of 20. What is enforced instead is *type* soundness — a non-finite
 * number never reaches the uniform buffer, because one NaN in `params` turns
 * the whole advection feedback into NaN within a frame and never recovers.
 */

import { parseImageFitMode, type ImageFitMode } from '$lib/engine/resources/imageUpload';
import { computeBackingSize } from '$lib/engine/gpu/surface';

/**
 * Ceiling on the feedback pair, independent of surface size and DPR.
 *
 * The Rust sizes both textures straight to the surface with no cap at all
 * (simulation.rs:160). On a 4K display at the clamped 2x DPR that is
 * 7680x4320 rgba8unorm x2 — 265 MB of advection buffer holding a pattern whose
 * finest feature is several pixels across. 2048² x2 is 33 MB.
 */
export const MOIRE_MAX_DIM = 2048;

/**
 * Simulation-texture size for a given surface: capped, aspect preserved.
 *
 * Aspect matters here — the compute kernel maps texel coordinates onto [-1,1]
 * on both axes, so a squashed texture would stretch the moiré grid relative to
 * the tiles the infinite renderer draws it into.
 */
export function moireTextureSize(
    width: number,
    height: number,
    maxTextureDimension2D: number
): [width: number, height: number] {
    return computeBackingSize(width, height, 1, Math.min(MOIRE_MAX_DIM, maxTextureDimension2D));
}

/** settings.rs:20. */
export type MoireGeneratorType = 'Linear' | 'Radial';

/** settings.rs:49. Six variants; the shader selects on the index below. */
export type MoireInterferenceMode =
    | 'Replace'
    | 'Add'
    | 'Multiply'
    | 'Overlay'
    | 'Mask'
    | 'Modulate';

export const MOIRE_GENERATOR_TYPES: readonly MoireGeneratorType[] = ['Linear', 'Radial'];

export const MOIRE_INTERFERENCE_MODES: readonly MoireInterferenceMode[] = [
    'Replace',
    'Add',
    'Multiply',
    'Overlay',
    'Mask',
    'Modulate',
];

/** compute.wgsl:12 — `generator_type` is a float discriminant, not an enum. */
export const GENERATOR_TYPE_CODE: Record<MoireGeneratorType, number> = {
    Linear: 0,
    Radial: 1,
};

/** compute.wgsl:32 — the order the `< 0.5 / < 1.5 / ...` ladder tests. */
export const INTERFERENCE_MODE_CODE: Record<MoireInterferenceMode, number> = {
    Replace: 0,
    Add: 1,
    Multiply: 2,
    Overlay: 3,
    Mask: 4,
    Modulate: 5,
};

export interface MoireSettings {
    // Animation
    speed: number;

    // Moiré pattern generation
    generator_type: MoireGeneratorType;

    // Moiré pattern parameters
    base_freq: number;
    moire_amount: number;
    moire_rotation: number;
    moire_scale: number;
    moire_interference: number;

    // Third grid
    moire_rotation3: number;
    moire_scale3: number;
    moire_weight3: number;

    // Radial generator
    radial_swirl_strength: number;
    radial_starburst_count: number;
    radial_center_brightness: number;

    // Advection flow
    advect_strength: number;
    advect_speed: number;
    curl: number;
    decay: number;

    // Image input
    image_mode_enabled: boolean;
    image_fit_mode: ImageFitMode;
    image_mirror_horizontal: boolean;
    image_mirror_vertical: boolean;
    image_invert_tone: boolean;
    image_interference_mode: MoireInterferenceMode;
}

/** Exactly `impl Default for Settings` (settings.rs:123). */
export function defaultMoireSettings(): MoireSettings {
    return {
        speed: 0.1,
        generator_type: 'Linear',
        base_freq: 20.0,
        moire_amount: 0.5,
        moire_rotation: 0.2,
        moire_scale: 1.05,
        moire_interference: 0.5,
        moire_rotation3: -0.1,
        moire_scale3: 1.1,
        moire_weight3: 0.3,
        radial_swirl_strength: 0.5,
        radial_starburst_count: 16.0,
        radial_center_brightness: 1.0,
        advect_strength: 0.6,
        advect_speed: 1.5,
        curl: 0.8,
        decay: 0.98,
        image_mode_enabled: false,
        image_fit_mode: 'Fit V',
        image_mirror_horizontal: false,
        image_mirror_vertical: false,
        image_invert_tone: true,
        image_interference_mode: 'Modulate',
    };
}

/** Every numeric key, in the order `Params` declares them (simulation.rs:38). */
const NUMERIC_KEYS = [
    'speed',
    'base_freq',
    'moire_amount',
    'moire_rotation',
    'moire_scale',
    'moire_interference',
    'moire_rotation3',
    'moire_scale3',
    'moire_weight3',
    'radial_swirl_strength',
    'radial_starburst_count',
    'radial_center_brightness',
    'advect_strength',
    'advect_speed',
    'curl',
    'decay',
] as const;

const BOOLEAN_KEYS = [
    'image_mode_enabled',
    'image_mirror_horizontal',
    'image_mirror_vertical',
    'image_invert_tone',
] as const;

type NumericKey = (typeof NUMERIC_KEYS)[number];
type BooleanKey = (typeof BOOLEAN_KEYS)[number];

const NUMERIC_KEY_SET: ReadonlySet<string> = new Set<string>(NUMERIC_KEYS);
const BOOLEAN_KEY_SET: ReadonlySet<string> = new Set<string>(BOOLEAN_KEYS);

/**
 * `serde_json::Value::as_f64()` — Some only for a JSON *number*.
 *
 * No coercion, deliberately: `Number(null)` is 0 and `Number('')` is 0, so a
 * coercing version would quietly accept a null the Rust rejected and write a
 * plausible-looking zero into the uniform. Non-finite is folded in because JSON
 * cannot express NaN or Infinity, but a JS caller can.
 */
function asFiniteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * `value.as_f64().unwrap() as f32` (simulation.rs:1331), minus the panic.
 *
 * The Rust unwrapped, so a bad type took the whole app down. Here it rejects,
 * which is what `sync.ts` needs to roll its optimistic update back.
 */
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
 * `FromStr for MoireGeneratorType` (settings.rs:31) — case-insensitive, and an
 * unrecognised name is an error rather than a silent fallback.
 */
export function parseGeneratorType(value: unknown): MoireGeneratorType {
    const text = String(value ?? '')
        .trim()
        .toLowerCase();
    if (text === 'linear') return 'Linear';
    if (text === 'radial') return 'Radial';
    throw new Error(
        `Invalid MoireGeneratorType: '${String(value)}'. Expected 'linear' or 'radial'`
    );
}

/** `FromStr for ImageInterferenceMode` (settings.rs:64). */
export function parseInterferenceMode(value: unknown): MoireInterferenceMode {
    const text = String(value ?? '')
        .trim()
        .toLowerCase();
    const found = MOIRE_INTERFERENCE_MODES.find((mode) => mode.toLowerCase() === text);
    if (found) return found;
    throw new Error(
        `Invalid ImageInterferenceMode: '${String(value)}'. Expected ` +
            `'replace', 'add', 'multiply', 'overlay', 'mask', or 'modulate'`
    );
}

/** `FromStr for ImageFitMode` (shared/types.rs:40), reusing the shared parser. */
export function parseFitMode(value: unknown): ImageFitMode {
    const parsed = parseImageFitMode(String(value ?? ''));
    if (!parsed) throw new Error(`Invalid ImageFitMode: '${String(value)}'`);
    return parsed;
}

/**
 * What the caller has to do on the GPU after a setting changed.
 *
 * Only the fit mode needs the image re-processed: the Rust also reprocesses on
 * every mirror and tone change (simulation.rs:1374-1387) even though
 * `sample_image_intensity` applies both in the shader, so those rebuilds are
 * pure waste and are not reproduced.
 */
export type MoireSettingEffect = 'none' | 'refit-image';

/** Port of `update_setting` (simulation.rs:1323). Mutates in place. */
export function updateMoireSetting(
    settings: MoireSettings,
    name: string,
    value: unknown
): MoireSettingEffect {
    if (NUMERIC_KEY_SET.has(name)) {
        // simulation.rs:1360 uses `unwrap_or(0.99)` for decay alone, so a
        // malformed value snaps to 0.99 rather than rejecting. Mirrored,
        // inconsistent with the 0.98 default though it is.
        if (name === 'decay') {
            settings.decay = asFiniteNumber(value) ?? 0.99;
            return 'none';
        }
        settings[name as NumericKey] = asFloat(value, name);
        return 'none';
    }

    if (BOOLEAN_KEY_SET.has(name)) {
        settings[name as BooleanKey] = asBool(value);
        return 'none';
    }

    switch (name) {
        case 'generator_type':
            settings.generator_type = parseGeneratorType(value);
            return 'none';
        case 'image_interference_mode':
            settings.image_interference_mode = parseInterferenceMode(value);
            return 'none';
        case 'image_fit_mode':
            settings.image_fit_mode = parseFitMode(value);
            return 'refit-image';
        default:
            throw new Error(`Unknown setting: ${name}`);
    }
}

/**
 * Coerce an arbitrary document into a complete `MoireSettings`.
 *
 * `apply_settings` deserialized straight into the struct, so serde rejected a
 * partial document outright. A partial one is normal here: `PresetStore` stores
 * built-ins as overrides only, exactly as `Settings { .., ..Settings::default() }`
 * wrote them, so anything absent comes from the defaults — which is the same
 * value the Rust preset would have carried.
 */
export function normalizeMoireSettings(input: unknown): MoireSettings {
    const settings = defaultMoireSettings();
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return settings;
    }

    for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
        try {
            updateMoireSetting(settings, name, value);
        } catch {
            // A preset from a newer build, or a hand-edited localStorage entry.
            // Keeping the default for that one field beats refusing the preset.
            console.warn(`[moire] ignoring unusable setting "${name}"`);
        }
    }
    return settings;
}

/**
 * Port of `randomize_settings` (simulation.rs:1286).
 *
 * Only the eight moiré-pattern parameters move; speed, the radial group, the
 * advection group and every image flag are left alone, which is what makes
 * "Randomize" usable rather than a reset button.
 *
 * `rng` is injected purely so the ranges are testable without sampling.
 */
export function randomizeMoireSettings(
    settings: MoireSettings,
    rng: () => number = Math.random
): void {
    settings.base_freq = 5.0 + rng() * 45.0;
    settings.moire_amount = rng();
    settings.moire_rotation = rng() * 3.14159;
    settings.moire_scale = 0.8 + rng() * 0.4;
    settings.moire_interference = rng();
    settings.moire_rotation3 = (rng() - 0.5) * 3.14159;
    settings.moire_scale3 = 0.8 + rng() * 0.4;
    settings.moire_weight3 = rng();
}

/** The 26 floats of `struct Params` (compute.wgsl:8 / simulation.rs:38). */
export const MOIRE_PARAM_FLOATS = 26;

export interface MoireParamInputs {
    time: number;
    width: number;
    height: number;
    /** True once an image texture holds real content. */
    imageLoaded: boolean;
    /**
     * Whether the LUT already in the buffer is a reversed one.
     *
     * Uploaded as 0 regardless — see `MoireSimulation.updateColorScheme`. Kept
     * in the signature so the packing stays a total function of the state it
     * documents rather than quietly ignoring an input.
     */
    colorSchemeReversed: boolean;
}

/**
 * Pack the uniform. Pure, so the field order can be pinned by a unit test —
 * a misordered uniform is invisible until the picture looks subtly wrong.
 */
export function packMoireParams(
    settings: MoireSettings,
    inputs: MoireParamInputs,
    out: Float32Array = new Float32Array(MOIRE_PARAM_FLOATS)
): Float32Array {
    out[0] = inputs.time;
    out[1] = inputs.width;
    out[2] = inputs.height;
    out[3] = GENERATOR_TYPE_CODE[settings.generator_type];
    out[4] = settings.base_freq;
    out[5] = settings.moire_amount;
    out[6] = settings.moire_rotation;
    out[7] = settings.moire_scale;
    out[8] = settings.moire_interference;
    out[9] = settings.moire_rotation3;
    out[10] = settings.moire_scale3;
    out[11] = settings.moire_weight3;
    out[12] = settings.radial_swirl_strength;
    out[13] = settings.radial_starburst_count;
    out[14] = settings.radial_center_brightness;
    // Always 0: the LUT handed to updateColorScheme has already been reversed
    // by ColorSchemeManager, and the shader's own inversion would cancel it.
    out[15] = 0;
    out[16] = settings.advect_strength;
    out[17] = settings.advect_speed;
    out[18] = settings.curl;
    out[19] = settings.decay;
    out[20] = inputs.imageLoaded ? 1 : 0;
    out[21] = settings.image_mode_enabled ? 1 : 0;
    out[22] = INTERFERENCE_MODE_CODE[settings.image_interference_mode];
    out[23] = settings.image_mirror_horizontal ? 1 : 0;
    out[24] = settings.image_mirror_vertical ? 1 : 0;
    out[25] = settings.image_invert_tone ? 1 : 0;
    return out;
}
