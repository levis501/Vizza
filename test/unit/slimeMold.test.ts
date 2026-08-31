import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    BACKGROUND_MODES,
    BACKGROUND_MODE_CODE,
    MASK_PATTERNS,
    MASK_PATTERN_CODE,
    MASK_TARGETS,
    MASK_TARGET_CODE,
    POSITION_GENERATORS,
    POSITION_GENERATOR_CODE,
    SLIME_MOLD_BACKGROUND_PARAM_BYTES,
    SLIME_MOLD_CURSOR_PARAM_BYTES,
    SLIME_MOLD_CURSOR_SIZE_RANGE,
    SLIME_MOLD_CURSOR_STRENGTH_RANGE,
    SLIME_MOLD_DEFAULT_AGENTS,
    SLIME_MOLD_DESKTOP_AGENTS,
    SLIME_MOLD_MIN_AGENTS,
    SLIME_MOLD_SIM_SIZE_BYTES,
    SLIME_MOLD_SIM_SIZE_SCALARS,
    TRAIL_MAP_FILTERINGS,
    clampSlimeMoldAgentCount,
    defaultSlimeMoldSettings,
    defaultSlimeMoldState,
    normalizeSlimeMoldSettings,
    packSlimeMoldBackgroundParams,
    packSlimeMoldCursorParams,
    packSlimeMoldSimSize,
    parseBackgroundMode,
    parseFitMode,
    parseMaskPattern,
    parseMaskTarget,
    parsePositionGenerator,
    parseTrailMapFiltering,
    randomizeSlimeMoldSettings,
    slimeMoldAgentMaxMillions,
    slimeMoldStateDocument,
    updateSlimeMoldSetting,
    updateSlimeMoldState,
    type SlimeMoldSettings,
} from '../../src/lib/engine/sims/slimeMold/settings';
import { SLIME_MOLD_BUILTIN_PRESETS } from '../../src/lib/engine/presets/builtins/slimeMold';
import { getBuiltinPresets } from '../../src/lib/engine/presets/builtins';
import { PresetStore, type KeyValueStore } from '../../src/lib/engine/presets/PresetStore';
import {
    SLIME_MOLD_AGENT_CEILING,
    SLIME_MOLD_AGENT_STRIDE,
    SLIME_MOLD_BUDGET_FRACTION,
} from '../../src/lib/engine/gpu/limits';

const ROOT = resolve(__dirname, '../..');
const SHADERS = join(ROOT, 'src-tauri/src/simulations/slime_mold/shaders');

function fakeStorage() {
    const map = new Map<string, string>();
    const store: KeyValueStore = {
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => void map.set(key, value),
        removeItem: (key) => void map.delete(key),
    };
    return store;
}

/** A settings + state pair, since `updateSlimeMoldSetting` needs both. */
function fresh() {
    return { settings: defaultSlimeMoldSettings(), state: defaultSlimeMoldState() };
}

describe('slime-mold settings defaults', () => {
    /**
     * Transcribed field by field from `impl Default for Settings`
     * (src-tauri/src/simulations/slime_mold/settings.rs:166). Written out in
     * full rather than spot-checked: these are what all thirteen built-in
     * presets are merged over, so one wrong number silently changes every one.
     */
    it('matches impl Default for Settings exactly, all fifteen fields', () => {
        expect(defaultSlimeMoldSettings()).toEqual({
            agent_jitter: 0.04,
            agent_possible_starting_headings: [0.0, 360.0],
            agent_sensor_angle: 0.3,
            agent_sensor_distance: 20.0,
            agent_speed_max: 60.0,
            agent_speed_min: 30.0,
            agent_turn_rate: 0.43,
            pheromone_decay_rate: 10.0,
            pheromone_deposition_rate: 100.0,
            pheromone_diffusion_rate: 100.0,
            position_image_fit_mode: 'Fit V',
            diffusion_frequency: 1,
            decay_frequency: 1,
            random_seed: 0,
            background_mode: 'Black',
        });
        expect(Object.keys(defaultSlimeMoldSettings())).toHaveLength(15);
    });

    /**
     * Four of the doc comments in settings.rs disagree with the `impl` directly
     * below them: decay is documented 1.0 and is 10.0, deposition and diffusion
     * are documented 1.0 and are 100.0, and the position fit mode is documented
     * `Stretch` and is `FitV`. Same trap as M4's `GrayScottDiagram.svelte` prop
     * defaults — the prose drifted, the impl is the model.
     */
    it('does not take its values from the stale doc comments', () => {
        const settings = defaultSlimeMoldSettings();
        expect(settings.pheromone_decay_rate).not.toBe(1.0);
        expect(settings.pheromone_deposition_rate).not.toBe(1.0);
        expect(settings.pheromone_diffusion_rate).not.toBe(1.0);
        expect(settings.position_image_fit_mode).not.toBe('Stretch');
    });

    /**
     * The position image fit mode is 'Fit V' while the *mask* image's, on the
     * state side, is `ImageFitMode::default()` = 'Stretch'. Two image slots,
     * two different defaults, in the same simulation.
     */
    it('defaults the two image slots to different fit modes, as the Rust does', () => {
        expect(defaultSlimeMoldSettings().position_image_fit_mode).toBe('Fit V');
        expect(defaultSlimeMoldState().mask_image_fit_mode).toBe('Stretch');
    });

    it('hands out a fresh object each time, the heading range included', () => {
        const first = defaultSlimeMoldSettings();
        first.agent_jitter = 999;
        first.agent_possible_starting_headings[0] = 999;
        expect(defaultSlimeMoldSettings().agent_jitter).toBe(0.04);
        expect(defaultSlimeMoldSettings().agent_possible_starting_headings).toEqual([0, 360]);
    });
});

describe('slime-mold state defaults', () => {
    it('matches impl Default for State, plus the three model-level fields', () => {
        expect(defaultSlimeMoldState()).toEqual({
            mask_pattern: 'Disabled',
            mask_target: 'Pheromone Deposition',
            mask_strength: 0.5,
            mask_curve: 1.0,
            mask_reversed: false,
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
            color_scheme_reversed: true,
            gui_visible: true,
            position_generator: 'Random',
            trail_map_filtering: 'Nearest',
            agent_count: 1_000_000,
            camera_position: [0, 0],
            camera_zoom: 1.0,
            simulation_time: 0.0,
            is_running: true,
        });
    });

    /**
     * **`State::cursor_size = 0.20` (state.rs:216) is a dead field.** Every
     * live read and write goes through `SlimeMoldModel`'s own `cursor_size`,
     * initialised to 300.0 / 5.0 at simulation.rs:522-523, clamped by
     * `update_setting`, written by `update_state`, emitted by `get_state` and
     * packed into `CursorParams`. The units are simulation pixels, which is why
     * `SlimeMoldMode.svelte:71` gives the slider `sizeMin={10} sizeMax={500}`.
     *
     * Transcribing state.rs naively would pin the handle at the left stop with
     * a brush 1500x too small — and it would look like a units bug in the
     * shader, not a wrong default.
     */
    it('takes the cursor defaults from the model, not from the dead State fields', () => {
        const state = defaultSlimeMoldState();
        expect(state.cursor_size).toBe(300);
        expect(state.cursor_strength).toBe(5);

        // Inside the slider's own bounds, which is the corroborating check.
        const [sizeLo, sizeHi] = SLIME_MOLD_CURSOR_SIZE_RANGE;
        const [strengthLo, strengthHi] = SLIME_MOLD_CURSOR_STRENGTH_RANGE;
        expect(state.cursor_size).toBeGreaterThanOrEqual(sizeLo);
        expect(state.cursor_size).toBeLessThanOrEqual(sizeHi);
        expect(state.cursor_strength).toBeGreaterThanOrEqual(strengthLo);
        expect(state.cursor_strength).toBeLessThanOrEqual(strengthHi);
    });

    it('hands out a fresh object each time, arrays included', () => {
        const first = defaultSlimeMoldState();
        first.mouse_position[0] = 99;
        first.cursor_size = 99;
        expect(defaultSlimeMoldState().mouse_position).toEqual([0, 0]);
        expect(defaultSlimeMoldState().cursor_size).toBe(300);
    });

    /**
     * `State` in the Rust carries `mask_image_base` and `mask_image_raw`, two
     * `Option<Vec<f32>>` of width x height, *inside the serialized state*. On a
     * 4K trail map that is eight million JSON numbers per `get_state`.
     */
    it('never puts the mask pixel buffers in the state document', () => {
        const state = defaultSlimeMoldState();
        expect('mask_image_base' in state).toBe(false);
        expect('mask_image_raw' in state).toBe(false);

        state.mask_image_base = new Float32Array(4);
        state.mask_image_raw = new Float32Array(4);
        const doc = slimeMoldStateDocument(state);
        expect('mask_image_base' in doc).toBe(false);
        expect('mask_image_raw' in doc).toBe(false);
        expect(doc.mask_pattern).toBe('Disabled');
    });
});

describe('slime-mold agent-count clamp', () => {
    /** The reference device's cap: 128 MiB x 0.9 / 16 B. */
    const CAP = Math.min(
        SLIME_MOLD_AGENT_CEILING,
        Math.floor((134_217_728 * SLIME_MOLD_BUDGET_FRACTION) / SLIME_MOLD_AGENT_STRIDE)
    );

    it('derives ~7.5 M on a spec-default device', () => {
        expect(CAP).toBe(7_549_747);
    });

    /**
     * The whole point of the clamp. `update_agent_count` takes a bare `u32`
     * (commands/slime_mold.rs:55) into `self.agent_count = count as usize`
     * (simulation.rs:1492) with no validation anywhere in the path, and
     * `SlimeMoldMode.svelte:295` offers `max={100}` million — 1.6 GB in one
     * storage buffer, i.e. a guaranteed device loss.
     */
    it('passes the cap through and reduces cap + 1', () => {
        expect(clampSlimeMoldAgentCount(CAP, CAP)).toBe(CAP);
        expect(clampSlimeMoldAgentCount(CAP + 1, CAP)).toBe(CAP);
        expect(clampSlimeMoldAgentCount(100_000_000, CAP)).toBe(CAP);
    });

    /** A zero-length storage buffer is not a legal binding. */
    it('raises 0 and negatives to the floor rather than rejecting them', () => {
        expect(clampSlimeMoldAgentCount(0, CAP)).toBe(SLIME_MOLD_MIN_AGENTS);
        expect(clampSlimeMoldAgentCount(-1, CAP)).toBe(SLIME_MOLD_MIN_AGENTS);
        expect(clampSlimeMoldAgentCount(-100_000_000, CAP)).toBe(SLIME_MOLD_MIN_AGENTS);
    });

    /**
     * The desktop default is 10 M, hardcoded at both construction sites
     * (manager.rs:266, traits.rs:266). At 16 B that is 160 MB against a 128 MiB
     * binding limit, so the desktop default does not fit in a browser at all —
     * it is reduced, not refused, which is what keeps a desktop settings file
     * loadable.
     */
    it('reduces the desktop default instead of refusing it', () => {
        expect(SLIME_MOLD_DESKTOP_AGENTS * SLIME_MOLD_AGENT_STRIDE).toBeGreaterThan(134_217_728);
        expect(clampSlimeMoldAgentCount(SLIME_MOLD_DESKTOP_AGENTS, CAP)).toBe(CAP);
    });

    /** ~1 M, per WEB_PORT.md's M7 entry, and comfortably under the cap. */
    it('leaves the browser default untouched', () => {
        expect(SLIME_MOLD_DEFAULT_AGENTS).toBe(1_000_000);
        expect(clampSlimeMoldAgentCount(SLIME_MOLD_DEFAULT_AGENTS, CAP)).toBe(
            SLIME_MOLD_DEFAULT_AGENTS
        );
        expect(SLIME_MOLD_DEFAULT_AGENTS * SLIME_MOLD_AGENT_STRIDE).toBe(16_000_000);
    });

    it('floors a fractional count', () => {
        expect(clampSlimeMoldAgentCount(1_500_000.9, CAP)).toBe(1_500_000);
        // AgentCountInput works in millions with a 0.1 step, so 0.1 M is exact.
        expect(clampSlimeMoldAgentCount(0.1 * 1e6, CAP)).toBe(100_000);
    });

    it('falls back to the default for a value that is not a number', () => {
        for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, null, undefined, '2000000', {}]) {
            expect(clampSlimeMoldAgentCount(bad, CAP)).toBe(SLIME_MOLD_DEFAULT_AGENTS);
        }
    });

    /** A cap below the floor must not invert the clamp into 0. */
    it('never returns less than the floor, even for an absurd cap', () => {
        expect(clampSlimeMoldAgentCount(1_000, 0)).toBe(SLIME_MOLD_MIN_AGENTS);
        expect(clampSlimeMoldAgentCount(1_000, -5)).toBe(SLIME_MOLD_MIN_AGENTS);
    });

    /**
     * `AgentCountInput` steps by 0.1 million, so the maximum it offers has to
     * round *down* to a tenth or the top of the range exceeds the cap.
     */
    it('gives the UI a maximum in millions that can never exceed the cap', () => {
        const maxMillions = slimeMoldAgentMaxMillions(CAP);
        expect(maxMillions).toBe(7.5);
        expect(maxMillions * 1e6).toBeLessThanOrEqual(CAP);
        expect(slimeMoldAgentMaxMillions(1_000_000)).toBe(1);
        expect(slimeMoldAgentMaxMillions(1_099_999)).toBe(1);
    });
});

describe('slime-mold update_setting', () => {
    it('accepts every float setting SlimeMoldMode sends', () => {
        const { settings, state } = fresh();
        const cases: Array<[keyof SlimeMoldSettings, number, string]> = [
            ['pheromone_decay_rate', 250, 'sim-params'],
            ['pheromone_deposition_rate', 42, 'sim-params'],
            ['pheromone_diffusion_rate', 7.5, 'sim-params'],
            ['agent_turn_rate', 1.2, 'sim-params'],
            ['agent_jitter', 0.9, 'sim-params'],
            ['agent_sensor_angle', 1.05, 'sim-params'],
            ['agent_sensor_distance', 120, 'sim-params'],
            // Both speed bounds re-randomize every agent's speed on the GPU
            // (simulation.rs:1218, :1225).
            ['agent_speed_min', 80, 'agent-speeds'],
            ['agent_speed_max', 400, 'agent-speeds'],
        ];

        for (const [name, value, effect] of cases) {
            expect(updateSlimeMoldSetting(settings, state, name, value), name).toBe(effect);
            expect(settings[name]).toBe(value);
        }
    });

    it('accepts the three u32 settings and rejects a non-integral one', () => {
        const { settings, state } = fresh();
        for (const name of ['diffusion_frequency', 'decay_frequency', 'random_seed'] as const) {
            expect(updateSlimeMoldSetting(settings, state, name, 4)).toBe('sim-params');
            expect(settings[name]).toBe(4);

            for (const bad of [1.5, -1, 2 ** 32, Number.NaN, '4', null]) {
                expect(() => updateSlimeMoldSetting(settings, state, name, bad), name).toThrow(
                    /unsigned 32-bit integer/
                );
            }
            expect(settings[name]).toBe(4);
        }
    });

    /**
     * **`agent_possible_starting_headings` and `background_mode` have no match
     * arm in the Rust at all** (simulation.rs:1188-1467), so `update_setting`
     * returns `Err("Unknown setting: …")` for either even though both are
     * `Settings` fields. That is reachable here in a way it is not there:
     * `normalizeSlimeMoldSettings` replays a stored document through this
     * function, so without the arms a preset would silently lose the field.
     */
    it('makes the two arm-less Settings fields stick', () => {
        const { settings, state } = fresh();

        expect(
            updateSlimeMoldSetting(settings, state, 'agent_possible_starting_headings', [90, 270])
        ).toBe('none');
        expect(settings.agent_possible_starting_headings).toEqual([90, 270]);

        expect(updateSlimeMoldSetting(settings, state, 'background_mode', 'White')).toBe(
            'background-params'
        );
        expect(settings.background_mode).toBe('White');
    });

    it('rejects a heading range that is not a pair of finite numbers', () => {
        const { settings, state } = fresh();
        // Wrong shape.
        for (const bad of [[0], [0, 1, 2], 360, null, { start: 0, end: 360 }]) {
            expect(() =>
                updateSlimeMoldSetting(settings, state, 'agent_possible_starting_headings', bad)
            ).toThrow(/\[start, end\] pair/);
        }
        // Right shape, unusable contents — caught one element down.
        for (const bad of [
            [0, Number.NaN],
            ['0', '360'],
            [null, 360],
        ]) {
            expect(() =>
                updateSlimeMoldSetting(settings, state, 'agent_possible_starting_headings', bad)
            ).toThrow(/finite number/);
        }
        expect(settings.agent_possible_starting_headings).toEqual([0, 360]);
    });

    /**
     * simulation.rs:1418 matches four literal spellings and ends in
     * `_ => unreachable!()`, which aborts the process on anything else; the two
     * mask enums do the same via `.expect(…)` at :1252 and :1271. Here they
     * throw, `invoke` rejects, and `sync.ts` rolls the optimistic update back.
     */
    it('throws instead of panicking on an unparseable fit mode', () => {
        const { settings, state } = fresh();
        expect(() =>
            updateSlimeMoldSetting(settings, state, 'position_image_fit_mode', 'Squash')
        ).toThrow(/Invalid ImageFitMode/);
        expect(settings.position_image_fit_mode).toBe('Fit V');

        expect(updateSlimeMoldSetting(settings, state, 'position_image_fit_mode', 'Center')).toBe(
            'refit-position-image'
        );
        expect(settings.position_image_fit_mode).toBe('Center');
    });

    /** Neither settings.rs nor update_setting clamps any simulation parameter. */
    it('does not clamp to the ranges the UI puts on its drag boxes', () => {
        const { settings, state } = fresh();
        updateSlimeMoldSetting(settings, state, 'agent_speed_max', 99_999);
        updateSlimeMoldSetting(settings, state, 'agent_jitter', -3);
        updateSlimeMoldSetting(settings, state, 'pheromone_decay_rate', 1e9);

        expect(settings.agent_speed_max).toBe(99_999);
        expect(settings.agent_jitter).toBe(-3);
        expect(settings.pheromone_decay_rate).toBe(1e9);
    });

    /**
     * One NaN in a speed puts every agent's position at NaN inside a frame, and
     * the trail map never recovers — `deposit` writes NaN at a NaN index.
     */
    it('rejects a value that would put a NaN in the uniform', () => {
        const { settings, state } = fresh();
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
            expect(() => updateSlimeMoldSetting(settings, state, 'agent_speed_max', bad)).toThrow(
                /finite number/
            );
        }
        expect(settings.agent_speed_max).toBe(60);
    });

    it('rejects an unknown setting name', () => {
        const { settings, state } = fresh();
        expect(() => updateSlimeMoldSetting(settings, state, 'nope', 1)).toThrow(
            /Unknown setting: nope/
        );
    });

    /**
     * The Rust's `update_setting` also routes thirteen mask/cursor/generator
     * names into `State` or the model. Unlike Gray-Scott — where the Svelte UI
     * never used that path — `ImageSelector` and `ControlsPanel` disagree about
     * which command to use, so both namespaces accept them here.
     */
    it('forwards the state names the Rust settings command also took', () => {
        const { settings, state } = fresh();
        expect(updateSlimeMoldSetting(settings, state, 'mask_pattern', 'Cosine Grid')).toBe(
            'regenerate-mask'
        );
        expect(state.mask_pattern).toBe('Cosine Grid');
        expect(updateSlimeMoldSetting(settings, state, 'cursor_size', 250)).toBe('cursor-params');
        expect(state.cursor_size).toBe(250);
        // …and nothing leaked into settings.
        expect('mask_pattern' in settings).toBe(false);
        expect('cursor_size' in settings).toBe(false);
    });
});

describe('slime-mold update_state', () => {
    it('maps each state name onto the work it actually requires', () => {
        const state = defaultSlimeMoldState();
        const cases: Array<[string, unknown, string]> = [
            ['mask_pattern', 'Radial Gradient', 'regenerate-mask'],
            ['mask_target', 'Agent Speed', 'sim-params'],
            ['mask_strength', 0.75, 'sim-params'],
            ['mask_curve', 2.5, 'sim-params'],
            ['mask_mirror_horizontal', true, 'regenerate-mask'],
            ['mask_mirror_vertical', true, 'regenerate-mask'],
            ['mask_invert_tone', true, 'regenerate-mask'],
            ['mask_image_fit_mode', 'Center', 'refit-mask-image'],
            ['cursor_size', 350, 'cursor-params'],
            ['cursor_strength', 12, 'cursor-params'],
            ['current_color_scheme', 'MATPLOTLIB_viridis', 'reload-lut'],
            ['color_scheme_reversed', false, 'reload-lut'],
            ['position_generator', 'Spiral', 'sim-params'],
            ['trail_map_filtering', 'Linear', 'display-sampler'],
            ['trailMapFiltering', 'Nearest', 'display-sampler'],
        ];

        for (const [name, value, effect] of cases) {
            expect(updateSlimeMoldState(state, name, value), name).toBe(effect);
        }

        expect(state.mask_pattern).toBe('Radial Gradient');
        expect(state.mask_target).toBe('Agent Speed');
        expect(state.mask_strength).toBe(0.75);
        expect(state.mask_curve).toBe(2.5);
        expect(state.mask_image_fit_mode).toBe('Center');
        expect(state.cursor_size).toBe(350);
        expect(state.cursor_strength).toBe(12);
        expect(state.current_color_scheme).toBe('MATPLOTLIB_viridis');
        expect(state.color_scheme_reversed).toBe(false);
        expect(state.position_generator).toBe('Spiral');
        expect(state.trail_map_filtering).toBe('Nearest');
    });

    /**
     * **The position-generator selector is dead on the desktop build.**
     * `SlimeMoldMode.svelte:148` sends `position_generator` through
     * `update_simulation_state`, and `update_state` (simulation.rs:2471) has no
     * arm for it — it lands in the `_ =>` warn at :2630. The only arm that
     * exists is in `update_setting` (:1441), which nothing calls with that
     * name. So every reset re-seeds with `Random`, and the Image generator —
     * with its own file picker, fit-mode control and
     * `load_slime_mold_position_image` command — is unreachable.
     *
     * Same class as M4's three dropped Gray-Scott names.
     */
    it('makes the position generator stick, which it does not in the Rust', () => {
        const state = defaultSlimeMoldState();
        expect(updateSlimeMoldState(state, 'position_generator', 'Image')).toBe('sim-params');
        expect(state.position_generator).toBe('Image');
    });

    /**
     * `mask_reversed` is defaulted, stored, serialized by `get_state` and
     * written by `update_setting` (simulation.rs:1314) — and read by nothing.
     * `SimSizeUniform` has no such member and no shader mentions it. Kept inert
     * for state-shape compatibility; hence 'none', there is no buffer to write.
     */
    it('stores mask_reversed but asks for no GPU work, because nothing reads it', () => {
        const state = defaultSlimeMoldState();
        expect(updateSlimeMoldState(state, 'mask_reversed', true)).toBe('none');
        expect(state.mask_reversed).toBe(true);
    });

    /**
     * `update_state` (simulation.rs:2620) assigns the cursor pair raw while
     * `update_setting` (:1404) clamps to 10..500 and 0..50 — and the UI uses
     * `update_state`. The slider's own bounds are already those numbers, so
     * clamping changes nothing reachable by hand and closes the other door.
     */
    it('clamps the cursor pair, which the Rust’s update_state does not', () => {
        const state = defaultSlimeMoldState();
        updateSlimeMoldState(state, 'cursor_size', 100_000);
        expect(state.cursor_size).toBe(500);
        updateSlimeMoldState(state, 'cursor_size', -20);
        expect(state.cursor_size).toBe(10);
        updateSlimeMoldState(state, 'cursor_strength', 999);
        expect(state.cursor_strength).toBe(50);
        updateSlimeMoldState(state, 'cursor_strength', -1);
        expect(state.cursor_strength).toBe(0);
    });

    it('treats every non-true value as false for the boolean flags', () => {
        const state = defaultSlimeMoldState();
        updateSlimeMoldState(state, 'mask_mirror_horizontal', 'yes');
        expect(state.mask_mirror_horizontal).toBe(false);
        updateSlimeMoldState(state, 'mask_mirror_horizontal', true);
        expect(state.mask_mirror_horizontal).toBe(true);
    });

    it('rejects a non-finite mask strength and an unknown state name', () => {
        const state = defaultSlimeMoldState();
        expect(() => updateSlimeMoldState(state, 'mask_strength', Number.NaN)).toThrow(
            /finite number/
        );
        expect(() => updateSlimeMoldState(state, 'nope', 1)).toThrow(/Unknown state: nope/);
    });

    it('rejects an unparseable mask pattern rather than silently keeping the old one', () => {
        const state = defaultSlimeMoldState();
        expect(() => updateSlimeMoldState(state, 'mask_pattern', 'Spirals')).toThrow(
            /Invalid MaskPattern/
        );
        expect(state.mask_pattern).toBe('Disabled');
    });
});

describe('slime-mold enums', () => {
    /**
     * **The Gray-Scott round-trip bug does not exist here, and that had to be
     * checked rather than assumed.** `get_state` (simulation.rs:2654) emits
     * `as_str()` — the display name — and `SlimeMoldMode.svelte:457` lists the
     * same display names, so the desktop round trip is intact. Canonicalising
     * on serde's spelling would *break* a working control, exactly as M5 found
     * in Vectors.
     *
     * The parser still accepts serde's PascalCase, because `State` derives
     * `Serialize` and a document written that way carries it.
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

        expect(MASK_PATTERNS).toHaveLength(9);
        for (const pattern of MASK_PATTERNS) {
            // Display spelling — as_str(), and what the UI sends and receives.
            expect(parseMaskPattern(pattern)).toBe(pattern);
            expect(parseMaskPattern(pattern.toLowerCase().replace(/ /g, '_'))).toBe(pattern);
            expect(parseMaskPattern(`  ${pattern.toLowerCase()}  `)).toBe(pattern);
        }
        for (const [emitted, canonical] of Object.entries(serde)) {
            expect(parseMaskPattern(emitted)).toBe(canonical);
        }
    });

    it('parses every mask target in all three spellings', () => {
        const serde: Record<string, string> = {
            PheromoneDeposition: 'Pheromone Deposition',
            PheromoneDecay: 'Pheromone Decay',
            PheromoneDiffusion: 'Pheromone Diffusion',
            AgentSpeed: 'Agent Speed',
            AgentTurnRate: 'Agent Turn Rate',
            AgentSensorDistance: 'Agent Sensor Distance',
            TrailMap: 'Trail Map',
        };

        expect(MASK_TARGETS).toHaveLength(7);
        for (const target of MASK_TARGETS) {
            expect(parseMaskTarget(target)).toBe(target);
            expect(parseMaskTarget(target.toLowerCase().replace(/ /g, '_'))).toBe(target);
            expect(parseMaskTarget(target.toLowerCase().replace(/ /g, ''))).toBe(target);
        }
        for (const [emitted, canonical] of Object.entries(serde)) {
            expect(parseMaskTarget(emitted)).toBe(canonical);
        }
    });

    /**
     * The `ButtonSelect` at SlimeMoldMode.svelte:127 sends serde's compact
     * `'UniformCircle'` / `'CenteredCircle'`, which
     * `SlimeMoldPositionGenerator::from_str` (position_generators.rs:155) — a
     * display-names-only match — returns `None` for. On the desktop that falls
     * into `update_setting`'s `else` (simulation.rs:1450) and silently means
     * `Random`. Accepting the compact form makes those two options work.
     */
    it('parses every position generator, compact spelling included', () => {
        expect(POSITION_GENERATORS).toHaveLength(8);
        for (const generator of POSITION_GENERATORS) {
            expect(parsePositionGenerator(generator)).toBe(generator);
            expect(parsePositionGenerator(generator.replace(/ /g, ''))).toBe(generator);
            expect(parsePositionGenerator(generator.toLowerCase().replace(/ /g, '_'))).toBe(
                generator
            );
        }
        expect(parsePositionGenerator('UniformCircle')).toBe('Uniform Circle');
        expect(parsePositionGenerator('CenteredCircle')).toBe('Centered Circle');
    });

    /**
     * Three spellings again, and here **serde's is canonical** — the opposite
     * choice from the mask enums. `background_mode` is a *Settings* field, so
     * the load-bearing path is `get_settings` / `apply_settings` / a stored
     * preset, all of which are plain serde and emit `"Black"`. `as_str()` and
     * `update_slime_mold_background_mode` (commands/slime_mold.rs:234) use
     * lowercase, and `SlimeMoldMode.svelte:672` types the field
     * `'black' | 'white'` — wrong about what the backend returns, but inert,
     * since no control renders it.
     */
    it('parses background modes in both spellings, serde’s canonical', () => {
        expect(BACKGROUND_MODES).toEqual(['Black', 'White']);
        expect(parseBackgroundMode('Black')).toBe('Black');
        expect(parseBackgroundMode('black')).toBe('Black');
        expect(parseBackgroundMode('White')).toBe('White');
        expect(parseBackgroundMode('white')).toBe('White');
        expect(() => parseBackgroundMode('grey')).toThrow(/Invalid BackgroundMode/);
    });

    /** The one enum whose serde, `as_str`, `Display` and `from_str` all agree. */
    it('parses trail-map filtering', () => {
        expect(TRAIL_MAP_FILTERINGS).toEqual(['Nearest', 'Linear']);
        expect(parseTrailMapFiltering('Nearest')).toBe('Nearest');
        expect(parseTrailMapFiltering('linear')).toBe('Linear');
        expect(() => parseTrailMapFiltering('Lanczos')).toThrow(/Invalid TrailMapFiltering/);
    });

    it('rejects anything that is not a variant', () => {
        expect(() => parseMaskPattern('Spirals')).toThrow(/Invalid MaskPattern/);
        expect(() => parseMaskPattern(null)).toThrow(/Invalid MaskPattern/);
        expect(() => parseMaskTarget('Pheromone')).toThrow(/Invalid MaskTarget/);
        expect(() => parseMaskTarget(undefined)).toThrow(/Invalid MaskTarget/);
        expect(() => parsePositionGenerator('Grid')).toThrow(/Invalid PositionGenerator/);
    });

    it('parses fit modes through the shared parser', () => {
        expect(parseFitMode('Stretch')).toBe('Stretch');
        expect(parseFitMode('fitv')).toBe('Fit V');
        expect(() => parseFitMode('Squash')).toThrow(/Invalid ImageFitMode/);
    });
});

describe('slime-mold shader enum codes', () => {
    const compute = readFileSync(join(SHADERS, 'compute.wgsl'), 'utf8');
    const gradient = readFileSync(join(SHADERS, 'gradient.wgsl'), 'utf8');
    const background = readFileSync(join(SHADERS, 'background_render.wgsl'), 'utf8');

    it('numbers the mask patterns 0..8 in declaration order', () => {
        expect(MASK_PATTERNS.map((p) => MASK_PATTERN_CODE[p])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    });

    /** gradient.wgsl:35-43 names every one of them as a constant. */
    it('agrees with the MASK_* constants written in gradient.wgsl', () => {
        for (const [name, code] of [
            ['MASK_DISABLED', 0],
            ['MASK_CHECKERBOARD', 1],
            ['MASK_DIAGONAL_GRADIENT', 2],
            ['MASK_RADIAL_GRADIENT', 3],
            ['MASK_VERTICAL_STRIPES', 4],
            ['MASK_HORIZONTAL_STRIPES', 5],
            ['MASK_WAVE_FUNCTION', 6],
            ['MASK_COSINE_GRID', 7],
            ['MASK_IMAGE', 8],
        ] as const) {
            expect(gradient, name).toContain(`const ${name}: u32 = ${code}u;`);
        }
    });

    /**
     * **0..6, and this one is a transcription, not a fix.** Gray-Scott's target
     * codes had to be corrected because the Rust uploaded `as u32` (0..4)
     * against a shader switching on 1..5 while an uncalled `From` impl produced
     * the right numbers. Here `SimSizeUniform::new` (simulation.rs:72) uploads
     * `u32::from(state.mask_target)`, the `From` impl (state.rs:139) yields
     * 0..6, and the shader's three disjoint branch sets cover exactly 0..6.
     * Checked, not assumed.
     */
    it('numbers the mask targets 0..6, matching both the upload and the shader', () => {
        expect(MASK_TARGETS.map((t) => MASK_TARGET_CODE[t])).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(MASK_TARGET_CODE['Pheromone Deposition']).toBe(0);
    });

    it('agrees with the mask-target branches actually written in compute.wgsl', () => {
        // The agent-update pass (compute.wgsl:203).
        expect(compute).toContain('if (sim_size.mask_target == 0u) { // PheromoneDeposition');
        expect(compute).toContain('} else if (sim_size.mask_target == 3u) { // AgentSpeed');
        expect(compute).toContain('} else if (sim_size.mask_target == 4u) { // AgentTurnRate');
        expect(compute).toContain(
            '} else if (sim_size.mask_target == 5u) { // AgentSensorDistance'
        );
        expect(compute).toContain('} else if (sim_size.mask_target == 6u) { // TrailMap');
        // The decay pass (:353) and the diffusion pass (:386) carry the other two.
        expect(compute).toContain('if (sim_size.mask_target == 1u) { // PheromoneDecay');
        expect(compute).toContain('if (sim_size.mask_target == 2u) { // PheromoneDiffusion');
    });

    it('agrees with the position-generator switch arms in compute.wgsl', () => {
        const body = compute.slice(compute.indexOf('switch (sim_size.position_generator)'));
        const arms: Array<[string, PositionGeneratorName]> = [
            ['case 0u: { // Random', 'Random'],
            ['case 1u: { // Center', 'Center'],
            ['case 2u: { // UniformCircle', 'Uniform Circle'],
            ['case 3u: { // CenteredCircle', 'Centered Circle'],
            ['case 4u: { // Ring', 'Ring'],
            ['case 5u: { // Line', 'Line'],
            ['case 6u: { // Spiral', 'Spiral'],
            ['case 7u: { // Image', 'Image'],
        ];
        for (const [arm, variant] of arms) {
            expect(body, arm).toContain(arm);
            expect(POSITION_GENERATOR_CODE[variant]).toBe(Number(arm.slice(5, arm.indexOf('u:'))));
        }
    });

    it('numbers the background modes as background_render.wgsl reads them', () => {
        expect(BACKGROUND_MODE_CODE).toEqual({ Black: 0, White: 1 });
        expect(background).toContain('if (background_params.background_type == 0u) {');
        expect(background).toContain('} else if (background_params.background_type == 1u) {');
    });
});

type PositionGeneratorName = (typeof POSITION_GENERATORS)[number];

describe('slime-mold applySettings normalization', () => {
    it('fills a partial document from the defaults', () => {
        const merged = normalizeSlimeMoldSettings({ agent_jitter: 0.1, agent_turn_rate: 0.93 });
        expect(merged).toEqual({
            ...defaultSlimeMoldSettings(),
            agent_jitter: 0.1,
            agent_turn_rate: 0.93,
        });
    });

    it('keeps the defaults for a document that is not an object', () => {
        for (const bad of [null, undefined, 7, 'x', [1, 2]]) {
            expect(normalizeSlimeMoldSettings(bad)).toEqual(defaultSlimeMoldSettings());
        }
    });

    it('drops a key it cannot use rather than refusing the whole preset', () => {
        const merged = normalizeSlimeMoldSettings({
            agent_jitter: 0.5,
            from_a_newer_build: 'whatever',
            agent_speed_max: 'not a number',
        });
        expect(merged.agent_jitter).toBe(0.5);
        expect(merged.agent_speed_max).toBe(defaultSlimeMoldSettings().agent_speed_max);
        expect('from_a_newer_build' in merged).toBe(false);
    });

    /**
     * A `get_state` document contains mask and cursor names that this function
     * happily parses — they must not end up in the settings object, or
     * `applySettings` would start writing state through the settings path.
     */
    it('absorbs state names without letting them into the settings object', () => {
        const merged = normalizeSlimeMoldSettings({
            agent_jitter: 0.5,
            mask_pattern: 'Cosine Grid',
            cursor_size: 400,
        });
        expect(Object.keys(merged).sort()).toEqual(Object.keys(defaultSlimeMoldSettings()).sort());
    });

    /** The whole settings document round-trips unchanged. */
    it('is idempotent on a complete document', () => {
        const settings = defaultSlimeMoldSettings();
        settings.background_mode = 'White';
        settings.agent_possible_starting_headings = [45, 315];
        expect(normalizeSlimeMoldSettings(settings)).toEqual(settings);
    });
});

describe('slime-mold randomize', () => {
    const DEG = Math.PI / 180;

    /** Ranges from `Settings::randomize` (settings.rs:190). */
    it('keeps every randomized parameter inside its Rust range', () => {
        for (const sample of [0, 0.5, 1 - 1e-9]) {
            const settings = defaultSlimeMoldSettings();
            randomizeSlimeMoldSettings(settings, () => sample);

            expect(settings.agent_speed_min).toBeGreaterThanOrEqual(0);
            expect(settings.agent_speed_min).toBeLessThan(500);
            // Always drawn above the fresh minimum, so the pair is ordered.
            expect(settings.agent_speed_max).toBeGreaterThanOrEqual(settings.agent_speed_min);
            expect(settings.agent_speed_max).toBeLessThanOrEqual(500);
            expect(settings.agent_turn_rate).toBeGreaterThanOrEqual(0);
            expect(settings.agent_turn_rate).toBeLessThan(360 * DEG);
            expect(settings.agent_jitter).toBeGreaterThanOrEqual(0);
            expect(settings.agent_jitter).toBeLessThan(1);
            expect(settings.agent_sensor_angle).toBeGreaterThanOrEqual(0);
            expect(settings.agent_sensor_angle).toBeLessThan(180 * DEG);
            expect(settings.agent_sensor_distance).toBeGreaterThanOrEqual(0);
            expect(settings.agent_sensor_distance).toBeLessThan(500);

            const [start, end] = settings.agent_possible_starting_headings;
            expect(start).toBeGreaterThanOrEqual(0);
            expect(end).toBeGreaterThanOrEqual(start);
            expect(end).toBeLessThanOrEqual(360);

            expect(Number.isInteger(settings.random_seed)).toBe(true);
            expect(settings.random_seed).toBeGreaterThanOrEqual(0);
            expect(settings.random_seed).toBeLessThan(2 ** 32);
        }
    });

    it('lands exactly on the low end of each range for rng() = 0', () => {
        const settings = defaultSlimeMoldSettings();
        randomizeSlimeMoldSettings(settings, () => 0);
        expect(settings.agent_speed_min).toBe(0);
        expect(settings.agent_speed_max).toBe(0);
        expect(settings.agent_turn_rate).toBe(0);
        expect(settings.agent_jitter).toBe(0);
        expect(settings.agent_sensor_angle).toBe(0);
        expect(settings.agent_sensor_distance).toBe(0);
        expect(settings.agent_possible_starting_headings).toEqual([0, 0]);
        expect(settings.random_seed).toBe(0);
    });

    /**
     * **Only eight fields can move.** `randomize` assigns nine constants as
     * well, and four of them are already the default: deposition and diffusion
     * are pinned to 100.0 (their default) and both frequencies to 1 (theirs).
     * The ninth, `pheromone_decay_rate`, is pinned to 100.0 against a default
     * of **10.0** — so Randomize permanently multiplies the trail decay by ten,
     * and nothing but loading a preset ever puts it back. Faithful, and pinned
     * here because it looks like a bug the first three times you read it.
     */
    it('moves exactly the eight fields it can, decay included', () => {
        const settings = defaultSlimeMoldSettings();
        let n = 0;
        randomizeSlimeMoldSettings(settings, () => ((n = (n + 0.37) % 1), n));

        const defaults = defaultSlimeMoldSettings();
        const moved = (Object.keys(defaults) as Array<keyof SlimeMoldSettings>).filter(
            (key) => JSON.stringify(settings[key]) !== JSON.stringify(defaults[key])
        );
        expect(moved.sort()).toEqual([
            'agent_jitter',
            'agent_possible_starting_headings',
            'agent_sensor_angle',
            'agent_sensor_distance',
            'agent_speed_max',
            'agent_speed_min',
            'agent_turn_rate',
            'pheromone_decay_rate',
            'random_seed',
        ]);

        expect(settings.pheromone_decay_rate).toBe(100);
        expect(defaults.pheromone_decay_rate).toBe(10);
    });

    it('pins the three rates and the two frequencies to constants', () => {
        const settings = defaultSlimeMoldSettings();
        settings.pheromone_deposition_rate = 1;
        settings.pheromone_diffusion_rate = 1;
        settings.diffusion_frequency = 9;
        settings.decay_frequency = 9;

        randomizeSlimeMoldSettings(settings, () => 0.5);
        expect(settings.pheromone_decay_rate).toBe(100);
        expect(settings.pheromone_deposition_rate).toBe(100);
        expect(settings.pheromone_diffusion_rate).toBe(100);
        expect(settings.diffusion_frequency).toBe(1);
        expect(settings.decay_frequency).toBe(1);
    });

    /** Mask settings are runtime state; settings.rs:205 says so explicitly. */
    it('leaves the fit mode and background mode alone', () => {
        const settings = defaultSlimeMoldSettings();
        settings.position_image_fit_mode = 'Center';
        settings.background_mode = 'White';
        randomizeSlimeMoldSettings(settings, () => 0.5);
        expect(settings.position_image_fit_mode).toBe('Center');
        expect(settings.background_mode).toBe('White');
    });

    /** Whatever it produces must survive the settings path unchanged. */
    it('produces a document normalize accepts verbatim', () => {
        const settings = defaultSlimeMoldSettings();
        randomizeSlimeMoldSettings(settings, Math.random);
        expect(normalizeSlimeMoldSettings(settings)).toEqual(settings);
    });
});

describe('slime-mold uniform packing', () => {
    const inputs = { width: 1920, height: 1080 };

    /**
     * `struct SimSizeUniform` (simulation.rs:23) and `compute.wgsl:6` — 20
     * four-byte scalars in this exact order. Take the order from `compute.wgsl`
     * only: `gradient.wgsl:9` stops at 19 members with `_pad1` where
     * `random_seed` goes, and `display.wgsl:4` names slots 11..17
     * `gradient_enabled` … `gradient_angle`, a stale struct from a feature that
     * no longer exists. Neither reads those slots, so neither is broken — but
     * neither is the layout either.
     */
    it('writes struct SimSizeUniform in compute.wgsl declaration order', () => {
        const settings = defaultSlimeMoldSettings();
        const state = defaultSlimeMoldState();
        settings.random_seed = 123;
        state.mask_pattern = 'Wave Function';
        state.mask_target = 'Agent Turn Rate';
        state.mask_strength = 0.75;
        state.mask_curve = 2.0;
        state.mask_mirror_vertical = true;
        state.position_generator = 'Spiral';

        const buffer = packSlimeMoldSimSize(settings, state, inputs);
        expect(buffer.byteLength).toBe(SLIME_MOLD_SIM_SIZE_BYTES);
        expect(SLIME_MOLD_SIM_SIZE_BYTES).toBe(80);
        expect(SLIME_MOLD_SIM_SIZE_SCALARS).toBe(20);

        const view = new DataView(buffer);
        const f = (slot: number) => view.getFloat32(slot * 4, true);
        const u = (slot: number) => view.getUint32(slot * 4, true);

        expect(u(0)).toBe(1920); // width
        expect(u(1)).toBe(1080); // height
        expect(f(2)).toBe(10); // decay_rate <- pheromone_decay_rate
        expect(f(3)).toBeCloseTo(0.04, 6); // agent_jitter
        expect(f(4)).toBe(30); // agent_speed_min
        expect(f(5)).toBe(60); // agent_speed_max
        expect(f(6)).toBeCloseTo(0.43, 6); // agent_turn_rate
        expect(f(7)).toBeCloseTo(0.3, 6); // agent_sensor_angle
        expect(f(8)).toBe(20); // agent_sensor_distance
        expect(f(9)).toBe(100); // diffusion_rate <- pheromone_diffusion_rate
        expect(f(10)).toBe(100); // pheromone_deposition_rate
        expect(u(11)).toBe(MASK_PATTERN_CODE['Wave Function']); // 6
        expect(u(12)).toBe(MASK_TARGET_CODE['Agent Turn Rate']); // 4
        expect(f(13)).toBe(0.75); // mask_strength
        expect(f(14)).toBe(2.0); // mask_curve
        expect(u(15)).toBe(0); // mask_mirror_horizontal
        expect(u(16)).toBe(1); // mask_mirror_vertical
        expect(u(17)).toBe(0); // mask_invert_tone
        expect(u(18)).toBe(123); // random_seed
        expect(u(19)).toBe(POSITION_GENERATOR_CODE.Spiral); // 6
    });

    /**
     * Six of the twenty members are `u32` in the WGSL, so writing them through
     * the float view would put 1065353216 where the shader reads 1.
     */
    it('writes the u32 members as integers, not as float bit patterns', () => {
        const state = defaultSlimeMoldState();
        state.mask_mirror_horizontal = true;
        state.mask_invert_tone = true;
        const settings = defaultSlimeMoldSettings();
        settings.random_seed = 1;

        const u32 = new Uint32Array(packSlimeMoldSimSize(settings, state, { width: 1, height: 1 }));
        expect(u32[0]).toBe(1);
        expect(u32[1]).toBe(1);
        expect(u32[15]).toBe(1);
        expect(u32[17]).toBe(1);
        expect(u32[18]).toBe(1);
    });

    it("reuses the caller's scratch buffer", () => {
        const scratch = new ArrayBuffer(SLIME_MOLD_SIM_SIZE_BYTES);
        expect(
            packSlimeMoldSimSize(
                defaultSlimeMoldSettings(),
                defaultSlimeMoldState(),
                inputs,
                scratch
            )
        ).toBe(scratch);
    });

    /** `struct CursorParams` (simulation.rs:84) — 5 live scalars plus 3 pads. */
    it('writes struct CursorParams with its three pad words', () => {
        const state = defaultSlimeMoldState();
        const buffer = packSlimeMoldCursorParams(state, { mode: 2, x: 640.5, y: 360.25 });
        expect(buffer.byteLength).toBe(SLIME_MOLD_CURSOR_PARAM_BYTES);

        const view = new DataView(buffer);
        expect(view.getUint32(0, true)).toBe(2); // is_active: repel
        expect(view.getFloat32(4, true)).toBe(640.5);
        expect(view.getFloat32(8, true)).toBe(360.25);
        expect(view.getFloat32(12, true)).toBe(5); // strength
        expect(view.getFloat32(16, true)).toBe(300); // size
        expect(view.getUint32(20, true)).toBe(0);
        expect(view.getUint32(24, true)).toBe(0);
        expect(view.getUint32(28, true)).toBe(0);
    });

    /**
     * `struct BackgroundParams` (simulation.rs:100) is 8 scalars, but
     * `background_render.wgsl:1` declares **one member** and reads only
     * `background_type`. The other seven are dead — `update_background_params`
     * (simulation.rs:2235) rewriting them on a mask change cannot alter a pixel.
     */
    it('writes struct BackgroundParams, only the first slot of which is read', () => {
        const settings = defaultSlimeMoldSettings();
        settings.background_mode = 'White';
        const state = defaultSlimeMoldState();
        state.mask_pattern = 'Checkerboard';
        state.mask_strength = 0.25;
        state.mask_invert_tone = true;

        const view = new DataView(packSlimeMoldBackgroundParams(settings, state));
        expect(view.byteLength).toBe(SLIME_MOLD_BACKGROUND_PARAM_BYTES);
        expect(view.getUint32(0, true)).toBe(1); // background_type: white
        expect(view.getUint32(4, true)).toBe(1); // mask_enabled
        expect(view.getUint32(8, true)).toBe(MASK_PATTERN_CODE.Checkerboard);
        expect(view.getFloat32(12, true)).toBe(0.25);
        expect(view.getUint32(16, true)).toBe(0);
        expect(view.getUint32(20, true)).toBe(0);
        expect(view.getUint32(24, true)).toBe(1); // mask_invert_tone
        expect(view.getUint32(28, true)).toBe(0); // _pad0
    });

    it('reports the mask disabled when the pattern is Disabled', () => {
        const view = new DataView(
            packSlimeMoldBackgroundParams(defaultSlimeMoldSettings(), defaultSlimeMoldState())
        );
        expect(view.getUint32(0, true)).toBe(0); // black
        expect(view.getUint32(4, true)).toBe(0); // mask_enabled
    });
});

describe('slime-mold built-in presets', () => {
    it('registers the thirteen presets from slime_mold/mod.rs in order', () => {
        expect(getBuiltinPresets('slime_mold').map((p) => p.name)).toEqual([
            'Default',
            'Gloop Loops',
            'Firecracker Trees',
            'Threads',
            'Snake',
            'Cells',
            'Net',
            'Bars',
            'Healthy Fungus',
            'Sand On A Speaker',
            'Spots',
            'Cascades',
            'Venom',
        ]);
        expect(SLIME_MOLD_BUILTIN_PRESETS).toHaveLength(13);
    });

    /** mod.rs:21 — `Preset::new("Default", Settings::default())`. */
    it('gives "Default" no overrides at all', () => {
        expect(SLIME_MOLD_BUILTIN_PRESETS[0]).toEqual({ name: 'Default', settings: {} });
    });

    /**
     * Every entry is written `Settings { .., ..Settings::default() }`, so
     * "only the fields that differ" is a straight transcription here — unlike
     * gray_scott/mod.rs, where all nine presets spelled out a complete literal
     * and three of its values disagreed with the defaults. Checked by asserting
     * that no preset names a *settings* key outside the model, and that the
     * eight keys the Rust literals use are the only ones present.
     */
    it('names only real settings keys, and only the eight the Rust literals use', () => {
        const allowed = new Set([
            'agent_jitter',
            'agent_turn_rate',
            'agent_speed_min',
            'agent_speed_max',
            'agent_sensor_angle',
            'agent_sensor_distance',
            'pheromone_decay_rate',
            'pheromone_deposition_rate',
            'pheromone_diffusion_rate',
        ]);
        const model = new Set(Object.keys(defaultSlimeMoldSettings()));
        for (const preset of SLIME_MOLD_BUILTIN_PRESETS) {
            for (const key of Object.keys(preset.settings)) {
                expect(model.has(key), `${preset.name}.${key}`).toBe(true);
                expect(allowed.has(key), `${preset.name}.${key}`).toBe(true);
            }
        }
    });

    /**
     * Six of thirteen pin `pheromone_decay_rate: 100.0` against a default of
     * 10.0, and Cells and Net pin 30.0 and 400.0. A 10x difference in how fast
     * trails fade is the most visible parameter in this simulation, so these
     * are load-bearing, not garnish — and the five that omit it really do run
     * at the slower default.
     */
    it('carries the decay-rate overrides exactly as mod.rs writes them', () => {
        const decay = Object.fromEntries(
            SLIME_MOLD_BUILTIN_PRESETS.map((p) => [p.name, p.settings.pheromone_decay_rate])
        );
        expect(decay).toEqual({
            Default: undefined,
            'Gloop Loops': 100.0,
            'Firecracker Trees': undefined,
            Threads: 100.0,
            Snake: undefined,
            Cells: 30.0,
            Net: 400.0,
            Bars: 100.0,
            'Healthy Fungus': 100.0,
            'Sand On A Speaker': 100.0,
            Spots: 100.0,
            Cascades: 100.0,
            Venom: undefined,
        });
        expect(defaultSlimeMoldSettings().pheromone_decay_rate).toBe(10);
    });

    /**
     * Three presets name a value that already equals the default —
     * `agent_sensor_angle: 0.3` in Firecracker Trees, Threads and Venom (which
     * also names `agent_sensor_distance: 20.0`), and `agent_turn_rate: 0.43` in
     * Gloop Loops. Kept rather than pruned so the diff against mod.rs stays
     * readable; the house rule is "no field that differs is missing", not
     * "no field that matches is present".
     */
    it('keeps the redundant keys the Rust literals also spell out', () => {
        const defaults = defaultSlimeMoldSettings();
        const byName = Object.fromEntries(SLIME_MOLD_BUILTIN_PRESETS.map((p) => [p.name, p]));
        expect(byName['Gloop Loops'].settings.agent_turn_rate).toBe(defaults.agent_turn_rate);
        expect(byName['Firecracker Trees'].settings.agent_sensor_angle).toBe(
            defaults.agent_sensor_angle
        );
        expect(byName.Threads.settings.agent_sensor_angle).toBe(defaults.agent_sensor_angle);
        expect(byName.Venom.settings.agent_sensor_distance).toBe(defaults.agent_sensor_distance);
    });

    it('loads all thirteen into complete settings through the store', () => {
        const store = new PresetStore(fakeStorage());
        const defaults = defaultSlimeMoldSettings();

        for (const builtin of SLIME_MOLD_BUILTIN_PRESETS) {
            const loaded = store.get('slime_mold', builtin.name, defaults);
            expect(loaded, builtin.name).toBeDefined();

            const settings = loaded!.settings as unknown as SlimeMoldSettings;
            expect(Object.keys(settings).sort()).toEqual(Object.keys(defaults).sort());
            // Everything the preset does not name comes from the defaults.
            for (const [key, value] of Object.entries(defaults)) {
                if (key in builtin.settings) continue;
                expect(settings[key as keyof SlimeMoldSettings], `${builtin.name}.${key}`).toEqual(
                    value
                );
            }
            // And what it does name survives the round trip into the engine.
            expect(normalizeSlimeMoldSettings(settings)).toEqual(settings);
        }
    });

    it('produces the exact settings the Rust literal built, for Net', () => {
        const store = new PresetStore(fakeStorage());
        expect(store.get('slime_mold', 'Net', defaultSlimeMoldSettings())!.settings).toEqual({
            agent_jitter: 3.0,
            agent_possible_starting_headings: [0.0, 360.0],
            agent_sensor_angle: 1.57,
            agent_sensor_distance: 225.0,
            agent_speed_max: 100.0,
            agent_speed_min: 99.0,
            agent_turn_rate: 6.0,
            pheromone_decay_rate: 400.0,
            pheromone_deposition_rate: 100.0,
            pheromone_diffusion_rate: 100.0,
            position_image_fit_mode: 'Fit V',
            diffusion_frequency: 1,
            decay_frequency: 1,
            random_seed: 0,
            background_mode: 'Black',
        });
    });

    /** "Default" is `Settings::default()` and must come back byte-identical. */
    it('resolves "Default" to the defaults exactly', () => {
        const store = new PresetStore(fakeStorage());
        expect(store.get('slime_mold', 'Default', defaultSlimeMoldSettings())!.settings).toEqual(
            defaultSlimeMoldSettings()
        );
    });

    /**
     * `agent_possible_starting_headings` is an array, and `mergeValues`
     * replaces arrays wholesale rather than merging element-wise — a preset
     * carrying `[90, 270]` must not come back as `[90, 270]` merged over
     * `[0, 360]` in some other shape.
     */
    it('replaces the heading range wholesale rather than merging it', () => {
        const storage = fakeStorage();
        new PresetStore(storage).save('slime_mold', 'Narrow', {
            ...defaultSlimeMoldSettings(),
            agent_possible_starting_headings: [90, 270],
        });
        const loaded = new PresetStore(storage).get(
            'slime_mold',
            'Narrow',
            defaultSlimeMoldSettings()
        );
        expect(loaded!.settings.agent_possible_starting_headings).toEqual([90, 270]);
    });

    it('round-trips a saved user preset', () => {
        const storage = fakeStorage();
        const defaults = defaultSlimeMoldSettings();

        const mine = { ...defaults, agent_jitter: 0.777, background_mode: 'White' as const };
        new PresetStore(storage).save('slime_mold', 'Mine', mine);

        const store = new PresetStore(storage);
        expect(store.names('slime_mold', defaults)).toEqual([
            'Default',
            'Gloop Loops',
            'Firecracker Trees',
            'Threads',
            'Snake',
            'Cells',
            'Net',
            'Bars',
            'Healthy Fungus',
            'Sand On A Speaker',
            'Spots',
            'Cascades',
            'Venom',
            'Mine',
        ]);
        expect(store.get('slime_mold', 'Mine', defaults)!.settings).toEqual(mine);
    });

    /**
     * "Default" is a built-in *name*, so `PresetStore.list` permanently shadows
     * a user preset saved under it — built-ins win on a name clash
     * (preset_manager.rs:113). The save appears to succeed and the value never
     * comes back.
     */
    it('permanently shadows a user preset named "Default"', () => {
        const storage = fakeStorage();
        const defaults = defaultSlimeMoldSettings();
        new PresetStore(storage).save('slime_mold', 'Default', {
            ...defaults,
            agent_jitter: 0.001,
        });

        const store = new PresetStore(storage);
        expect(store.names('slime_mold', defaults).filter((n) => n === 'Default')).toHaveLength(1);
        expect(store.get('slime_mold', 'Default', defaults)!.settings.agent_jitter).toBe(0.04);
        expect(new PresetStore(storage).hasUserPreset('slime_mold', 'Default')).toBe(true);
    });

    /**
     * The forward-compatible merge: a preset written before `background_mode`
     * and the two frequencies existed still loads, with the missing keys coming
     * from the defaults. Presets live in `localStorage`, so they outlive every
     * deploy and there is no migration step to hang a fixup on.
     */
    it('survives a preset written before three of the fields existed', () => {
        const storage = fakeStorage();
        new PresetStore(storage).save('slime_mold', 'Ancient', {
            agent_jitter: 0.1,
            agent_sensor_angle: 0.7,
            agent_speed_max: 300.0,
            pheromone_decay_rate: 100.0,
        });

        const loaded = new PresetStore(storage).get(
            'slime_mold',
            'Ancient',
            defaultSlimeMoldSettings()
        );
        expect(loaded!.settings).toEqual({
            ...defaultSlimeMoldSettings(),
            agent_jitter: 0.1,
            agent_sensor_angle: 0.7,
            agent_speed_max: 300.0,
            pheromone_decay_rate: 100.0,
        });
        expect(normalizeSlimeMoldSettings(loaded!.settings)).toEqual(loaded!.settings);
    });
});
