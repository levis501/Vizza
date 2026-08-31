/**
 * An `EngineContext` with no GPU behind it.
 *
 * Playwright's launcher makes `navigator.gpu` undefined regardless of flags, so
 * the DOM layer can never exercise a real engine (WEB_PORT.md, "Test strategy":
 * *L4 runs against a fake engine*). Without one, every menu in the app is
 * untestable: `get_current_settings` returns `{}`, the mode components render
 * `loading={loading || !settings}` forever, and no control can be shown to
 * round-trip through `update_simulation_setting`.
 *
 * This is the payoff of `EngineContext` being an interface rather than a
 * concrete host: the same handlers, the same registry, the same `PresetStore`,
 * with in-memory settings instead of a device.
 *
 * **DEV only.** `bootstrap.ts` reaches it through a dynamic import inside an
 * `import.meta.env.DEV` block, so the production bundle contains none of it.
 */

import type { EngineContext } from '$lib/rpc';
import { emit } from '$lib/rpc';
import type { CameraState, Caps } from '$lib/engine/types';
import { slimeMoldAgentCap } from '$lib/engine/gpu/limits';
import { setEngineContext } from '$lib/rpc/context';
import {
    defaultMoireSettings,
    normalizeMoireSettings,
    updateMoireSetting,
} from '$lib/engine/sims/moire/settings';
import {
    defaultGrayScottSettings,
    defaultGrayScottState,
    normalizeGrayScottSettings,
    updateGrayScottSetting,
    updateGrayScottState,
} from '$lib/engine/sims/grayScott/settings';
import { GRADIENT_DISPLAY_MODE, parseGradientDisplayMode } from '$lib/engine/sims/gradient';
import {
    defaultVectorsSettings,
    defaultVectorsState,
    normalizeVectorsSettings,
    updateVectorsSetting,
    updateVectorsState,
    vectorsStateDocument,
    type VectorsState,
} from '$lib/engine/sims/vectors/settings';
import {
    defaultSlimeMoldSettings,
    defaultSlimeMoldState,
    normalizeSlimeMoldSettings,
    slimeMoldStateDocument,
    updateSlimeMoldSetting,
    updateSlimeMoldState,
    type SlimeMoldState,
} from '$lib/engine/sims/slimeMold/settings';

/**
 * Runtime state the moded UIs read when a simulation has no ported state model.
 *
 * Moiré's shape, because Moiré was the first mode wired up and its menu binds
 * `color_scheme_name` / `color_scheme_reversed` directly.
 */
function legacyDefaultState(width: number, height: number): Record<string, unknown> {
    return {
        color_scheme_name: 'ZELDA_Fordite',
        color_scheme_reversed: false,
        time: 0,
        width,
        height,
    };
}

/** How one simulation's settings behave, so the fake is not moiré-specific. */
interface SettingsModel {
    defaults(): Record<string, unknown>;
    /**
     * `state` is passed because Slime Mold's `update_setting` accepts several
     * *state* names too — the Rust does (simulation.rs:1248-1400 covers the
     * whole mask block) and `ImageSelector`/`ControlsPanel` disagree about
     * which command to use, so both have to work.
     */
    update(
        settings: Record<string, unknown>,
        name: string,
        value: unknown,
        state: Record<string, unknown>
    ): void;
    normalize(input: unknown): Record<string, unknown>;
    /**
     * Runtime state, for a simulation whose menu reads more than the colour
     * scheme. Optional: a mode with no state model keeps `legacyDefaultState`.
     */
    state?(): Record<string, unknown>;
    /**
     * Project the stored state onto what `getState()` actually hands out.
     *
     * Only needed where the two differ — Vectors keeps four geometry-cache
     * fields that its `get_state` never returned, and a fake that leaked them
     * would let a mode bind to a field the real engine never sends.
     */
    stateDocument?(state: Record<string, unknown>): Record<string, unknown>;
    /**
     * Apply one `update_simulation_state`. Optional for the same reason, and
     * worth providing where it exists: the real model *throws* on an unknown
     * name, which is what `sync.ts` needs in order to roll an optimistic update
     * back. A fake that accepts everything cannot exercise that path.
     */
    updateState?(state: Record<string, unknown>, name: string, value: unknown): void;
}

/**
 * A simulation with no ported settings module: accept anything, remember it.
 * That is enough for navigation tests, and wrong in no way a DOM test can see.
 */
const PERMISSIVE: SettingsModel = {
    defaults: () => ({}),
    update: (settings, name, value) => void (settings[name] = value),
    normalize: (input) =>
        typeof input === 'object' && input !== null && !Array.isArray(input)
            ? { ...(input as Record<string, unknown>) }
            : {},
};

const MODELS: Record<string, SettingsModel> = {
    moire: {
        defaults: () => defaultMoireSettings() as unknown as Record<string, unknown>,
        update: (settings, name, value) =>
            void updateMoireSetting(
                settings as unknown as Parameters<typeof updateMoireSetting>[0],
                name,
                value
            ),
        normalize: (input) => normalizeMoireSettings(input) as unknown as Record<string, unknown>,
    },
    gray_scott: {
        defaults: () => defaultGrayScottSettings() as unknown as Record<string, unknown>,
        update: (settings, name, value) =>
            void updateGrayScottSetting(
                settings as unknown as Parameters<typeof updateGrayScottSetting>[0],
                name,
                value
            ),
        normalize: (input) =>
            normalizeGrayScottSettings(input) as unknown as Record<string, unknown>,
        state: () => defaultGrayScottState() as unknown as Record<string, unknown>,
        // The mask enums round-trip through here, which is the whole point of
        // giving Gray-Scott a real state model: `getState()` must hand back the
        // *canonical* spelling of what was set, or the <Selector> in
        // GrayScottMode falls back to its placeholder and its ◀/▶ buttons cycle
        // from indexOf() === -1. A `state[name] = value` fake would echo
        // whatever was sent and hide that entirely.
        updateState: (state, name, value) =>
            void updateGrayScottState(
                state as unknown as Parameters<typeof updateGrayScottState>[0],
                name,
                value
            ),
    },
    /**
     * Gradient has no settings at all — `update_setting` is an unconditional
     * `Ok(())` in the Rust (gradient/simulation.rs:308) and a no-op here
     * (sims/gradient/index.ts:286) — and exactly one state field. Modelling it
     * rather than falling through to PERMISSIVE is what lets the editor's
     * display-mode toggle be asserted as reaching the engine *with the value
     * the shader would take*: `parseGradientDisplayMode` clamps anything that
     * is not `dithered` to `smooth`, so a control sending a string or an
     * out-of-range number shows up in the log as the mode it really selected.
     */
    gradient: {
        defaults: () => ({}),
        update: () => {},
        normalize: () => ({}),
        state: () => ({ display_mode: GRADIENT_DISPLAY_MODE.smooth }),
        updateState: (state, name, value) => {
            // Both spellings, for the reason sims/gradient/index.ts:300 gives:
            // the Rust matches on `displayMode` while `get_state` serialises
            // `display_mode`.
            if (name === 'display_mode' || name === 'displayMode') {
                state.display_mode = parseGradientDisplayMode(value);
                return;
            }
            // The real simulation warns and carries on; a throw here would turn
            // an unknown state name into a rejected promise the modes do not
            // expect from this simulation.
            console.warn(`Unknown state parameter for Gradient: ${name}`);
        },
    },
    vectors: {
        defaults: () => defaultVectorsSettings() as unknown as Record<string, unknown>,
        update: (settings, name, value) =>
            void updateVectorsSetting(
                settings as unknown as Parameters<typeof updateVectorsSetting>[0],
                name,
                value
            ),
        normalize: (input) => normalizeVectorsSettings(input) as unknown as Record<string, unknown>,
        // Vectors' `get_state` returns a *subset* of `State` (two fields in the
        // Rust, five here), and the mode reads `current_color_scheme` straight
        // out of it, so the document shape has to be the real one. Storing the
        // full state and projecting on read is what keeps that honest.
        state: () => defaultVectorsState() as unknown as Record<string, unknown>,
        stateDocument: (state) => vectorsStateDocument(state as unknown as VectorsState),
        updateState: (state, name, value) =>
            void updateVectorsState(
                state as unknown as Parameters<typeof updateVectorsState>[0],
                name,
                value
            ),
    },
    /**
     * Slime Mold, M7. The state model is what makes the two mask <Selector>s
     * and the position-generator <ButtonSelect> assertable: all three send a
     * name and read the canonicalised value straight back out of `getState()`,
     * which is precisely where the desktop build's spellings diverged.
     */
    slime_mold: {
        defaults: () => defaultSlimeMoldSettings() as unknown as Record<string, unknown>,
        update: (settings, name, value, state) =>
            void updateSlimeMoldSetting(
                settings as unknown as Parameters<typeof updateSlimeMoldSetting>[0],
                state as unknown as SlimeMoldState,
                name,
                value
            ),
        normalize: (input) =>
            normalizeSlimeMoldSettings(input) as unknown as Record<string, unknown>,
        state: () => defaultSlimeMoldState() as unknown as Record<string, unknown>,
        stateDocument: (state) => slimeMoldStateDocument(state as unknown as SlimeMoldState),
        updateState: (state, name, value) =>
            void updateSlimeMoldState(state as unknown as SlimeMoldState, name, value),
    },
};

/**
 * The device the fake reports through `caps()`.
 *
 * Deliberately **not** the reference device's 128 MiB. The agent-count control
 * has two possible sources for its ceiling — `get_agent_count_limit` asking the
 * engine, and the same command's registry stub answering from the WebGPU spec
 * minimum when no engine booted — and if both produced 7,549,747 a DOM test
 * could not tell a wired-up control from a hardcoded one. 64 MiB gives a
 * distinct 3,774,873, so an assertion on the displayed ceiling is an assertion
 * that the number came from the engine.
 */
const FAKE_STORAGE_BUFFER_BINDING_SIZE = 64 * 1024 * 1024;

/**
 * FNV-1a over a LUT, so a test can tell *which* colour scheme arrived.
 *
 * The log has to stay JSON-serialisable — Playwright reads it through
 * `page.evaluate`, and 768 numbers per entry would make every assertion failure
 * unreadable — but "a LUT arrived" is too weak on its own. The gradient
 * editor's colour-space picker is the case in point: every space produces a
 * 768-entry buffer, and the regression being guarded against is two of them
 * throwing before they get here. One number distinguishes them.
 */
function fnv1a(values: Uint32Array): number {
    let hash = 0x811c9dc5;
    for (const value of values) {
        hash = Math.imul(hash ^ (value & 0xff), 0x01000193);
        hash = Math.imul(hash ^ ((value >>> 8) & 0xff), 0x01000193);
        hash = Math.imul(hash ^ ((value >>> 16) & 0xff), 0x01000193);
        hash = Math.imul(hash ^ (value >>> 24), 0x01000193);
    }
    return hash >>> 0;
}

export class FakeEngine implements EngineContext {
    private simulationId: string | null = null;
    private settings: Record<string, unknown> = {};
    private state: Record<string, unknown> = {};
    private paused = false;
    private camera: CameraState = { position: [0, 0], zoom: 1 };
    private viewport = { width: 1280, height: 720 };

    /** Every command that mutated something, in order. The tests read this. */
    readonly log: Array<{ command: string; args: unknown }> = [];

    private model(): SettingsModel {
        return (this.simulationId && MODELS[this.simulationId]) || PERMISSIVE;
    }

    private record(command: string, args: unknown): void {
        this.log.push({ command, args });
    }

    /** The host's own precondition, so the fake refuses what it would refuse. */
    private requireSimulation(): string {
        if (!this.simulationId) throw new Error('No simulation is running');
        return this.simulationId;
    }

    currentSimulation(): string | null {
        return this.simulationId;
    }

    caps(): Caps {
        return {
            slimeMoldAgents: slimeMoldAgentCap(FAKE_STORAGE_BUFFER_BINDING_SIZE),
            flowPool: 1_000_000,
            particleLife: 500_000,
            pellets: 50_000,
            primordial: 1_000_000,
            grayScottMaxDim: 2048,
            flowTrailMaxDim: 2048,
            maxWorkgroupsPerDimension: 65535,
            maxStorageBufferBindingSize: FAKE_STORAGE_BUFFER_BINDING_SIZE,
            maxTextureDimension2D: 8192,
        };
    }

    async start(simulationType: string): Promise<void> {
        this.simulationId = simulationType;
        const model = this.model();
        this.settings = model.defaults();
        this.state =
            model.state?.() ?? legacyDefaultState(this.viewport.width, this.viewport.height);
        this.paused = false;
        this.record('start', simulationType);

        // The modes gate their loading overlay on these, and subscribe only
        // after invoking start — hence the microtask, as SimulationHost does.
        queueMicrotask(() => {
            emit('simulation-initialized', null);
            emit('simulation-resumed', null);
        });
    }

    async destroy(): Promise<void> {
        this.simulationId = null;
        this.settings = {};
        this.state = {};
        this.record('destroy', null);
    }

    pause(): void {
        this.paused = true;
    }

    resume(): void {
        this.paused = false;
    }

    step(): void {}

    isPaused(): boolean {
        return this.paused;
    }

    async getSettings(): Promise<Record<string, unknown>> {
        return { ...this.settings };
    }

    async getState(): Promise<Record<string, unknown>> {
        const model = this.model();
        return model.stateDocument ? model.stateDocument(this.state) : { ...this.state };
    }

    async updateSetting(name: string, value: unknown): Promise<void> {
        // Throwing on a bad value is the point: sync.ts rolls its optimistic
        // update back in a catch, and that path has to stay exercised.
        this.model().update(this.settings, name, value, this.state);
        this.record('update_simulation_setting', { name, value });
    }

    async updateState(name: string, value: unknown): Promise<void> {
        // Recorded *before* the model runs, so a rejected value still shows up
        // in the log as an attempt — a test asserting "the control reached the
        // engine" should not depend on the value being accepted.
        this.record('update_simulation_state', { name, value });
        const model = this.model();
        if (model.updateState) model.updateState(this.state, name, value);
        else this.state[name] = value;
    }

    applySettings(settings: Record<string, unknown>): void {
        this.settings = this.model().normalize(settings);
        this.record('apply_settings', settings);
    }

    panCamera(deltaX: number, deltaY: number): void {
        this.record('pan_camera', { deltaX, deltaY });
        this.camera = {
            position: [this.camera.position[0] + deltaX, this.camera.position[1] + deltaY],
            zoom: this.camera.zoom,
        };
    }

    zoomCamera(delta: number): void {
        this.record('zoom_camera', { delta });
        this.applyZoom(delta);
    }

    private applyZoom(delta: number): void {
        this.camera = { ...this.camera, zoom: this.camera.zoom * (1 + delta * 0.3) };
    }

    zoomCameraToCursor(delta: number, cursorX?: number, cursorY?: number): void {
        // Recorded under its own name: a mode that wires the wheel to plain
        // zoom instead of zoom-to-cursor is a real regression, and delegating
        // without recording would hide it.
        this.record('zoom_camera_to_cursor', { delta, cursorX, cursorY });
        this.applyZoom(delta);
    }

    resetCamera(): void {
        this.record('reset_camera', {});
        this.camera = { position: [0, 0], zoom: 1 };
    }

    getCameraState(): CameraState {
        return { position: [...this.camera.position], zoom: this.camera.zoom };
    }

    /**
     * Recorded rather than ignored.
     *
     * For a painting simulation this *is* the interaction under test — "left
     * click seeds a reaction" is the only thing Gray-Scott's control panel
     * advertises about the mouse — and a silent no-op here would let a mode
     * that never reaches the engine pass every assertion.
     */
    handleMouseInteraction(canvasX: number, canvasY: number, button: number): void {
        this.record('handle_mouse_interaction', { canvasX, canvasY, button });
    }

    handleMouseRelease(button: number): void {
        this.record('handle_mouse_release', { button });
    }

    resetRuntimeState(): void {
        // Whichever spelling this simulation's state document uses — Moiré's is
        // `time`, Gray-Scott's is `simulation_time`. Writing the wrong one would
        // quietly add a field the real `getState()` never returns.
        if ('simulation_time' in this.state) this.state.simulation_time = 0;
        if ('time' in this.state) this.state.time = 0;
        this.record('reset_runtime_state', null);
    }

    /**
     * Distinct from `resetRuntimeState` on purpose — see `EngineContext`. The
     * fake records them under different names so a test can tell which one the
     * Reset button actually reached.
     */
    resetSimulation(): void {
        this.record('reset_simulation', null);
    }

    seedRandomNoise(seed?: number): void {
        this.record('seed_random_noise', { seed: seed ?? null });
    }

    resetAgents(): void {
        this.record('reset_agents', null);
    }

    /**
     * Writes the state field as well as recording, because `agent_count` is
     * part of the state document (`slimeMoldStateDocument`) and the mode reads
     * it straight back through `get_current_agent_count`. Recording alone would
     * let a control that clamps on the way out but not on the way back in pass.
     */
    setAgentCount(count: number): void {
        this.record('set_agent_count', { count });
        if ('agent_count' in this.state) this.state.agent_count = count;
    }

    randomizeSettings(): void {
        this.record('randomize_settings', null);
    }

    updateColorScheme(lut: Uint32Array, reversed: boolean): void {
        // As `SimulationHost.updateColorScheme` does, through
        // `requireSimulation()` (SimulationHost.ts:401). Faithful rather than
        // lenient because the caller that gets this wrong is real: the gradient
        // editor's debounced preview lands after the user has navigated away
        // and the simulation has been torn down, and a fake that quietly
        // accepted the push would let that regress invisibly at the one layer
        // that can see it.
        this.requireSimulation();
        this.state.color_scheme_reversed = reversed;
        this.record('update_color_scheme', { length: lut.length, reversed, checksum: fnv1a(lut) });
    }

    async loadImage(file: File, slot: string): Promise<void> {
        this.record('load_image', { name: file.name, size: file.size, slot });
    }

    resize(width: number, height: number): void {
        this.viewport = { width, height };
    }

    getViewport(): { width: number; height: number } {
        return { ...this.viewport };
    }

    setFpsLimit(): void {}

    setCameraSensitivity(): void {}
}

/**
 * Install a fake engine as the process-wide context, replacing whatever is
 * there. Returns it so a test can read its log.
 */
export function installFakeEngine(): FakeEngine {
    const engine = new FakeEngine();
    setEngineContext(engine);
    return engine;
}
