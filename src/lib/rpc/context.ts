/**
 * The seam between the command surface and the engine.
 *
 * Handlers never touch the GPU directly — they go through this interface, so
 * DOM tests can substitute an in-memory fake with no WebGPU device at all.
 * `SimulationHost` provides the real implementation from M2 onward.
 */

import type { CameraState } from '$lib/engine/types';

export interface EngineContext {
    /** The running simulation's id, or null on the menu. */
    currentSimulation(): string | null;

    /** Construct and start a simulation, tearing down any current one. */
    start(simulationType: string): Promise<void>;

    /** Tear down the current simulation, releasing its GPU resources. */
    destroy(): Promise<void>;

    pause(): void;
    resume(): void;
    step(): void;
    isPaused(): boolean;

    /** Settings are the preset-persisted parameters; state is everything else. */
    getSettings(): Promise<Record<string, unknown>>;
    getState(): Promise<Record<string, unknown>>;
    updateSetting(name: string, value: unknown): Promise<void>;
    updateState(name: string, value: unknown): Promise<void>;
    applySettings(settings: Record<string, unknown>): void;

    /**
     * Camera lives on the host, not per-simulation.
     *
     * The Rust gave each of the eleven sims its own camera and fanned every
     * command out through five near-identical eleven-arm match blocks
     * (simulation/manager.rs). Hoisting it removes all of that.
     */
    panCamera(deltaX: number, deltaY: number): void;
    zoomCamera(delta: number): void;
    zoomCameraToCursor(delta: number, cursorX: number, cursorY: number): void;
    resetCamera(): void;
    getCameraState(): CameraState;

    /** Coordinates are canvas backing-store pixels, not CSS or screen pixels. */
    handleMouseInteraction(canvasX: number, canvasY: number, button: number): void;
    handleMouseRelease(button: number): void;

    resetRuntimeState(): void;

    /**
     * The Reset button, which is not `resetRuntimeState`.
     *
     * The Rust kept these deliberately separate and Gray-Scott is where the
     * difference first bites: its `reset_runtime_state` is a literal no-op
     * (gray_scott/simulation.rs:1919), while `reset_simulation` blanks the
     * chemical field through a different path entirely (manager.rs:1382).
     * Routing both to `resetRuntimeState` — as this layer did until M4 — makes
     * the button silently do nothing. Simulations that draw no distinction fall
     * back to `resetRuntimeState`.
     */
    resetSimulation(): void;

    /**
     * Re-seed the field with noise. A no-op for simulations that have no such
     * concept, which is most of them — Gray-Scott's control panel is the only
     * one with the button today.
     */
    seedRandomNoise(seed?: number): void;

    randomizeSettings(): void;
    updateColorScheme(lut: Uint32Array, reversed: boolean): void;

    /**
     * Hand an uploaded file to the running simulation.
     *
     * The desktop commands took a filesystem path; a browser has none, so
     * `ImageSelector.svelte` sends the `File` itself. `slot` names which input
     * the command meant — Slime Mold has two (position and mask), everything
     * else has one. Rejects if the running simulation accepts no image, which
     * is what `sync.ts` needs in order to report the failure.
     */
    loadImage(file: File, slot: string): Promise<void>;

    resize(width: number, height: number): void;
    getViewport(): { width: number; height: number };
    setFpsLimit(limit: number | null): void;
    setCameraSensitivity(sensitivity: number): void;
}

let context: EngineContext | null = null;

export function setEngineContext(ctx: EngineContext | null): void {
    context = ctx;
}

export function getEngineContext(): EngineContext {
    if (!context) {
        throw new Error('Engine context not initialised — call setEngineContext() first');
    }
    return context;
}

export function hasEngineContext(): boolean {
    return context !== null;
}
