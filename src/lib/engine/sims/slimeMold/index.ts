/**
 * Slime Mold — a port of slime_mold/simulation.rs (3,230 ln) around
 * `compute.wgsl` (610 ln, five entry points), `display.wgsl`, `gradient.wgsl`
 * and the shared infinite renderer.
 *
 * The largest simulation in the project, and the first with an agent pool. What
 * is new here relative to M3–M6:
 *
 *   - a **storage buffer** as the working field rather than a texture. The
 *     trail map is `array<f32>`, one float per simulation pixel, and every
 *     compute pass reads and writes it as `read_write` storage. That is legal
 *     WebGPU (the `read_write` prohibition is on storage *textures*), so no
 *     remediation was needed — but it is also unsynchronised, see `renderFrame`.
 *   - a **display compute pass**: the trail scalar is coloured through the LUT
 *     into an `rgba8unorm` storage texture, which the infinite renderer then
 *     samples. So Slime Mold takes the renderer's *texture* path (`fs_main_texture`),
 *     like Moiré, not Gray-Scott's storage path.
 *   - **two image inputs**, position and mask, sharing one GPU buffer — see
 *     `loadImage`.
 *   - an agent buffer whose size the user picks, which is the one number in
 *     this app that can lose the device. Every path that sizes it goes through
 *     `clampSlimeMoldAgentCount` (settings.ts); there is no such clamp anywhere
 *     in the Rust.
 *
 * Deliberate divergences from the Rust, each commented where it happens:
 *
 *   1. `compute.wgsl`'s agent index stride is now `num_workgroups.x`, not a
 *      hardcoded 65535 — the Rust skipped 15 of every 16 agents. See
 *      `dispatchAgentPass`.
 *   2. The trail map is **one** buffer, not a ping-pong pair. See `renderFrame`.
 *   3. The mask pass runs on change, not every frame, and also runs for the
 *      `Disabled` pattern so that disabling a mask actually disables it. See
 *      `refreshMask`.
 *   4. `background_render.wgsl` is not ported; nor are the buffer pool, the
 *      workgroup optimizer, or the average-colour pipeline. See the notes on
 *      each below.
 *   5. `decay_frequency` / `diffusion_frequency` are honoured. They are stored
 *      and read by nothing in the Rust. See `renderFrame`.
 *   6. The position image is uploaded around the seeding dispatch rather than
 *      at load time. See `resetAgents`.
 */

import type { GpuContext, Simulation, SimulationId } from '$lib/engine/types';
import { getShader } from '$lib/engine/shaders';
import {
    createComputePipelineChecked,
    createShaderModuleChecked,
} from '$lib/engine/gpu/errorScopes';
import { foldDispatch } from '$lib/engine/gpu/limits';
import {
    createBufferWithData,
    createStorageBuffer,
    createUniformBuffer,
    writeBuffer,
} from '$lib/engine/resources/buffers';
import { createTexture2d } from '$lib/engine/resources/textures';
import { Camera } from '$lib/engine/core/Camera';
import { InfiniteRenderer, type TextureFilteringMode } from '$lib/engine/render/InfiniteRenderer';
import {
    decodeImageFile,
    drawFittedImage,
    grayscaleFromCanvas,
} from '$lib/engine/resources/imageUpload';
import {
    clampSlimeMoldAgentCount,
    defaultSlimeMoldSettings,
    defaultSlimeMoldState,
    normalizeSlimeMoldSettings,
    packSlimeMoldBackgroundParams,
    packSlimeMoldCursorParams,
    packSlimeMoldSimSize,
    randomizeSlimeMoldSettings,
    slimeMoldStateDocument,
    updateSlimeMoldSetting,
    updateSlimeMoldState,
    SLIME_MOLD_BACKGROUND_PARAM_BYTES,
    SLIME_MOLD_CURSOR_PARAM_BYTES,
    SLIME_MOLD_DEFAULT_AGENTS,
    SLIME_MOLD_SIM_SIZE_BYTES,
    type SlimeMoldSettings,
    type SlimeMoldSettingEffect,
    type SlimeMoldState,
} from './settings';

export const SLIME_MOLD_COMPUTE_SHADER_PATH = 'slime_mold/shaders/compute.wgsl';
export const SLIME_MOLD_DISPLAY_SHADER_PATH = 'slime_mold/shaders/display.wgsl';
export const SLIME_MOLD_GRADIENT_SHADER_PATH = 'slime_mold/shaders/gradient.wgsl';

/** 768 u32 entries, planar [R][G][B] — the shape of every .lut file. */
const LUT_ENTRIES = 768;

/** 16 B per agent: `vec4<f32>(x, y, angle, speed)` (compute.wgsl:2, :41). */
export const SLIME_MOLD_AGENT_STRIDE = 16;

/** One f32 per simulation pixel (compute.wgsl:44). */
export const SLIME_MOLD_TRAIL_STRIDE = 4;

/**
 * The five compute entry points, with the workgroup shapes the WGSL declares.
 *
 * **`workgroup_optimizer.rs` (242 ln) does not port.** It chose these numbers
 * from the GPU *vendor* string and `ShaderManager::create_compute_shader`
 * (render/shader_manager.rs:71) then text-substituted them into the WGSL source
 * before compiling. WebGPU deliberately does not expose the vendor, so the port
 * uses the literal sizes — which is also the only *safe* choice, because the
 * shader bodies and the Rust's own dispatch arithmetic both hardcode 16 in
 * places (simulation.rs:1039, compute.wgsl:177) and therefore silently
 * miscompute at any other size. `settings.ts` records that no setting depends
 * on this.
 *
 * 16x16 is exactly `maxComputeInvocationsPerWorkgroup` on the reference device,
 * so there is no headroom to enlarge these (WEB_PORT.md, "Reference device").
 */
const AGENT_WORKGROUP = { x: 16, y: 16, threads: 256 } as const;
const FIELD_WORKGROUP = 16;
const MASK_WORKGROUP = 256;
const RESET_WORKGROUP = 64;

/**
 * `TIME_STEP` (compute.wgsl:155) — a *constant* 0.016 inside the kernel, not
 * the frame's delta. Exported because the L3 agent-motion bounds are derived
 * from it rather than from a number written twice.
 */
export const SLIME_MOLD_TIME_STEP = 0.016;

// ---------------------------------------------------------------------------
// Field sizing
// ---------------------------------------------------------------------------

/**
 * How much of the storage-binding budget one trail-sized buffer may take.
 *
 * There are **two** of them — the trail map and the mask/position map — plus
 * the agent buffer, and all three have to be bound at once. A quarter each
 * leaves the agent pool its own ninth of the budget with room to spare.
 *
 * The Rust instead allowed a single buffer to fill the *entire*
 * `max_storage_buffer_binding_size` (simulation.rs:228) and only then scaled
 * down, which cannot fit the mask buffer beside it.
 */
export const SLIME_MOLD_TRAIL_BUDGET_FRACTION = 0.25;

/**
 * The largest trail map this device can drive, in texels.
 *
 * Two independent ceilings, and the smaller wins:
 *
 *  - the storage-binding budget above; and
 *  - `generate_mask` (gradient.wgsl:44) is a **1D** kernel — it indexes by
 *    `id.x` alone and ignores `id.y`, so its dispatch cannot be folded into two
 *    dimensions and the pixel count is capped at
 *    `maxComputeWorkgroupsPerDimension x 256`. Nothing in the Rust notices
 *    this; it simply under-covers the mask above 16.7 M pixels.
 */
export function slimeMoldMaxTexels(caps: {
    maxStorageBufferBindingSize: number;
    maxWorkgroupsPerDimension: number;
}): number {
    const budget = Math.floor(
        (caps.maxStorageBufferBindingSize * SLIME_MOLD_TRAIL_BUDGET_FRACTION) /
            SLIME_MOLD_TRAIL_STRIDE
    );
    return Math.max(1, Math.min(budget, caps.maxWorkgroupsPerDimension * MASK_WORKGROUP));
}

/**
 * Trail-map (and display-texture) size for a given surface.
 *
 * One simulation pixel per surface pixel, as the Rust has it, scaled down
 * preserving aspect when the surface is larger than `slimeMoldMaxTexels`. The
 * display texture is kept the *same* size deliberately: `display.wgsl:124`
 * rescales when they differ, and the Rust lets them differ only on a surface
 * wider than `maxTextureDimension2D`, at which point every dispatch that uses
 * `display_texture.width()` as a stand-in for the trail width (four sites) is
 * already wrong.
 */
export function slimeMoldFieldSize(
    width: number,
    height: number,
    caps: {
        maxStorageBufferBindingSize: number;
        maxWorkgroupsPerDimension: number;
        maxTextureDimension2D: number;
    }
): [number, number] {
    let w = Math.max(1, Math.floor(width));
    let h = Math.max(1, Math.floor(height));

    const maxTexels = slimeMoldMaxTexels(caps);
    if (w * h > maxTexels) {
        const scale = Math.sqrt(maxTexels / (w * h));
        w = Math.max(1, Math.floor(w * scale));
        h = Math.max(1, Math.floor(h * scale));
    }

    w = Math.min(w, caps.maxTextureDimension2D);
    h = Math.min(h, caps.maxTextureDimension2D);
    return [w, h];
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export interface SlimeMoldCreateOptions {
    /** 768 planar u32 entries. A neutral ramp is used when absent. */
    lut?: Uint32Array;
    /**
     * Initial agent count, clamped to `caps.slimeMoldAgents` like every other
     * path. Present so the GPU tests can run at a few thousand agents rather
     * than the million a real session starts with.
     */
    agentCount?: number;
}

export class SlimeMoldSimulation implements Simulation {
    readonly id: SimulationId = 'slime_mold';

    private readonly device: GPUDevice;
    private readonly format: GPUTextureFormat;
    private readonly caps: GpuContext['caps'];

    private readonly computeLayout: GPUBindGroupLayout;
    private readonly displayLayout: GPUBindGroupLayout;
    private readonly maskLayout: GPUBindGroupLayout;
    private readonly agentPipeline: GPUComputePipeline;
    private readonly decayPipeline: GPUComputePipeline;
    private readonly diffusePipeline: GPUComputePipeline;
    private readonly speedsPipeline: GPUComputePipeline;
    private readonly resetPipeline: GPUComputePipeline;
    private readonly displayPipeline: GPUComputePipeline;
    private readonly maskPipeline: GPUComputePipeline;
    private readonly renderer: InfiniteRenderer;

    private readonly simSizeBuffer: GPUBuffer;
    private readonly cursorBuffer: GPUBuffer;
    private readonly backgroundBuffer: GPUBuffer;
    private readonly lutBuffer: GPUBuffer;

    private agentBuffer: GPUBuffer;
    private trailBuffer: GPUBuffer;
    private maskBuffer: GPUBuffer;
    private displayTexture: GPUTexture;

    // Definite-assignment: all four are built by `rebuildBindGroups()`, which
    // the constructor calls and every reallocation calls again.
    private computeBindGroup!: GPUBindGroup;
    private displayBindGroup!: GPUBindGroup;
    private maskBindGroup!: GPUBindGroup;
    private renderBindGroup!: GPUBindGroup;

    private readonly simSizeScratch = new ArrayBuffer(SLIME_MOLD_SIM_SIZE_BYTES);
    private readonly cursorScratch = new ArrayBuffer(SLIME_MOLD_CURSOR_PARAM_BYTES);
    private readonly backgroundScratch = new ArrayBuffer(SLIME_MOLD_BACKGROUND_PARAM_BYTES);

    /** Decoded sources, kept so a fit-mode change or a resize can re-fit. */
    private maskSource: ImageBitmap | null = null;
    private positionSource: ImageBitmap | null = null;
    /** The fitted greyscale planes, at the current field size. */
    private maskPixels: Float32Array | null = null;
    private positionPixels: Float32Array | null = null;

    private camera: Camera;
    private ownsCamera = true;

    settings: SlimeMoldSettings = defaultSlimeMoldSettings();
    state: SlimeMoldState = defaultSlimeMoldState();

    private width: number;
    private height: number;
    private agents: number;
    private cursorMode: 0 | 1 | 2 = 0;
    private cursorX = 0;
    private cursorY = 0;
    private frame = 0;
    private paramsDirty = true;
    private maskDirty = true;
    private destroyed = false;

    private constructor(init: {
        device: GPUDevice;
        format: GPUTextureFormat;
        caps: GpuContext['caps'];
        width: number;
        height: number;
        agents: number;
        computeLayout: GPUBindGroupLayout;
        displayLayout: GPUBindGroupLayout;
        maskLayout: GPUBindGroupLayout;
        agentPipeline: GPUComputePipeline;
        decayPipeline: GPUComputePipeline;
        diffusePipeline: GPUComputePipeline;
        speedsPipeline: GPUComputePipeline;
        resetPipeline: GPUComputePipeline;
        displayPipeline: GPUComputePipeline;
        maskPipeline: GPUComputePipeline;
        renderer: InfiniteRenderer;
        simSizeBuffer: GPUBuffer;
        cursorBuffer: GPUBuffer;
        backgroundBuffer: GPUBuffer;
        lutBuffer: GPUBuffer;
        agentBuffer: GPUBuffer;
        trailBuffer: GPUBuffer;
        maskBuffer: GPUBuffer;
        displayTexture: GPUTexture;
        camera: Camera;
    }) {
        this.device = init.device;
        this.format = init.format;
        this.caps = init.caps;
        this.width = init.width;
        this.height = init.height;
        this.agents = init.agents;
        this.computeLayout = init.computeLayout;
        this.displayLayout = init.displayLayout;
        this.maskLayout = init.maskLayout;
        this.agentPipeline = init.agentPipeline;
        this.decayPipeline = init.decayPipeline;
        this.diffusePipeline = init.diffusePipeline;
        this.speedsPipeline = init.speedsPipeline;
        this.resetPipeline = init.resetPipeline;
        this.displayPipeline = init.displayPipeline;
        this.maskPipeline = init.maskPipeline;
        this.renderer = init.renderer;
        this.simSizeBuffer = init.simSizeBuffer;
        this.cursorBuffer = init.cursorBuffer;
        this.backgroundBuffer = init.backgroundBuffer;
        this.lutBuffer = init.lutBuffer;
        this.agentBuffer = init.agentBuffer;
        this.trailBuffer = init.trailBuffer;
        this.maskBuffer = init.maskBuffer;
        this.displayTexture = init.displayTexture;
        this.camera = init.camera;

        this.state.agent_count = init.agents;

        // Every bind group built once. The Rust rebuilds *all five* on any
        // resize or agent-count change (simulation.rs:1541) and regenerates the
        // mask on every frame; neither depends on anything per-frame.
        this.rebuildBindGroups();
        this.uploadBackgroundParams();
        this.uploadCursorParams();
        this.seedTrails();
        this.resetAgents();
    }

    static async create(
        gpu: GpuContext,
        options: SlimeMoldCreateOptions = {}
    ): Promise<SlimeMoldSimulation> {
        const { device, format, caps } = gpu;
        const [width, height] = slimeMoldFieldSize(gpu.width, gpu.height, caps);

        // The clamp, at the first of its three entry points. `create` is reached
        // from a stored `agent_count` as readily as from a fresh default, and
        // the desktop's 10 M does not fit in a 128 MiB binding at all.
        const agents = clampSlimeMoldAgentCount(
            options.agentCount ?? SLIME_MOLD_DEFAULT_AGENTS,
            caps.slimeMoldAgents
        );

        // --- compute ---------------------------------------------------------
        //
        // One module, five entry points, one bind group layout
        // (render/pipeline_manager.rs:37). Bindings 0 and 1 are `read_write`
        // storage buffers, which core WebGPU allows — the `read_write`
        // prohibition in WEB_PORT.md's remediation table is about storage
        // *textures*.

        const computeModule = await createShaderModuleChecked(device, {
            label: 'slime mold compute',
            code: getShader(SLIME_MOLD_COMPUTE_SHADER_PATH),
        });

        const computeLayout = device.createBindGroupLayout({
            label: 'slime mold compute layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                {
                    binding: 3,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'read-only-storage' },
                },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ],
        });

        const computePipelineLayout = device.createPipelineLayout({
            label: 'slime mold compute pipeline layout',
            bindGroupLayouts: [computeLayout],
        });

        const computePipeline = (label: string, entryPoint: string) =>
            createComputePipelineChecked(device, {
                label,
                layout: computePipelineLayout,
                compute: { module: computeModule, entryPoint },
            });

        const [agentPipeline, decayPipeline, diffusePipeline, speedsPipeline, resetPipeline] =
            await Promise.all([
                computePipeline('slime mold agents', 'update_agents'),
                computePipeline('slime mold decay', 'decay_trail'),
                computePipeline('slime mold diffuse', 'diffuse_trail'),
                computePipeline('slime mold agent speeds', 'update_agent_speeds'),
                computePipeline('slime mold reset agents', 'reset_agents'),
            ]);

        // --- display ---------------------------------------------------------
        //
        // Binding 4 (`gradient_map`) is declared by display.wgsl and read only
        // by `sample_gradient_map_smooth`, which `main` never calls. It stays in
        // the layout and in the bind group because a layout may carry entries a
        // pipeline does not use, and dropping it would fork the shader.

        const displayModule = await createShaderModuleChecked(device, {
            label: 'slime mold display',
            code: getShader(SLIME_MOLD_DISPLAY_SHADER_PATH),
        });

        const displayLayout = device.createBindGroupLayout({
            label: 'slime mold display layout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'read-only-storage' },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.COMPUTE,
                    storageTexture: {
                        access: 'write-only',
                        format: 'rgba8unorm',
                        viewDimension: '2d',
                    },
                },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                {
                    binding: 3,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'read-only-storage' },
                },
                {
                    binding: 4,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'read-only-storage' },
                },
            ],
        });

        const displayPipeline = await createComputePipelineChecked(device, {
            label: 'slime mold display pipeline',
            layout: device.createPipelineLayout({
                label: 'slime mold display pipeline layout',
                bindGroupLayouts: [displayLayout],
            }),
            compute: { module: displayModule, entryPoint: 'main' },
        });

        // --- mask generation -------------------------------------------------
        //
        // gradient.wgsl declares bindings **2 and 3 only** — sparse binding
        // numbers with gaps, which WebGPU allows (the infinite renderer's
        // storage path does the same). Binding 3 is `read_write` here and
        // `read` in compute.wgsl, so the two cannot share a layout.

        const maskModule = await createShaderModuleChecked(device, {
            label: 'slime mold mask',
            code: getShader(SLIME_MOLD_GRADIENT_SHADER_PATH),
        });

        const maskLayout = device.createBindGroupLayout({
            label: 'slime mold mask layout',
            entries: [
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            ],
        });

        const maskPipeline = await createComputePipelineChecked(device, {
            label: 'slime mold mask pipeline',
            layout: device.createPipelineLayout({
                label: 'slime mold mask pipeline layout',
                bindGroupLayouts: [maskLayout],
            }),
            compute: { module: maskModule, entryPoint: 'generate_mask' },
        });

        // --- render ----------------------------------------------------------
        //
        // `fs_main_texture`, bindings 0/1/2 — the same path Moiré takes. The
        // Rust's own render bind group additionally binds an average-colour
        // uniform at binding 3, which `fs_main_texture` never names; and it
        // binds a *colour* at binding 2, where the shader reads
        // `RenderParams.filtering_mode`. See the `renderParams` comment in
        // InfiniteRenderer for what that costs the desktop build.
        const renderer = await InfiniteRenderer.create(device, format, {
            label: 'slime mold',
            path: 'texture',
        });

        const simSizeBuffer = createUniformBuffer(device, SLIME_MOLD_SIM_SIZE_BYTES, {
            label: 'slime mold sim size',
        });
        const cursorBuffer = createUniformBuffer(device, SLIME_MOLD_CURSOR_PARAM_BYTES, {
            label: 'slime mold cursor params',
        });
        // Written and never read: see `uploadBackgroundParams`.
        const backgroundBuffer = createUniformBuffer(device, SLIME_MOLD_BACKGROUND_PARAM_BYTES, {
            label: 'slime mold background params',
        });
        const lutBuffer = createBufferWithData(
            device,
            options.lut && options.lut.length === LUT_ENTRIES ? options.lut : defaultSlimeMoldLut(),
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            'slime mold lut'
        );

        const agentBuffer = createAgentBuffer(device, agents);
        const trailBuffer = createStorageBuffer(device, width * height * SLIME_MOLD_TRAIL_STRIDE, {
            label: 'slime mold trail map',
        });
        const maskBuffer = createStorageBuffer(device, width * height * SLIME_MOLD_TRAIL_STRIDE, {
            label: 'slime mold mask map',
        });
        const displayTexture = createTexture2d(device, width, height, {
            label: 'slime mold display',
            format: 'rgba8unorm',
        });

        // Uploaded straight away: the first frame may be a paused redraw, and an
        // all-zero camera uniform collapses every tile to a point.
        const camera = new Camera(gpu.width, gpu.height);
        camera.attachToDevice(device, 'slime mold camera uniform');
        camera.uploadToGpu(device.queue);
        renderer.setCameraBuffer(camera.getBuffer()!);

        return new SlimeMoldSimulation({
            device,
            format,
            caps,
            width,
            height,
            agents,
            computeLayout,
            displayLayout,
            maskLayout,
            agentPipeline,
            decayPipeline,
            diffusePipeline,
            speedsPipeline,
            resetPipeline,
            displayPipeline,
            maskPipeline,
            renderer,
            simSizeBuffer,
            cursorBuffer,
            backgroundBuffer,
            lutBuffer,
            agentBuffer,
            trailBuffer,
            maskBuffer,
            displayTexture,
            camera,
        });
    }

    // -----------------------------------------------------------------------
    // Frame
    // -----------------------------------------------------------------------

    /**
     * Mask (when stale), agents, decay, diffusion, display, tiled canvas.
     *
     * **One encoder and one submit**, where the Rust uses five of each
     * (simulation.rs:837). Ordering inside a queue is guaranteed either way, so
     * the difference is purely four fewer round trips per frame.
     *
     * **The trail map is a single buffer, deliberately.** The Rust keeps a
     * `PingPongBuffers` pair and swaps it before the diffusion pass — but
     * `compute.wgsl` declares *one* `trail_map` binding, and `diffuse_trail`
     * reads its four neighbours and writes its own cell through it, so there is
     * no source/destination split to ping-pong. What the swap actually achieves
     * is that on alternate frames diffusion runs on the buffer that nothing else
     * writes and nothing reads: the deposit and decay passes always use
     * `compute_bind_group` (buffer A) and so does the display pass, so half the
     * diffusion work is discarded and the field is diffused at half the intended
     * rate. Porting the pair faithfully would mean allocating a second
     * field-sized storage buffer purely to throw work into it, so it is dropped.
     * **Consequence: diffusion now takes effect every frame rather than every
     * other one, so trails spread about twice as fast as on the desktop build at
     * the same `pheromone_diffusion_rate`.**
     *
     * In-place diffusion is a cross-workgroup read/write race, and so is the
     * deposit at compute.wgsl:329 (`trail_map[idx] = clamp(trail_map[idx] + …)`,
     * an unsynchronised read-modify-write at colliding addresses). Both are
     * faithful: this is the algorithm the Rust runs, it "works" because a lost
     * deposit or a half-diffused cell is invisible, and every value stays inside
     * [0,1] because both writes clamp. It does mean **the trail map is not
     * bit-reproducible**, which is why the determinism test in the L3 harness
     * asserts on the agent buffer after seeding instead.
     *
     * `decay_frequency` and `diffusion_frequency` gate their passes here. Both
     * are `Settings` fields that the Rust stores, accepts writes to
     * (simulation.rs:1204) and then reads **nowhere** — `run_compute_passes` has
     * no counter and runs both passes unconditionally. At their default of 1 the
     * behaviour is identical; a zero is coerced to 1 rather than disabling a
     * pass outright, since a trail map that never decays saturates to a white
     * screen and looks like a hang.
     */
    renderFrame(view: GPUTextureView, dt: number): void {
        if (this.destroyed) return;

        this.state.simulation_time += dt;
        this.uploadParams();
        this.advanceOwnCamera(dt);
        if (this.maskDirty) this.refreshMask();

        const encoder = this.device.createCommandEncoder({ label: 'slime mold frame' });

        this.dispatchAgentPass(encoder, this.agentPipeline, 'slime mold agents');

        if (this.frame % passFrequency(this.settings.decay_frequency) === 0) {
            this.dispatchField(encoder, this.decayPipeline, 'slime mold decay');
        }
        if (this.frame % passFrequency(this.settings.diffusion_frequency) === 0) {
            this.dispatchField(encoder, this.diffusePipeline, 'slime mold diffuse');
        }

        this.encodeDisplay(encoder);
        this.renderer.encode(encoder, view, this.renderBindGroup, this.camera.zoom);
        this.device.queue.submit([encoder.finish()]);

        this.frame++;
    }

    /**
     * Redraw without advancing.
     *
     * The display pass is re-run rather than skipped: it is idempotent over an
     * unchanged trail map, and it is what makes a colour-scheme change visible
     * while paused. (The Rust runs it *twice* here, simulation.rs:2366 and
     * :2392, from two separate encoders.)
     */
    renderFramePaused(view: GPUTextureView): void {
        if (this.destroyed) return;

        this.uploadParams();
        if (this.maskDirty) this.refreshMask();

        const encoder = this.device.createCommandEncoder({ label: 'slime mold frame (paused)' });
        this.encodeDisplay(encoder);
        this.renderer.encode(encoder, view, this.renderBindGroup, this.camera.zoom);
        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * Resize the field to the new surface.
     *
     * The trail map is blanked and the mask regenerated; **agents are left
     * alone**. Their positions are in simulation pixels and `update_agents`
     * wraps them toroidally (compute.wgsl:319), so an agent outside the new
     * extent re-enters on the first step — a uniform distribution stays uniform
     * under that wrap. The Rust instead nearest-neighbour-rescales the trail
     * map *and* every agent position through a `MAP_READ`/`MAP_WRITE` staging
     * round trip on the CPU (simulation.rs:2856, :2988), stalling the queue for
     * the whole of a 33 MB readback, and falls back to a plain reset whenever
     * that path throws. Not worth the stall for a field that re-forms in about a
     * second.
     */
    resize(width: number, height: number): void {
        if (this.destroyed) return;

        const [nextWidth, nextHeight] = slimeMoldFieldSize(width, height, this.caps);
        this.camera.resize(width, height);
        if (nextWidth === this.width && nextHeight === this.height) return;

        this.width = nextWidth;
        this.height = nextHeight;
        this.paramsDirty = true;

        const bytes = nextWidth * nextHeight * SLIME_MOLD_TRAIL_STRIDE;
        this.trailBuffer.destroy();
        this.trailBuffer = createStorageBuffer(this.device, bytes, {
            label: 'slime mold trail map',
        });
        this.maskBuffer.destroy();
        this.maskBuffer = createStorageBuffer(this.device, bytes, {
            label: 'slime mold mask map',
        });
        this.displayTexture.destroy();
        this.displayTexture = createTexture2d(this.device, nextWidth, nextHeight, {
            label: 'slime mold display',
            format: 'rgba8unorm',
        });

        this.rebuildBindGroups();
        this.seedTrails();

        // Both image planes are indexed by simulation texel, so they are exactly
        // as invalid as the field. The Rust never re-fits them on resize
        // (`reprocess_*_with_current_fit_mode` exists and is not called), which
        // leaves a stale-sized plane being rescaled as if it were trail data.
        this.refitImages();
        this.maskDirty = true;
    }

    // -----------------------------------------------------------------------
    // Settings and state
    // -----------------------------------------------------------------------

    getSettings(): Record<string, unknown> {
        return { ...this.settings };
    }

    getState(): Record<string, unknown> {
        return slimeMoldStateDocument({
            ...this.state,
            agent_count: this.agents,
            camera_position: [this.camera.position[0], this.camera.position[1]],
            camera_zoom: this.camera.zoom,
        });
    }

    updateSetting(name: string, value: unknown): void {
        this.applyEffect(updateSlimeMoldSetting(this.settings, this.state, name, value));
    }

    updateState(name: string, value: unknown): void {
        this.applyEffect(updateSlimeMoldState(this.state, name, value));
    }

    /**
     * Apply a preset or a stored document.
     *
     * `agent_count` is handled here even though it is *state*, not a `Settings`
     * field: this is the path a settings file written by the desktop app
     * arrives on, and that file carries a 10,000,000 which is 160 MB in one
     * binding — 32 MB past the 128 MiB the reference device grants. Left to
     * `normalizeSlimeMoldSettings` the key would simply be warned about and
     * dropped, which is safe but silently ignores the user's intent; clamped it
     * gives them as many agents as the device can actually bind.
     */
    applySettings(settings: Record<string, unknown>): void {
        this.settings = normalizeSlimeMoldSettings(settings);
        this.paramsDirty = true;
        this.maskDirty = true;

        if (settings && 'agent_count' in settings) {
            this.setAgentCount(settings.agent_count as number);
        }
    }

    /**
     * `Settings::randomize` (settings.rs:190).
     *
     * The speed bounds move, but the agents keep the speeds they were seeded
     * with until a Reset Agents — faithfully, since `randomize_settings`
     * (simulation.rs:2809) is a thin wrapper that writes the uniform and
     * dispatches nothing. `update_setting("agent_speed_min"/"_max")` *does*
     * re-roll them, which is why that path has its own effect.
     */
    randomizeSettings(): void {
        randomizeSlimeMoldSettings(this.settings);
        this.paramsDirty = true;
    }

    /**
     * `reset_runtime_state` (simulation.rs:2766) — which for Slime Mold is
     * `reset_trails`, not the no-op Gray-Scott has. This is the "Clear Trails"
     * button; "Reset Agents" is `resetAgents` and the two are separate controls.
     */
    resetRuntimeState(): void {
        if (this.destroyed) return;
        this.clearTrails();
        this.state.simulation_time = 0;
    }

    /**
     * Re-seed every agent — the second of the clamp's three entry points is
     * `setAgentCount`, and this one runs at whatever count is current.
     *
     * A fresh `random_seed` is drawn first and pushed into the uniform, exactly
     * as simulation.rs:1102 does, so pressing the button twice gives two
     * different fields. `seed` is injectable purely so the result is testable.
     */
    resetAgents(seed: number = randomSeed()): void {
        if (this.destroyed) return;

        this.settings.random_seed = seed >>> 0;
        this.paramsDirty = true;
        this.uploadParams();

        // The Image position generator samples `mask_map` (compute.wgsl:536 via
        // `sample_mask_with_mirror_invert`) — there is no separate position
        // buffer on the GPU, and the Rust says as much at simulation.rs:1949:
        // "reuse mask buffer for now, since position generation uses mask_map".
        // Its consequence there is that the two images clobber each other, and
        // that a procedural mask pattern — regenerated every frame — wipes the
        // position image within one frame of loading it. Here the position plane
        // is swapped in around the seeding dispatch and the mask restored after,
        // so both inputs work at once. Note the mask's own mirror/invert flags
        // still apply to it, because the shader applies them in the sampler.
        const usePosition =
            this.state.position_generator === 'Image' && this.positionPixels !== null;
        if (usePosition) {
            writeBuffer(this.device.queue, this.maskBuffer, this.positionPixels!);
        }

        const encoder = this.device.createCommandEncoder({ label: 'slime mold reset agents' });
        const pass = encoder.beginComputePass({ label: 'slime mold reset agents' });
        pass.setPipeline(this.resetPipeline);
        pass.setBindGroup(0, this.computeBindGroup);
        const [x, y] = foldDispatch(
            Math.ceil(this.agents / RESET_WORKGROUP),
            this.caps.maxWorkgroupsPerDimension
        );
        pass.dispatchWorkgroups(x, y, 1);
        pass.end();
        this.device.queue.submit([encoder.finish()]);

        if (usePosition) this.refreshMask();
    }

    /**
     * Resize the agent pool — the third and last entry point for the clamp.
     *
     * There is no validation whatever on the Rust side of this: a bare `u32`
     * goes from `commands/slime_mold.rs:55` into `self.agent_count = count as
     * usize` (simulation.rs:1491) and straight into a `create_buffer` of
     * `count * 16` bytes. The UI's own maximum was 100 million, i.e. a 1.6 GB
     * allocation and a guaranteed device loss. `clampSlimeMoldAgentCount`
     * reduces rather than rejects, so a preset asking for the impossible still
     * starts.
     *
     * Agent state is not preserved across a resize, on either build.
     */
    setAgentCount(count: number): void {
        if (this.destroyed) return;

        const next = clampSlimeMoldAgentCount(count, this.caps.slimeMoldAgents);
        if (next === this.agents) return;

        this.agents = next;
        this.state.agent_count = next;

        // No buffer pool. `buffer_pool.rs` is a `HashMap<(size, usage), Vec<Buffer>>`
        // free list, three deep per key, that exists to dodge Vulkan/Metal
        // allocation latency on a 500 ms-debounced resize path. `createBuffer`
        // in WebGPU is cheap, this path runs on a user gesture rather than per
        // frame, and the pool hands back a buffer with the previous owner's
        // contents still in it — which for an agent pool means live agents at
        // stale positions if a reseed is ever skipped. Not ported.
        this.agentBuffer.destroy();
        this.agentBuffer = createAgentBuffer(this.device, next);

        this.rebuildBindGroups();
        this.resetAgents();
    }

    /**
     * Replace the LUT.
     *
     * `lut` arrives from `ColorSchemeManager.current()` with the reversal
     * **already applied**, so it is written verbatim and no shader flag is set —
     * the same contract Moiré and Gray-Scott follow, and the reason reversal
     * actually reverses here where on the desktop the two inversions cancelled.
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
     * Attract (left) or repel (right) agents near the cursor.
     *
     * `handle_mouse_interaction` (simulation.rs:2692): world [-1,1] to
     * simulation pixels with the Y axis flipped, which is the same conversion
     * Gray-Scott's paint path uses. The radius is in simulation pixels too —
     * `cursor_size` defaults to **300**, not to `State::cursor_size`'s 0.20,
     * which is a dead field; see `defaultSlimeMoldState`.
     *
     * Unlike Gray-Scott there is nothing to dispatch: the cursor is a uniform
     * the agent kernel reads on its next step (compute.wgsl:276), so a click
     * outside the field is written through rather than discarded — it simply
     * leaves no agent within `cursor.size` of it.
     */
    handleMouseInteraction(worldX: number, worldY: number, button: number): void {
        if (this.destroyed) return;

        this.cursorMode = button === 0 ? 1 : button === 2 ? 2 : 0;
        this.cursorX = (worldX + 1) * 0.5 * this.width;
        this.cursorY = (1 - worldY) * 0.5 * this.height;

        this.state.mouse_pressed = this.cursorMode !== 0;
        this.state.mouse_screen_position = [worldX, worldY];
        this.state.mouse_position = [this.cursorX, this.cursorY];

        this.uploadCursorParams();
    }

    handleMouseRelease(_button: number): void {
        if (this.destroyed) return;
        this.cursorMode = 0;
        this.cursorX = 0;
        this.cursorY = 0;
        this.state.mouse_pressed = false;
        this.uploadCursorParams();
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

        camera.attachToDevice(this.device, 'slime mold camera uniform');
        camera.uploadToGpu(this.device.queue);
        this.renderer.setCameraBuffer(camera.getBuffer()!);
    }

    /**
     * The two image inputs.
     *
     * `slot` is `'position'` (`load_slime_mold_position_image`) or `'mask'`
     * (`load_slime_mold_mask_image`) — Slime Mold is the only simulation with
     * more than one, which is why `EngineContext.loadImage` carries a slot at
     * all. Loading an image does not select the generator or pattern that reads
     * it; the UI does that separately, as on the desktop.
     *
     * Both decode to a greyscale `array<f32>` in [0,1] at field resolution, not
     * to a texture: `mask_map` is a storage buffer in the shared corpus. Only
     * the *fit* happens on the CPU — mirroring and tone inversion are uniform
     * flags that `sample_mask_with_mirror_invert` (compute.wgsl:113) applies, so
     * baking them in here would apply them twice.
     */
    async loadImage(file: File, slot: string): Promise<void> {
        if (slot !== 'position' && slot !== 'mask') {
            throw new Error(`Slime Mold takes 'position' or 'mask' images, not '${slot}'`);
        }

        const bitmap = await decodeImageFile(file);
        if (this.destroyed) {
            bitmap.close();
            return;
        }

        if (slot === 'mask') {
            this.maskSource?.close();
            this.maskSource = bitmap;
        } else {
            this.positionSource?.close();
            this.positionSource = bitmap;
        }

        this.refitImages();
        if (slot === 'mask') this.maskDirty = true;
    }

    /** True once a mask image has been decoded and fitted. */
    get hasImage(): boolean {
        return this.maskPixels !== null;
    }

    get hasPositionImage(): boolean {
        return this.positionPixels !== null;
    }

    /** Simulation-field size, which is not the surface size once clamped. */
    get fieldSize(): [number, number] {
        return [this.width, this.height];
    }

    get agentCount(): number {
        return this.agents;
    }

    /** Readback seams for the L3 harness; all three carry COPY_SRC. */
    get agentStorage(): GPUBuffer {
        return this.agentBuffer;
    }

    get trailStorage(): GPUBuffer {
        return this.trailBuffer;
    }

    get maskStorage(): GPUBuffer {
        return this.maskBuffer;
    }

    get displaySurface(): GPUTexture {
        return this.displayTexture;
    }

    get targetFormat(): GPUTextureFormat {
        return this.format;
    }

    /** `update_app_settings` — the app-wide preference `Settings.svelte` edits. */
    setFilteringMode(mode: TextureFilteringMode): void {
        if (this.destroyed) return;
        this.renderer.setFilteringMode(mode);
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        this.simSizeBuffer.destroy();
        this.cursorBuffer.destroy();
        this.backgroundBuffer.destroy();
        this.lutBuffer.destroy();
        this.agentBuffer.destroy();
        this.trailBuffer.destroy();
        this.maskBuffer.destroy();
        this.displayTexture.destroy();
        this.maskSource?.close();
        this.positionSource?.close();
        this.maskSource = null;
        this.positionSource = null;
        this.maskPixels = null;
        this.positionPixels = null;
        this.renderer.destroy();

        // Only ours to release: the host's camera outlives every simulation.
        if (this.ownsCamera) this.camera.destroy();
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    private applyEffect(effect: SlimeMoldSettingEffect): void {
        switch (effect) {
            case 'sim-params':
                this.paramsDirty = true;
                return;

            case 'agent-speeds':
                // simulation.rs:1218 — changing either bound re-rolls every
                // agent's speed inside the new range, on the GPU. Dispatched
                // immediately rather than deferred to the next frame: the kernel
                // reads the bounds out of the uniform, so it has to run after
                // the upload and before anything else touches the agents.
                this.paramsDirty = true;
                this.uploadParams();
                this.dispatchAgentSpeeds();
                return;

            case 'regenerate-mask':
                this.paramsDirty = true;
                this.maskDirty = true;
                return;

            case 'background-params':
                // Kept current so the buffer holds what the Rust would have
                // written, and read by nothing — see `uploadBackgroundParams`.
                this.uploadBackgroundParams();
                return;

            case 'cursor-params':
                this.uploadCursorParams();
                return;

            case 'refit-mask-image':
                this.refitImages();
                this.maskDirty = true;
                return;

            case 'refit-position-image':
                // Re-fitted now, uploaded at the next seeding — the position
                // plane only ever reaches the GPU inside `resetAgents`.
                this.refitImages();
                return;

            case 'reload-lut':
                // The LUT bytes arrive on the `updateColorScheme` seam; this
                // case only records the name or the reversed flag, which
                // `updateSlimeMoldState` has already done.
                return;

            case 'display-sampler':
                // `trail_map_filtering`, and there is genuinely nothing to do.
                // `fs_main_texture` (infinite_render.wgsl:141) branches on
                // `filtering_mode`, but its 0 (nearest) and 1 (linear) arms are
                // *the same statement* — one `textureSample` through one
                // filtering sampler — so "Nearest" has never been nearest on any
                // build. On the desktop the setting is doubly dead:
                // `update_display_sampler` (simulation.rs:3166) reads the
                // app-wide `texture_filtering` instead of this field, and then
                // never rebuilds the bind group that holds the old sampler. The
                // live control is the app-wide one, on `setFilteringMode`.
                return;

            case 'none':
                return;
        }
    }

    /** Upload `SimSizeUniform`, if anything changed since the last upload. */
    private uploadParams(): void {
        if (!this.paramsDirty) return;
        this.paramsDirty = false;

        packSlimeMoldSimSize(
            this.settings,
            this.state,
            { width: this.width, height: this.height },
            this.simSizeScratch
        );
        this.device.queue.writeBuffer(this.simSizeBuffer, 0, this.simSizeScratch);
    }

    private uploadCursorParams(): void {
        packSlimeMoldCursorParams(
            this.state,
            { mode: this.cursorMode, x: this.cursorX, y: this.cursorY },
            this.cursorScratch
        );
        this.device.queue.writeBuffer(this.cursorBuffer, 0, this.cursorScratch);
    }

    /**
     * `update_background_params` (simulation.rs:2235), kept only so the buffer
     * has the bytes the Rust would have put there.
     *
     * **`background_render.wgsl` is deliberately not ported**, for a stronger
     * reason than Gray-Scott's. There the pass drew opaque black into a target
     * the renderer already clears; here it draws into `display_view` and then
     * the display compute pass overwrites *every* texel of that texture
     * unconditionally (display.wgsl:136 stores at every in-bounds id, and the
     * ids cover the whole texture). So the background pass has never put a pixel
     * on screen on any build, and `background_mode: White` — whose only command,
     * `update_slime_mold_background_mode`, no `.svelte` file calls — could not
     * have worked even if it were reachable. Omitting the pass costs one
     * pipeline, one bind group and one render pass per frame and changes nothing.
     */
    private uploadBackgroundParams(): void {
        packSlimeMoldBackgroundParams(this.settings, this.state, this.backgroundScratch);
        this.device.queue.writeBuffer(this.backgroundBuffer, 0, this.backgroundScratch);
    }

    private advanceOwnCamera(dt: number): void {
        if (!this.ownsCamera) return;
        this.camera.update(dt);
        this.camera.uploadToGpu(this.device.queue);
    }

    private rebuildBindGroups(): void {
        const displayView = this.displayTexture.createView();

        this.computeBindGroup = this.device.createBindGroup({
            label: 'slime mold compute',
            layout: this.computeLayout,
            entries: [
                { binding: 0, resource: { buffer: this.agentBuffer } },
                { binding: 1, resource: { buffer: this.trailBuffer } },
                { binding: 2, resource: { buffer: this.simSizeBuffer } },
                { binding: 3, resource: { buffer: this.maskBuffer } },
                { binding: 4, resource: { buffer: this.cursorBuffer } },
            ],
        });

        this.displayBindGroup = this.device.createBindGroup({
            label: 'slime mold display',
            layout: this.displayLayout,
            entries: [
                { binding: 0, resource: { buffer: this.trailBuffer } },
                { binding: 1, resource: displayView },
                { binding: 2, resource: { buffer: this.simSizeBuffer } },
                { binding: 3, resource: { buffer: this.lutBuffer } },
                { binding: 4, resource: { buffer: this.maskBuffer } },
            ],
        });

        this.maskBindGroup = this.device.createBindGroup({
            label: 'slime mold mask',
            layout: this.maskLayout,
            entries: [
                { binding: 2, resource: { buffer: this.simSizeBuffer } },
                { binding: 3, resource: { buffer: this.maskBuffer } },
            ],
        });

        this.renderBindGroup = this.renderer.createSourceBindGroup(displayView);
    }

    /**
     * The agent kernels' dispatch.
     *
     * `foldDispatch` (gpu/limits.ts) against
     * `maxComputeWorkgroupsPerDimension`, which is what the port reads instead
     * of the Rust's literal 65535 (hardcoded at simulation.rs:1024, :1138 and
     * :1169). Reading the limit is only *correct* because the shader was fixed
     * to derive its row stride from `num_workgroups.x` in the same commit: it
     * used to assume the stride was exactly `65535 * 16`, which holds only once
     * the fold saturates at 16.7 M agents. Below that the Rust's own dispatch
     * addressed 1 agent in every 16 — at 1 M agents, 62,512 of them moved and
     * 937,488 sat frozen where `reset_agents` had put them. Reported rather
     * than reproduced; see WEB_PORT.md's M7 entry.
     */
    private dispatchAgentPass(
        encoder: GPUCommandEncoder,
        pipeline: GPUComputePipeline,
        label: string
    ): void {
        const pass = encoder.beginComputePass({ label });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.computeBindGroup);
        const [x, y] = foldDispatch(
            Math.ceil(this.agents / AGENT_WORKGROUP.threads),
            this.caps.maxWorkgroupsPerDimension
        );
        pass.dispatchWorkgroups(x, y, 1);
        pass.end();
    }

    private dispatchAgentSpeeds(): void {
        const encoder = this.device.createCommandEncoder({ label: 'slime mold agent speeds' });
        this.dispatchAgentPass(encoder, this.speedsPipeline, 'slime mold agent speeds');
        this.device.queue.submit([encoder.finish()]);
    }

    /** A 2D pass over the field: decay, diffusion. */
    private dispatchField(
        encoder: GPUCommandEncoder,
        pipeline: GPUComputePipeline,
        label: string
    ): void {
        const pass = encoder.beginComputePass({ label });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, this.computeBindGroup);
        pass.dispatchWorkgroups(
            Math.ceil(this.width / FIELD_WORKGROUP),
            Math.ceil(this.height / FIELD_WORKGROUP),
            1
        );
        pass.end();
    }

    private encodeDisplay(encoder: GPUCommandEncoder): void {
        const pass = encoder.beginComputePass({ label: 'slime mold display' });
        pass.setPipeline(this.displayPipeline);
        pass.setBindGroup(0, this.displayBindGroup);
        pass.dispatchWorkgroups(
            Math.ceil(this.width / FIELD_WORKGROUP),
            Math.ceil(this.height / FIELD_WORKGROUP),
            1
        );
        pass.end();
    }

    /**
     * Put the right thing in `mask_map`, on change rather than every frame.
     *
     * Three cases, and the middle one is a fix. The Rust gates the mask
     * dispatch on `pattern != Disabled && pattern != Image`
     * (simulation.rs:993), so switching *away* from a pattern leaves the old
     * mask in the buffer — and `get_mask_factor` (compute.wgsl:149) is called
     * unconditionally by all three kernels, with `update_agents` applying it
     * through whichever `mask_target` branch is selected regardless of the
     * pattern. **Disabling the mask therefore does not disable its effect on the
     * desktop build.** `generate_mask` already writes 0.0 for both Disabled and
     * Image (gradient.wgsl:54), so the fix is simply to run the pass for
     * Disabled too and let the shader zero the buffer — which is also what makes
     * the `Image` case safe to special-case, since running it there would erase
     * the uploaded image.
     *
     * Running it on a dirty flag rather than every frame is free: the mask is a
     * pure function of the uniform, so it changes only when the uniform does.
     */
    private refreshMask(): void {
        if (this.destroyed) return;
        this.maskDirty = false;
        this.uploadParams();

        if (this.state.mask_pattern === 'Image') {
            // An Image pattern with no image loaded must not leave the previous
            // pattern behind either, hence the explicit zero fill.
            const pixels = this.maskPixels ?? new Float32Array(this.width * this.height);
            writeBuffer(this.device.queue, this.maskBuffer, pixels);
            return;
        }

        const encoder = this.device.createCommandEncoder({ label: 'slime mold mask' });
        const pass = encoder.beginComputePass({ label: 'slime mold mask' });
        pass.setPipeline(this.maskPipeline);
        pass.setBindGroup(0, this.maskBindGroup);
        // 1D only: `generate_mask` reads `id.x` and ignores `id.y`, so this
        // cannot be folded — `slimeMoldMaxTexels` caps the field precisely so
        // that it never has to be.
        pass.dispatchWorkgroups(Math.ceil((this.width * this.height) / MASK_WORKGROUP), 1, 1);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * The initial trail map: small random values, as simulation.rs:266 seeds it.
     *
     * Without it every sensor reading is identical on the first step and the
     * agents fan out in perfectly straight lines until their own deposits break
     * the tie, which takes long enough to look broken.
     */
    private seedTrails(): void {
        const values = new Float32Array(this.width * this.height);
        for (let i = 0; i < values.length; i++) values[i] = Math.random() * 0.1;
        writeBuffer(this.device.queue, this.trailBuffer, values);
    }

    /** `reset_trails` (simulation.rs:2952) — zero the whole map. */
    private clearTrails(): void {
        const encoder = this.device.createCommandEncoder({ label: 'slime mold clear trails' });
        // `clearBuffer` rather than the Rust's `write_buffer` of a
        // heap-allocated zero vector, which at 4K is a 33 MB CPU allocation and
        // upload for a fill the driver can do in place.
        encoder.clearBuffer(this.trailBuffer);
        this.device.queue.submit([encoder.finish()]);
    }

    /** Re-fit whichever images are loaded to the current field size. */
    private refitImages(): void {
        if (this.destroyed) return;

        if (this.maskSource) {
            this.maskPixels = this.fitToField(this.maskSource, this.state.mask_image_fit_mode);
            this.state.mask_image_needs_upload = false;
        }
        if (this.positionSource) {
            this.positionPixels = this.fitToField(
                this.positionSource,
                this.settings.position_image_fit_mode
            );
        }
    }

    private fitToField(source: ImageBitmap, fitMode: SlimeMoldSettings['position_image_fit_mode']) {
        const canvas = drawFittedImage(source, this.width, this.height, { fitMode });
        return grayscaleFromCanvas(canvas, this.width, this.height);
    }
}

export async function createSlimeMold(gpu: GpuContext): Promise<Simulation> {
    return SlimeMoldSimulation.create(gpu);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `create_agent_buffer` (simulation.rs:2826) — sized, never CPU-initialised.
 * The `reset_agents` kernel writes every element before anything reads one.
 */
function createAgentBuffer(device: GPUDevice, count: number): GPUBuffer {
    return createStorageBuffer(device, count * SLIME_MOLD_AGENT_STRIDE, {
        label: 'slime mold agents',
    });
}

/** A pass schedule of 0 would divide by zero; see `renderFrame`. */
function passFrequency(value: number): number {
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
}

/** `rand::random::<u32>()`, which is what re-seeds the agents in the Rust. */
function randomSeed(): number {
    return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/**
 * A neutral greyscale ramp, so the first frame has a LUT before the
 * colour-scheme layer has fetched anything.
 *
 * The Rust loads "MATPLOTLIB_cubehelix" at construction (simulation.rs:342)
 * while `State::default` names "MATPLOTLIB_prism" — the two disagree, and
 * `settings.ts` follows the state. In the browser either would be a network
 * fetch on the critical path to first paint, and `apply_color_scheme_by_name`
 * replaces this within a frame or two. Grey rather than an approximation of
 * anything, so a LUT that never got replaced looks obviously provisional.
 */
export function defaultSlimeMoldLut(): Uint32Array {
    const lut = new Uint32Array(LUT_ENTRIES);
    for (let i = 0; i < 256; i++) {
        lut[i] = i;
        lut[256 + i] = i;
        lut[512 + i] = i;
    }
    return lut;
}
