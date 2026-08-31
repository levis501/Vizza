/**
 * Moiré — a port of moire/simulation.rs (1465 ln) around
 * `moire/compute.wgsl` (316 ln) and the shared infinite renderer.
 *
 * The smallest simulation in the repo, and deliberately the first ported: one
 * compute pass into an already-legal write-only storage texture, one instanced
 * render pass, no particles, no grid, no atomics. What it does exercise is the
 * whole spine — shader corpus, ping-pong, camera uniform, LUT, presets, image
 * upload, the rpc shim — so anything structurally wrong shows up here rather
 * than in one of the large sims.
 *
 * The compute kernel both *writes* the next frame and *reads* the previous one
 * through an advected sample, so the pair is genuine ping-pong even though the
 * Rust called it "double buffering". Orientation follows the `PingPongTextures`
 * convention rather than the Rust's: the pass reads `current` and writes
 * `inactive`, then swaps, leaving `current` holding the frame just produced.
 * The Rust does it the other way round and swaps afterwards, which is why its
 * `render_frame_paused` displays the frame *before* last — a visible one-frame
 * regression every time you pause. See renderFramePaused below.
 */

import type { GpuContext, Simulation, SimulationId } from '$lib/engine/types';
import { getShader } from '$lib/engine/shaders';
import {
    createComputePipelineChecked,
    createShaderModuleChecked,
} from '$lib/engine/gpu/errorScopes';
import {
    createBufferWithData,
    createUniformBuffer,
    writeBuffer,
} from '$lib/engine/resources/buffers';
import { PingPongTextures } from '$lib/engine/resources/pingPong';
import { Camera } from '$lib/engine/core/Camera';
import { InfiniteRenderer } from '$lib/engine/render/InfiniteRenderer';
import {
    decodeImageFile,
    drawFittedImage,
    grayscaleBytesFromCanvas,
} from '$lib/engine/resources/imageUpload';
import {
    defaultMoireSettings,
    moireTextureSize,
    MOIRE_PARAM_FLOATS,
    normalizeMoireSettings,
    packMoireParams,
    randomizeMoireSettings,
    updateMoireSetting,
    type MoireSettings,
} from './settings';

export const MOIRE_SHADER_PATH = 'moire/compute.wgsl';

/** compute.wgsl:223 — `@compute @workgroup_size(8, 8)`. */
const WORKGROUP_SIZE = 8;

/** 768 u32 entries, planar [R][G][B] — the shape of every .lut file. */
const LUT_ENTRIES = 768;

export { MOIRE_MAX_DIM, moireTextureSize } from './settings';

/** Mirrors `moire/state.rs`, which is what `get_current_state` returned. */
export interface MoireState extends Record<string, unknown> {
    time: number;
    width: number;
    height: number;
    color_scheme_name: string;
    color_scheme_reversed: boolean;
    camera_position: [number, number];
    camera_zoom: number;
    simulation_time: number;
    is_running: boolean;
}

export class MoireSimulation implements Simulation {
    readonly id: SimulationId = 'moire';

    private readonly device: GPUDevice;
    private readonly format: GPUTextureFormat;
    private readonly maxTextureDimension2D: number;

    private readonly computePipeline: GPUComputePipeline;
    private readonly computeLayout: GPUBindGroupLayout;
    private readonly renderer: InfiniteRenderer;
    private readonly sampler: GPUSampler;

    private readonly paramsBuffer: GPUBuffer;
    private readonly lutBuffer: GPUBuffer;
    private readonly paramScratch = new Float32Array(MOIRE_PARAM_FLOATS);

    private textures: PingPongTextures;
    private computeBindGroups: [GPUBindGroup, GPUBindGroup];
    private renderBindGroups: [GPUBindGroup, GPUBindGroup];

    /** Bound at binding 5 whenever no image is loaded; never sampled then. */
    private readonly placeholderImage: GPUTexture;
    private imageTexture: GPUTexture | null = null;
    /** Kept so a fit-mode change can re-fit without asking for the file again. */
    private imageSource: ImageBitmap | null = null;

    private camera: Camera;
    private ownsCamera = true;

    settings: MoireSettings = defaultMoireSettings();

    private width: number;
    private height: number;
    private time = 0;
    private colorSchemeName = 'ZELDA_Fordite';
    private colorSchemeReversed = false;
    private destroyed = false;

    private constructor(init: {
        device: GPUDevice;
        format: GPUTextureFormat;
        maxTextureDimension2D: number;
        width: number;
        height: number;
        computePipeline: GPUComputePipeline;
        computeLayout: GPUBindGroupLayout;
        renderer: InfiniteRenderer;
        sampler: GPUSampler;
        paramsBuffer: GPUBuffer;
        lutBuffer: GPUBuffer;
        textures: PingPongTextures;
        placeholderImage: GPUTexture;
        camera: Camera;
    }) {
        this.device = init.device;
        this.format = init.format;
        this.maxTextureDimension2D = init.maxTextureDimension2D;
        this.width = init.width;
        this.height = init.height;
        this.computePipeline = init.computePipeline;
        this.computeLayout = init.computeLayout;
        this.renderer = init.renderer;
        this.sampler = init.sampler;
        this.paramsBuffer = init.paramsBuffer;
        this.lutBuffer = init.lutBuffer;
        this.textures = init.textures;
        this.placeholderImage = init.placeholderImage;
        this.camera = init.camera;

        this.computeBindGroups = this.buildComputeBindGroups();
        this.renderBindGroups = this.renderer.createSourceBindGroups(this.textures.allViews);
    }

    static async create(gpu: GpuContext, lut?: Uint32Array): Promise<MoireSimulation> {
        const { device, format } = gpu;
        const [width, height] = moireTextureSize(
            gpu.width,
            gpu.height,
            gpu.caps.maxTextureDimension2D
        );

        const module = await createShaderModuleChecked(device, {
            label: 'moire compute',
            code: getShader(MOIRE_SHADER_PATH),
        });

        const computeLayout = device.createBindGroupLayout({
            label: 'moire compute layout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'rgba8unorm',
                        viewDimension: '2d',
                    },
                },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'read-only-storage' },
                },
                {
                    binding: 3,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 4,
                    visibility: GPUShaderStage.COMPUTE,
                    sampler: { type: 'filtering' },
                },
                {
                    binding: 5,
                    visibility: GPUShaderStage.COMPUTE,
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
            ],
        });

        const computePipeline = await createComputePipelineChecked(device, {
            label: 'moire compute pipeline',
            layout: device.createPipelineLayout({
                label: 'moire compute pipeline layout',
                bindGroupLayouts: [computeLayout],
            }),
            compute: { module, entryPoint: 'main' },
        });

        const renderer = await InfiniteRenderer.create(device, format, { label: 'moire' });

        const sampler = device.createSampler({
            label: 'moire sampler',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'nearest',
        });

        const paramsBuffer = createUniformBuffer(device, MOIRE_PARAM_FLOATS * 4, {
            label: 'moire params',
        });
        const lutBuffer = createBufferWithData(
            device,
            lut && lut.length === LUT_ENTRIES ? lut : defaultMoireLut(),
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            'moire lut'
        );

        const textures = new PingPongTextures(device, width, height, 'rgba8unorm', {
            label: 'moire texture',
        });

        // 1x1 r8unorm, matching the format a real image lands in. Binding 5 has
        // to reference *something* legal even when image mode is off; the Rust
        // aliased one of the ping-pong textures there, which works but makes
        // every bind group depend on the ping-pong orientation for no reason.
        const placeholderImage = device.createTexture({
            label: 'moire image placeholder',
            size: { width: 1, height: 1, depthOrArrayLayers: 1 },
            format: 'r8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });

        // Uploaded straight away: the very first frame may be a paused redraw
        // (the host asks for one on resize), and an all-zero camera uniform is
        // a degenerate transform that collapses every tile to a point.
        const camera = new Camera(gpu.width, gpu.height);
        camera.attachToDevice(device, 'moire camera uniform');
        camera.uploadToGpu(device.queue);
        renderer.setCameraBuffer(camera.getBuffer()!);

        return new MoireSimulation({
            device,
            format,
            maxTextureDimension2D: gpu.caps.maxTextureDimension2D,
            width,
            height,
            computePipeline,
            computeLayout,
            renderer,
            sampler,
            paramsBuffer,
            lutBuffer,
            textures,
            placeholderImage,
            camera,
        });
    }

    // -----------------------------------------------------------------------
    // Frame
    // -----------------------------------------------------------------------

    renderFrame(view: GPUTextureView, dt: number): void {
        if (this.destroyed) return;

        // simulation.rs:922 — the animation clock is scaled by `speed`, so
        // pausing by setting speed to 0 freezes the pattern but not the flow.
        this.time += dt * this.settings.speed;
        this.uploadParams();
        this.advanceOwnCamera(dt);

        const encoder = this.device.createCommandEncoder({ label: 'moire frame' });

        const pass = encoder.beginComputePass({ label: 'moire compute' });
        pass.setPipeline(this.computePipeline);
        pass.setBindGroup(0, this.computeBindGroups[this.textures.currentIndex]);
        pass.dispatchWorkgroups(
            Math.ceil(this.width / WORKGROUP_SIZE),
            Math.ceil(this.height / WORKGROUP_SIZE),
            1
        );
        pass.end();

        // Swap before drawing: the pass wrote `inactive`, so after the swap
        // `current` is the frame that was just produced, and every later read —
        // this draw and the next paused redraw — sees the newest picture.
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

        const encoder = this.device.createCommandEncoder({ label: 'moire frame (paused)' });
        this.renderer.encode(
            encoder,
            view,
            this.renderBindGroups[this.textures.currentIndex],
            this.camera.zoom
        );
        this.device.queue.submit([encoder.finish()]);
    }

    resize(width: number, height: number): void {
        if (this.destroyed) return;

        const [nextWidth, nextHeight] = moireTextureSize(width, height, this.maxTextureDimension2D);
        this.camera.resize(width, height);
        if (nextWidth === this.width && nextHeight === this.height) return;

        this.width = nextWidth;
        this.height = nextHeight;

        this.textures.destroy();
        this.textures = new PingPongTextures(this.device, nextWidth, nextHeight, 'rgba8unorm', {
            label: 'moire texture',
        });
        this.renderBindGroups = this.renderer.createSourceBindGroups(this.textures.allViews);

        // The fitted image is rendered at simulation resolution, so a resize
        // invalidates it exactly as it invalidates the feedback textures.
        this.refitImage();
        this.computeBindGroups = this.buildComputeBindGroups();
    }

    // -----------------------------------------------------------------------
    // Settings and state
    // -----------------------------------------------------------------------

    getSettings(): Record<string, unknown> {
        return { ...this.settings };
    }

    getState(): Record<string, unknown> {
        const state: MoireState = {
            time: this.time,
            width: this.width,
            height: this.height,
            color_scheme_name: this.colorSchemeName,
            color_scheme_reversed: this.colorSchemeReversed,
            camera_position: [this.camera.position[0], this.camera.position[1]],
            camera_zoom: this.camera.zoom,
            simulation_time: this.time,
            is_running: true,
        };
        return state;
    }

    updateSetting(name: string, value: unknown): void {
        if (updateMoireSetting(this.settings, name, value) === 'refit-image') {
            this.refitImage();
            this.computeBindGroups = this.buildComputeBindGroups();
        }
    }

    updateState(name: string, value: unknown): void {
        switch (name) {
            case 'color_scheme_name':
                this.colorSchemeName = String(value);
                return;
            case 'color_scheme_reversed':
                this.colorSchemeReversed = value === true;
                return;
            default:
                throw new Error(`Unknown state: ${name}`);
        }
    }

    applySettings(settings: Record<string, unknown>): void {
        const previousFitMode = this.settings.image_fit_mode;
        this.settings = normalizeMoireSettings(settings);

        if (this.imageSource && this.settings.image_fit_mode !== previousFitMode) {
            this.refitImage();
            this.computeBindGroups = this.buildComputeBindGroups();
        }
    }

    handleMouseInteraction(_worldX: number, _worldY: number, _button: number): void {
        // simulation.rs:1235 — Moiré has no pointer interaction at all.
    }

    handleMouseRelease(_button: number): void {}

    resetRuntimeState(): void {
        // simulation.rs:1276 rewinds the clock only. The feedback textures are
        // deliberately left alone: the advection decays them out within a
        // second, and clearing them makes every preset change flash black.
        this.time = 0;
    }

    randomizeSettings(): void {
        randomizeMoireSettings(this.settings);
    }

    /**
     * Replace the LUT.
     *
     * `lut` arrives from `ColorSchemeManager.current()`, which has **already**
     * applied the reversal, so it is written verbatim and `params
     * .color_scheme_reversed` stays 0. The Rust reversed the buffer *and* told
     * the shader to invert the index (simulation.rs:1313 with compute.wgsl:285),
     * two operations that cancel — which is why reversing a colour scheme has no
     * visible effect on the desktop build.
     */
    updateColorScheme(lut: Uint32Array, reversed: boolean): void {
        if (lut.length !== LUT_ENTRIES) {
            throw new Error(`LUT must be ${LUT_ENTRIES} u32 entries, got ${lut.length}`);
        }
        this.colorSchemeReversed = reversed;
        writeBuffer(this.device.queue, this.lutBuffer, lut);
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

        camera.attachToDevice(this.device, 'moire camera uniform');
        camera.uploadToGpu(this.device.queue);
        this.renderer.setCameraBuffer(camera.getBuffer()!);
    }

    /**
     * `load_moire_image`. Session-only — nothing about the file is persisted,
     * because base64 of a 4K image would evict every preset from localStorage.
     */
    async loadImage(file: File): Promise<void> {
        const bitmap = await decodeImageFile(file);
        if (this.destroyed) {
            bitmap.close();
            return;
        }

        this.imageSource?.close();
        this.imageSource = bitmap;
        this.refitImage();
        this.computeBindGroups = this.buildComputeBindGroups();
    }

    /** True once an image has been decoded and uploaded. */
    get hasImage(): boolean {
        return this.imageTexture !== null;
    }

    /** Simulation-texture size, which is not the surface size once clamped. */
    get textureSize(): [number, number] {
        return [this.width, this.height];
    }

    get targetFormat(): GPUTextureFormat {
        return this.format;
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        this.paramsBuffer.destroy();
        this.lutBuffer.destroy();
        this.textures.destroy();
        this.placeholderImage.destroy();
        this.imageTexture?.destroy();
        this.imageTexture = null;
        this.imageSource?.close();
        this.imageSource = null;
        this.renderer.destroy();

        // Only ours to release: the host's camera outlives every simulation and
        // is re-attached to the next one.
        if (this.ownsCamera) this.camera.destroy();
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    private uploadParams(): void {
        packMoireParams(
            this.settings,
            {
                time: this.time,
                width: this.width,
                height: this.height,
                imageLoaded: this.imageTexture !== null,
                colorSchemeReversed: this.colorSchemeReversed,
            },
            this.paramScratch
        );
        this.device.queue.writeBuffer(this.paramsBuffer, 0, this.paramScratch);
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
     * Both compute orientations: [0] reads A writes B, [1] reads B writes A —
     * indexed by `textures.currentIndex`, so the orientation is never chosen by
     * hand. Binding 3 (`prev_texture`) and binding 0 (`output_texture`) are
     * always different textures, which is what keeps the pass legal.
     */
    private buildComputeBindGroups(): [GPUBindGroup, GPUBindGroup] {
        const imageView = (this.imageTexture ?? this.placeholderImage).createView();
        const [viewA, viewB] = this.textures.allViews;

        const make = (read: GPUTextureView, write: GPUTextureView, suffix: string) =>
            this.device.createBindGroup({
                label: `moire compute ${suffix}`,
                layout: this.computeLayout,
                entries: [
                    { binding: 0, resource: write },
                    { binding: 1, resource: { buffer: this.paramsBuffer } },
                    { binding: 2, resource: { buffer: this.lutBuffer } },
                    { binding: 3, resource: read },
                    { binding: 4, resource: this.sampler },
                    { binding: 5, resource: imageView },
                ],
            });

        return [make(viewA, viewB, 'A->B'), make(viewB, viewA, 'B->A')];
    }

    /**
     * Re-fit the decoded image to the current simulation size and fit mode.
     *
     * Only the *fit* happens on the CPU. Mirroring and tone inversion are
     * uniform flags the shader applies in `sample_image_intensity`
     * (compute.wgsl:140), so baking them in here would apply them twice.
     */
    private refitImage(): void {
        if (!this.imageSource) return;

        const canvas = drawFittedImage(this.imageSource, this.width, this.height, {
            fitMode: this.settings.image_fit_mode,
        });
        const bytes = grayscaleBytesFromCanvas(canvas, this.width, this.height);

        if (
            !this.imageTexture ||
            this.imageTexture.width !== this.width ||
            this.imageTexture.height !== this.height
        ) {
            this.imageTexture?.destroy();
            this.imageTexture = this.device.createTexture({
                label: 'moire image',
                size: { width: this.width, height: this.height, depthOrArrayLayers: 1 },
                format: 'r8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
        }

        // writeTexture, unlike copyBufferToTexture, puts no 256-byte alignment
        // on bytesPerRow, so a single-channel row can be written as-is.
        this.device.queue.writeTexture(
            { texture: this.imageTexture },
            bytes,
            { bytesPerRow: this.width, rowsPerImage: this.height },
            { width: this.width, height: this.height, depthOrArrayLayers: 1 }
        );
    }
}

export async function createMoire(gpu: GpuContext): Promise<Simulation> {
    return MoireSimulation.create(gpu);
}

/**
 * A built-in ramp so the first frame has a LUT before the colour-scheme layer
 * has fetched anything.
 *
 * The Rust loaded "ZELDA_Fordite" at construction (simulation.rs:205); in the
 * browser that is a network fetch on the critical path to first paint, and
 * `apply_color_scheme_by_name` replaces this within a frame or two anyway.
 * A cubehelix-like ramp, matching `State::default`'s cubehelix choice.
 */
export function defaultMoireLut(): Uint32Array {
    const lut = new Uint32Array(LUT_ENTRIES);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        // Green's cubehelix, start 0.5, rotation -1.5, hue 1.2, gamma 1.
        const angle = 2 * Math.PI * (0.5 / 3 + 1 + -1.5 * t);
        const amplitude = (1.2 * t * (1 - t)) / 2;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const channel = (a: number, b: number) =>
            Math.round(255 * Math.min(1, Math.max(0, t + amplitude * (a * cos + b * sin))));

        lut[i] = channel(-0.14861, 1.78277);
        lut[256 + i] = channel(-0.29227, -0.90649);
        lut[512 + i] = channel(1.97294, 0.0);
    }
    return lut;
}
