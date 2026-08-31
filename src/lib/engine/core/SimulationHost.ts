/**
 * Owns the running simulation: construct it, destroy it, drive the render loop,
 * hold the camera, forward resizes.
 *
 * This is the real implementation of `EngineContext` (src/lib/rpc/context.ts) —
 * the seam every rpc handler goes through, and the one the DOM tests replace
 * with an in-memory fake.
 *
 * Structural difference from the Rust: `SimulationManager` fanned every camera
 * command out across an eleven-arm `match` (manager.rs:1443, and again at 1463,
 * 1481, 1517, 1535 — five near-identical matches), because each simulation
 * owned its own `Camera`. Here there is one camera, on the host. A sim that
 * needs the camera uniform picks it up through the optional `attachCamera` hook
 * below.
 *
 * Nothing in this module touches WebGPU at import time; a `GpuContext` is
 * supplied at construction and may be a fake.
 */

import type { EngineContext } from '$lib/rpc';
import type {
    CameraState,
    GpuContext,
    Simulation,
    SimulationFactory,
    SimulationId,
} from '../types';
import { emit } from '$lib/rpc';
import { Camera } from './Camera';
import { RenderLoop, type RenderLoopOptions } from './RenderLoop';
import { assertSimulationId } from './Simulation';
import * as registry from './SimulationRegistry';
import { screenCoords } from './coordinates';
import { ResourceLedger } from './resourceLedger';

// The ledger used to live in this file; re-exported so existing call sites and
// the leak tests keep naming one path for it.
export { ResourceLedger, instrumentDevice, type ResourceStats } from './resourceLedger';

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

/** Optional hook a simulation may expose to receive the host's camera. */
interface CameraAware {
    attachCamera(camera: Camera): void;
}

/** Optional hook for the five simulations that take an uploaded image. */
interface ImageAware {
    loadImage(file: File, slot: string): Promise<void>;
}

/** Optional hook for a simulation whose Reset does more than rewind its clock. */
interface Resettable {
    reset(): void;
}

/** Optional hook for a simulation that can re-seed its field with noise. */
interface NoiseSeedable {
    seedRandomNoise(seed?: number): void;
}

export interface SimulationHostOptions {
    /** Override the module registry — the fake-engine and leak tests use this. */
    resolveFactory?: (id: SimulationId) => Promise<SimulationFactory>;
    /** Injectable clock and scheduler for the render loop. */
    loop?: RenderLoopOptions;
    ledger?: ResourceLedger;
}

export class SimulationHost implements EngineContext {
    readonly camera: Camera;
    readonly loop: RenderLoop;
    readonly resources: ResourceLedger;

    private gpu: GpuContext;
    private simulation: Simulation | null = null;
    private simulationId: SimulationId | null = null;
    private readonly resolveFactory: (id: SimulationId) => Promise<SimulationFactory>;

    /**
     * Lifecycle operations are serialised through this chain.
     *
     * `start()` is async and the menu can fire two of them before the first
     * resolves — double-clicking a card, or a navigation racing a restore. Two
     * interleaved constructions would leave one simulation unreferenced and
     * undestroyed, which is exactly the leak the ledger exists to catch.
     */
    private lifecycle: Promise<void> = Promise.resolve();

    /** Surface-acquisition failures are logged once, not once per frame. */
    private surfaceErrorLogged = false;

    constructor(gpu: GpuContext, options: SimulationHostOptions = {}) {
        this.gpu = gpu;
        this.resources = options.ledger ?? new ResourceLedger();
        this.camera = new Camera(gpu.width, gpu.height);
        this.resolveFactory = options.resolveFactory ?? ((id) => registry.resolve(id));
        this.loop = new RenderLoop(
            { render: this.onRender, renderPaused: this.onRenderPaused },
            options.loop ?? {}
        );
    }

    // -----------------------------------------------------------------------
    // EngineContext
    // -----------------------------------------------------------------------

    currentSimulation(): string | null {
        return this.simulationId;
    }

    /** Tear down whatever is running, construct `simulationType`, start the loop. */
    start(simulationType: string): Promise<void> {
        const id = assertSimulationId(simulationType);
        return this.enqueue(async () => {
            await this.teardown();

            const factory = await this.resolveFactory(id);
            const simulation = await factory(this.gpu);

            this.simulation = simulation;
            this.simulationId = id;
            this.resources.create('simulation');

            this.camera.reset();
            this.camera.resize(this.gpu.width, this.gpu.height);
            attachCamera(simulation, this.camera);

            this.surfaceErrorLogged = false;
            this.loop.start();

            // The modes gate their loading overlay on these two, and several
            // subscribe only after invoking start — hence the microtask, which
            // matches what the M1 stubs at rpc/registry.ts do.
            queueMicrotask(() => {
                emit('simulation-initialized', null);
                emit('simulation-resumed', null);
            });
        });
    }

    destroy(): Promise<void> {
        return this.enqueue(() => this.teardown());
    }

    pause(): void {
        this.loop.pause();
    }

    resume(): void {
        if (!this.loop.isPaused()) return;
        this.loop.resume();
        emit('simulation-resumed', null);
    }

    step(): void {
        this.loop.step();
    }

    isPaused(): boolean {
        return this.loop.isPaused();
    }

    async getSettings(): Promise<Record<string, unknown>> {
        return this.simulation?.getSettings() ?? {};
    }

    async getState(): Promise<Record<string, unknown>> {
        return this.simulation?.getState() ?? {};
    }

    async updateSetting(name: string, value: unknown): Promise<void> {
        this.requireSimulation().updateSetting(name, value);
        this.loop.requestRedraw();
    }

    async updateState(name: string, value: unknown): Promise<void> {
        this.requireSimulation().updateState(name, value);
        this.loop.requestRedraw();
    }

    // -----------------------------------------------------------------------
    // Beyond EngineContext — what the rpc handlers need but the interface,
    // which is pinned, does not declare.
    // -----------------------------------------------------------------------

    /**
     * Adopt a new backing-store size.
     *
     * @param width  `canvas.width` — backing-store pixels, never `innerWidth`
     * @param height `canvas.height`
     *
     * `Camera.screenToWorld` consumes backing-store pixels, so feeding CSS
     * pixels here silently offsets every click by the DPR (WEB_PORT.md, "The
     * mouse-coordinate fix").
     */
    resize(width: number, height: number): void {
        this.gpu = { ...this.gpu, width, height };
        this.camera.resize(width, height);
        this.simulation?.resize(width, height);
        this.loop.requestRedraw();
    }

    /** The current backing-store size the host believes it is rendering into. */
    getViewport(): { width: number; height: number } {
        return { width: this.gpu.width, height: this.gpu.height };
    }

    applySettings(settings: Record<string, unknown>): void {
        this.requireSimulation().applySettings(settings);
        this.loop.requestRedraw();
    }

    resetRuntimeState(): void {
        this.requireSimulation().resetRuntimeState();
        this.loop.requestRedraw();
    }

    /**
     * Optional capabilities rather than additions to the pinned `Simulation`
     * interface, for the same reason `loadImage` is one: widening the interface
     * for the one simulation that distinguishes reset-the-field from
     * reset-the-clock would force ten no-op implementations.
     */
    resetSimulation(): void {
        const simulation = this.requireSimulation() as Simulation & Partial<Resettable>;
        if (typeof simulation.reset === 'function') simulation.reset();
        else simulation.resetRuntimeState();
        this.loop.requestRedraw();
    }

    seedRandomNoise(seed?: number): void {
        const simulation = this.requireSimulation() as Partial<NoiseSeedable>;
        if (typeof simulation.seedRandomNoise !== 'function') return;
        simulation.seedRandomNoise(seed);
        this.loop.requestRedraw();
    }

    randomizeSettings(): void {
        this.requireSimulation().randomizeSettings();
        this.loop.requestRedraw();
    }

    updateColorScheme(lut: Uint32Array, reversed: boolean): void {
        this.requireSimulation().updateColorScheme(lut, reversed);
        this.loop.requestRedraw();
    }

    /**
     * Route an uploaded file to whichever simulation is running.
     *
     * Image support is an optional capability rather than part of the pinned
     * `Simulation` interface — five of the eleven simulations have one, and
     * widening the interface for them would force six no-op implementations.
     */
    async loadImage(file: File, slot: string): Promise<void> {
        const simulation = this.requireSimulation() as Partial<ImageAware>;
        if (typeof simulation.loadImage !== 'function') {
            throw new Error(`${this.simulationId} does not take an image`);
        }
        await simulation.loadImage(file, slot);
        this.loop.requestRedraw();
    }

    /**
     * @param canvasX canvas backing-store pixels — see `gpu/pointer.ts`
     * @param canvasY canvas backing-store pixels
     */
    handleMouseInteraction(canvasX: number, canvasY: number, button: number): void {
        const simulation = this.simulation;
        if (!simulation) return;
        const world = this.camera.screenToWorld(screenCoords(canvasX, canvasY));
        simulation.handleMouseInteraction(world.x, world.y, button);
        this.loop.requestRedraw();
    }

    handleMouseRelease(button: number): void {
        this.simulation?.handleMouseRelease(button);
        this.loop.requestRedraw();
    }

    // Camera commands. Each one asks for a redraw so a paused simulation still
    // follows the camera — the on-demand replacement for the Rust's
    // every-frame `render_frame_paused`.

    panCamera(deltaX: number, deltaY: number): void {
        this.camera.pan(deltaX, deltaY);
        this.loop.requestRedraw();
    }

    zoomCamera(delta: number): void {
        this.camera.zoomBy(delta);
        this.loop.requestRedraw();
    }

    /** `cursorX`/`cursorY` are canvas backing-store pixels. */
    zoomCameraToCursor(delta: number, cursorX: number, cursorY: number): void {
        this.camera.zoomToCursor(delta, cursorX, cursorY);
        this.loop.requestRedraw();
    }

    resetCamera(): void {
        this.camera.reset();
        this.loop.requestRedraw();
    }

    getCameraState(): CameraState {
        return this.camera.getState();
    }

    setCameraSensitivity(sensitivity: number): void {
        this.camera.setSensitivity(sensitivity);
    }

    setFpsLimit(limit: number | null): void {
        this.loop.setFpsLimit(limit);
    }

    /** Stop everything and release the host's own GPU objects. Idempotent. */
    async dispose(): Promise<void> {
        await this.destroy();
        this.camera.destroy();
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    private onRender = (dt: number): void => {
        const simulation = this.simulation;
        if (!simulation) return;

        this.camera.update(dt);
        this.uploadCamera();

        const view = this.acquireView();
        if (!view) return;
        simulation.renderFrame(view, dt);
    };

    private onRenderPaused = (): void => {
        const simulation = this.simulation;
        if (!simulation) return;

        // Still advance the camera smoothing: a pan issued while paused should
        // glide rather than jump. One extra redraw is requested for as long as
        // it is still settling, which is what keeps this from spinning forever.
        this.camera.update(1 / 60);
        this.uploadCamera();

        const view = this.acquireView();
        if (view) simulation.renderFramePaused(view);

        if (this.camera.isSettling()) this.loop.requestRedraw();
    };

    /**
     * Guarded so a host built over a fake `GpuContext` (the L4 harness) never
     * dereferences a device it does not have.
     */
    private uploadCamera(): void {
        if (!this.camera.getBuffer()) return;
        this.camera.uploadToGpu(this.gpu.device.queue);
    }

    private acquireView(): GPUTextureView | null {
        try {
            return this.gpu.context.getCurrentTexture().createView();
        } catch (error) {
            // The Rust reconfigured the surface and retried here
            // (manager.rs:1250). In a browser the canvas context reconfigures
            // itself on the next frame, so the frame is simply dropped.
            if (!this.surfaceErrorLogged) {
                this.surfaceErrorLogged = true;
                console.warn('[engine] failed to acquire the surface texture', error);
            }
            return null;
        }
    }

    private async teardown(): Promise<void> {
        this.loop.stop();

        const simulation = this.simulation;
        this.simulation = null;
        this.simulationId = null;
        if (!simulation) return;

        try {
            simulation.destroy();
        } finally {
            // Counted even if destroy() threw: the simulation is unreachable
            // either way, and leaving it counted as live would mask every
            // subsequent leak behind one permanent false positive.
            this.resources.destroy('simulation');
        }
    }

    private requireSimulation(): Simulation {
        if (!this.simulation) {
            throw new Error('No simulation is running');
        }
        return this.simulation;
    }

    /** Serialise a lifecycle operation behind the previous one. */
    private enqueue(operation: () => Promise<void>): Promise<void> {
        const next = this.lifecycle.then(operation, operation);
        // Swallow on the chain only — the returned promise still rejects, so
        // the rpc caller sees the failure and sync.ts can roll back.
        this.lifecycle = next.then(
            () => undefined,
            () => undefined
        );
        return next;
    }
}

function attachCamera(simulation: Simulation, camera: Camera): void {
    const candidate = simulation as Partial<CameraAware>;
    if (typeof candidate.attachCamera === 'function') {
        candidate.attachCamera(camera);
    }
}
