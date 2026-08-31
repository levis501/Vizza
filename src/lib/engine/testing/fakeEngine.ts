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
import type { CameraState } from '$lib/engine/types';
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
import {
    defaultVectorsSettings,
    defaultVectorsState,
    normalizeVectorsSettings,
    updateVectorsSetting,
    updateVectorsState,
    vectorsStateDocument,
    type VectorsState,
} from '$lib/engine/sims/vectors/settings';

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
    update(settings: Record<string, unknown>, name: string, value: unknown): void;
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
};

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

    currentSimulation(): string | null {
        return this.simulationId;
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
        this.model().update(this.settings, name, value);
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

    randomizeSettings(): void {
        this.record('randomize_settings', null);
    }

    updateColorScheme(lut: Uint32Array, reversed: boolean): void {
        this.state.color_scheme_reversed = reversed;
        this.record('update_color_scheme', { length: lut.length, reversed });
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
