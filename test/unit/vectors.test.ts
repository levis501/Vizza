import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    BACKGROUND_COLOR_MODES,
    NOISE_TYPES,
    NOISE_TYPE_CODE,
    NOISE_TYPE_LABELS,
    NOISE_TYPE_OCTAVES,
    VECTORS_MAX_LINES,
    VECTORS_MIN_SPACING,
    VECTORS_VIEW_HALF_SPAN,
    VECTOR_FIELD_TYPES,
    defaultVectorsSettings,
    defaultVectorsState,
    normalizeVectorsSettings,
    parseBackgroundColorMode,
    parseFitMode,
    parseNoiseType,
    parseVectorFieldType,
    randomizeVectorsSettings,
    updateVectorsSetting,
    updateVectorsState,
    vectorsClearColor,
    vectorsGridExtent,
    vectorsGridSpacing,
    vectorsLineQuad,
    vectorsLineSegment,
    vectorsQuadIndices,
    vectorsStateDocument,
    type VectorsSettings,
} from '../../src/lib/engine/sims/vectors/settings';
import { VECTORS_BUILTIN_PRESETS } from '../../src/lib/engine/presets/builtins/vectors';
import { getBuiltinPresets } from '../../src/lib/engine/presets/builtins';
import { PresetStore, type KeyValueStore } from '../../src/lib/engine/presets/PresetStore';

const ROOT = resolve(__dirname, '../..');
const RUST = join(ROOT, 'src-tauri/src/simulations/vectors');

function fakeStorage(): KeyValueStore {
    const map = new Map<string, string>();
    return {
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => void map.set(key, value),
        removeItem: (key) => void map.delete(key),
    };
}

/** A deterministic `rng()` that walks a fixed list and then repeats the last. */
function sequence(values: number[]): () => number {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
}

describe('vectors settings defaults', () => {
    /**
     * Transcribed field by field from `impl Default for Settings`
     * (src-tauri/src/simulations/vectors/settings.rs:31). Written out in full
     * rather than spot-checked: the single built-in preset is an *empty*
     * override set, so these thirteen values are literally what "Default" means
     * for this simulation.
     */
    it('matches impl Default for Settings exactly', () => {
        expect(defaultVectorsSettings()).toEqual({
            vector_field_type: 'Noise',
            noise_type: 'OpenSimplex',
            noise_seed: 0,
            noise_scale: 5.0,
            noise_dt_multiplier: 1.0,
            density: 0.02,
            line_length: 0.03,
            line_width: 0.001,
            background_color_mode: 'Black',
            image_fit_mode: 'Stretch',
            image_mirror_horizontal: false,
            image_mirror_vertical: false,
            image_invert_tone: false,
        });
    });

    it('hands out a fresh object each time', () => {
        const first = defaultVectorsSettings();
        first.density = 999;
        expect(defaultVectorsSettings().density).toBe(0.02);
    });

    /** `impl Default for State` (state.rs:15). */
    it('matches impl Default for State exactly', () => {
        expect(defaultVectorsState()).toEqual({
            current_color_scheme: 'MATPLOTLIB_viridis',
            color_scheme_reversed: false,
            gui_visible: true,
            simulation_time: 0,
            is_running: true,
            last_camera_x: 0,
            last_camera_y: 0,
            last_camera_zoom: 1,
            last_noise_scale: 5.0,
        });
    });

    /**
     * The cache the dirty check compares against starts at the *default*
     * noise scale, not at zero — otherwise the very first `geometry_dirty` call
     * would report a scale change that never happened.
     */
    it('seeds the geometry cache with the default noise scale', () => {
        expect(defaultVectorsState().last_noise_scale).toBe(defaultVectorsSettings().noise_scale);
    });

    it('keeps the geometry cache out of the state document', () => {
        const doc = vectorsStateDocument(defaultVectorsState());
        expect(Object.keys(doc).sort()).toEqual([
            'color_scheme_reversed',
            'current_color_scheme',
            'gui_visible',
            'is_running',
            'simulation_time',
        ]);
    });
});

describe('vectors enums', () => {
    it('lists the variants in declaration order', () => {
        expect(VECTOR_FIELD_TYPES).toEqual(['Noise', 'Image']);
        expect(NOISE_TYPES).toEqual([
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
        ]);
    });

    /**
     * The eleven variants, read straight out of `enum NoiseType` in the Rust.
     *
     * A regex over the source rather than a second hardcoded list: this is the
     * assertion that catches an upstream variant being added or renamed, which
     * is otherwise invisible until a `_ =>` fallback silently eats it.
     */
    it('agrees with the Rust enum declaration', () => {
        const source = readFileSync(join(RUST, 'settings.rs'), 'utf8');
        const body = source.match(/pub enum NoiseType \{([^}]*)\}/)![1];
        const variants = body
            .split(',')
            .map((line) => line.trim())
            .filter(Boolean);
        expect(variants).toEqual([...NOISE_TYPES]);
    });

    /**
     * `update_setting`'s `"noise_type"` arm (simulation.rs:723) matches the
     * serde spellings, and `VectorsMode.svelte` lists them — so unlike
     * Gray-Scott's mask enums, this one round-trips on the desktop build and the
     * serde spelling is what stays canonical here.
     */
    it('parses every serde spelling to itself', () => {
        for (const type of NOISE_TYPES) {
            expect(parseNoiseType(type)).toBe(type);
        }
    });

    /**
     * The `Display` impl (settings.rs:79) disagrees with serde for five
     * variants. It has no caller in the Rust, but a hand-written preset or a
     * future label-showing UI could produce these, so they parse too.
     */
    it('parses every Display spelling as well', () => {
        expect(NOISE_TYPE_LABELS.Fbm).toBe('FBM');
        expect(NOISE_TYPE_LABELS.FBMBillow).toBe('FBM Billow');
        expect(NOISE_TYPE_LABELS.FBMClouds).toBe('FBM Clouds');
        expect(NOISE_TYPE_LABELS.FBMRidged).toBe('FBM Ridged');
        expect(NOISE_TYPE_LABELS.RidgedMulti).toBe('Ridged Multi');

        for (const type of NOISE_TYPES) {
            expect(parseNoiseType(NOISE_TYPE_LABELS[type])).toBe(type);
        }
    });

    it('parses lowercase, underscored and spaced spellings', () => {
        expect(parseNoiseType('opensimplex')).toBe('OpenSimplex');
        expect(parseNoiseType('fbm')).toBe('Fbm');
        expect(parseNoiseType('fbm_billow')).toBe('FBMBillow');
        expect(parseNoiseType('ridged multi')).toBe('RidgedMulti');
        expect(parseNoiseType('  Checkerboard  ')).toBe('Checkerboard');
    });

    /**
     * The Rust's arm ends `_ => self.settings.noise_type`, so a misspelling
     * silently keeps the old value and reports success. Throwing is what lets
     * sync.ts roll the optimistic update back.
     */
    it('throws rather than silently keeping the previous noise type', () => {
        expect(() => parseNoiseType('FBM-Billowy')).toThrow(/Invalid NoiseType/);
        expect(() => parseNoiseType('')).toThrow(/Invalid NoiseType/);
        expect(() => parseNoiseType(null)).toThrow(/Invalid NoiseType/);
    });

    it('parses VectorFieldType in both spellings the Rust accepts', () => {
        expect(parseVectorFieldType('Noise')).toBe('Noise');
        expect(parseVectorFieldType('noise')).toBe('Noise');
        expect(parseVectorFieldType('Image')).toBe('Image');
        expect(parseVectorFieldType('image')).toBe('Image');
        expect(() => parseVectorFieldType('Webcam')).toThrow(/Invalid VectorFieldType/);
    });

    /**
     * `BackgroundColorMode::ColorScheme` is `#[serde(rename = "Color Scheme")]`
     * (shared/types.rs:72), so the serde spelling has a space in it and matches
     * the `<Selector>` option list — which is why this enum, unlike Gray-Scott's
     * masks, never had a round-trip problem.
     */
    it('parses BackgroundColorMode including the renamed variant', () => {
        expect(BACKGROUND_COLOR_MODES).toEqual(['Black', 'White', 'Gray18', 'Color Scheme']);
        for (const mode of BACKGROUND_COLOR_MODES) {
            expect(parseBackgroundColorMode(mode)).toBe(mode);
        }
        expect(parseBackgroundColorMode('color_scheme')).toBe('Color Scheme');
        expect(parseBackgroundColorMode('colorscheme')).toBe('Color Scheme');
        expect(() => parseBackgroundColorMode('Grey18')).toThrow(/Invalid BackgroundColorMode/);
    });

    /** The shared parser, reused rather than redeclared. */
    it('parses ImageFitMode across its spellings', () => {
        expect(parseFitMode('Stretch')).toBe('Stretch');
        expect(parseFitMode('Fit H')).toBe('Fit H');
        expect(parseFitMode('fith')).toBe('Fit H');
        expect(parseFitMode('fit v')).toBe('Fit V');
        expect(() => parseFitMode('Cover')).toThrow(/Invalid ImageFitMode/);
    });
});

describe('NOISE_TYPE_CODE', () => {
    /**
     * The bridge to `shaders/noise.wgsl`, which switches on a u32. Nothing in
     * the Rust assigns these numbers — the CPU matches the enum straight onto
     * `noise` crate generators — so declaration order is the contract, and this
     * test is what stops a reordering of the union silently renumbering the
     * shader's switch arms.
     */
    it('is the declaration order, 0..10', () => {
        expect(NOISE_TYPES.map((type) => NOISE_TYPE_CODE[type])).toEqual([
            0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
        ]);
    });

    it('covers every variant exactly once', () => {
        const codes = Object.values(NOISE_TYPE_CODE);
        expect(Object.keys(NOISE_TYPE_CODE).sort()).toEqual([...NOISE_TYPES].sort());
        expect(new Set(codes).size).toBe(NOISE_TYPES.length);
    });

    /**
     * The other half of the bridge.
     *
     * `shaders/noise.wgsl` switches on this code, so the table and the shader's
     * `case` arms are one contract split across two files with nothing but
     * convention holding them together. Reading the WGSL text is what turns that
     * into an assertion — the same technique M4 used to pin `MASK_TARGET_CODE`
     * against `reaction_diffusion.wgsl`.
     */
    it('matches the switch arms in noise.wgsl', () => {
        const wgsl = readFileSync(join(RUST, 'shaders/noise.wgsl'), 'utf8');
        const dispatch = wgsl.slice(wgsl.indexOf('fn noise_sample_signed'));
        const arms = [...dispatch.matchAll(/case (\d+)u: \{\s*\n\s*return (\w+)\(/g)];

        expect(arms.map((m) => Number(m[1]))).toEqual(
            NOISE_TYPES.map((type) => NOISE_TYPE_CODE[type])
        );

        // The generator family each arm calls, which is what the octave table
        // above only implies.
        expect(arms.map((m) => m[2])).toEqual([
            'noise_open_simplex',
            'noise_worley',
            'noise_value_3d',
            'noise_fbm',
            'noise_billow',
            'noise_fbm',
            'noise_ridged',
            'noise_billow',
            'noise_ridged',
            'noise_cylinders',
            'noise_checkerboard',
        ]);
    });

    it('agrees with the octave constants noise.wgsl declares', () => {
        const wgsl = readFileSync(join(RUST, 'shaders/noise.wgsl'), 'utf8');
        const declared = new Map(
            [...wgsl.matchAll(/^const NOISE_OCTAVES_(\w+): u32 = (\d+)u;$/gm)].map((m) => [
                m[1],
                Number(m[2]),
            ])
        );
        // The five multi-octave variants, by the shader's SCREAMING_SNAKE name.
        expect(declared.get('FBM')).toBe(NOISE_TYPE_OCTAVES.Fbm);
        expect(declared.get('FBM_BILLOW')).toBe(NOISE_TYPE_OCTAVES.FBMBillow);
        expect(declared.get('FBM_CLOUDS')).toBe(NOISE_TYPE_OCTAVES.FBMClouds);
        expect(declared.get('FBM_RIDGED')).toBe(NOISE_TYPE_OCTAVES.FBMRidged);
        expect(declared.get('BILLOW')).toBe(NOISE_TYPE_OCTAVES.Billow);
        expect(declared.get('RIDGED_MULTI')).toBe(NOISE_TYPE_OCTAVES.RidgedMulti);
    });

    /**
     * `randomize_settings` (simulation.rs:891) picks `rng.random_range(0..11)`
     * and maps 0..9 onto the variants in declaration order with `_ =>
     * Checkerboard` last, so the Rust already indexes them this way.
     */
    it('matches the order randomize_settings indexes', () => {
        const source = readFileSync(join(RUST, 'simulation.rs'), 'utf8');
        const arms = [...source.matchAll(/^\s+\d+ => super::settings::NoiseType::(\w+),$/gm)].map(
            (m) => m[1]
        );
        // Ten numbered arms plus the `_ =>` catch-all for Checkerboard.
        expect(arms).toEqual(NOISE_TYPES.slice(0, 10));
        expect(source).toMatch(/_ => super::settings::NoiseType::Checkerboard,/);
    });

    /**
     * The octave counts are the *only* thing separating several of these
     * variants — Fbm, FBMClouds and Billow/FBMBillow are the same generator at
     * different depths — so a shader that ignores them renders eleven names as
     * six fields.
     */
    it('carries the octave count each generator is built with', () => {
        expect(NOISE_TYPE_OCTAVES).toEqual({
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
        });
    });

    it('reads its octave counts off noise_helper.rs', () => {
        const source = readFileSync(join(RUST, 'noise_helper.rs'), 'utf8');
        for (const [type, octaves] of Object.entries(NOISE_TYPE_OCTAVES)) {
            if (octaves === 1) continue;
            const at = source.indexOf(`NoiseType::${type} =>`);
            expect(at, `no arm for ${type}`).toBeGreaterThan(-1);
            // The arm is a few lines of builder calls; the next `set_octaves`
            // after it is its own.
            const arm = source.slice(at, at + 200);
            expect(arm).toContain(`.set_octaves(${octaves})`);
        }
    });
});

describe('updateVectorsSetting', () => {
    /**
     * Every name `VectorsMode.svelte` sends has a match arm in the Rust — unlike
     * Gray-Scott, where three did not and silently reverted on the next sync.
     * This is that check, done against the Rust source rather than by eye.
     */
    it('accepts exactly the names the Rust matches', () => {
        const source = readFileSync(join(RUST, 'simulation.rs'), 'utf8');
        const block = source.slice(
            source.indexOf('match setting_name {'),
            source.indexOf('fn update_state')
        );
        const names = [...block.matchAll(/^\s+"([a-z_]+)" => \{$/gm)].map((m) => m[1]);
        expect(names.length).toBe(13);

        const settings = defaultVectorsSettings();
        for (const name of names) {
            // Every one of the thirteen must be a name this port also accepts.
            expect(() => updateVectorsSetting(settings, name, probeFor(name))).not.toThrow();
        }
    });

    /** A value of the right JSON type for each setting name. */
    function probeFor(name: string): unknown {
        if (name === 'vector_field_type') return 'Image';
        if (name === 'noise_type') return 'Worley';
        if (name === 'background_color_mode') return 'White';
        if (name === 'image_fit_mode') return 'Fit V';
        if (name.startsWith('image_')) return true;
        if (name === 'noise_seed') return 7;
        return 0.5;
    }

    it('writes each field and reports the effect it needs', () => {
        const settings = defaultVectorsSettings();

        expect(updateVectorsSetting(settings, 'density', 0.05)).toBe('geometry');
        expect(settings.density).toBe(0.05);

        expect(updateVectorsSetting(settings, 'noise_type', 'RidgedMulti')).toBe('geometry');
        expect(settings.noise_type).toBe('RidgedMulti');

        expect(updateVectorsSetting(settings, 'vector_field_type', 'Image')).toBe('geometry');
        expect(settings.vector_field_type).toBe('Image');

        expect(updateVectorsSetting(settings, 'image_invert_tone', true)).toBe('refit-image');
        expect(settings.image_invert_tone).toBe(true);

        expect(updateVectorsSetting(settings, 'image_fit_mode', 'Fit H')).toBe('refit-image');
        expect(settings.image_fit_mode).toBe('Fit H');

        // The one deliberate divergence: the Rust rebuilds the entire vertex
        // and index buffer to change a clear colour.
        expect(updateVectorsSetting(settings, 'background_color_mode', 'Gray18')).toBe(
            'clear-color'
        );
        expect(settings.background_color_mode).toBe('Gray18');
    });

    it('rejects a non-number where the Rust wanted as_f64', () => {
        const settings = defaultVectorsSettings();
        for (const bad of [null, '0.5', undefined, NaN, Infinity, {}]) {
            expect(() => updateVectorsSetting(settings, 'noise_scale', bad)).toThrow(
                /finite number/
            );
        }
        expect(settings.noise_scale).toBe(5.0);
    });

    /**
     * `value.as_u64()` then `as u32` — a wrapping truncation, and reachable:
     * `VectorsMode.svelte` puts the drag box maximum at 4294967295. The seed is
     * meaningless arithmetically, so wrapping is faithful where a clamp would
     * not be.
     */
    it('wraps noise_seed into u32 and rejects what as_u64 would', () => {
        const settings = defaultVectorsSettings();

        updateVectorsSetting(settings, 'noise_seed', 4294967295);
        expect(settings.noise_seed).toBe(4294967295);

        updateVectorsSetting(settings, 'noise_seed', 4294967296);
        expect(settings.noise_seed).toBe(0);

        for (const bad of [-1, 1.5, '7', null]) {
            expect(() => updateVectorsSetting(settings, 'noise_seed', bad)).toThrow(
                /non-negative integer/
            );
        }
    });

    it('treats anything but true as false, as as_bool did', () => {
        const settings = defaultVectorsSettings();
        updateVectorsSetting(settings, 'image_mirror_horizontal', true);
        expect(settings.image_mirror_horizontal).toBe(true);
        updateVectorsSetting(settings, 'image_mirror_horizontal', 'yes');
        expect(settings.image_mirror_horizontal).toBe(false);
    });

    it('throws on a name the Rust would have ignored', () => {
        const settings = defaultVectorsSettings();
        expect(() => updateVectorsSetting(settings, 'noise_octaves', 4)).toThrow(
            /Unknown setting: noise_octaves/
        );
    });

    /** `update_state` matches exactly two names (simulation.rs:792). */
    it('updates the two state fields and rejects the rest', () => {
        const state = defaultVectorsState();
        expect(updateVectorsState(state, 'current_color_scheme', 'ZELDA_Glass')).toBe('reload-lut');
        expect(state.current_color_scheme).toBe('ZELDA_Glass');
        expect(updateVectorsState(state, 'color_scheme_reversed', true)).toBe('reload-lut');
        expect(state.color_scheme_reversed).toBe(true);
        expect(() => updateVectorsState(state, 'gui_visible', false)).toThrow(
            /Unknown state: gui_visible/
        );
    });
});

describe('normalizeVectorsSettings', () => {
    it('fills every absent field from the defaults', () => {
        expect(normalizeVectorsSettings({})).toEqual(defaultVectorsSettings());
        expect(normalizeVectorsSettings({ density: 0.05 })).toEqual({
            ...defaultVectorsSettings(),
            density: 0.05,
        });
    });

    it('survives garbage input entirely', () => {
        for (const input of [null, undefined, 42, 'nonsense', []]) {
            expect(normalizeVectorsSettings(input)).toEqual(defaultVectorsSettings());
        }
    });

    /**
     * The forward-compatible merge. `#[serde(default)]` on the last five fields
     * is what let the desktop app load a preset written before they existed;
     * here *every* field has that guarantee, and an unknown field from a newer
     * build is dropped with a warning rather than taking the whole preset down.
     */
    it('is forward compatible in both directions', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            // A pre-image-support document: the eight required fields only.
            const old = {
                vector_field_type: 'Noise',
                noise_type: 'Worley',
                noise_seed: 12,
                noise_scale: 3,
                noise_dt_multiplier: 2,
                density: 0.04,
                line_length: 0.06,
                line_width: 0.002,
            };
            expect(normalizeVectorsSettings(old)).toEqual({
                ...defaultVectorsSettings(),
                ...old,
            });
            expect(warn).not.toHaveBeenCalled();

            // A document from a newer build.
            const future = normalizeVectorsSettings({
                density: 0.03,
                noise_warp_strength: 4,
                noise_type: 'Perlin',
            });
            expect(future.density).toBe(0.03);
            expect(future.noise_type).toBe('OpenSimplex');
            expect(warn).toHaveBeenCalledTimes(2);
        } finally {
            warn.mockRestore();
        }
    });
});

describe('randomizeVectorsSettings', () => {
    /**
     * `randomize_settings` (simulation.rs:884) moves three of thirteen fields.
     * The `noise_scale` range is transcribed, not reconciled — see the note on
     * the function: 0.001..0.1 is two to four orders of magnitude below the
     * default of 5.0, which makes Randomize reliably produce a near-uniform
     * comb. Reproduced because no second source says what it was meant to be;
     * this assertion is what makes changing it a deliberate act.
     */
    it('keeps the Rust ranges, including the suspicious noise_scale one', () => {
        const low = defaultVectorsSettings();
        randomizeVectorsSettings(low, () => 0);
        expect(low.noise_type).toBe('OpenSimplex');
        expect(low.noise_seed).toBe(0);
        expect(low.noise_scale).toBeCloseTo(0.001, 10);

        const high = defaultVectorsSettings();
        randomizeVectorsSettings(high, () => 1 - Number.EPSILON / 2);
        expect(high.noise_type).toBe('Checkerboard');
        expect(high.noise_seed).toBeLessThanOrEqual(4294967295);
        expect(high.noise_scale).toBeLessThan(0.1);
        expect(high.noise_scale).toBeGreaterThan(0.099);

        // Well below the default it replaces, every time.
        expect(high.noise_scale).toBeLessThan(defaultVectorsSettings().noise_scale);
    });

    it('leaves the other ten fields alone', () => {
        const settings = defaultVectorsSettings();
        randomizeVectorsSettings(settings, sequence([0.5, 0.25, 0.75]));
        const untouched: Array<keyof VectorsSettings> = [
            'vector_field_type',
            'noise_dt_multiplier',
            'density',
            'line_length',
            'line_width',
            'background_color_mode',
            'image_fit_mode',
            'image_mirror_horizontal',
            'image_mirror_vertical',
            'image_invert_tone',
        ];
        const defaults = defaultVectorsSettings();
        for (const key of untouched) {
            expect(settings[key]).toEqual(defaults[key]);
        }
    });

    it('only ever produces a declared variant', () => {
        for (let i = 0; i < 200; i++) {
            const settings = defaultVectorsSettings();
            randomizeVectorsSettings(settings);
            expect(NOISE_TYPES).toContain(settings.noise_type);
            expect(Number.isInteger(settings.noise_seed)).toBe(true);
            expect(settings.noise_seed).toBeGreaterThanOrEqual(0);
            expect(settings.noise_seed).toBeLessThanOrEqual(4294967295);
        }
    });
});

describe('clear colour', () => {
    /** `get_clear_color` (simulation.rs:367). */
    it('matches the four arms', () => {
        expect(vectorsClearColor('Black')).toEqual([0, 0, 0, 1]);
        expect(vectorsClearColor('White')).toEqual([1, 1, 1, 1]);
        expect(vectorsClearColor('Gray18')).toEqual([0.18, 0.18, 0.18, 1]);
        expect(vectorsClearColor('Color Scheme', [0.2, 0.4, 0.6])).toEqual([0.2, 0.4, 0.6, 1]);
    });

    it('falls back to black when the scheme has no first colour', () => {
        expect(vectorsClearColor('Color Scheme')).toEqual([0, 0, 0, 1]);
        expect(vectorsClearColor('Color Scheme', null)).toEqual([0, 0, 0, 1]);
        expect(vectorsClearColor('Color Scheme', [])).toEqual([0, 0, 0, 1]);
    });
});

describe('grid geometry', () => {
    it('uses the Rust half-span and spacing floor', () => {
        expect(VECTORS_VIEW_HALF_SPAN).toBe(1.2);
        expect(VECTORS_MIN_SPACING).toBe(0.001);
        expect(vectorsGridSpacing(0.02)).toBe(0.02);
        expect(vectorsGridSpacing(0)).toBe(0.001);
        expect(vectorsGridSpacing(-5)).toBe(0.001);
    });

    /**
     * The Rust reads `let half_span = 1.2 / zoom;` and floors the spacing at
     * 0.001; both are asserted against the source so a change upstream shows up
     * here rather than as a differently-sized field.
     */
    it('reads the same constants the Rust does', () => {
        const source = readFileSync(join(RUST, 'simulation.rs'), 'utf8');
        expect(source).toContain('let half_span = 1.2 / zoom;');
        expect(source).toContain('let spacing = density.max(0.001);');
    });

    it('covers the view at the default density and zoom', () => {
        const grid = vectorsGridExtent(0, 0, 1, 0.02);
        expect(grid.spacing).toBe(0.02);
        expect(grid.minX).toBeCloseTo(-1.2, 10);
        expect(grid.minY).toBeCloseTo(-1.2, 10);
        // floor(2.4 / 0.02) + 1
        expect(grid.countX).toBe(121);
        expect(grid.count).toBe(121 * 121);
        expect(grid.clamped).toBe(false);
    });

    it('follows the camera and the zoom', () => {
        const grid = vectorsGridExtent(3, -2, 2, 0.02);
        expect(grid.minX).toBeCloseTo(3 - 0.6, 10);
        expect(grid.minY).toBeCloseTo(-2 - 0.6, 10);
        expect(grid.countX).toBe(61);
    });

    /**
     * The cap that is not in the Rust.
     *
     * `VectorsMode.svelte` puts the density minimum at exactly 0.001, which at
     * zoom 1 is a 2401² grid: 5.77 M lines, a 277 MB vertex buffer and a 138 MB
     * index buffer, against a 256 MiB `maxBufferSize` on the reference device —
     * a guaranteed allocation failure, rebuilt every frame. Clamping raises the
     * *spacing*, so the field still covers the whole view.
     */
    it('coarsens rather than truncating when the budget is exceeded', () => {
        const grid = vectorsGridExtent(0, 0, 1, 0.001);
        expect(grid.clamped).toBe(true);
        expect(grid.count).toBeLessThanOrEqual(VECTORS_MAX_LINES);
        expect(grid.spacing).toBeGreaterThan(0.001);
        // Still the full view, just coarser.
        expect(grid.minX).toBeCloseTo(-1.2, 10);
        expect(grid.minX + (grid.countX - 1) * grid.spacing).toBeCloseTo(1.2, 6);
    });

    it('never exceeds the budget at any density or zoom', () => {
        for (const zoom of [0.05, 0.5, 1, 4, 20]) {
            for (const density of [0.001, 0.002, 0.01, 0.02, 0.1]) {
                const grid = vectorsGridExtent(0, 0, zoom, density);
                expect(grid.count).toBeLessThanOrEqual(VECTORS_MAX_LINES);
            }
        }
    });

    /** simulation.rs:312-315 — angle is the full turn, length runs from half. */
    it('turns a sample into the same segment the Rust does', () => {
        const [x0, y0, x1, y1] = vectorsLineSegment(0.5, -0.25, 0, 0.03);
        expect(x0).toBe(0.5);
        expect(y0).toBe(-0.25);
        // value 0 -> angle 0, len 0.5 * line_length
        expect(x1).toBeCloseTo(0.5 + 0.015, 10);
        expect(y1).toBeCloseTo(-0.25, 10);

        // value 0.25 -> a quarter turn, length 0.625 * line_length
        const quarter = vectorsLineSegment(0, 0, 0.25, 0.04);
        expect(quarter[2]).toBeCloseTo(0, 10);
        expect(quarter[3]).toBeCloseTo(0.025, 10);

        // value 1 -> a full turn: same direction as 0, but the full length.
        const full = vectorsLineSegment(0, 0, 1, 0.03);
        expect(full[2]).toBeCloseTo(0.03, 10);
        expect(full[3]).toBeCloseTo(0, 10);
    });

    /** simulation.rs:222 — four vertices offset along the segment normal. */
    it('expands a segment into a quad of the right width', () => {
        const quad = vectorsLineQuad([0, 0, 1, 0], 0.75, 0.2);
        expect(quad).toHaveLength(12);
        // A horizontal segment: the normal is +y, so half the width each side.
        expect(quad.slice(0, 3)).toEqual([0, -0.1, 0.75]);
        expect(quad.slice(3, 6)).toEqual([0, 0.1, 0.75]);
        expect(quad.slice(6, 9)).toEqual([1, 0.1, 0.75]);
        expect(quad.slice(9, 12)).toEqual([1, -0.1, 0.75]);
    });

    it('survives a zero-length segment', () => {
        const quad = vectorsLineQuad([0.5, 0.5, 0.5, 0.5], 0, 0.01);
        expect(quad.every(Number.isFinite)).toBe(true);
    });

    it('emits two triangles per quad from its base index', () => {
        expect(vectorsQuadIndices(0)).toEqual([0, 1, 2, 0, 2, 3]);
        expect(vectorsQuadIndices(3)).toEqual([12, 13, 14, 12, 14, 15]);
    });
});

describe('vectors built-in presets', () => {
    /** mod.rs:12 — one entry, `Preset::new("Default", Settings::default())`. */
    it('is the single Default preset the Rust registers', () => {
        expect(VECTORS_BUILTIN_PRESETS).toEqual([{ name: 'Default', settings: {} }]);
        expect(getBuiltinPresets('vectors')).toEqual([{ name: 'Default', settings: {} }]);
    });

    it('reads back as Settings::default() through the store', () => {
        const store = new PresetStore(fakeStorage());
        expect(store.names('vectors')).toEqual(['Default']);
        const preset = store.get('vectors', 'Default')!;
        expect(normalizeVectorsSettings(preset.settings)).toEqual(defaultVectorsSettings());
    });

    /**
     * The empty override set is the point: "Default" must not pin any value, or
     * a change to `Settings::default()` would stop being reflected in it.
     */
    it('pins no values of its own', () => {
        expect(Object.keys(VECTORS_BUILTIN_PRESETS[0].settings)).toEqual([]);
    });

    it('round-trips a user preset alongside it', () => {
        const store = new PresetStore(fakeStorage());
        const settings = defaultVectorsSettings();
        settings.noise_type = 'FBMRidged';
        settings.density = 0.007;
        store.save('vectors', 'Ridges', settings as unknown as Record<string, unknown>);

        expect(store.names('vectors')).toContain('Ridges');
        expect(normalizeVectorsSettings(store.get('vectors', 'Ridges')!.settings)).toEqual(
            settings
        );
    });
});
