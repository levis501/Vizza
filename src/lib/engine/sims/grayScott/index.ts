/**
 * Gray-Scott — a port of gray_scott/simulation.rs (1966 ln) around
 * `reaction_diffusion.wgsl` (338 ln), `paint.wgsl`, `noise_seed.wgsl` and the
 * shared infinite renderer.
 *
 * The second simulation ported, and the first with any of: a field the user can
 * paint into, a second and third compute pipeline, a `read` storage texture, an
 * f16 texture format, and the infinite renderer's *storage* path — Gray-Scott
 * renders through `fs_main`/`fs_main_storage` (one scalar out of the red
 * channel, coloured through a LUT), not the `fs_main_texture` Moiré uses.
 *
 * The concentration field is **not** a storage buffer, despite the entry point's
 * name. It is a ping-pong pair of `rgba16float` textures with `R = U`, `G = V`,
 * `B = A = 0`; the `UVPair` struct declared in both `reaction_diffusion.wgsl`
 * and `infinite_render.wgsl` is dead — never instantiated, never bound. Each
 * texture is bound as a storage texture by the compute passes and as a sampled
 * texture by the paint pass and the renderer, which is why the shared
 * `SIM_TEXTURE_USAGE` (a superset) is what the pair is created with.
 *
 * Orientation follows the `PingPongTextures` convention: a pass reads `current`
 * and writes `inactive`, then swaps, leaving `current` holding what was just
 * produced. Unlike Moiré, the Rust already does it this way round here
 * (simulation.rs:1310), so there is no paused-frame staleness to correct.
 *
 * **One simulation step per frame.** There is no `steps_per_frame`, no substep
 * loop and no accumulator anywhere in `gray_scott/`; `settings.timestep` is the
 * only speed control, and it is applied inside the kernel.
 *
 * Three deliberate divergences from the Rust are implemented here rather than
 * transcribed. Each is commented at the point it happens:
 *
 *   1. The f16 seeding bug — `grayScottSeedTexels` below.
 *   2. `filtering_mode` was never the app setting — see the `renderParams`
 *      comment in `engine/render/InfiniteRenderer.ts`.
 *   3. `background_render.wgsl` is not ported — see `renderFrame`.
 */

import type { GpuContext, Simulation, SimulationId } from '$lib/engine/types';
import { getShader } from '$lib/engine/shaders';
import {
    createComputePipelineChecked,
    createShaderModuleChecked,
} from '$lib/engine/gpu/errorScopes';
import {
    createBufferWithData,
    createStorageBuffer,
    createUniformBuffer,
    writeBuffer,
} from '$lib/engine/resources/buffers';
import { PingPongTextures } from '$lib/engine/resources/pingPong';
import { Camera } from '$lib/engine/core/Camera';
import { InfiniteRenderer, type TextureFilteringMode } from '$lib/engine/render/InfiniteRenderer';
import {
    decodeImageFile,
    drawFittedImage,
    grayscaleFromCanvas,
} from '$lib/engine/resources/imageUpload';
import {
    defaultGrayScottSettings,
    defaultGrayScottState,
    grayScottStateDocument,
    grayScottTextureSize,
    GRAY_SCOTT_PARAM_BYTES,
    normalizeGrayScottSettings,
    packGrayScottParams,
    randomizeGrayScottSettings,
    resetGrayScottRuntimeState,
    updateGrayScottSetting,
    updateGrayScottState,
    type GrayScottSettings,
    type GrayScottState,
} from './settings';

export const GRAY_SCOTT_REACTION_SHADER_PATH = 'gray_scott/shaders/reaction_diffusion.wgsl';
export const GRAY_SCOTT_PAINT_SHADER_PATH = 'gray_scott/shaders/paint.wgsl';
export const GRAY_SCOTT_NOISE_SHADER_PATH = 'gray_scott/shaders/noise_seed.wgsl';

/**
 * All three kernels declare `@workgroup_size(8, 8)`.
 *
 * `reaction_diffusion.wgsl` declared `(1, 1, 1)` and was dispatched
 * `width × height` — 4.2 million single-thread workgroups per frame at 2048².
 * That is remediation (b); the shader and the Rust dispatch were both fixed
 * today, and the ragged tail is discarded by the bounds guard at
 * reaction_diffusion.wgsl:266.
 */
const WORKGROUP_SIZE = 8;

/** 768 u32 entries, planar [R][G][B] — the shape of every .lut file. */
const LUT_ENTRIES = 768;

/** `struct PaintParams` (paint.wgsl:4): 7 scalars + one word of padding. */
export const PAINT_PARAM_BYTES = 32;

/** noise_seed.wgsl:10 — `width, height, seed: u32` then `noise_strength: f32`. */
export const NOISE_PARAM_BYTES = 16;

/** simulation.rs:180 — the radius, in texels, of the initial perturbation. */
export const SEED_DISC_RADIUS = 10;

export { GRAY_SCOTT_MAX_DIM, GRAY_SCOTT_MIN_DIM, grayScottTextureSize } from './settings';

// ---------------------------------------------------------------------------
// IEEE binary16
// ---------------------------------------------------------------------------

const F32_SCRATCH = new Float32Array(1);
const F32_BITS = new Uint32Array(F32_SCRATCH.buffer);

/**
 * Encode a number as IEEE binary16, returning the 16 bits as a plain integer.
 *
 * There is no `Float16Array` guaranteed by the TypeScript lib or by every
 * browser we target, and the alternative — uploading f32 and letting the driver
 * convert — is not available either: `queue.writeTexture` copies bytes, it does
 * not convert formats. So the conversion is done here, where it can be tested,
 * rather than hoped for.
 *
 * Round-to-nearest-even, with subnormals and both infinities handled, because
 * the seeding values are not the only thing that ever goes through it and a
 * truncating version would be a silent half-ulp bias in anything that did.
 */
export function encodeFloat16(value: number): number {
    F32_SCRATCH[0] = value;
    const bits = F32_BITS[0];

    const sign = (bits >>> 16) & 0x8000;
    const exponent = (bits >>> 23) & 0xff;
    let mantissa = bits & 0x7fffff;

    // Inf and NaN keep their kind; a NaN payload is forced non-zero so it does
    // not silently become an infinity.
    if (exponent === 0xff) {
        return sign | 0x7c00 | (mantissa === 0 ? 0 : 0x0200);
    }

    // Re-bias: 127 for binary32, 15 for binary16.
    const half = exponent - 112;

    if (half >= 0x1f) return sign | 0x7c00; // overflows the half range
    if (half <= 0) {
        // Subnormal, or too small to represent at all.
        if (half < -10) return sign;
        mantissa |= 0x800000; // restore the implicit leading 1
        const shift = 14 - half;
        const truncated = mantissa >>> shift;
        const roundBit = (mantissa >>> (shift - 1)) & 1;
        const sticky = (mantissa & ((1 << (shift - 1)) - 1)) !== 0;
        return sign | (truncated + (roundBit && (sticky || (truncated & 1) === 1) ? 1 : 0));
    }

    const truncated = (half << 10) | (mantissa >>> 13);
    const roundBit = (mantissa >>> 12) & 1;
    const sticky = (mantissa & 0xfff) !== 0;
    // A carry out of the mantissa lands in the exponent, which is exactly right
    // — including when it carries all the way to infinity.
    return sign | (truncated + (roundBit && (sticky || (truncated & 1) === 1) ? 1 : 0));
}

/** The inverse, for readback and for testing the encoder round-trips. */
export function decodeFloat16(bits: number): number {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >>> 10) & 0x1f;
    const mantissa = bits & 0x3ff;

    if (exponent === 0) return sign * mantissa * 2 ** -24;
    if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : NaN;
    return sign * (mantissa + 0x400) * 2 ** (exponent - 25);
}

/**
 * The initial concentration field: `U = 1, V = 0` everywhere, plus a
 * radius-10 disc of seed at the centre.
 *
 * **This is remediation (1), a deliberate divergence.** The Rust builds a
 * `Vec<UVPair>` of four `f32`s — 16 bytes per element — and uploads it into an
 * 8-bytes-per-texel `rgba16float` texture with `bytes_per_row: width * 16`
 * (simulation.rs:225, and identically in `reset` at :939 and in
 * `recreate_simulation_buffers` at :779). `write_texture` treats `bytes_per_row`
 * as a *source* stride, so each destination row consumes only the first
 * `width * 8` bytes of it and reinterprets f32 bit patterns as pairs of f16:
 * the intended `u=1.0, v=0.0` arrives on the GPU as roughly `u=0, v=1.875` in
 * even columns and `(0,0,0,0)` in odd ones, the right half of every source row
 * is never read at all, and the centre disc is garbled the same way.
 *
 * Ported here is the *intent* — the values the Rust source plainly means — not
 * the bytes. The consequence to know about: **the first frame does not match
 * `example-gray-scott.png`**, so any visual-parity assertion against that
 * reference has to be "after N steps", never at t=0. After a few hundred steps
 * the reaction has forgotten its initial condition anyway, which is why this is
 * a fix rather than a compatibility break.
 *
 * @returns width*height*4 half-floats, ready for `writeTexture` with
 *          `bytesPerRow = width * 8`.
 */
export function grayScottSeedTexels(width: number, height: number): Uint16Array<ArrayBuffer> {
    const texels = new Uint16Array(width * height * 4);

    const one = encodeFloat16(1);
    for (let i = 0; i < texels.length; i += 4) texels[i] = one;

    // simulation.rs:177 — integer division, so an even axis seeds just right of
    // centre. Faithful, and invisible at any real resolution.
    const centerX = Math.trunc(width / 2);
    const centerY = Math.trunc(height / 2);
    const half = encodeFloat16(0.5);

    for (let y = -SEED_DISC_RADIUS; y <= SEED_DISC_RADIUS; y++) {
        for (let x = -SEED_DISC_RADIUS; x <= SEED_DISC_RADIUS; x++) {
            const nx = centerX + x;
            const ny = centerY + y;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;

            // Note the whole *square* is overwritten with u = 0.5: outside the
            // inscribed disc `factor` is 0, so those texels get (0.5, 0) rather
            // than being left at (1, 0). That is what the Rust does.
            const distance = Math.sqrt(x * x + y * y) / SEED_DISC_RADIUS;
            const factor = distance < 1 ? (1 - distance * distance) ** 2 : 0;

            const p = (ny * width + nx) * 4;
            texels[p] = half;
            texels[p + 1] = encodeFloat16(0.99 * factor);
            texels[p + 2] = 0;
            texels[p + 3] = 0;
        }
    }

    return texels;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export class GrayScottSimulation implements Simulation {
    readonly id: SimulationId = 'gray_scott';

    private readonly device: GPUDevice;
    private readonly format: GPUTextureFormat;
    private readonly maxTextureDimension2D: number;

    private readonly reactionPipeline: GPUComputePipeline;
    private readonly reactionLayout: GPUBindGroupLayout;
    private readonly paintPipeline: GPUComputePipeline;
    private readonly paintLayout: GPUBindGroupLayout;
    private readonly noisePipeline: GPUComputePipeline;
    private readonly noiseLayout: GPUBindGroupLayout;
    private readonly renderer: InfiniteRenderer;

    private readonly simParamsBuffer: GPUBuffer;
    private readonly paintParamsBuffer: GPUBuffer;
    private readonly noiseParamsBuffer: GPUBuffer;
    private readonly lutBuffer: GPUBuffer;

    /**
     * `gradient_map` at binding 3 of the reaction kernel.
     *
     * Allocated unconditionally, at `width * height * 4` bytes, even with no
     * image loaded — the binding is *statically used* (inside the mask switch,
     * reachable from `main`), so WebGPU requires it in the layout and in every
     * bind group whether or not the mask pattern that reads it is selected.
     * Same class of trap as Moiré's placeholder image texture.
     */
    private gradientBuffer: GPUBuffer;

    private textures: PingPongTextures;
    // Definite-assignment: all four are built by `rebuildBindGroups()`, which
    // the constructor calls and every resize calls again.
    private reactionBindGroups!: [GPUBindGroup, GPUBindGroup];
    private paintBindGroups!: [GPUBindGroup, GPUBindGroup];
    private noiseBindGroups!: [GPUBindGroup, GPUBindGroup];
    private renderBindGroups!: [GPUBindGroup, GPUBindGroup];

    private readonly paramScratch = new ArrayBuffer(GRAY_SCOTT_PARAM_BYTES);
    private readonly paintScratch = new ArrayBuffer(PAINT_PARAM_BYTES);
    private readonly noiseScratch = new ArrayBuffer(NOISE_PARAM_BYTES);

    /** Kept so a fit-mode change or a resize can re-fit without the file. */
    private maskSource: ImageBitmap | null = null;
    private maskLoaded = false;

    private camera: Camera;
    private ownsCamera = true;

    settings: GrayScottSettings = defaultGrayScottSettings();
    state: GrayScottState = defaultGrayScottState();

    private width: number;
    private height: number;
    private paramsDirty = true;
    private destroyed = false;

    private constructor(init: {
        device: GPUDevice;
        format: GPUTextureFormat;
        maxTextureDimension2D: number;
        width: number;
        height: number;
        reactionPipeline: GPUComputePipeline;
        reactionLayout: GPUBindGroupLayout;
        paintPipeline: GPUComputePipeline;
        paintLayout: GPUBindGroupLayout;
        noisePipeline: GPUComputePipeline;
        noiseLayout: GPUBindGroupLayout;
        renderer: InfiniteRenderer;
        simParamsBuffer: GPUBuffer;
        paintParamsBuffer: GPUBuffer;
        noiseParamsBuffer: GPUBuffer;
        lutBuffer: GPUBuffer;
        gradientBuffer: GPUBuffer;
        textures: PingPongTextures;
        camera: Camera;
    }) {
        this.device = init.device;
        this.format = init.format;
        this.maxTextureDimension2D = init.maxTextureDimension2D;
        this.width = init.width;
        this.height = init.height;
        this.reactionPipeline = init.reactionPipeline;
        this.reactionLayout = init.reactionLayout;
        this.paintPipeline = init.paintPipeline;
        this.paintLayout = init.paintLayout;
        this.noisePipeline = init.noisePipeline;
        this.noiseLayout = init.noiseLayout;
        this.renderer = init.renderer;
        this.simParamsBuffer = init.simParamsBuffer;
        this.paintParamsBuffer = init.paintParamsBuffer;
        this.noiseParamsBuffer = init.noiseParamsBuffer;
        this.lutBuffer = init.lutBuffer;
        this.gradientBuffer = init.gradientBuffer;
        this.textures = init.textures;
        this.camera = init.camera;

        // Every bind group both orientations can need, built once. The Rust
        // rebuilds the render and camera bind groups on *every frame*
        // (simulation.rs:1316) and a fresh paint buffer plus bind group on every
        // mouse event (paint_compute.rs:88); neither depends on anything that
        // changes between frames.
        this.rebuildBindGroups();
        this.seedInitialField();
    }

    static async create(gpu: GpuContext, lut?: Uint32Array): Promise<GrayScottSimulation> {
        const { device, format } = gpu;
        const [width, height] = grayScottTextureSize(
            gpu.width,
            gpu.height,
            gpu.caps.maxTextureDimension2D
        );

        // --- reaction ------------------------------------------------------
        //
        // Binding 0 is `texture_storage_2d<rgba16float, read>`, the read-only
        // storage-texture form. It is a pre-existing use rather than something
        // this port introduced, and it was measured working in Chrome and in
        // SwiftShader with no extra feature requested, so it is left alone.
        // (`paint.wgsl` was a different case — it wanted `read_write` on
        // rgba16float, which core WebGPU rejects outright, and it was converted
        // to a ping-pong pass with a sampled source.)
        const reactionModule = await createShaderModuleChecked(device, {
            label: 'gray-scott reaction',
            code: getShader(GRAY_SCOTT_REACTION_SHADER_PATH),
        });

        const reactionLayout = device.createBindGroupLayout({
            label: 'gray-scott reaction layout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'read-only',
                        format: 'rgba16float',
                        viewDimension: '2d',
                    },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'rgba16float',
                        viewDimension: '2d',
                    },
                },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                {
                    binding: 3,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'read-only-storage' },
                },
            ],
        });

        const reactionPipeline = await createComputePipelineChecked(device, {
            label: 'gray-scott reaction pipeline',
            layout: device.createPipelineLayout({
                label: 'gray-scott reaction pipeline layout',
                bindGroupLayouts: [reactionLayout],
            }),
            compute: { module: reactionModule, entryPoint: 'main' },
        });

        // --- paint ---------------------------------------------------------

        const paintModule = await createShaderModuleChecked(device, {
            label: 'gray-scott paint',
            code: getShader(GRAY_SCOTT_PAINT_SHADER_PATH),
        });

        const paintLayout = device.createBindGroupLayout({
            label: 'gray-scott paint layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'rgba16float',
                        viewDimension: '2d',
                    },
                },
            ],
        });

        const paintPipeline = await createComputePipelineChecked(device, {
            label: 'gray-scott paint pipeline',
            layout: device.createPipelineLayout({
                label: 'gray-scott paint pipeline layout',
                bindGroupLayouts: [paintLayout],
            }),
            compute: { module: paintModule, entryPoint: 'main' },
        });

        // --- noise seeding -------------------------------------------------

        const noiseModule = await createShaderModuleChecked(device, {
            label: 'gray-scott noise seed',
            code: getShader(GRAY_SCOTT_NOISE_SHADER_PATH),
        });

        const noiseLayout = device.createBindGroupLayout({
            label: 'gray-scott noise layout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'rgba16float',
                        viewDimension: '2d',
                    },
                },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ],
        });

        const noisePipeline = await createComputePipelineChecked(device, {
            label: 'gray-scott noise pipeline',
            layout: device.createPipelineLayout({
                label: 'gray-scott noise pipeline layout',
                bindGroupLayouts: [noiseLayout],
            }),
            compute: { module: noiseModule, entryPoint: 'main' },
        });

        // --- render --------------------------------------------------------

        const renderer = await InfiniteRenderer.create(device, format, {
            label: 'gray-scott',
            path: 'storage',
        });

        const simParamsBuffer = createUniformBuffer(device, GRAY_SCOTT_PARAM_BYTES, {
            label: 'gray-scott params',
        });
        const paintParamsBuffer = createUniformBuffer(device, PAINT_PARAM_BYTES, {
            label: 'gray-scott paint params',
        });
        const noiseParamsBuffer = createUniformBuffer(device, NOISE_PARAM_BYTES, {
            label: 'gray-scott noise params',
        });
        const lutBuffer = createBufferWithData(
            device,
            lut && lut.length === LUT_ENTRIES ? lut : defaultGrayScottLut(),
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            'gray-scott lut'
        );
        const gradientBuffer = createStorageBuffer(device, width * height * 4, {
            label: 'gray-scott gradient map',
        });

        const textures = new PingPongTextures(device, width, height, 'rgba16float', {
            label: 'gray-scott uvs',
        });

        // Uploaded straight away: the very first frame may be a paused redraw
        // (the host asks for one on resize), and an all-zero camera uniform is
        // a degenerate transform that collapses every tile to a point.
        const camera = new Camera(gpu.width, gpu.height);
        camera.attachToDevice(device, 'gray-scott camera uniform');
        camera.uploadToGpu(device.queue);
        renderer.setCameraBuffer(camera.getBuffer()!);

        return new GrayScottSimulation({
            device,
            format,
            maxTextureDimension2D: gpu.caps.maxTextureDimension2D,
            width,
            height,
            reactionPipeline,
            reactionLayout,
            paintPipeline,
            paintLayout,
            noisePipeline,
            noiseLayout,
            renderer,
            simParamsBuffer,
            paintParamsBuffer,
            noiseParamsBuffer,
            lutBuffer,
            gradientBuffer,
            textures,
            camera,
        });
    }

    // -----------------------------------------------------------------------
    // Frame
    // -----------------------------------------------------------------------

    /**
     * One reaction step, then the tiled canvas.
     *
     * **`background_render.wgsl` is deliberately not ported.** The Rust draws it
     * first, into the same render pass, from a `BackgroundParams` buffer that is
     * written once at construction (simulation.rs:497) and mutated by no command
     * anywhere in the tree — so `background_type` is permanently 0 and the shader
     * outputs opaque black over the whole quad. `InfiniteRenderer.encode` already
     * clears black, so omitting the pass is pixel-identical, and one pipeline,
     * one bind group and one uniform buffer per simulation go with it.
     */
    renderFrame(view: GPUTextureView, dt: number): void {
        if (this.destroyed) return;

        // `State::simulation_time` is never written by the Rust — it is
        // initialised to 0 and reset to 0, and nothing in between advances it.
        // Advanced here because it is a state field the UI reads and a clock
        // that never ticks is worse than a small divergence.
        this.state.simulation_time += dt;

        this.uploadParams();
        this.advanceOwnCamera(dt);

        const encoder = this.device.createCommandEncoder({ label: 'gray-scott frame' });

        const pass = encoder.beginComputePass({ label: 'gray-scott reaction' });
        pass.setPipeline(this.reactionPipeline);
        pass.setBindGroup(0, this.reactionBindGroups[this.textures.currentIndex]);
        pass.dispatchWorkgroups(
            Math.ceil(this.width / WORKGROUP_SIZE),
            Math.ceil(this.height / WORKGROUP_SIZE),
            1
        );
        pass.end();

        // Swap before drawing: the pass wrote `inactive`, so after the swap
        // `current` is the frame that was just produced.
        this.textures.swap();
        this.renderer.encode(
            encoder,
            view,
            this.renderBindGroups[this.textures.currentIndex],
            this.camera.zoom
        );

        this.device.queue.submit([encoder.finish()]);
    }

    renderFramePaused(view: GPUTextureView): void {
        if (this.destroyed) return;

        const encoder = this.device.createCommandEncoder({ label: 'gray-scott frame (paused)' });
        this.renderer.encode(
            encoder,
            view,
            this.renderBindGroups[this.textures.currentIndex],
            this.camera.zoom
        );
        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * Resize the field to the new surface.
     *
     * The concentration pair cannot be resampled — a reaction-diffusion state is
     * not an image, and a stretched one is not a valid state of the new grid —
     * so both textures are re-seeded, exactly as `recreate_simulation_buffers`
     * (simulation.rs:740) does. A window resize therefore restarts the pattern,
     * on both builds.
     */
    resize(width: number, height: number): void {
        if (this.destroyed) return;

        const [nextWidth, nextHeight] = grayScottTextureSize(
            width,
            height,
            this.maxTextureDimension2D
        );
        this.camera.resize(width, height);
        if (nextWidth === this.width && nextHeight === this.height) return;

        this.width = nextWidth;
        this.height = nextHeight;
        this.paramsDirty = true;

        this.textures.destroy();
        this.textures = new PingPongTextures(this.device, nextWidth, nextHeight, 'rgba16float', {
            label: 'gray-scott uvs',
        });

        // The gradient map is indexed by simulation texel, so it is exactly as
        // invalid as the field itself.
        this.gradientBuffer.destroy();
        this.gradientBuffer = createStorageBuffer(this.device, nextWidth * nextHeight * 4, {
            label: 'gray-scott gradient map',
        });

        this.rebuildBindGroups();
        this.seedInitialField();
        this.refitMask();
    }

    // -----------------------------------------------------------------------
    // Settings and state
    // -----------------------------------------------------------------------

    getSettings(): Record<string, unknown> {
        return { ...this.settings };
    }

    /**
     * The state document, with the mask pixel arrays stripped — see
     * `grayScottStateDocument`.
     *
     * `camera_position` and `camera_zoom` are inert fields in the Rust (nothing
     * ever writes them) but are part of the document's shape, so they are filled
     * from the live camera rather than reported as a permanent 0/1.
     */
    getState(): Record<string, unknown> {
        return grayScottStateDocument({
            ...this.state,
            camera_position: [this.camera.position[0], this.camera.position[1]],
            camera_zoom: this.camera.zoom,
        });
    }

    updateSetting(name: string, value: unknown): void {
        this.applyEffect(updateGrayScottSetting(this.settings, name, value));
    }

    updateState(name: string, value: unknown): void {
        this.applyEffect(updateGrayScottState(this.state, name, value));
    }

    applySettings(settings: Record<string, unknown>): void {
        this.settings = normalizeGrayScottSettings(settings);
        this.paramsDirty = true;
    }

    randomizeSettings(): void {
        randomizeGrayScottSettings(this.settings);
        this.paramsDirty = true;
    }

    /**
     * A no-op, faithfully — see `resetGrayScottRuntimeState`. Clearing the field
     * belongs in `reset()`, which the "Reset" button reaches through the
     * separate `reset_simulation` command.
     */
    resetRuntimeState(): void {
        resetGrayScottRuntimeState();
    }

    /**
     * `GrayScottModel::reset` (simulation.rs:915) — blank the concentration
     * field back to its initial condition, leaving settings and camera alone.
     */
    reset(): void {
        if (this.destroyed) return;
        this.seedInitialField();
        this.state.simulation_time = 0;
    }

    /**
     * `seed_random_noise` (simulation.rs:951) — fBm noise into the field, which
     * is what `GrayScottMode.svelte` fires once on `simulation-initialized` so
     * the user sees a pattern developing rather than one central blob.
     *
     * Both textures are seeded **with the same seed**, so the pair stays
     * coherent and no swap is needed afterwards; the Rust does the same. `seed`
     * is injectable purely so the result is testable — the Rust draws it from
     * `rand::random`, which is what the default does.
     */
    seedRandomNoise(seed: number = randomSeed(), noiseStrength = 1.0): void {
        if (this.destroyed) return;

        const params = new DataView(this.noiseScratch);
        params.setUint32(0, this.width, true);
        params.setUint32(4, this.height, true);
        params.setUint32(8, seed >>> 0, true);
        params.setFloat32(12, noiseStrength, true);
        this.device.queue.writeBuffer(this.noiseParamsBuffer, 0, this.noiseScratch);

        const encoder = this.device.createCommandEncoder({ label: 'gray-scott noise seed' });
        const pass = encoder.beginComputePass({ label: 'gray-scott noise seed' });
        pass.setPipeline(this.noisePipeline);
        for (const bindGroup of this.noiseBindGroups) {
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(
                Math.ceil(this.width / WORKGROUP_SIZE),
                Math.ceil(this.height / WORKGROUP_SIZE),
                1
            );
        }
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * Replace the LUT.
     *
     * `lut` arrives from `ColorSchemeManager.current()`, which has **already**
     * applied the reversal, so it is written verbatim — the same contract Moiré
     * follows, and the reason no shader-side inversion flag is set. The name is
     * not carried on this seam; `GrayScottMode.svelte` follows every
     * `apply_color_scheme_by_name` with an `update_simulation_state` that writes
     * `current_color_scheme`, which is the only thing that fills it in.
     */
    updateColorScheme(lut: Uint32Array, reversed: boolean): void {
        if (lut.length !== LUT_ENTRIES) {
            throw new Error(`LUT must be ${LUT_ENTRIES} u32 entries, got ${lut.length}`);
        }
        this.state.color_scheme_reversed = reversed;
        writeBuffer(this.device.queue, this.lutBuffer, lut);
    }

    // -----------------------------------------------------------------------
    // Pointer
    // -----------------------------------------------------------------------

    /**
     * Paint into the field. The first pointer-driven write path in this port.
     *
     * The host hands over **world** coordinates; `paint.wgsl` wants normalised
     * texture space, Y-down. The conversion is the one at manager.rs:538, which
     * is the live path — note the trait impl at simulation.rs:1857 does the same
     * conversion **without the Y flip**, so the desktop build has two
     * contradictory versions and paints upside down through whichever of the two
     * commands is not the one the UI uses.
     *
     * Painting is a ping-pong pass (remediation (c)): every destination texel is
     * written, the untouched ones copied through, so the swap afterwards is not
     * optional — skipping it would show a field two frames stale.
     */
    handleMouseInteraction(worldX: number, worldY: number, button: number): void {
        if (this.destroyed) return;

        const textureX = (worldX + 1) * 0.5;
        const textureY = (1 - worldY) * 0.5;

        this.state.mouse_screen_position = [worldX, worldY];

        // `TextureCoords::is_valid` (coordinates.rs:105). A click outside the
        // tile under the cursor is not an error, it just paints nothing.
        if (!(textureX >= 0 && textureX <= 1 && textureY >= 0 && textureY <= 1)) return;

        this.state.mouse_pressed = true;
        this.state.mouse_position = [textureX, textureY];

        const params = new DataView(this.paintScratch);
        params.setFloat32(0, textureX, true);
        params.setFloat32(4, textureY, true);
        params.setFloat32(8, this.state.cursor_size, true);
        params.setFloat32(12, this.state.cursor_strength, true);
        params.setUint32(16, button >>> 0, true);
        params.setUint32(20, this.width, true);
        params.setUint32(24, this.height, true);
        params.setUint32(28, 0, true);
        this.device.queue.writeBuffer(this.paintParamsBuffer, 0, this.paintScratch);

        const encoder = this.device.createCommandEncoder({ label: 'gray-scott paint' });
        const pass = encoder.beginComputePass({ label: 'gray-scott paint' });
        pass.setPipeline(this.paintPipeline);
        pass.setBindGroup(0, this.paintBindGroups[this.textures.currentIndex]);
        pass.dispatchWorkgroups(
            Math.ceil(this.width / WORKGROUP_SIZE),
            Math.ceil(this.height / WORKGROUP_SIZE),
            1
        );
        pass.end();
        this.device.queue.submit([encoder.finish()]);

        this.textures.swap();
    }

    handleMouseRelease(_button: number): void {
        // simulation.rs:1509 — nothing to undo; the paint already happened.
        this.state.mouse_pressed = false;
    }

    // -----------------------------------------------------------------------
    // Camera and images
    // -----------------------------------------------------------------------

    /** `SimulationHost` hook — one camera on the host, not one per simulation. */
    attachCamera(camera: Camera): void {
        if (this.destroyed || camera === this.camera) return;

        if (this.ownsCamera) this.camera.destroy();
        this.camera = camera;
        this.ownsCamera = false;

        camera.attachToDevice(this.device, 'gray-scott camera uniform');
        camera.uploadToGpu(this.device.queue);
        this.renderer.setCameraBuffer(camera.getBuffer()!);
    }

    /**
     * `load_nutrient_image` — the image-driven mask, mask pattern 8.
     *
     * Loading an image does **not** select the pattern that reads it; the UI
     * does that separately, as it does on the desktop. Session-only, like every
     * other uploaded image in this port.
     */
    async loadImage(file: File): Promise<void> {
        const bitmap = await decodeImageFile(file);
        if (this.destroyed) {
            bitmap.close();
            return;
        }

        this.maskSource?.close();
        this.maskSource = bitmap;
        this.refitMask();
    }

    /** True once a mask image has been decoded and uploaded. */
    get hasImage(): boolean {
        return this.maskLoaded;
    }

    /** Simulation-texture size, which is not the surface size once clamped. */
    get textureSize(): [number, number] {
        return [this.width, this.height];
    }

    /**
     * The half of the ping-pong pair currently holding the field.
     *
     * The readback seam: `SIM_TEXTURE_USAGE` includes COPY_SRC, so a test (or a
     * future "export a frame" command) can copy the concentrations out without
     * reaching through the ping-pong by index and getting the stale half.
     */
    get currentField(): GPUTexture {
        return this.textures.current;
    }

    /**
     * `update_app_settings` (simulation.rs:683) — the app-wide texture-filtering
     * preference `Settings.svelte` edits.
     *
     * On the desktop this wrote a buffer that was bound nowhere; see the
     * `renderParams` comment in `InfiniteRenderer`. Here it reaches the shader,
     * which means Gray-Scott's default appearance changes from Lanczos to
     * Linear — that is remediation (2), and the reason this hook exists at all.
     */
    setFilteringMode(mode: TextureFilteringMode): void {
        if (this.destroyed) return;
        this.renderer.setFilteringMode(mode);
    }

    get targetFormat(): GPUTextureFormat {
        return this.format;
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        this.simParamsBuffer.destroy();
        this.paintParamsBuffer.destroy();
        this.noiseParamsBuffer.destroy();
        this.lutBuffer.destroy();
        this.gradientBuffer.destroy();
        this.textures.destroy();
        this.maskSource?.close();
        this.maskSource = null;
        this.renderer.destroy();

        // Only ours to release: the host's camera outlives every simulation.
        if (this.ownsCamera) this.camera.destroy();
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    private applyEffect(effect: ReturnType<typeof updateGrayScottSetting>): void {
        switch (effect) {
            case 'sim-params':
            case 'both-params':
                this.paramsDirty = true;
                return;
            case 'refit-image':
                this.refitMask();
                return;
            case 'render-params':
                // `cursor_size` / `cursor_strength`. In the Rust these live in
                // the 68-byte `RenderSimulationParams`, which — see the
                // InfiniteRenderer comment — is read by nothing. Here they are
                // written straight into `PaintParams` on the next paint event,
                // so there is no buffer to refresh.
                return;
            case 'reload-lut':
                // The LUT *bytes* arrive on the `updateColorScheme` seam, driven
                // by `apply_color_scheme_by_name`. This case only records the
                // name or the reversed flag, which `updateGrayScottState` has
                // already done.
                return;
            case 'none':
                return;
        }
    }

    /**
     * Upload `SimulationParams`, if anything changed since the last upload.
     *
     * Nothing in the struct is per-frame — unlike Moiré, whose clock is in its
     * uniform — so this is dirty-flagged rather than written every frame, which
     * is also what the Rust's explicit `update_simulation_params` call sites do.
     */
    private uploadParams(): void {
        if (!this.paramsDirty) return;
        this.paramsDirty = false;

        packGrayScottParams(
            this.guardedSettings(),
            this.state,
            { width: this.width, height: this.height },
            this.paramScratch
        );
        this.device.queue.writeBuffer(this.simParamsBuffer, 0, this.paramScratch);
    }

    /**
     * The adaptive-timestep guard.
     *
     * `calculate_adaptive_timestep` (reaction_diffusion.wgsl:242) forms
     * `0.25 / (delta_u + delta_v)` and `1.0 / (1.0 + feed_rate + kill_rate)`
     * with no guard on either denominator, and all four are user-settable to
     * anything finite — settings.ts deliberately clamps nothing, because the
     * Rust clamps nothing.
     *
     * A single zero denominator is survivable on its own (`min` picks the other
     * limit), but the two failure modes are real: a *negative* total diffusion
     * makes the effective timestep negative and runs the reaction backwards, and
     * *both* denominators at zero makes it `inf`, which multiplies a zero
     * derivative into NaN and poisons the whole field within one frame — with no
     * way back short of a reset, since NaN survives the `clamp`.
     *
     * So the precondition is checked where it can be: the adaptive path is used
     * only when both of its stability limits are positive numbers. Otherwise the
     * uploaded copy has the flag cleared and the user's fixed `timestep` applies
     * — the same fallback the shader takes when the feature is off. `settings`
     * itself is untouched, so `getSettings()` still reports what the user set.
     */
    private guardedSettings(): GrayScottSettings {
        const settings = this.settings;
        if (!settings.enable_adaptive_timestep) return settings;

        const diffusionSum = settings.diffusion_rate_u + settings.diffusion_rate_v;
        const reactionSum = 1 + settings.feed_rate + settings.kill_rate;
        if (diffusionSum > 0 && reactionSum > 0) return settings;

        return { ...settings, enable_adaptive_timestep: false };
    }

    /**
     * Drive the camera only when nothing else is.
     *
     * `SimulationHost` updates and uploads the camera it owns before calling
     * `renderFrame`; doing it again here would double the smoothing rate.
     */
    private advanceOwnCamera(dt: number): void {
        if (!this.ownsCamera) return;
        this.camera.update(dt);
        this.camera.uploadToGpu(this.device.queue);
    }

    /**
     * Every bind group, in both orientations, indexed by `currentIndex` — so no
     * caller ever picks an orientation by hand.
     *
     * [0] reads A and writes B, [1] reads B and writes A, for the two ping-pong
     * passes; the noise pass writes one texture each and the render pass reads
     * one, so for those the index simply names the texture.
     */
    private rebuildBindGroups(): void {
        const [viewA, viewB] = this.textures.allViews;

        const reaction = (read: GPUTextureView, write: GPUTextureView, suffix: string) =>
            this.device.createBindGroup({
                label: `gray-scott reaction ${suffix}`,
                layout: this.reactionLayout,
                entries: [
                    { binding: 0, resource: read },
                    { binding: 1, resource: write },
                    { binding: 2, resource: { buffer: this.simParamsBuffer } },
                    { binding: 3, resource: { buffer: this.gradientBuffer } },
                ],
            });

        const paint = (read: GPUTextureView, write: GPUTextureView, suffix: string) =>
            this.device.createBindGroup({
                label: `gray-scott paint ${suffix}`,
                layout: this.paintLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.paintParamsBuffer } },
                    { binding: 1, resource: read },
                    { binding: 2, resource: write },
                ],
            });

        const noise = (write: GPUTextureView, suffix: string) =>
            this.device.createBindGroup({
                label: `gray-scott noise ${suffix}`,
                layout: this.noiseLayout,
                entries: [
                    { binding: 0, resource: write },
                    { binding: 1, resource: { buffer: this.noiseParamsBuffer } },
                ],
            });

        this.reactionBindGroups = [reaction(viewA, viewB, 'A->B'), reaction(viewB, viewA, 'B->A')];
        this.paintBindGroups = [paint(viewA, viewB, 'A->B'), paint(viewB, viewA, 'B->A')];
        this.noiseBindGroups = [noise(viewA, 'A'), noise(viewB, 'B')];
        this.renderBindGroups = this.renderer.createStorageSourceBindGroups(
            this.textures.allViews,
            this.lutBuffer
        );
    }

    /** Write the initial condition into **both** textures, as the Rust does. */
    private seedInitialField(): void {
        const texels = grayScottSeedTexels(this.width, this.height);
        for (const texture of this.textures.all) {
            this.device.queue.writeTexture(
                { texture },
                texels,
                // 8 bytes per texel — four halves. This is the number the Rust
                // gets wrong; see `grayScottSeedTexels`.
                { bytesPerRow: this.width * 8, rowsPerImage: this.height },
                { width: this.width, height: this.height, depthOrArrayLayers: 1 }
            );
        }
    }

    /**
     * Re-fit the decoded mask image to the current simulation size and fit mode,
     * and upload it to `gradient_map`.
     *
     * Only the *fit* happens on the CPU. Mirroring and tone inversion are
     * uniform flags `get_mask_factor` applies (reaction_diffusion.wgsl:119 and
     * :234), so baking them in here would apply them twice — the Rust says as
     * much at simulation.rs:1128.
     *
     * The buffer is `array<f32>` in [0,1], not bytes: the binding type is part
     * of the shared corpus and cannot change, so the greyscale helper that
     * returns floats is the one to use here. (`grayscaleBytesFromCanvas`, which
     * Moiré uses, is for an `r8unorm` *texture* — a different consumer.)
     */
    private refitMask(): void {
        if (!this.maskSource || this.destroyed) return;

        const canvas = drawFittedImage(this.maskSource, this.width, this.height, {
            fitMode: this.state.mask_image_fit_mode,
        });
        const values = grayscaleFromCanvas(canvas, this.width, this.height);

        writeBuffer(this.device.queue, this.gradientBuffer, values);
        this.maskLoaded = true;
        this.state.mask_image_needs_upload = false;
    }
}

export async function createGrayScott(gpu: GpuContext): Promise<Simulation> {
    return GrayScottSimulation.create(gpu);
}

/** `rand::random::<u32>()`, which is what seeds the noise pass in the Rust. */
function randomSeed(): number {
    return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/**
 * A neutral greyscale ramp, so the first frame has a LUT before the
 * colour-scheme layer has fetched anything.
 *
 * The Rust loaded "MATPLOTLIB_prism" at construction (simulation.rs:519); in the
 * browser that is a network fetch on the critical path to first paint, and
 * `apply_color_scheme_by_name` replaces this within a frame or two. Grey rather
 * than an approximation of prism, so a LUT that never got replaced looks
 * obviously provisional instead of subtly wrong.
 */
export function defaultGrayScottLut(): Uint32Array {
    const lut = new Uint32Array(LUT_ENTRIES);
    for (let i = 0; i < 256; i++) {
        lut[i] = i;
        lut[256 + i] = i;
        lut[512 + i] = i;
    }
    return lut;
}
