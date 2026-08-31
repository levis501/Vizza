import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    GRAY_SCOTT_MAX_DIM,
    GRAY_SCOTT_MIN_DIM,
    GRAY_SCOTT_PARAM_BYTES,
    GRAY_SCOTT_PARAM_SCALARS,
    MASK_PATTERNS,
    MASK_PATTERN_CODE,
    MASK_TARGETS,
    MASK_TARGET_CODE,
    defaultGrayScottSettings,
    defaultGrayScottState,
    grayScottStateDocument,
    grayScottTextureSize,
    normalizeGrayScottSettings,
    packGrayScottParams,
    parseFitMode,
    parseMaskPattern,
    parseMaskTarget,
    randomizeGrayScottSettings,
    resetGrayScottMask,
    resetGrayScottMouse,
    resetGrayScottRuntimeState,
    resetGrayScottState,
    updateGrayScottSetting,
    updateGrayScottState,
    type GrayScottSettings,
} from '../../src/lib/engine/sims/grayScott/settings';
import { GRAY_SCOTT_BUILTIN_PRESETS } from '../../src/lib/engine/presets/builtins/grayScott';
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

describe('gray-scott settings defaults', () => {
    /**
     * Transcribed field by field from `impl Default for Settings`
     * (src-tauri/src/simulations/gray_scott/settings.rs:17). Written out in
     * full rather than spot-checked: these are what all nine built-in presets
     * are merged over, so one wrong number silently changes every one of them.
     */
    it('matches impl Default for Settings exactly', () => {
        expect(defaultGrayScottSettings()).toEqual({
            feed_rate: 0.055,
            kill_rate: 0.062,
            diffusion_rate_u: 0.16,
            diffusion_rate_v: 0.08,
            timestep: 2.5,
            max_timestep: 4.0,
            stability_factor: 0.9,
            enable_adaptive_timestep: false,
        });
    });

    /**
     * GrayScottDiagram.svelte:116 declares Svelte *prop* defaults of
     * `diffusionRateU = 0.1` and `timestep = 1.0`, which disagree with the
     * model. The drawing drifted; settings.rs is the source of truth.
     */
    it('does not take its values from the explainer diagram', () => {
        const settings = defaultGrayScottSettings();
        expect(settings.diffusion_rate_u).not.toBe(0.1);
        expect(settings.timestep).not.toBe(1.0);
    });

    it('hands out a fresh object each time', () => {
        const first = defaultGrayScottSettings();
        first.feed_rate = 999;
        expect(defaultGrayScottSettings().feed_rate).toBe(0.055);
    });
});

describe('gray-scott state defaults', () => {
    /** `impl Default for State` (state.rs:220), field by field. */
    it('matches impl Default for State exactly', () => {
        expect(defaultGrayScottState()).toEqual({
            mask_pattern: 'Disabled',
            mask_target: 'UV Concentration',
            mask_strength: 0.5,
            mask_reversed: false,
            mask_image_fit_mode: 'Stretch',
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
            color_scheme_reversed: true,
            gui_visible: true,
            camera_position: [0, 0],
            camera_zoom: 1.0,
            simulation_time: 0.0,
            is_running: true,
        });
    });

    /**
     * state.rs:228 is `ImageFitMode::default()`, which is Stretch. Moiré's own
     * default is 'Fit V' — the fit mode is per-simulation, and copying Moiré's
     * here would crop every uploaded mask differently from the desktop app.
     */
    it('defaults the mask fit mode to Stretch, not to Moiré’s Fit V', () => {
        expect(defaultGrayScottState().mask_image_fit_mode).toBe('Stretch');
    });

    it('hands out a fresh object each time, arrays included', () => {
        const first = defaultGrayScottState();
        first.mouse_position[0] = 99;
        first.cursor_size = 99;
        expect(defaultGrayScottState().mouse_position).toEqual([0, 0]);
        expect(defaultGrayScottState().cursor_size).toBe(0.2);
    });

    /**
     * `State` in the Rust carries `mask_image_base` and `mask_image_raw`, two
     * `Option<Vec<f32>>` of width x height, *inside the serialized state*. A
     * `get_state` on a 2048² field would put four million JSON numbers across
     * the bridge, and GrayScottMode.svelte syncs state after most
     * interactions. The pixels stay on the simulation object instead.
     */
    it('never puts the mask pixel buffers in the state document', () => {
        const state = defaultGrayScottState();
        expect('mask_image_base' in state).toBe(false);
        expect('mask_image_raw' in state).toBe(false);

        // And the document builder strips them even if something re-adds them:
        // GrayScottState has an index signature, so the assignment type-checks.
        state.mask_image_base = new Float32Array(4);
        state.mask_image_raw = new Float32Array(4);
        const doc = grayScottStateDocument(state);
        expect('mask_image_base' in doc).toBe(false);
        expect('mask_image_raw' in doc).toBe(false);
        expect(doc.mask_pattern).toBe('Disabled');
    });
});

describe('gray-scott state resets', () => {
    /**
     * `State::reset_mouse` (state.rs:281) sets `cursor_size = 0.1`, which is
     * *not* the 0.20 `State::default` uses. The two really do disagree in the
     * Rust; transcribed rather than reconciled.
     */
    it('shrinks the cursor on a mouse reset, unlike the default', () => {
        const state = defaultGrayScottState();
        expect(state.cursor_size).toBe(0.2);
        resetGrayScottMouse(state);
        expect(state.cursor_size).toBe(0.1);
    });

    it('puts the mask back to Disabled / UV Concentration', () => {
        const state = defaultGrayScottState();
        state.mask_pattern = 'Cosine Grid';
        state.mask_target = 'Kill Rate';
        state.mask_strength = 0.9;
        state.mask_reversed = true;

        resetGrayScottMask(state);
        expect(state.mask_pattern).toBe('Disabled');
        expect(state.mask_target).toBe('UV Concentration');
        expect(state.mask_strength).toBe(0.5);
        expect(state.mask_reversed).toBe(false);
    });

    it('leaves the colour scheme and GUI flags alone on a full reset', () => {
        const state = defaultGrayScottState();
        state.current_color_scheme = 'MATPLOTLIB_viridis';
        state.gui_visible = false;
        state.simulation_time = 12;

        resetGrayScottState(state);
        expect(state.current_color_scheme).toBe('MATPLOTLIB_viridis');
        expect(state.gui_visible).toBe(false);
        expect(state.simulation_time).toBe(0);
    });

    /**
     * `Simulation::reset_runtime_state` (simulation.rs:1919) is a literal
     * no-op for Gray-Scott. The user-visible "Reset" button is a different
     * command — `reset_simulation` → `GrayScottModel::reset` — which blanks the
     * concentration field. Keeping the two distinguishable is the point:
     * clearing the field on every preset change would throw away the pattern.
     */
    it('is a no-op, and is not the field-clearing reset', () => {
        expect(resetGrayScottRuntimeState()).toBeUndefined();
    });
});

describe('gray-scott update_setting', () => {
    it('accepts every numeric setting GrayScottMode sends', () => {
        const settings = defaultGrayScottSettings();
        const numeric: Array<[keyof GrayScottSettings, number]> = [
            ['feed_rate', 0.0367],
            ['kill_rate', 0.0649],
            ['diffusion_rate_u', 0.2],
            ['diffusion_rate_v', 0.1],
            ['timestep', 1.0],
            ['max_timestep', 2.0],
            ['stability_factor', 0.8],
        ];

        for (const [name, value] of numeric) {
            expect(updateGrayScottSetting(settings, name, value)).toBe('sim-params');
            expect(settings[name]).toBe(value);
        }
    });

    /**
     * simulation.rs:1148 has no match arm for these three even though
     * GrayScottMode.svelte:170-177 sends all three by these exact names. On the
     * desktop build the drag box moves, the local copy updates, the backend
     * drops the value, and the next state sync snaps it back. Fixed here.
     */
    it('makes the three adaptive-timestep names stick', () => {
        const settings = defaultGrayScottSettings();

        expect(updateGrayScottSetting(settings, 'max_timestep', 6.5)).toBe('sim-params');
        expect(updateGrayScottSetting(settings, 'stability_factor', 0.42)).toBe('sim-params');
        expect(updateGrayScottSetting(settings, 'enable_adaptive_timestep', true)).toBe(
            'sim-params'
        );

        expect(settings.max_timestep).toBe(6.5);
        expect(settings.stability_factor).toBe(0.42);
        expect(settings.enable_adaptive_timestep).toBe(true);
    });

    /** Neither settings.rs nor update_setting clamps anything. */
    it('does not clamp to the ranges the UI puts on its drag boxes', () => {
        const settings = defaultGrayScottSettings();
        updateGrayScottSetting(settings, 'feed_rate', 5);
        updateGrayScottSetting(settings, 'kill_rate', -1);
        updateGrayScottSetting(settings, 'timestep', 250);

        expect(settings.feed_rate).toBe(5);
        expect(settings.kill_rate).toBe(-1);
        expect(settings.timestep).toBe(250);
    });

    it('rejects a value that would put a NaN in the uniform', () => {
        const settings = defaultGrayScottSettings();
        for (const bad of [
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            '0.03',
            null,
            true,
            {},
            [],
        ]) {
            expect(() => updateGrayScottSetting(settings, 'feed_rate', bad)).toThrow(
                /finite number/
            );
        }
        expect(settings.feed_rate).toBe(0.055);
    });

    it('treats every non-true value as false for the boolean flag', () => {
        const settings = defaultGrayScottSettings();
        updateGrayScottSetting(settings, 'enable_adaptive_timestep', 'yes');
        expect(settings.enable_adaptive_timestep).toBe(false);

        updateGrayScottSetting(settings, 'enable_adaptive_timestep', true);
        expect(settings.enable_adaptive_timestep).toBe(true);
    });

    /**
     * The Rust's `_ => {}` (simulation.rs:1235) ignored an unknown name
     * silently. Throwing is what lets an optimistic UI update be rolled back
     * instead of showing a value the engine never took — same call Moiré makes.
     */
    it('rejects an unknown setting name', () => {
        expect(() => updateGrayScottSetting(defaultGrayScottSettings(), 'nope', 1)).toThrow(
            /Unknown setting: nope/
        );
    });

    /**
     * The Rust routes eight mask/cursor names through the *settings* command
     * into `State`. The Svelte UI never uses that path — every one of them goes
     * through `update_simulation_state` — so those aliases are not reproduced,
     * and the two namespaces stay separate here.
     */
    it('does not accept the state names the Rust settings command also took', () => {
        const settings = defaultGrayScottSettings();
        for (const name of ['mask_pattern', 'mask_strength', 'cursor_size', 'image_fit_mode']) {
            expect(() => updateGrayScottSetting(settings, name, 0.5)).toThrow(/Unknown setting/);
        }
    });
});

describe('gray-scott update_state', () => {
    it('maps each state name onto the work it actually requires', () => {
        const state = defaultGrayScottState();
        const cases: Array<[string, unknown, string]> = [
            ['mask_pattern', 'Radial Gradient', 'both-params'],
            ['mask_target', 'Feed Rate', 'both-params'],
            ['mask_strength', 0.75, 'both-params'],
            ['mask_mirror_horizontal', true, 'both-params'],
            ['mask_mirror_vertical', true, 'both-params'],
            ['mask_invert_tone', true, 'both-params'],
            ['mask_image_fit_mode', 'Center', 'refit-image'],
            ['image_fit_mode', 'Fit H', 'refit-image'],
            ['cursor_size', 0.35, 'render-params'],
            ['cursor_strength', 0.5, 'render-params'],
            ['current_color_scheme', 'MATPLOTLIB_viridis', 'reload-lut'],
            ['color_scheme_reversed', false, 'reload-lut'],
        ];

        for (const [name, value, effect] of cases) {
            expect(updateGrayScottState(state, name, value), name).toBe(effect);
        }

        expect(state.mask_pattern).toBe('Radial Gradient');
        expect(state.mask_target).toBe('Feed Rate');
        expect(state.mask_strength).toBe(0.75);
        expect(state.mask_image_fit_mode).toBe('Fit H');
        expect(state.cursor_size).toBe(0.35);
        expect(state.current_color_scheme).toBe('MATPLOTLIB_viridis');
        expect(state.color_scheme_reversed).toBe(false);
    });

    /**
     * `mask_reversed` is stored, serialized, reset and updated by two commands
     * — and read by nothing. `SimulationParams` has no such field and no shader
     * mentions it, so reversing a mask has never done anything on any build.
     * It is kept inert for state-shape compatibility; do not "fix" it into the
     * uniform. Hence 'none': there is no buffer to re-upload.
     */
    it('stores mask_reversed but asks for no GPU work, because nothing reads it', () => {
        const state = defaultGrayScottState();
        expect(updateGrayScottState(state, 'mask_reversed', true)).toBe('none');
        expect(state.mask_reversed).toBe(true);
    });

    it('rejects a non-finite mask strength and an unknown state name', () => {
        const state = defaultGrayScottState();
        expect(() => updateGrayScottState(state, 'mask_strength', Number.NaN)).toThrow(
            /finite number/
        );
        expect(() => updateGrayScottState(state, 'nope', 1)).toThrow(/Unknown state: nope/);
    });

    it('rejects an unparseable mask pattern rather than silently keeping the old one', () => {
        const state = defaultGrayScottState();
        expect(() => updateGrayScottState(state, 'mask_pattern', 'Spirals')).toThrow(
            /Invalid MaskPattern/
        );
        expect(state.mask_pattern).toBe('Disabled');
    });
});

describe('gray-scott mask enums', () => {
    /**
     * Every variant carries three competing spellings in the Rust: serde's
     * PascalCase (what `get_state` emits), `as_str()`'s display name (what the
     * `<Selector>` lists and `updateMaskPattern` sends), and the
     * lowercase/underscore forms `from_str` also takes. The display spelling is
     * canonical here — it is the one the UI already uses on both ends — and the
     * parser accepts all three so either build's documents load.
     */
    it('parses every mask pattern in all three spellings', () => {
        const serde: Record<string, string> = {
            Disabled: 'Disabled',
            Checkerboard: 'Checkerboard',
            DiagonalGradient: 'Diagonal Gradient',
            RadialGradient: 'Radial Gradient',
            VerticalStripes: 'Vertical Stripes',
            HorizontalStripes: 'Horizontal Stripes',
            WaveFunction: 'Wave Function',
            CosineGrid: 'Cosine Grid',
            Image: 'Image',
        };

        for (const pattern of MASK_PATTERNS) {
            // Display spelling — as_str(), and what the UI sends.
            expect(parseMaskPattern(pattern)).toBe(pattern);
            // Underscore/lowercase form — from_str's second branch.
            expect(parseMaskPattern(pattern.toLowerCase().replace(/ /g, '_'))).toBe(pattern);
            expect(parseMaskPattern(`  ${pattern.toLowerCase()}  `)).toBe(pattern);
        }
        // Serde spelling — what get_state returned, and what made the Selector
        // fall back to its placeholder after every state sync.
        for (const [emitted, canonical] of Object.entries(serde)) {
            expect(parseMaskPattern(emitted)).toBe(canonical);
        }
    });

    /** state.rs:98 — `"image gradient" | "image_gradient" | "image"`. */
    it('accepts the image pattern’s three aliases', () => {
        expect(parseMaskPattern('image gradient')).toBe('Image');
        expect(parseMaskPattern('image_gradient')).toBe('Image');
        expect(parseMaskPattern('image')).toBe('Image');
    });

    it('parses every mask target in all three spellings', () => {
        const serde: Record<string, string> = {
            FeedRate: 'Feed Rate',
            KillRate: 'Kill Rate',
            DiffusionU: 'Diffusion U',
            DiffusionV: 'Diffusion V',
            UVConcentration: 'UV Concentration',
        };

        for (const target of MASK_TARGETS) {
            expect(parseMaskTarget(target)).toBe(target);
            expect(parseMaskTarget(target.toLowerCase().replace(/ /g, '_'))).toBe(target);
            // from_str's compact form — "feedrate", "uvconcentration".
            expect(parseMaskTarget(target.toLowerCase().replace(/ /g, ''))).toBe(target);
        }
        for (const [emitted, canonical] of Object.entries(serde)) {
            expect(parseMaskTarget(emitted)).toBe(canonical);
        }
    });

    it('rejects anything that is not a variant', () => {
        expect(() => parseMaskPattern('Spirals')).toThrow(/Invalid MaskPattern/);
        expect(() => parseMaskPattern(null)).toThrow(/Invalid MaskPattern/);
        expect(() => parseMaskTarget('Feed')).toThrow(/Invalid MaskTarget/);
        expect(() => parseMaskTarget(undefined)).toThrow(/Invalid MaskTarget/);
    });

    it('parses fit modes through the shared parser', () => {
        expect(parseFitMode('Stretch')).toBe('Stretch');
        expect(parseFitMode('fitv')).toBe('Fit V');
        expect(() => parseFitMode('Squash')).toThrow(/Invalid ImageFitMode/);
    });
});

describe('gray-scott shader enum codes', () => {
    const shader = readFileSync(
        join(ROOT, 'src-tauri/src/simulations/gray_scott/shaders/reaction_diffusion.wgsl'),
        'utf8'
    );

    /**
     * reaction_diffusion.wgsl switches `params.mask_pattern` on 0..8. The
     * Rust's `as u32` discriminants, its `From<MaskPattern> for u32` impl and
     * the shader all agree, so this one is a straight transcription.
     */
    it('numbers the mask patterns 0..8 in declaration order', () => {
        expect(MASK_PATTERNS.map((p) => MASK_PATTERN_CODE[p])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    });

    /**
     * **The target codes are 1..5, and that is a bug fix, not a transcription.**
     *
     * The Rust uploads `state.mask_target as u32` (simulation.rs:1243), i.e.
     * the declaration discriminants 0..4, while reaction_diffusion.wgsl:305
     * switches on 1..5 and treats everything else as "no mask". The
     * `From<MaskTarget> for u32` impl at state.rs:166 does produce 1..5 — and
     * has no callers anywhere in the tree.
     *
     * So on the desktop build the whole selector is off by one: "Feed Rate"
     * uploads 0 and applies no mask at all, and the default "UV Concentration"
     * uploads 4 and silently runs the Diffusion-V branch. The shader's arms
     * carry per-variant comments, so the shader is the documented contract and
     * the upload is what is wrong.
     */
    it('numbers the mask targets 1..5, matching the shader rather than the upload', () => {
        expect(MASK_TARGETS.map((t) => MASK_TARGET_CODE[t])).toEqual([1, 2, 3, 4, 5]);
        expect(MASK_TARGET_CODE['Feed Rate']).not.toBe(0);
    });

    it('agrees with the switch arms actually written in the WGSL', () => {
        const body = shader.slice(shader.indexOf('switch (params.mask_target)'));
        expect(body).toContain('case 1u: { // FeedRate');
        expect(body).toContain('case 2u: { // KillRate');
        expect(body).toContain('case 3u: { // DiffusionU');
        expect(body).toContain('case 4u: { // DiffusionV');
        expect(body).toContain('case 5u: { // UVConcentration');
        // There is no `case 0u`, which is why the Rust's upload silently
        // disables the mask for the first variant.
        expect(body.slice(0, body.indexOf('let delta_u'))).not.toContain('case 0u');
    });
});

describe('gray-scott applySettings normalization', () => {
    it('fills a partial document from the defaults', () => {
        const merged = normalizeGrayScottSettings({ feed_rate: 0.0367, kill_rate: 0.0649 });
        expect(merged).toEqual({
            ...defaultGrayScottSettings(),
            feed_rate: 0.0367,
            kill_rate: 0.0649,
        });
    });

    it('keeps the defaults for a document that is not an object', () => {
        for (const bad of [null, undefined, 7, 'x', [1, 2]]) {
            expect(normalizeGrayScottSettings(bad)).toEqual(defaultGrayScottSettings());
        }
    });

    it('drops a key it cannot use rather than refusing the whole preset', () => {
        const merged = normalizeGrayScottSettings({
            feed_rate: 0.03,
            from_a_newer_build: 'whatever',
            timestep: 'not a number',
        });
        expect(merged.feed_rate).toBe(0.03);
        expect(merged.timestep).toBe(defaultGrayScottSettings().timestep);
        expect('from_a_newer_build' in merged).toBe(false);
    });
});

describe('gray-scott randomize', () => {
    /** Ranges from `Settings::randomize` (settings.rs:36), all half-open. */
    it('keeps every randomized parameter inside its Rust range', () => {
        for (const sample of [0, 0.5, 1 - 1e-9]) {
            const settings = defaultGrayScottSettings();
            randomizeGrayScottSettings(settings, () => sample);

            expect(settings.feed_rate).toBeGreaterThanOrEqual(0.02);
            expect(settings.feed_rate).toBeLessThan(0.08);
            expect(settings.kill_rate).toBeGreaterThanOrEqual(0.04);
            expect(settings.kill_rate).toBeLessThan(0.08);
            expect(settings.diffusion_rate_u).toBeGreaterThanOrEqual(0.1);
            expect(settings.diffusion_rate_u).toBeLessThan(0.3);
            expect(settings.diffusion_rate_v).toBeGreaterThanOrEqual(0.05);
            expect(settings.diffusion_rate_v).toBeLessThan(0.15);
            expect(settings.timestep).toBeGreaterThanOrEqual(0.5);
            expect(settings.timestep).toBeLessThan(2.0);
        }
    });

    it('lands exactly on the low end of each range for rng() = 0', () => {
        const settings = defaultGrayScottSettings();
        randomizeGrayScottSettings(settings, () => 0);
        expect(settings.feed_rate).toBe(0.02);
        expect(settings.kill_rate).toBe(0.04);
        expect(settings.diffusion_rate_u).toBe(0.1);
        expect(settings.diffusion_rate_v).toBe(0.05);
        expect(settings.timestep).toBe(0.5);
    });

    /**
     * The adaptive-timestep group is left alone. It matters: a randomized
     * `max_timestep` below the randomized `timestep` would quietly cap it,
     * which is not something a "Randomize" button should be able to do.
     */
    it('leaves the adaptive-timestep group alone', () => {
        const settings = defaultGrayScottSettings();
        randomizeGrayScottSettings(settings, () => 0.5);
        expect(settings.max_timestep).toBe(4.0);
        expect(settings.stability_factor).toBe(0.9);
        expect(settings.enable_adaptive_timestep).toBe(false);
    });

    it('actually moves all five randomized fields', () => {
        const settings = defaultGrayScottSettings();
        let n = 0;
        randomizeGrayScottSettings(settings, () => ((n = (n + 0.37) % 1), n));

        const defaults = defaultGrayScottSettings();
        const moved = (
            ['feed_rate', 'kill_rate', 'diffusion_rate_u', 'diffusion_rate_v', 'timestep'] as const
        ).filter((key) => settings[key] !== defaults[key]);
        expect(moved).toHaveLength(5);
    });
});

describe('gray-scott uniform packing', () => {
    const inputs = { width: 1024, height: 768 };

    /**
     * `struct SimulationParams` (reaction_diffusion.wgsl:1) — 16 four-byte
     * scalars in this exact order. Take the order from the WGSL only: the
     * struct literals in gray_scott/tests.rs list `mask_invert_tone` before the
     * two mirror flags, which is not the real layout.
     */
    it('writes struct SimulationParams in WGSL declaration order', () => {
        const settings = defaultGrayScottSettings();
        settings.enable_adaptive_timestep = true;

        const state = defaultGrayScottState();
        state.mask_pattern = 'Wave Function';
        state.mask_target = 'Diffusion U';
        state.mask_strength = 0.75;
        state.mask_mirror_vertical = true;

        const buffer = packGrayScottParams(settings, state, inputs);
        expect(buffer.byteLength).toBe(GRAY_SCOTT_PARAM_BYTES);
        expect(GRAY_SCOTT_PARAM_BYTES).toBe(64);
        expect(GRAY_SCOTT_PARAM_SCALARS).toBe(16);

        const view = new DataView(buffer);
        const f = (slot: number) => view.getFloat32(slot * 4, true);
        const u = (slot: number) => view.getUint32(slot * 4, true);

        expect(f(0)).toBeCloseTo(0.055, 6); // feed_rate
        expect(f(1)).toBeCloseTo(0.062, 6); // kill_rate
        expect(f(2)).toBeCloseTo(0.16, 6); // delta_u  <- diffusion_rate_u
        expect(f(3)).toBeCloseTo(0.08, 6); // delta_v  <- diffusion_rate_v
        expect(f(4)).toBe(2.5); // timestep
        expect(u(5)).toBe(1024); // width
        expect(u(6)).toBe(768); // height
        expect(u(7)).toBe(MASK_PATTERN_CODE['Wave Function']); // 6
        expect(u(8)).toBe(MASK_TARGET_CODE['Diffusion U']); // 3
        expect(f(9)).toBe(0.75); // mask_strength
        expect(u(10)).toBe(0); // mask_mirror_horizontal
        expect(u(11)).toBe(1); // mask_mirror_vertical
        expect(u(12)).toBe(0); // mask_invert_tone
        expect(f(13)).toBe(4.0); // max_timestep
        expect(f(14)).toBeCloseTo(0.9, 6); // stability_factor
        expect(u(15)).toBe(1); // enable_adaptive_timestep
    });

    /**
     * width/height/the mask codes/the flags are `u32` in the WGSL, so writing
     * them through the float view would put 1065353216 where the shader reads
     * 1. A single mixed view over one ArrayBuffer is the only correct shape.
     */
    it('writes the u32 members as integers, not as float bit patterns', () => {
        const state = defaultGrayScottState();
        state.mask_mirror_horizontal = true;
        state.mask_invert_tone = true;

        const u32 = new Uint32Array(
            packGrayScottParams(defaultGrayScottSettings(), state, { width: 1, height: 1 })
        );
        expect(u32[5]).toBe(1);
        expect(u32[6]).toBe(1);
        expect(u32[10]).toBe(1);
        expect(u32[12]).toBe(1);
    });

    /**
     * `params.max_timestep` is never referenced by the shader —
     * `calculate_adaptive_timestep` clamps against `timestep` — but the slot is
     * positionally load-bearing: dropping it would shift stability_factor and
     * enable_adaptive_timestep down four bytes each.
     */
    it('keeps the unread max_timestep slot, because the two after it depend on it', () => {
        const settings = defaultGrayScottSettings();
        settings.max_timestep = 12.5;
        settings.stability_factor = 0.25;

        const view = new DataView(packGrayScottParams(settings, defaultGrayScottState(), inputs));
        expect(view.getFloat32(52, true)).toBe(12.5);
        expect(view.getFloat32(56, true)).toBe(0.25);
    });

    it("reuses the caller's scratch buffer", () => {
        const scratch = new ArrayBuffer(GRAY_SCOTT_PARAM_BYTES);
        expect(
            packGrayScottParams(
                defaultGrayScottSettings(),
                defaultGrayScottState(),
                inputs,
                scratch
            )
        ).toBe(scratch);
    });

    /** The default target is UV Concentration, which must reach the shader as 5. */
    it('sends the default mask target as the shader’s UVConcentration arm', () => {
        const u32 = new Uint32Array(
            packGrayScottParams(defaultGrayScottSettings(), defaultGrayScottState(), inputs)
        );
        expect(u32[8]).toBe(5);
    });
});

describe('gray-scott built-in presets', () => {
    it('registers the nine presets from gray_scott/mod.rs in order', () => {
        expect(getBuiltinPresets('gray_scott').map((p) => p.name)).toEqual([
            'Brain Coral',
            'Fingerprint',
            'Mitosis',
            'Ripples',
            'Soliton Collapse',
            'U-Skate World',
            'Undulating',
            'Worms',
            'Custom',
        ]);
    });

    /** There is no "Default" preset for Gray-Scott, unlike every other sim. */
    it('has no Default entry', () => {
        expect(GRAY_SCOTT_BUILTIN_PRESETS.map((p) => p.name)).not.toContain('Default');
    });

    /**
     * The Rust loop writes a *complete* Settings literal with no
     * `..Settings::default()`, and three of the spelled-out values disagree
     * with the defaults: timestep 1.0 (default 2.5), max_timestep 2.0 (default
     * 4.0), stability_factor 0.8 (default 0.9). Omitting them here would give
     * every preset a 2.5x faster reaction than the desktop app.
     */
    it('carries the three optimization overrides on every entry, not just feed/kill', () => {
        const defaults = defaultGrayScottSettings();
        for (const preset of GRAY_SCOTT_BUILTIN_PRESETS) {
            expect(Object.keys(preset.settings).sort(), preset.name).toEqual([
                'feed_rate',
                'kill_rate',
                'max_timestep',
                'stability_factor',
                'timestep',
            ]);
            expect(preset.settings.timestep, preset.name).toBe(1.0);
            expect(preset.settings.max_timestep, preset.name).toBe(2.0);
            expect(preset.settings.stability_factor, preset.name).toBe(0.8);

            expect(preset.settings.timestep).not.toBe(defaults.timestep);
            expect(preset.settings.max_timestep).not.toBe(defaults.max_timestep);
            expect(preset.settings.stability_factor).not.toBe(defaults.stability_factor);
        }
    });

    it('carries the feed/kill pair from the mod.rs table', () => {
        const pairs = GRAY_SCOTT_BUILTIN_PRESETS.map((p) => [
            p.name,
            p.settings.feed_rate,
            p.settings.kill_rate,
        ]);
        expect(pairs).toEqual([
            ['Brain Coral', 0.0545, 0.062],
            ['Fingerprint', 0.0545, 0.062],
            ['Mitosis', 0.0367, 0.0649],
            ['Ripples', 0.018, 0.051],
            ['Soliton Collapse', 0.022, 0.06],
            ['U-Skate World', 0.062, 0.061],
            ['Undulating', 0.026, 0.051],
            ['Worms', 0.078, 0.061],
            ['Custom', 0.035, 0.058],
        ]);
    });

    /**
     * Brain Coral and Fingerprint are byte-identical in mod.rs:18-19 — the same
     * (0.0545, 0.062) pair under two names. That is in the Rust table, not a
     * transcription slip, and the preset list really does offer one simulation
     * twice. Pinned so nobody "fixes" one of them.
     */
    it('keeps Brain Coral and Fingerprint identical, as the Rust table has them', () => {
        const [brainCoral, fingerprint] = GRAY_SCOTT_BUILTIN_PRESETS;
        expect(brainCoral.name).toBe('Brain Coral');
        expect(fingerprint.name).toBe('Fingerprint');
        expect(fingerprint.settings).toEqual(brainCoral.settings);
    });

    it('loads all nine into complete settings through the store', () => {
        const store = new PresetStore(fakeStorage());
        const defaults = defaultGrayScottSettings();

        for (const builtin of GRAY_SCOTT_BUILTIN_PRESETS) {
            const loaded = store.get('gray_scott', builtin.name, defaults);
            expect(loaded, builtin.name).toBeDefined();

            const settings = loaded!.settings as unknown as GrayScottSettings;
            expect(Object.keys(settings).sort()).toEqual(Object.keys(defaults).sort());
            // Everything the preset does not name comes from the defaults.
            for (const [key, value] of Object.entries(defaults)) {
                if (key in builtin.settings) continue;
                expect(settings[key as keyof GrayScottSettings], `${builtin.name}.${key}`).toBe(
                    value
                );
            }
            // And what it does name survives the round trip into the engine.
            expect(normalizeGrayScottSettings(settings)).toEqual(settings);
        }
    });

    it('produces the exact settings the Rust literal built', () => {
        const store = new PresetStore(fakeStorage());
        expect(store.get('gray_scott', 'Mitosis', defaultGrayScottSettings())!.settings).toEqual({
            feed_rate: 0.0367,
            kill_rate: 0.0649,
            diffusion_rate_u: 0.16,
            diffusion_rate_v: 0.08,
            timestep: 1.0,
            max_timestep: 2.0,
            stability_factor: 0.8,
            enable_adaptive_timestep: false,
        });
    });

    /**
     * "Custom" is a built-in *name* here, so `PresetStore.list` permanently
     * shadows a user preset saved under it — built-ins win on a name clash
     * (preset_manager.rs:113). Faithful to the Rust, and a trap worth pinning:
     * the save appears to succeed and the value never comes back.
     */
    it('permanently shadows a user preset named "Custom"', () => {
        const storage = fakeStorage();
        const defaults = defaultGrayScottSettings();
        new PresetStore(storage).save('gray_scott', 'Custom', { ...defaults, feed_rate: 0.001 });

        const store = new PresetStore(storage);
        expect(store.names('gray_scott', defaults).filter((n) => n === 'Custom')).toHaveLength(1);
        // The built-in's value, not the user's.
        expect(store.get('gray_scott', 'Custom', defaults)!.settings.feed_rate).toBe(0.035);
        // It is still on disk, which is what makes the shadowing confusing.
        expect(new PresetStore(storage).hasUserPreset('gray_scott', 'Custom')).toBe(true);
    });

    it('round-trips a saved user preset', () => {
        const storage = fakeStorage();
        const defaults = defaultGrayScottSettings();

        const mine = { ...defaults, feed_rate: 0.0301, enable_adaptive_timestep: true };
        new PresetStore(storage).save('gray_scott', 'Mine', mine);

        const store = new PresetStore(storage);
        expect(store.names('gray_scott', defaults)).toEqual([
            'Brain Coral',
            'Fingerprint',
            'Mitosis',
            'Ripples',
            'Soliton Collapse',
            'U-Skate World',
            'Undulating',
            'Worms',
            'Custom',
            'Mine',
        ]);
        expect(store.get('gray_scott', 'Mine', defaults)!.settings).toEqual(mine);
    });

    it('survives a preset written before the adaptive-timestep fields existed', () => {
        const storage = fakeStorage();
        // A document from the build that had five settings, not eight.
        new PresetStore(storage).save('gray_scott', 'Ancient', {
            feed_rate: 0.03,
            kill_rate: 0.06,
            diffusion_rate_u: 0.16,
            diffusion_rate_v: 0.08,
            timestep: 1.0,
        });

        const loaded = new PresetStore(storage).get(
            'gray_scott',
            'Ancient',
            defaultGrayScottSettings()
        );
        expect(loaded!.settings).toEqual({
            ...defaultGrayScottSettings(),
            feed_rate: 0.03,
            kill_rate: 0.06,
            timestep: 1.0,
        });
        expect(normalizeGrayScottSettings(loaded!.settings)).toEqual(loaded!.settings);
    });
});

describe('gray-scott simulation-texture size', () => {
    /**
     * simulation.rs:715 sizes both rgba16float textures to the surface with
     * `.max(256)` per axis and no upper bound. A 4K display at an unclamped 3x
     * DPR is 11520x6480 — ~1.2 GB for the pair.
     */
    it('caps a large surface without distorting it', () => {
        const [w, h] = grayScottTextureSize(7680, 4320, 8192);
        expect(Math.max(w, h)).toBeLessThanOrEqual(GRAY_SCOTT_MAX_DIM);
        expect(w / h).toBeCloseTo(7680 / 4320, 2);
    });

    it('leaves a surface between the floor and the cap alone', () => {
        expect(grayScottTextureSize(1600, 900, 8192)).toEqual([1600, 900]);
    });

    /** The 256 floor is per axis in the Rust, so it does change the aspect. */
    it('floors each axis at 256, as the Rust does', () => {
        expect(grayScottTextureSize(400, 200, 8192)).toEqual([400, 256]);
        expect(grayScottTextureSize(100, 100, 8192)).toEqual([
            GRAY_SCOTT_MIN_DIM,
            GRAY_SCOTT_MIN_DIM,
        ]);
    });

    it('respects a device whose maxTextureDimension2D is below the cap', () => {
        const [w, h] = grayScottTextureSize(1600, 900, 1024);
        expect(Math.max(w, h)).toBeLessThanOrEqual(1024);
        expect(Math.min(w, h)).toBeGreaterThanOrEqual(GRAY_SCOTT_MIN_DIM);
    });

    /** The floor must never push a texture past the device's own limit. */
    it('never asks for more than the device allows, even with the 256 floor', () => {
        const [w, h] = grayScottTextureSize(1600, 900, 128);
        expect(Math.max(w, h)).toBeLessThanOrEqual(128);
    });

    it('never produces a zero-sized texture from an unlaid-out canvas', () => {
        expect(grayScottTextureSize(0, 0, 8192)).toEqual([GRAY_SCOTT_MIN_DIM, GRAY_SCOTT_MIN_DIM]);
    });
});
