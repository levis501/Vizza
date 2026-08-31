import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    GENERATOR_TYPE_CODE,
    INTERFERENCE_MODE_CODE,
    MOIRE_INTERFERENCE_MODES,
    MOIRE_PARAM_FLOATS,
    defaultMoireSettings,
    normalizeMoireSettings,
    packMoireParams,
    parseFitMode,
    parseGeneratorType,
    parseInterferenceMode,
    randomizeMoireSettings,
    updateMoireSetting,
    MOIRE_MAX_DIM,
    moireTextureSize,
    type MoireSettings,
} from '../../src/lib/engine/sims/moire/settings';
import {
    MAX_TILES_PER_AXIS,
    calculateTileCount,
} from '../../src/lib/engine/render/InfiniteRenderer';
import { MOIRE_BUILTIN_PRESETS } from '../../src/lib/engine/presets/builtins/moire';
import { getBuiltinPresets } from '../../src/lib/engine/presets/builtins';
import { PresetStore, type KeyValueStore } from '../../src/lib/engine/presets/PresetStore';

const ROOT = resolve(__dirname, '../..');

function fakeStorage() {
    const map = new Map<string, string>();
    const store: KeyValueStore = {
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => void map.set(key, value),
        removeItem: (key) => void map.delete(key),
    };
    return store;
}

describe('moiré settings defaults', () => {
    /**
     * Transcribed field by field from `impl Default for Settings`
     * (src-tauri/src/simulations/moire/settings.rs:123). Written out in full
     * rather than spot-checked: these values are what every built-in preset is
     * merged over, so one wrong number silently changes all four of them.
     */
    it('matches impl Default for Settings exactly', () => {
        expect(defaultMoireSettings()).toEqual({
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
        });
    });

    it('hands out a fresh object each time', () => {
        const first = defaultMoireSettings();
        first.base_freq = 999;
        expect(defaultMoireSettings().base_freq).toBe(20.0);
    });
});

describe('moiré update_setting', () => {
    it('accepts every numeric setting MoireMode sends', () => {
        const settings = defaultMoireSettings();
        const numeric: Array<[keyof MoireSettings, number]> = [
            ['speed', 2.5],
            ['base_freq', 33],
            ['moire_amount', 0.75],
            ['moire_rotation', -1.25],
            ['moire_scale', 1.5],
            ['moire_interference', 0.25],
            ['moire_rotation3', 0.4],
            ['moire_scale3', 1.3],
            ['moire_weight3', 0.6],
            ['radial_swirl_strength', 2],
            ['radial_starburst_count', 24],
            ['radial_center_brightness', 1.5],
            ['advect_strength', 0.9],
            ['advect_speed', 3],
            ['curl', 0.1],
            ['decay', 0.5],
        ];

        for (const [name, value] of numeric) {
            expect(updateMoireSetting(settings, name, value)).toBe('none');
            expect(settings[name]).toBe(value);
        }
    });

    /**
     * settings.rs declares no clamping at all, and the drag boxes in
     * MoireMode.svelte cap base_freq at 20 — while two of the four built-in
     * presets set it to 30 and 40. Clamping to the UI range would corrupt them.
     */
    it('does not clamp to the ranges the UI puts on its drag boxes', () => {
        const settings = defaultMoireSettings();
        updateMoireSetting(settings, 'base_freq', 40);
        updateMoireSetting(settings, 'moire_amount', 5);
        updateMoireSetting(settings, 'curl', -3);

        expect(settings.base_freq).toBe(40);
        expect(settings.moire_amount).toBe(5);
        expect(settings.curl).toBe(-3);
    });

    it('rejects a value that would put a NaN in the uniform', () => {
        const settings = defaultMoireSettings();
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 'nonsense', null, true, {}]) {
            expect(() => updateMoireSetting(settings, 'base_freq', bad)).toThrow(/finite number/);
        }
        expect(settings.base_freq).toBe(20.0);
    });

    /**
     * simulation.rs:1360 spells decay `unwrap_or(0.99)` where every other
     * numeric setting unwraps outright — so decay alone snaps to 0.99 rather
     * than failing, and to 0.99 rather than to its own 0.98 default.
     */
    it('falls decay back to 0.99, as the Rust does', () => {
        const settings = defaultMoireSettings();
        updateMoireSetting(settings, 'decay', 'not a number');
        expect(settings.decay).toBe(0.99);
    });

    it('treats every non-true value as false for the boolean flags', () => {
        const settings = defaultMoireSettings();
        updateMoireSetting(settings, 'image_invert_tone', 'yes');
        expect(settings.image_invert_tone).toBe(false);

        updateMoireSetting(settings, 'image_mode_enabled', true);
        expect(settings.image_mode_enabled).toBe(true);
    });

    it('parses the generator type case-insensitively and rejects anything else', () => {
        expect(parseGeneratorType('linear')).toBe('Linear');
        expect(parseGeneratorType('Radial')).toBe('Radial');
        expect(parseGeneratorType(' RADIAL ')).toBe('Radial');
        expect(() => parseGeneratorType('spiral')).toThrow(/Invalid MoireGeneratorType/);
    });

    it('parses all six interference modes and rejects the UI\'s old "Blend"', () => {
        for (const mode of MOIRE_INTERFERENCE_MODES) {
            expect(parseInterferenceMode(mode)).toBe(mode);
            expect(parseInterferenceMode(mode.toLowerCase())).toBe(mode);
        }
        // MoireMode.svelte used to offer a "Blend" option that no variant of
        // ImageInterferenceMode matches; the select now lists the real six.
        expect(() => parseInterferenceMode('Blend')).toThrow(/Invalid ImageInterferenceMode/);
    });

    it('parses fit modes in both the display and compact spellings', () => {
        expect(parseFitMode('Fit V')).toBe('Fit V');
        expect(parseFitMode('fitv')).toBe('Fit V');
        expect(parseFitMode('Stretch')).toBe('Stretch');
        expect(() => parseFitMode('Squash')).toThrow(/Invalid ImageFitMode/);
    });

    it('asks for a re-fit only when the fit mode changed', () => {
        const settings = defaultMoireSettings();
        expect(updateMoireSetting(settings, 'image_fit_mode', 'Center')).toBe('refit-image');
        // Mirroring and tone inversion are applied by the shader, so they cost
        // no CPU work — the Rust reprocessed the image for both anyway.
        expect(updateMoireSetting(settings, 'image_mirror_horizontal', true)).toBe('none');
        expect(updateMoireSetting(settings, 'image_invert_tone', true)).toBe('none');
    });

    it('rejects an unknown setting name', () => {
        expect(() => updateMoireSetting(defaultMoireSettings(), 'nope', 1)).toThrow(
            /Unknown setting: nope/
        );
    });
});

describe('moiré applySettings normalization', () => {
    it('fills a partial document from the defaults', () => {
        const merged = normalizeMoireSettings({ base_freq: 30, moire_amount: 0.8 });
        expect(merged).toEqual({ ...defaultMoireSettings(), base_freq: 30, moire_amount: 0.8 });
    });

    it('keeps the defaults for a document that is not an object', () => {
        for (const bad of [null, 7, 'x', [1, 2]]) {
            expect(normalizeMoireSettings(bad)).toEqual(defaultMoireSettings());
        }
    });

    it('drops a key it cannot use rather than refusing the whole preset', () => {
        const merged = normalizeMoireSettings({
            base_freq: 30,
            from_a_newer_build: 'whatever',
            curl: 'not a number',
        });
        expect(merged.base_freq).toBe(30);
        expect(merged.curl).toBe(defaultMoireSettings().curl);
        expect('from_a_newer_build' in merged).toBe(false);
    });
});

describe('moiré uniform packing', () => {
    const inputs = {
        time: 1.5,
        width: 640,
        height: 480,
        imageLoaded: true,
        colorSchemeReversed: true,
    };

    it('writes struct Params in declaration order', () => {
        const settings = defaultMoireSettings();
        settings.generator_type = 'Radial';
        settings.image_mode_enabled = true;
        settings.image_mirror_vertical = true;
        settings.image_interference_mode = 'Overlay';

        const params = packMoireParams(settings, inputs);
        expect(params.length).toBe(MOIRE_PARAM_FLOATS);

        // compute.wgsl:8 — time, width, height, generator_type, base_freq, ...
        // Compared as a Float32Array so the f32 rounding is on both sides.
        expect(params).toEqual(
            new Float32Array([
                1.5,
                640,
                480,
                GENERATOR_TYPE_CODE.Radial,
                20.0,
                0.5,
                0.2,
                1.05,
                0.5,
                -0.1,
                1.1,
                0.3,
                0.5,
                16.0,
                1.0,
                0, // color_scheme_reversed — see below
                0.6,
                1.5,
                0.8,
                0.98,
                1, // image_loaded
                1, // image_mode_enabled
                INTERFERENCE_MODE_CODE.Overlay,
                0, // mirror horizontal
                1, // mirror vertical
                1, // invert tone
            ])
        );
    });

    /**
     * The LUT reaching updateColorScheme has already been reversed by
     * ColorSchemeManager.current(), and compute.wgsl:285 would invert the index
     * as well — two operations that cancel. The Rust does both, which is why
     * reversing a colour scheme has no visible effect on the desktop build.
     */
    it('never asks the shader to invert the LUT index a second time', () => {
        const reversed = packMoireParams(defaultMoireSettings(), inputs)[15];
        const forward = packMoireParams(defaultMoireSettings(), {
            ...inputs,
            colorSchemeReversed: false,
        })[15];
        expect(reversed).toBe(0);
        expect(forward).toBe(0);
    });

    it('maps every interference mode onto the shader ladder', () => {
        // compute.wgsl:256 tests `< 0.5`, `< 1.5`, ... so the codes must be the
        // integers 0..5 in exactly this order.
        expect(MOIRE_INTERFERENCE_MODES.map((m) => INTERFERENCE_MODE_CODE[m])).toEqual([
            0, 1, 2, 3, 4, 5,
        ]);
    });

    it("reuses the caller's scratch array", () => {
        const scratch = new Float32Array(MOIRE_PARAM_FLOATS);
        expect(packMoireParams(defaultMoireSettings(), inputs, scratch)).toBe(scratch);
    });
});

describe('moiré randomize_settings', () => {
    /** Port of the ranges at simulation.rs:1292-1299. */
    it('keeps every randomized parameter inside its Rust range', () => {
        for (const sample of [0, 0.5, 1 - 1e-9]) {
            const settings = defaultMoireSettings();
            randomizeMoireSettings(settings, () => sample);

            expect(settings.base_freq).toBeGreaterThanOrEqual(5);
            expect(settings.base_freq).toBeLessThanOrEqual(50);
            expect(settings.moire_amount).toBeGreaterThanOrEqual(0);
            expect(settings.moire_amount).toBeLessThanOrEqual(1);
            expect(settings.moire_rotation).toBeGreaterThanOrEqual(0);
            expect(settings.moire_rotation).toBeLessThanOrEqual(Math.PI);
            expect(settings.moire_scale).toBeGreaterThanOrEqual(0.8);
            expect(settings.moire_scale).toBeLessThanOrEqual(1.2);
            expect(settings.moire_interference).toBeGreaterThanOrEqual(0);
            expect(settings.moire_interference).toBeLessThanOrEqual(1);
            expect(Math.abs(settings.moire_rotation3)).toBeLessThanOrEqual(Math.PI / 2);
            expect(settings.moire_scale3).toBeGreaterThanOrEqual(0.8);
            expect(settings.moire_scale3).toBeLessThanOrEqual(1.2);
            expect(settings.moire_weight3).toBeGreaterThanOrEqual(0);
            expect(settings.moire_weight3).toBeLessThanOrEqual(1);
        }
    });

    it('leaves speed, the radial group and every image flag alone', () => {
        const settings = defaultMoireSettings();
        const before = { ...settings };
        randomizeMoireSettings(settings, () => 0.5);

        for (const key of [
            'speed',
            'generator_type',
            'radial_swirl_strength',
            'radial_starburst_count',
            'radial_center_brightness',
            'advect_strength',
            'advect_speed',
            'curl',
            'decay',
            'image_mode_enabled',
            'image_fit_mode',
            'image_mirror_horizontal',
            'image_mirror_vertical',
            'image_invert_tone',
            'image_interference_mode',
        ] as const) {
            expect(settings[key]).toBe(before[key]);
        }
    });

    it('actually moves the eight pattern parameters', () => {
        const settings = defaultMoireSettings();
        let n = 0;
        randomizeMoireSettings(settings, () => ((n = (n + 0.37) % 1), n));

        const defaults = defaultMoireSettings();
        const moved = (
            [
                'base_freq',
                'moire_amount',
                'moire_rotation',
                'moire_scale',
                'moire_interference',
                'moire_rotation3',
                'moire_scale3',
                'moire_weight3',
            ] as const
        ).filter((key) => settings[key] !== defaults[key]);
        expect(moved).toHaveLength(8);
    });
});

describe('moiré built-in presets', () => {
    it('registers the four presets from moire/mod.rs in order', () => {
        expect(getBuiltinPresets('moire').map((p) => p.name)).toEqual([
            'Default',
            'Classic Moiré',
            'Psychedelic',
            'Subtle',
        ]);
    });

    it('carries only the overrides each Rust literal spells out', () => {
        // `Preset::new("Default", Settings::default())` has no overrides.
        expect(MOIRE_BUILTIN_PRESETS[0].settings).toEqual({});
        expect(MOIRE_BUILTIN_PRESETS[1].settings).toEqual({
            base_freq: 30.0,
            moire_amount: 0.8,
            moire_rotation: 0.1,
            moire_scale: 1.02,
            moire_interference: 0.7,
            advect_strength: 0.1,
        });
        expect(MOIRE_BUILTIN_PRESETS[3].settings).toEqual({
            base_freq: 40.0,
            moire_amount: 0.3,
            moire_rotation: 0.05,
            moire_scale: 1.01,
            moire_interference: 0.3,
            advect_strength: 0.2,
        });
    });

    it('loads all four into complete settings through the store', () => {
        const store = new PresetStore(fakeStorage());
        const defaults = defaultMoireSettings();

        for (const builtin of MOIRE_BUILTIN_PRESETS) {
            const loaded = store.get('moire', builtin.name, defaults);
            expect(loaded, builtin.name).toBeDefined();

            const settings = loaded!.settings as unknown as MoireSettings;
            expect(Object.keys(settings).sort()).toEqual(Object.keys(defaults).sort());
            // Everything the preset does not name comes from the defaults —
            // exactly what `..Settings::default()` means.
            for (const [key, value] of Object.entries(defaults)) {
                if (key in builtin.settings) continue;
                expect(settings[key as keyof MoireSettings], `${builtin.name}.${key}`).toBe(value);
            }
            // And what it does name survives the round trip into the engine.
            expect(normalizeMoireSettings(settings)).toEqual(settings);
        }
    });

    it('round-trips a saved user preset', () => {
        const storage = fakeStorage();
        const defaults = defaultMoireSettings();

        const mine = { ...defaults, base_freq: 7.5, generator_type: 'Radial' as const };
        new PresetStore(storage).save('moire', 'Mine', mine);

        const store = new PresetStore(storage);
        expect(store.names('moire', defaults)).toEqual([
            'Default',
            'Classic Moiré',
            'Psychedelic',
            'Subtle',
            'Mine',
        ]);
        expect(store.get('moire', 'Mine', defaults)!.settings).toEqual(mine);
    });

    it('survives a preset written before a field existed', () => {
        const storage = fakeStorage();
        // A document from a build that had no radial generator at all.
        new PresetStore(storage).save('moire', 'Ancient', { base_freq: 12, moire_amount: 0.9 });

        const loaded = new PresetStore(storage).get('moire', 'Ancient', defaultMoireSettings());
        expect(loaded!.settings).toEqual({
            ...defaultMoireSettings(),
            base_freq: 12,
            moire_amount: 0.9,
        });
    });
});

describe('moiré simulation-texture size', () => {
    /**
     * The Rust sizes the feedback pair to the surface with no ceiling at all
     * (simulation.rs:160). At a 4K display's clamped 2x DPR that is 7680x4320
     * rgba8unorm x2 = 265 MB of pattern nobody can resolve.
     */
    it('caps a large surface without distorting it', () => {
        const [w, h] = moireTextureSize(7680, 4320, 8192);
        expect(Math.max(w, h)).toBeLessThanOrEqual(MOIRE_MAX_DIM);
        expect(w / h).toBeCloseTo(7680 / 4320, 2);
    });

    it('leaves a surface below the cap alone', () => {
        expect(moireTextureSize(1600, 900, 8192)).toEqual([1600, 900]);
    });

    it('respects a device whose maxTextureDimension2D is below the cap', () => {
        const [w, h] = moireTextureSize(1600, 900, 1024);
        expect(Math.max(w, h)).toBeLessThanOrEqual(1024);
    });

    it('never produces a zero-sized texture from an unlaid-out canvas', () => {
        expect(moireTextureSize(0, 0, 8192)).toEqual([1, 1]);
    });
});

describe('infinite render tiling', () => {
    /**
     * The instance count is computed on the CPU and the per-instance offset in
     * `calculate_tile_count` on the GPU. If the two disagree the tiled canvas
     * tears along its edge, so the TS port is checked against the constants in
     * the shared shader rather than only against itself.
     */
    const shader = readFileSync(
        join(ROOT, 'src-tauri/src/simulations/shared/infinite_render.wgsl'),
        'utf8'
    );

    it('uses the same constants as the WGSL it mirrors', () => {
        const body = shader.slice(shader.indexOf('fn calculate_tile_count'));
        expect(body).toContain('let visible_world_size = 2.0 / zoom;');
        expect(body).toContain('i32(ceil(visible_world_size / 2.0)) + 6');
        expect(body).toContain('select(5, 7, zoom < 0.1)');
        expect(body).toContain(`min(max(tiles_needed, min_tiles), ${MAX_TILES_PER_AXIS})`);
    });

    it('reproduces the shader arithmetic', () => {
        // ceil(2/zoom / 2) + 6, floored at 5 (or 7 below zoom 0.1).
        expect(calculateTileCount(1)).toBe(7);
        expect(calculateTileCount(2)).toBe(7);
        expect(calculateTileCount(50)).toBe(7);
        expect(calculateTileCount(0.5)).toBe(8);
        expect(calculateTileCount(0.1)).toBe(16);
        expect(calculateTileCount(0.09)).toBe(18);
        expect(calculateTileCount(0.005)).toBe(206);
    });

    it('caps the grid rather than asking for millions of instances', () => {
        expect(calculateTileCount(1e-9)).toBe(MAX_TILES_PER_AXIS);
    });

    it('falls back to the minimum tiling for a degenerate zoom', () => {
        // A zero-sized or not-yet-laid-out viewport can produce these, and
        // 2/0 would otherwise make the instance count infinite.
        expect(calculateTileCount(0)).toBe(7);
        expect(calculateTileCount(-1)).toBe(7);
        expect(calculateTileCount(Number.NaN)).toBe(5);
    });
});
