/**
 * Shared contracts for the engine.
 *
 * These are fixed up front so the GPU layer, the simulation core, and the data
 * layer can be built against a stable seam. Everything here mirrors something
 * in the Rust backend — see the citations on each type.
 */

// ---------------------------------------------------------------------------
// GPU
// ---------------------------------------------------------------------------

/**
 * Ceilings derived from what the adapter actually granted.
 *
 * The reference device (Apple Metal-3, Chrome 152) grants exactly the WebGPU
 * spec defaults — 128 MiB storage binding, 8 storage buffers per stage — so
 * these must be computed, never assumed. See WEB_PORT.md "Reference device".
 */
export interface Caps {
    /** 16 B per agent; the binding limit is what constrains this. */
    slimeMoldAgents: number;
    flowPool: number;
    particleLife: number;
    pellets: number;
    primordial: number;
    /** Sim-texture ceiling, independent of surface size and DPR. */
    grayScottMaxDim: number;
    /** Trail map ceiling; 2048² as atomic u32×4 is 67 MB. */
    flowTrailMaxDim: number;
    /** From device.limits — the Rust hardcodes 65535 in three places. */
    maxWorkgroupsPerDimension: number;
    maxStorageBufferBindingSize: number;
    maxTextureDimension2D: number;
}

/** Everything a simulation needs to talk to the GPU. */
export interface GpuContext {
    adapter: GPUAdapter;
    device: GPUDevice;
    canvas: HTMLCanvasElement;
    context: GPUCanvasContext;
    /** Preferred canvas format, from getPreferredCanvasFormat(). */
    format: GPUTextureFormat;
    caps: Caps;
    /** Backing-store size, i.e. canvas.width/height — never CSS pixels. */
    width: number;
    height: number;
}

/** Why WebGPU could not start, so the UI can say something useful. */
export type GpuFailure =
    | { kind: 'insecure-context'; origin: string }
    | { kind: 'no-webgpu' }
    | { kind: 'no-adapter' }
    | { kind: 'device-failed'; message: string };

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/** Mirrors src-tauri/src/simulations/shared/camera.rs. */
export interface CameraState {
    position: [number, number];
    zoom: number;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/**
 * The porting contract, mirroring the Rust `Simulation` trait at
 * src-tauri/src/simulations/traits.rs:66.
 *
 * Settings are the preset-persisted parameters; state is everything else
 * (per .cursorrules). Both are string-keyed and JSON-valued, exactly as the
 * Rust trait had them, which is why the invoke() shim maps onto this cleanly.
 */
export interface Simulation {
    readonly id: SimulationId;

    /** Advance and draw. dt is seconds since the previous frame. */
    renderFrame(view: GPUTextureView, dt: number): void;
    /** Redraw without advancing, so camera moves still show while paused. */
    renderFramePaused(view: GPUTextureView): void;

    resize(width: number, height: number): void;

    getSettings(): Record<string, unknown>;
    getState(): Record<string, unknown>;
    updateSetting(name: string, value: unknown): void;
    updateState(name: string, value: unknown): void;
    applySettings(settings: Record<string, unknown>): void;

    handleMouseInteraction(worldX: number, worldY: number, button: number): void;
    handleMouseRelease(button: number): void;

    resetRuntimeState(): void;
    randomizeSettings(): void;
    updateColorScheme(lut: Uint32Array, reversed: boolean): void;

    /** Release every GPU resource. Must be idempotent. */
    destroy(): void;
}

/** Mirrors SimulationType at traits.rs:233. */
export type SimulationId =
    | 'slime_mold'
    | 'gray_scott'
    | 'particle_life'
    | 'flow'
    | 'pellets'
    | 'main_menu'
    | 'gradient'
    | 'voronoi_ca'
    | 'moire'
    | 'primordial_particles'
    | 'vectors';

/** Constructed asynchronously — pipeline creation and shader compile are async. */
export type SimulationFactory = (gpu: GpuContext) => Promise<Simulation>;

// ---------------------------------------------------------------------------
// Colour schemes
// ---------------------------------------------------------------------------

/**
 * A 768-byte planar LUT: [R×256][G×256][B×256].
 * Mirrors src-tauri/src/simulations/shared/color_scheme.rs.
 */
export interface ColorScheme {
    name: string;
    /** 768 bytes, planar. */
    data: Uint8Array;
}
