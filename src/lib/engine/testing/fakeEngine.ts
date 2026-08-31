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

/** How one simulation's settings behave, so the fake is not moiré-specific. */
interface SettingsModel {
    defaults(): Record<string, unknown>;
    update(settings: Record<string, unknown>, name: string, value: unknown): void;
    normalize(input: unknown): Record<string, unknown>;
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
        this.settings = this.model().defaults();
        this.state = {
            color_scheme_name: 'ZELDA_Fordite',
            color_scheme_reversed: false,
            time: 0,
            width: this.viewport.width,
            height: this.viewport.height,
        };
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
        return { ...this.state };
    }

    async updateSetting(name: string, value: unknown): Promise<void> {
        // Throwing on a bad value is the point: sync.ts rolls its optimistic
        // update back in a catch, and that path has to stay exercised.
        this.model().update(this.settings, name, value);
        this.record('update_simulation_setting', { name, value });
    }

    async updateState(name: string, value: unknown): Promise<void> {
        this.state[name] = value;
        this.record('update_simulation_state', { name, value });
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

    handleMouseInteraction(): void {}

    handleMouseRelease(): void {}

    resetRuntimeState(): void {
        this.state.time = 0;
        this.record('reset_runtime_state', null);
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
