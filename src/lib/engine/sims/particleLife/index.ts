/**
 * Particle Life — a port of `particle_life/simulation.rs` (4,079 ln) around
 * `compute.wgsl`, `init.wgsl`, `vertex.wgsl`/`fragment.wgsl`,
 * `fade_vertex.wgsl`/`fade_fragment.wgsl` and the shared infinite renderer.
 *
 * The first simulation in the port whose working state is a particle buffer the
 * *render* stage reads directly: there is no field, no trail scalar and no
 * display compute pass. `vertex.wgsl` instances six vertices per particle
 * straight out of the same `array<Particle>` the compute kernel just wrote, so
 * the whole pipeline is compute → draw → tile.
 *
 * **Six of the eleven shaders in `particle_life/shaders/` are ported.** The
 * other five are dead on every build; each is accounted for at the point it
 * would otherwise have been used:
 *
 *   - `tile_render.wgsl` (250 ln) — a whole second renderer that tiles
 *     *particles* with per-tile LOD. Its pipeline is built (simulation.rs:998)
 *     and stored (:2009) and `set_pipeline` is never called with it anywhere in
 *     the file. See `renderFrame`.
 *   - `post_effect.wgsl` — gated on `needs_post_effects()`, which is literally
 *     `false` (simulation.rs:561) and reads no field. Its params are `[1,1,1,1]`,
 *     an identity transform. Both the pass and `render_infinite_bind_group`,
 *     its only consumer, are unreachable.
 *   - `force_update.wgsl` and `force_randomize.wgsl` — the two functions that
 *     dispatch them, `update_force_element_gpu` (:2285) and
 *     `randomize_force_matrix_gpu` (:2326), have zero callers in the whole
 *     `src-tauri` tree. Every matrix write that actually happens is CPU-side
 *     plus a `write_buffer`, which is what `uploadForceMatrix` does here.
 *   - `background_render.wgsl` — a full-screen draw of one constant colour.
 *     Ported as the render pass's own clear value; see `backgroundClear`.
 *
 * Deliberate divergences from the Rust, each commented where it happens:
 *
 *   1. Choosing a matrix generator now changes the matrix on the GPU. See
 *      `applyEffect`.
 *   2. The six controls the mode sends through `update_simulation_state` are
 *      wired. See `updateState` and settings.ts.
 *   3. The adaptive-resolution path is not ported. See `particleLifeFieldSize`.
 *   4. Particle count is clamped to a derived ceiling. See `setParticleCount`.
 *   5. The CPU and GPU tile counts agree for the first time. See `renderFrame`.
 *   6. The trail texture is the renderer's source under traces, so the blit
 *      pass and its two pipelines are gone. See `renderFrame`.
 */

import type { GpuContext, Simulation, SimulationId } from '$lib/engine/types';
import { getShader } from '$lib/engine/shaders';
import {
    createComputePipelineChecked,
    createRenderPipelineChecked,
    createShaderModuleChecked,
} from '$lib/engine/gpu/errorScopes';
import {
    createStorageBuffer,
    createUniformBuffer,
    writeBuffer,
} from '$lib/engine/resources/buffers';
import { createTexture2d } from '$lib/engine/resources/textures';
import { computeBackingSize } from '$lib/engine/gpu/surface';
import { Camera } from '$lib/engine/core/Camera';
import { InfiniteRenderer, type TextureFilteringMode } from '$lib/engine/render/InfiniteRenderer';
import { PARTICLE_LIFE_WORKGROUP } from '$lib/engine/gpu/limits';
import {
    clampParticleCount,
    clampSpeciesCount,
    defaultParticleLifeSettings,
    defaultParticleLifeState,
    flattenForceMatrix,
    normalizeParticleLifeSettings,
    packParticleLifeFadeParams,
    packParticleLifeInitParams,
    packParticleLifeSimParams,
    packParticleLifeSpeciesColors,
    packParticleLifeViewportParams,
    particleLifeBackgroundColor,
    particleLifeSpeciesColors,
    particleLifeStateDocument,
    randomizeParticleLifeSettings,
    updateParticleLifeSetting,
    updateParticleLifeState,
    BACKGROUND_COLOR_MODE_CODE,
    PARTICLE_LIFE_COLOR_MODE_BYTES,
    PARTICLE_LIFE_FADE_PARAM_BYTES,
    PARTICLE_LIFE_INIT_PARAM_BYTES,
    PARTICLE_LIFE_SIM_PARAM_BYTES,
    PARTICLE_LIFE_SPECIES_COLOR_BYTES,
    PARTICLE_LIFE_VIEWPORT_PARAM_BYTES,
    PARTICLE_STRIDE,
    type ParticleLifeEffect,
    type ParticleLifeSettings,
    type ParticleLifeState,
} from './settings';

export const PARTICLE_LIFE_COMPUTE_SHADER_PATH = 'particle_life/shaders/compute.wgsl';
export const PARTICLE_LIFE_INIT_SHADER_PATH = 'particle_life/shaders/init.wgsl';
export const PARTICLE_LIFE_VERTEX_SHADER_PATH = 'particle_life/shaders/vertex.wgsl';
export const PARTICLE_LIFE_FRAGMENT_SHADER_PATH = 'particle_life/shaders/fragment.wgsl';
export const PARTICLE_LIFE_FADE_VERTEX_SHADER_PATH = 'particle_life/shaders/fade_vertex.wgsl';
export const PARTICLE_LIFE_FADE_FRAGMENT_SHADER_PATH = 'particle_life/shaders/fade_fragment.wgsl';

/** 768 planar u32 entries — the shape of every .lut file. */
const LUT_ENTRIES = 768;

/** The offscreen surface the infinite renderer tiles, in either direction. */
const PARTICLE_LIFE_TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

/**
 * Ceiling on the offscreen render targets — three of them, so 2048² costs
 * 28 MB in total.
 *
 * **The adaptive-resolution path is deliberately not ported.**
 * `calculate_resolution_scale` (simulation.rs:316) multiplies the surface size
 * by up to 4.27 in each axis (its own `max_allowed_scale`, 8192 / width) and
 * `update_resolution` then reallocates *five* textures at that size —
 * `display`, `post_effect`, a 4x-MSAA target, and both trail halves — whenever
 * the zoom moves by more than 5%. At 1920x1080 and zoom 4 that is a little over
 * **1.2 GB reallocated mid-gesture**, and the MSAA target is 604 MB of it that
 * no render pass anywhere in the file ever attaches (`offscreen_render_pipeline`
 * is built and never bound either). Even at the default zoom of 1.0 the formula
 * yields 1.6x, so the desktop build sits at ~170 MB of render targets at rest
 * for a field of 4-pixel dots.
 *
 * **Consequence, and it is a real one:** zooming past 1x magnifies the tile
 * texture rather than re-rendering it, so particles go soft where the desktop
 * build keeps them crisp. A *bounded* supersample would recover that for a
 * fixed cost and is the right M14 item; an unbounded one that loses the device
 * is not a thing to reproduce.
 */
export const PARTICLE_LIFE_MAX_DIM = 2048;

/**
 * Offscreen size for a given surface: capped, aspect preserved.
 *
 * Aspect has to be preserved because `vertex.wgsl` maps the world's [-1,1]
 * square onto the *whole* texture and the infinite renderer maps the whole
 * texture back onto a world square, so a squashed texture would squash the
 * field. The particles themselves stay round through all of it: the camera
 * matrix carries no aspect term (`Camera`'s module comment), so screen NDC and
 * texture NDC coincide, and `vertex.wgsl:113` divides the quad's x by
 * `camera.aspect_ratio` to compensate. That division looks wrong on first
 * reading and is correct.
 */
export function particleLifeFieldSize(
    width: number,
    height: number,
    maxTextureDimension2D: number
): [width: number, height: number] {
    return computeBackingSize(
        width,
        height,
        1,
        Math.min(PARTICLE_LIFE_MAX_DIM, maxTextureDimension2D)
    );
}

export interface ParticleLifeCreateOptions {
    /** 768 planar u32 entries. A neutral ramp is used when absent. */
    lut?: Uint32Array;
    /** Initial particle count, clamped to `caps.particleLife` like every path. */
    particleCount?: number;
    /**
     * Seed for `init.wgsl`. Random when absent — see `defaultParticleLifeState`
     * for why the Rust's literal 0 is not reproduced. Present so the GPU tests
     * get the same field twice.
     */
    seed?: number;
    /** Injectable RNG for the matrix generators, so tests can pin a matrix. */
    rng?: () => number;
}

export class ParticleLifeSimulation implements Simulation {
    readonly id: SimulationId = 'particle_life';

    private readonly device: GPUDevice;
    private readonly format: GPUTextureFormat;
    private readonly caps: GpuContext['caps'];
    private readonly rng: () => number;

    private readonly computeLayout: GPUBindGroupLayout;
    private readonly initLayout: GPUBindGroupLayout;
    private readonly particleLayout: GPUBindGroupLayout;
    private readonly colorLayout: GPUBindGroupLayout;
    private readonly cameraLayout: GPUBindGroupLayout;
    private readonly fadeLayout: GPUBindGroupLayout;

    private readonly computePipeline: GPUComputePipeline;
    private readonly initPipeline: GPUComputePipeline;
    private readonly particlePipeline: GPURenderPipeline;
    private readonly fadePipeline: GPURenderPipeline;
    private readonly renderer: InfiniteRenderer;
    private readonly fadeSampler: GPUSampler;

    private readonly simParamsBuffer: GPUBuffer;
    private readonly initParamsBuffer: GPUBuffer;
    private readonly speciesColorsBuffer: GPUBuffer;
    private readonly colorModeBuffer: GPUBuffer;
    private readonly viewportParamsBuffer: GPUBuffer;
    private readonly fadeParamsBuffer: GPUBuffer;

    private particleBuffer: GPUBuffer;
    private forceMatrixBuffer: GPUBuffer;
    private displayTexture: GPUTexture;
    private trailTextures: [GPUTexture, GPUTexture];

    // Definite-assignment: every one is built by `rebuildBindGroups()`, which
    // the constructor calls and every reallocation calls again.
    private computeBindGroup!: GPUBindGroup;
    private initBindGroup!: GPUBindGroup;
    private particleBindGroup!: GPUBindGroup;
    private colorBindGroup!: GPUBindGroup;
    private cameraBindGroup: GPUBindGroup | null = null;
    private fadeBindGroups!: [GPUBindGroup, GPUBindGroup];
    private displaySource!: GPUBindGroup;
    private trailSources!: [GPUBindGroup, GPUBindGroup];

    private readonly simParamsScratch = new ArrayBuffer(PARTICLE_LIFE_SIM_PARAM_BYTES);
    private readonly initParamsScratch = new ArrayBuffer(PARTICLE_LIFE_INIT_PARAM_BYTES);
    private readonly speciesColorScratch = new Float32Array(PARTICLE_LIFE_SPECIES_COLOR_BYTES / 4);

    private camera: Camera;
    private ownsCamera = true;

    settings: ParticleLifeSettings = defaultParticleLifeSettings();
    state: ParticleLifeState = defaultParticleLifeState();

    private width: number;
    private height: number;
    private particles: number;
    /** The most recent LUT, kept so a species-count change can re-sample it. */
    private lut: Uint32Array;
    /** `current_trail_is_a` — index of the half being written this frame. */
    private trailWrite = 0;
    private cursorMode: 0 | 1 | 2 = 0;
    private cursorX = 0;
    private cursorY = 0;
    private paramsDirty = true;
    private destroyed = false;

    private constructor(init: {
        device: GPUDevice;
        format: GPUTextureFormat;
        caps: GpuContext['caps'];
        rng: () => number;
        width: number;
        height: number;
        particles: number;
        seed: number;
        lut: Uint32Array;
        computeLayout: GPUBindGroupLayout;
        initLayout: GPUBindGroupLayout;
        particleLayout: GPUBindGroupLayout;
        colorLayout: GPUBindGroupLayout;
        cameraLayout: GPUBindGroupLayout;
        fadeLayout: GPUBindGroupLayout;
        computePipeline: GPUComputePipeline;
        initPipeline: GPUComputePipeline;
        particlePipeline: GPURenderPipeline;
        fadePipeline: GPURenderPipeline;
        renderer: InfiniteRenderer;
        fadeSampler: GPUSampler;
        simParamsBuffer: GPUBuffer;
        initParamsBuffer: GPUBuffer;
        speciesColorsBuffer: GPUBuffer;
        colorModeBuffer: GPUBuffer;
        viewportParamsBuffer: GPUBuffer;
        fadeParamsBuffer: GPUBuffer;
        particleBuffer: GPUBuffer;
        forceMatrixBuffer: GPUBuffer;
        displayTexture: GPUTexture;
        trailTextures: [GPUTexture, GPUTexture];
        camera: Camera;
    }) {
        this.device = init.device;
        this.format = init.format;
        this.caps = init.caps;
        this.rng = init.rng;
        this.width = init.width;
        this.height = init.height;
        this.particles = init.particles;
        this.lut = init.lut;
        this.computeLayout = init.computeLayout;
        this.initLayout = init.initLayout;
        this.particleLayout = init.particleLayout;
        this.colorLayout = init.colorLayout;
        this.cameraLayout = init.cameraLayout;
        this.fadeLayout = init.fadeLayout;
        this.computePipeline = init.computePipeline;
        this.initPipeline = init.initPipeline;
        this.particlePipeline = init.particlePipeline;
        this.fadePipeline = init.fadePipeline;
        this.renderer = init.renderer;
        this.fadeSampler = init.fadeSampler;
        this.simParamsBuffer = init.simParamsBuffer;
        this.initParamsBuffer = init.initParamsBuffer;
        this.speciesColorsBuffer = init.speciesColorsBuffer;
        this.colorModeBuffer = init.colorModeBuffer;
        this.viewportParamsBuffer = init.viewportParamsBuffer;
        this.fadeParamsBuffer = init.fadeParamsBuffer;
        this.particleBuffer = init.particleBuffer;
        this.forceMatrixBuffer = init.forceMatrixBuffer;
        this.displayTexture = init.displayTexture;
        this.trailTextures = init.trailTextures;
        this.camera = init.camera;

        this.state.particle_count = init.particles;
        this.state.random_seed = init.seed >>> 0;

        this.rebuildBindGroups();
        this.uploadViewportParams();
        this.uploadColorMode();
        this.uploadFadeParams();
        this.recolor();
        this.uploadForceMatrix();
        this.uploadParams();
        this.spawnParticles();
        this.clearTrails();
    }

    static async create(
        gpu: GpuContext,
        options: ParticleLifeCreateOptions = {}
    ): Promise<ParticleLifeSimulation> {
        const { device, format, caps } = gpu;
        const [width, height] = particleLifeFieldSize(
            gpu.width,
            gpu.height,
            caps.maxTextureDimension2D
        );
        const settings = defaultParticleLifeSettings();
        const particles = clampParticleCount(
            options.particleCount ?? defaultParticleLifeState().particle_count,
            caps.particleLife
        );

        // --- compute: physics ------------------------------------------------
        //
        // Binding 0 is the particle pool as `read_write` storage and binding 2
        // is the force matrix as `read`. Note that `main` reads *every other*
        // particle out of the same read_write binding it writes its own to
        // (compute.wgsl:149), which is an unsynchronised cross-invocation read.
        // Faithful: it is what the Rust runs, a neighbour caught mid-update is
        // off by one sub-step, and splitting the pool into a source and a
        // destination would need a second binding — i.e. a Rust edit — for a
        // difference nothing can see. It does mean **a step is not
        // bit-reproducible**, which is why the L3 determinism assertions are on
        // the freshly-seeded pool rather than on a stepped one.

        const computeModule = await createShaderModuleChecked(device, {
            label: 'particle life compute',
            code: getShader(PARTICLE_LIFE_COMPUTE_SHADER_PATH),
        });

        const computeLayout = device.createBindGroupLayout({
            label: 'particle life compute layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                {
                    binding: 2,
                    visibility: GPUShaderStage.COMPUTE,
                    buffer: { type: 'read-only-storage' },
                },
            ],
        });

        const computePipeline = await createComputePipelineChecked(device, {
            label: 'particle life compute pipeline',
            layout: device.createPipelineLayout({
                label: 'particle life compute pipeline layout',
                bindGroupLayouts: [computeLayout],
            }),
            compute: { module: computeModule, entryPoint: 'main' },
        });

        // --- compute: seeding ------------------------------------------------
        //
        // `init.wgsl` carries **both** generator families: the eleven
        // `generate_*_position` functions and the eleven `generate_*_type`
        // ones, selected by two switches on the same uniform. Species
        // assignment is entirely GPU-side — nothing on the CPU ever writes a
        // `Particle`, on either build.

        const initModule = await createShaderModuleChecked(device, {
            label: 'particle life init',
            code: getShader(PARTICLE_LIFE_INIT_SHADER_PATH),
        });

        const initLayout = device.createBindGroupLayout({
            label: 'particle life init layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ],
        });

        const initPipeline = await createComputePipelineChecked(device, {
            label: 'particle life init pipeline',
            layout: device.createPipelineLayout({
                label: 'particle life init pipeline layout',
                bindGroupLayouts: [initLayout],
            }),
            compute: { module: initModule, entryPoint: 'main' },
        });

        // --- render: particles -----------------------------------------------
        //
        // Three bind groups, because `vertex.wgsl` and `fragment.wgsl` declare
        // three: 0 = pool + params (vertex), 1 = species colours + colour mode
        // (fragment), 2 = camera + viewport (vertex).
        //
        // Group 2 is why this cannot share the infinite renderer's camera bind
        // group even though both want the same buffer at binding 0: the
        // renderer's layout has that one entry and this one has two. Two bind
        // groups over one buffer, rather than widening the wrapper for the one
        // caller that needs it.

        const [vertexModule, fragmentModule] = await Promise.all([
            createShaderModuleChecked(device, {
                label: 'particle life vertex',
                code: getShader(PARTICLE_LIFE_VERTEX_SHADER_PATH),
            }),
            createShaderModuleChecked(device, {
                label: 'particle life fragment',
                code: getShader(PARTICLE_LIFE_FRAGMENT_SHADER_PATH),
            }),
        ]);

        const particleLayout = device.createBindGroupLayout({
            label: 'particle life pool layout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX,
                    buffer: { type: 'read-only-storage' },
                },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
            ],
        });

        // Binding 1 is `color_mode`, which `fragment.wgsl` declares at group 1
        // and its `main` never mentions — the four-way Gray18/White/Black/
        // ColorScheme switch it was meant to drive does not exist in the shader.
        // Kept in the layout and written every time the mode changes so the
        // buffer holds what the Rust would have put there; see `uploadColorMode`.
        const colorLayout = device.createBindGroupLayout({
            label: 'particle life colors layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });

        const cameraLayout = device.createBindGroupLayout({
            label: 'particle life camera layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
            ],
        });

        // **One** particle pipeline, where the Rust builds four.
        // `display_render_pipeline` and `trail_render_pipeline` differ only in
        // REPLACE versus ALPHA_BLENDING, and `fragment.wgsl` returns a hardcoded
        // alpha of 1.0 — at which point src-alpha blending *is* replace, so the
        // two are the same pipeline. `offscreen_render_pipeline` (4x MSAA) and
        // `render_pipeline` (surface format) are never bound by any pass.
        const particlePipeline = await createRenderPipelineChecked(device, {
            label: 'particle life particles',
            layout: device.createPipelineLayout({
                label: 'particle life particle pipeline layout',
                bindGroupLayouts: [particleLayout, colorLayout, cameraLayout],
            }),
            vertex: { module: vertexModule, entryPoint: 'main' },
            fragment: {
                module: fragmentModule,
                entryPoint: 'main',
                targets: [{ format: PARTICLE_LIFE_TEXTURE_FORMAT }],
            },
            primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
        });

        // --- render: the trace fade ------------------------------------------

        const [fadeVertexModule, fadeFragmentModule] = await Promise.all([
            createShaderModuleChecked(device, {
                label: 'particle life fade vertex',
                code: getShader(PARTICLE_LIFE_FADE_VERTEX_SHADER_PATH),
            }),
            createShaderModuleChecked(device, {
                label: 'particle life fade fragment',
                code: getShader(PARTICLE_LIFE_FADE_FRAGMENT_SHADER_PATH),
            }),
        ]);

        const fadeLayout = device.createBindGroupLayout({
            label: 'particle life fade layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    sampler: { type: 'filtering' },
                },
            ],
        });

        // `BlendState::ALPHA_BLENDING` (simulation.rs:1342) exactly. The alpha
        // channel matters here and nowhere else in this simulation: the target
        // starts cleared to an opaque background, so `one, one-minus-src-alpha`
        // pins the result's alpha at 1 and the *colour* term decays the previous
        // frame toward the background by `fade_amount` each pass.
        const fadePipeline = await createRenderPipelineChecked(device, {
            label: 'particle life fade',
            layout: device.createPipelineLayout({
                label: 'particle life fade pipeline layout',
                bindGroupLayouts: [fadeLayout],
            }),
            vertex: { module: fadeVertexModule, entryPoint: 'main' },
            fragment: {
                module: fadeFragmentModule,
                entryPoint: 'main',
                targets: [
                    {
                        format: PARTICLE_LIFE_TEXTURE_FORMAT,
                        blend: {
                            color: {
                                srcFactor: 'src-alpha',
                                dstFactor: 'one-minus-src-alpha',
                                operation: 'add',
                            },
                            alpha: {
                                srcFactor: 'one',
                                dstFactor: 'one-minus-src-alpha',
                                operation: 'add',
                            },
                        },
                    },
                ],
            },
            primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
        });

        const fadeSampler = device.createSampler({
            label: 'particle life fade sampler',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            magFilter: 'linear',
            minFilter: 'linear',
        });

        // --- render: the tiled canvas ----------------------------------------
        //
        // The shared `fs_main_texture` path, bindings 0/1/2 — Particle Life's
        // own `infinite_render_bind_group_layout` (simulation.rs:1879) is
        // texture, filtering sampler, uniform, which is that path exactly. No
        // extension to the wrapper was needed.
        const renderer = await InfiniteRenderer.create(device, format, {
            label: 'particle life',
            path: 'texture',
        });

        const simParamsBuffer = createUniformBuffer(device, PARTICLE_LIFE_SIM_PARAM_BYTES, {
            label: 'particle life sim params',
        });
        const initParamsBuffer = createUniformBuffer(device, PARTICLE_LIFE_INIT_PARAM_BYTES, {
            label: 'particle life init params',
        });
        const speciesColorsBuffer = createUniformBuffer(device, PARTICLE_LIFE_SPECIES_COLOR_BYTES, {
            label: 'particle life species colors',
        });
        const colorModeBuffer = createUniformBuffer(device, PARTICLE_LIFE_COLOR_MODE_BYTES, {
            label: 'particle life color mode',
        });
        const viewportParamsBuffer = createUniformBuffer(
            device,
            PARTICLE_LIFE_VIEWPORT_PARAM_BYTES,
            { label: 'particle life viewport params' }
        );
        const fadeParamsBuffer = createUniformBuffer(device, PARTICLE_LIFE_FADE_PARAM_BYTES, {
            label: 'particle life fade params',
        });

        const particleBuffer = createParticleBuffer(device, particles);
        const forceMatrixBuffer = createForceMatrixBuffer(device, settings.species_count);
        const displayTexture = createOffscreen(device, width, height, 'particle life display');
        const trailTextures: [GPUTexture, GPUTexture] = [
            createOffscreen(device, width, height, 'particle life trail A'),
            createOffscreen(device, width, height, 'particle life trail B'),
        ];

        // Uploaded straight away, as Slime Mold does: the first frame may be a
        // paused redraw, and an all-zero camera uniform collapses every tile.
        const camera = new Camera(gpu.width, gpu.height);
        camera.attachToDevice(device, 'particle life camera uniform');
        camera.uploadToGpu(device.queue);
        renderer.setCameraBuffer(camera.getBuffer()!);

        return new ParticleLifeSimulation({
            device,
            format,
            caps,
            rng: options.rng ?? Math.random,
            width,
            height,
            particles,
            seed: options.seed ?? randomSeed(),
            lut:
                options.lut && options.lut.length === LUT_ENTRIES
                    ? options.lut
                    : defaultParticleLifeLut(),
            computeLayout,
            initLayout,
            particleLayout,
            colorLayout,
            cameraLayout,
            fadeLayout,
            computePipeline,
            initPipeline,
            particlePipeline,
            fadePipeline,
            renderer,
            fadeSampler,
            simParamsBuffer,
            initParamsBuffer,
            speciesColorsBuffer,
            colorModeBuffer,
            viewportParamsBuffer,
            fadeParamsBuffer,
            particleBuffer,
            forceMatrixBuffer,
            displayTexture,
            trailTextures,
            camera,
        });
    }

    // -----------------------------------------------------------------------
    // Frame
    // -----------------------------------------------------------------------

    /**
     * Step the pool, draw it, tile the result across the canvas.
     *
     * **One encoder and one submit**, where the Rust uses two of each plus a
     * device poll. The Rust's comment says the split avoids "texture usage
     * conflicts", but the conflict it was dodging is a texture bound as an
     * attachment and sampled in the *same* pass; separate passes inside one
     * encoder are ordered and legal, so the round trips buy nothing.
     *
     * **The blit pass is gone.** With traces on the Rust renders into a trail
     * texture, blits that onto the display texture, and tiles the display
     * texture — but the blit is an unblended full-screen copy, so the trail
     * texture *is* the finished image and the renderer can sample it directly.
     * That drops `blit_pipeline`, `display_blit_pipeline`, their bind group and
     * a render pass per frame, and it sidesteps a validation error in the
     * process: `render_frame_paused` binds `blit_pipeline`, whose colour target
     * is the *surface* format, into an `Rgba8Unorm` attachment where
     * `display_blit_pipeline` is the correctly-formatted twin.
     *
     * **The tile count now agrees between CPU and GPU.** The Rust's
     * `calculate_tile_count` (simulation.rs:2697) adds 8 with a minimum of 7 or
     * 9, while `infinite_render.wgsl:71` — which lays out the grid the instance
     * index is decoded against — adds 6 with a minimum of 5 or 7. At zoom 1 the
     * CPU issues 81 instances and the shader decodes them as a 7-wide grid, so
     * the 12 rows land from y-3 to y+8: five spare rows of tiles above the view
     * and none to either side. `InfiniteRenderer.calculateTileCount` is a port
     * of the WGSL, so using the wrapper makes the two agree.
     */
    renderFrame(view: GPUTextureView, dt: number): void {
        if (this.destroyed) return;

        this.uploadParams();
        this.advanceOwnCamera(dt);

        const encoder = this.device.createCommandEncoder({ label: 'particle life frame' });

        const pass = encoder.beginComputePass({ label: 'particle life physics' });
        pass.setPipeline(this.computePipeline);
        pass.setBindGroup(0, this.computeBindGroup);
        pass.dispatchWorkgroups(this.dispatchWorkgroups(), 1, 1);
        pass.end();

        const source = this.state.traces_enabled
            ? this.encodeTraces(encoder, true)
            : this.encodeDirect(encoder);

        this.renderer.encode(encoder, view, source, this.camera.zoom);
        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * Redraw without stepping.
     *
     * The draw is re-run rather than skipped so that a colour-scheme change, a
     * background-mode change or a camera move shows while paused. With traces
     * on the particles are re-stamped onto the current trail half **without**
     * the fade and without a swap, which is idempotent — the same particles at
     * the same positions in the same colours — where fading here would make a
     * paused simulation slowly dissolve.
     */
    renderFramePaused(view: GPUTextureView): void {
        if (this.destroyed) return;

        this.uploadParams();

        const encoder = this.device.createCommandEncoder({
            label: 'particle life frame (paused)',
        });
        const source = this.state.traces_enabled
            ? this.encodeTraces(encoder, false)
            : this.encodeDirect(encoder);
        this.renderer.encode(encoder, view, source, this.camera.zoom);
        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * Adopt a new surface size.
     *
     * The three offscreen targets are reallocated and the trails cleared;
     * **particles are left alone**. Their positions are in world units, not
     * texels, so a resize does not invalidate a single one — which is also why
     * there is nothing here resembling the Rust's five-texture churn.
     */
    resize(width: number, height: number): void {
        if (this.destroyed) return;

        const [nextWidth, nextHeight] = particleLifeFieldSize(
            width,
            height,
            this.caps.maxTextureDimension2D
        );
        this.camera.resize(width, height);
        if (nextWidth === this.width && nextHeight === this.height) return;

        this.width = nextWidth;
        this.height = nextHeight;
        this.paramsDirty = true;

        this.displayTexture.destroy();
        this.trailTextures[0].destroy();
        this.trailTextures[1].destroy();
        this.displayTexture = createOffscreen(
            this.device,
            nextWidth,
            nextHeight,
            'particle life display'
        );
        this.trailTextures = [
            createOffscreen(this.device, nextWidth, nextHeight, 'particle life trail A'),
            createOffscreen(this.device, nextWidth, nextHeight, 'particle life trail B'),
        ];

        this.rebuildBindGroups();
        this.uploadViewportParams();
        this.clearTrails();
    }

    // -----------------------------------------------------------------------
    // Settings and state
    // -----------------------------------------------------------------------

    getSettings(): Record<string, unknown> {
        return {
            ...this.settings,
            force_matrix: this.settings.force_matrix.map((row) => [...row]),
        };
    }

    getState(): Record<string, unknown> {
        return particleLifeStateDocument({
            ...this.state,
            particle_count: this.particles,
            species_colors: this.state.species_colors.map((color) => [...color]),
            camera_position: [this.camera.position[0], this.camera.position[1]],
            camera_zoom: this.camera.zoom,
        });
    }

    updateSetting(name: string, value: unknown): void {
        this.applyEffect(
            updateParticleLifeSetting(this.settings, this.state, name, value, this.rng)
        );
    }

    /**
     * `update_state` — which on the desktop has exactly one arm.
     *
     * `ParticleLifeMode.svelte` routes six controls through
     * `syncManager.updateStateOptimistic`, i.e. through this command:
     * `cursor_size`, `cursor_strength`, `traces_enabled`, `trace_fade`,
     * `color_scheme_reversed` and `background_color_mode`. The Rust's
     * `update_state` (simulation.rs:3663) matches `color_scheme` and logs a
     * warning for everything else, so all six move a widget on screen and
     * change nothing — the cursor does not resize, the Traces checkbox does not
     * enable traces, and the background-colour picker does not change the
     * background. Five of the six already had a working `update_setting` arm
     * sitting unused a hundred lines further up.
     */
    updateState(name: string, value: unknown): void {
        this.applyEffect(updateParticleLifeState(this.settings, this.state, name, value, this.rng));
    }

    /**
     * Apply a preset or a stored document.
     *
     * `particle_count` is handled here as well as in `updateSetting` because it
     * is *state*, not a `Settings` field, and this is the path a document
     * written by another build arrives on.
     */
    applySettings(settings: Record<string, unknown>): void {
        const previousSpecies = this.settings.species_count;
        this.settings = normalizeParticleLifeSettings(settings);
        this.paramsDirty = true;

        // The force-matrix buffer is sized `species_count²`, so a preset that
        // moves the count has to reallocate it *before* the upload — writing
        // 8x8 floats into a 4x4 buffer is a validation error, not a truncation.
        if (this.settings.species_count !== previousSpecies) {
            this.forceMatrixBuffer.destroy();
            this.forceMatrixBuffer = createForceMatrixBuffer(
                this.device,
                this.settings.species_count
            );
            this.rebuildBindGroups();
        }

        this.uploadForceMatrix();
        this.recolor();

        if (settings && typeof settings.particle_count === 'number') {
            this.setParticleCount(settings.particle_count);
        }
        // Unconditionally, and after any pool resize: the species count may have
        // moved, which changes the range every particle's species is drawn
        // from, so the existing pool is stale whatever the count did.
        this.spawnParticles();
    }

    /**
     * `randomize_settings` (simulation.rs:3893) — the "Regenerate Matrix"
     * button, which redraws the force matrix through the *currently selected*
     * generator and leaves the physics parameters and both counts alone.
     */
    randomizeSettings(): void {
        randomizeParticleLifeSettings(this.settings, this.state, this.rng);
        this.uploadForceMatrix();
    }

    /**
     * `reset_runtime_state` (simulation.rs:3860) — a fresh seed and a respawn.
     *
     * `reset()` below is the same operation, because for Particle Life the two
     * Rust entry points genuinely are the same: `reset_simulation` routes to
     * `reset_particles_gpu` (manager.rs:1389) and that re-seeds and respawns
     * too. The only difference upstream is where the new seed comes from, and
     * `reset_particles_gpu` derives it from a `StdRng` seeded with the *old*
     * seed — a deterministic chain, so pressing the button twice from the same
     * starting seed always gives the same two fields.
     */
    resetRuntimeState(): void {
        if (this.destroyed) return;
        this.state.random_seed = randomSeed();
        this.paramsDirty = true;
        this.spawnParticles();
        this.clearTrails();
    }

    /** The Reset button. See `resetRuntimeState`. */
    reset(): void {
        this.resetRuntimeState();
    }

    /**
     * "Clear Trails" — an optional host capability, reached by the
     * `clear_trail_texture` command.
     *
     * Distinct from `reset()`, which also throws the particles away. The Rust
     * clears **both** halves of the ping-pong (simulation.rs:2654), which is
     * necessary: the fade pass reads the half that is not being written, so
     * clearing only one leaves the old trail to be blended straight back in on
     * the next frame.
     */
    clearTrails(): void {
        if (this.destroyed) return;
        const [r, g, b, a] = this.backgroundClear();
        const encoder = this.device.createCommandEncoder({
            label: 'particle life clear trails',
        });
        for (const texture of this.trailTextures) {
            encoder
                .beginRenderPass({
                    label: 'particle life clear trail',
                    colorAttachments: [
                        {
                            view: texture.createView(),
                            loadOp: 'clear',
                            storeOp: 'store',
                            clearValue: { r, g, b, a },
                        },
                    ],
                })
                .end();
        }
        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * Resize the pool — the sink for the particle-count clamp.
     *
     * `update_particle_count` (simulation.rs:3978) clamps to 1,000..100,000,
     * which is twice its own UI's maximum, and then checks the buffer against
     * `max_storage_buffer_binding_size` and returns an error. The binding size
     * is not the interesting bound here: 100,000 particles is 2.4 MB but ten
     * billion pair evaluations a frame. `clampParticleCount` reduces rather
     * than rejecting, so a preset asking for the impossible still starts.
     *
     * Particle state is not preserved across a resize, on either build.
     */
    setParticleCount(count: number): void {
        if (this.destroyed) return;

        const next = clampParticleCount(count, this.caps.particleLife);
        this.state.particle_count = next;
        if (next === this.particles) return;

        this.particles = next;
        this.paramsDirty = true;

        this.particleBuffer.destroy();
        this.particleBuffer = createParticleBuffer(this.device, next);
        this.rebuildBindGroups();
        this.spawnParticles();
    }

    /** `EngineContext.setAgentCount` reaches this too, so both names work. */
    setAgentCount(count: number): void {
        this.setParticleCount(count);
    }

    /** "Regenerate Particles" — a respawn at the current count and generators. */
    resetAgents(): void {
        this.resetRuntimeState();
    }

    /**
     * Replace the LUT.
     *
     * The bytes arrive from `ColorSchemeManager.current()` with the reversal
     * **already applied** — the contract every sim from M3 on follows — so they
     * are re-sampled verbatim and no shader flag is set.
     *
     * Unlike the field simulations, the LUT never reaches the GPU as a LUT: the
     * fragment shader takes a fixed nine-slot colour table, so the sampling
     * happens here and only the resulting `species_count (+1)` colours are
     * uploaded. That is also why the LUT has to be kept — a species-count
     * change has to re-sample it at a different number of stops.
     */
    updateColorScheme(lut: Uint32Array, reversed: boolean): void {
        if (lut.length !== LUT_ENTRIES) {
            throw new Error(`LUT must be ${LUT_ENTRIES} u32 entries, got ${lut.length}`);
        }
        this.lut = new Uint32Array(lut);
        this.state.color_scheme_reversed = reversed;
        this.recolor();
    }

    // -----------------------------------------------------------------------
    // Pointer
    // -----------------------------------------------------------------------

    /**
     * Attract (left) or repel (right), with a tangential swirl either way.
     *
     * Nothing is dispatched: the cursor is three words of the uniform that
     * `compute.wgsl:177` reads on its next step. The coordinates stay in world
     * [-1,1] — this is the only ported simulation that does not convert them to
     * texels, because the particles live in world space too.
     */
    handleMouseInteraction(worldX: number, worldY: number, button: number): void {
        if (this.destroyed) return;

        this.cursorMode = button === 0 ? 1 : button === 2 ? 2 : 0;
        this.cursorX = worldX;
        this.cursorY = worldY;
        this.paramsDirty = true;
    }

    handleMouseRelease(_button: number): void {
        if (this.destroyed) return;
        this.cursorMode = 0;
        this.cursorX = 0;
        this.cursorY = 0;
        this.paramsDirty = true;
    }

    // -----------------------------------------------------------------------
    // Camera and capabilities
    // -----------------------------------------------------------------------

    /** `SimulationHost` hook — one camera on the host, not one per simulation. */
    attachCamera(camera: Camera): void {
        if (this.destroyed || camera === this.camera) return;

        if (this.ownsCamera) this.camera.destroy();
        this.camera = camera;
        this.ownsCamera = false;

        camera.attachToDevice(this.device, 'particle life camera uniform');
        camera.uploadToGpu(this.device.queue);
        this.renderer.setCameraBuffer(camera.getBuffer()!);
        this.rebuildCameraBindGroup();
    }

    /** `update_app_settings` — the app-wide preference `Settings.svelte` edits. */
    setFilteringMode(mode: TextureFilteringMode): void {
        if (this.destroyed) return;
        this.renderer.setFilteringMode(mode);
    }

    /** `get_species_colors`, in linear RGBA, species first. */
    getSpeciesColors(): number[][] {
        return this.state.species_colors.map((color) => [...color]);
    }

    /** Offscreen target size, which is not the surface size once clamped. */
    get fieldSize(): [number, number] {
        return [this.width, this.height];
    }

    get particleCount(): number {
        return this.particles;
    }

    /** Readback seams for the L3 harness; both carry COPY_SRC. */
    get particleStorage(): GPUBuffer {
        return this.particleBuffer;
    }

    get forceMatrixStorage(): GPUBuffer {
        return this.forceMatrixBuffer;
    }

    get displaySurface(): GPUTexture {
        return this.displayTexture;
    }

    /** The half holding the most recent image; see `encodeTraces`. */
    get trailSurface(): GPUTexture {
        return this.trailTextures[this.trailWrite];
    }

    /** Both halves, so a test can assert that "Clear Trails" wiped each one. */
    get trailSurfaces(): readonly [GPUTexture, GPUTexture] {
        return this.trailTextures;
    }

    get targetFormat(): GPUTextureFormat {
        return this.format;
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        this.simParamsBuffer.destroy();
        this.initParamsBuffer.destroy();
        this.speciesColorsBuffer.destroy();
        this.colorModeBuffer.destroy();
        this.viewportParamsBuffer.destroy();
        this.fadeParamsBuffer.destroy();
        this.particleBuffer.destroy();
        this.forceMatrixBuffer.destroy();
        this.displayTexture.destroy();
        this.trailTextures[0].destroy();
        this.trailTextures[1].destroy();
        this.renderer.destroy();

        // Only ours to release: the host's camera outlives every simulation.
        if (this.ownsCamera) this.camera.destroy();
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    /**
     * What a settings or state write costs on the GPU.
     *
     * **`force-matrix` is the fix for the port's headline defect.**
     * `update_setting("matrix_generator")` (simulation.rs:3552) draws a new
     * matrix with `randomize_force_matrix`, calls
     * `recreate_bind_groups_with_force_matrix` — which builds a fresh bind group
     * pointing at the *same* buffer, whose bytes nothing has touched — and then
     * `update_sim_params`, which writes `SimParams` and not the matrix. The new
     * matrix never reaches `force_matrix_buffer`, so **all 22 generators are
     * no-ops on the desktop build**: the picker changes the value the UI shows
     * and the particles carry on obeying the previous matrix. It is masked by
     * the fact that the two buttons next to it, "Regenerate Matrix" and
     * "Randomize", take a different path (`randomize_settings`,
     * simulation.rs:3906) which does upload.
     */
    private applyEffect(effect: ParticleLifeEffect): void {
        switch (effect) {
            case 'sim-params':
                this.paramsDirty = true;
                return;

            case 'force-matrix':
                this.uploadForceMatrix();
                return;

            case 'species-count':
                // The matrix changed shape, the colours are sampled at a
                // different number of stops, and every particle's species is
                // now drawn from a different range — so all three follow.
                this.paramsDirty = true;
                this.forceMatrixBuffer.destroy();
                this.forceMatrixBuffer = createForceMatrixBuffer(
                    this.device,
                    this.settings.species_count
                );
                this.rebuildBindGroups();
                this.uploadForceMatrix();
                this.recolor();
                this.spawnParticles();
                return;

            case 'particle-count':
                this.setParticleCount(this.state.particle_count);
                return;

            case 'respawn':
                this.paramsDirty = true;
                this.spawnParticles();
                return;

            case 'recolor':
                // Only the *name* and the reversed flag land here; the bytes
                // arrive separately on `updateColorScheme`. Re-sampling the LUT
                // already held is still right, because the background-colour
                // mode may have changed which stop is the background.
                this.recolor();
                return;

            case 'background':
                this.uploadColorMode();
                this.recolor();
                return;

            case 'none':
                return;
        }
    }

    private uploadParams(): void {
        if (!this.paramsDirty) return;
        this.paramsDirty = false;

        packParticleLifeSimParams(
            this.settings,
            this.state,
            {
                width: this.width,
                height: this.height,
                particleCount: this.particles,
                cursorActive: this.cursorMode,
                cursorX: this.cursorX,
                cursorY: this.cursorY,
            },
            this.simParamsScratch
        );
        this.device.queue.writeBuffer(this.simParamsBuffer, 0, this.simParamsScratch);
        this.uploadFadeParams();
    }

    private uploadViewportParams(): void {
        writeBuffer(
            this.device.queue,
            this.viewportParamsBuffer,
            packParticleLifeViewportParams(this.width, this.height)
        );
    }

    private uploadFadeParams(): void {
        writeBuffer(
            this.device.queue,
            this.fadeParamsBuffer,
            packParticleLifeFadeParams(this.state.trace_fade)
        );
    }

    /** Written for fidelity; `fragment.wgsl` declares `color_mode` and never reads it. */
    private uploadColorMode(): void {
        writeBuffer(
            this.device.queue,
            this.colorModeBuffer,
            new Uint32Array([BACKGROUND_COLOR_MODE_CODE[this.state.background_color_mode], 0, 0, 0])
        );
    }

    /** Re-sample the LUT for the current species count and background mode. */
    private recolor(): void {
        this.state.species_colors = particleLifeSpeciesColors(
            this.lut,
            this.settings.species_count,
            this.state.background_color_mode
        );
        packParticleLifeSpeciesColors(this.state.species_colors, this.speciesColorScratch);
        writeBuffer(this.device.queue, this.speciesColorsBuffer, this.speciesColorScratch);
    }

    private uploadForceMatrix(): void {
        writeBuffer(
            this.device.queue,
            this.forceMatrixBuffer,
            flattenForceMatrix(this.settings.force_matrix)
        );
    }

    /**
     * `initialize_particles_gpu` (simulation.rs:2205).
     *
     * `start_index` is always 0 and `spawn_count` always the whole pool on both
     * builds — the shader's partial-respawn support has no caller.
     */
    private spawnParticles(): void {
        if (this.destroyed) return;

        packParticleLifeInitParams(
            this.settings,
            this.state,
            {
                startIndex: 0,
                spawnCount: this.particles,
                width: this.width,
                height: this.height,
            },
            this.initParamsScratch
        );
        this.device.queue.writeBuffer(this.initParamsBuffer, 0, this.initParamsScratch);

        const encoder = this.device.createCommandEncoder({ label: 'particle life spawn' });
        const pass = encoder.beginComputePass({ label: 'particle life spawn' });
        pass.setPipeline(this.initPipeline);
        pass.setBindGroup(0, this.initBindGroup);
        pass.dispatchWorkgroups(this.dispatchWorkgroups(), 1, 1);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * A plain 1D dispatch, and **not** `foldDispatch`.
     *
     * Both particle kernels reconstruct their index as a bare `global_id.x`
     * (compute.wgsl:132, init.wgsl:272) with no `num_workgroups` stride, so
     * folding the dispatch into two dimensions would leave every workgroup with
     * `id.y > 0` writing over the first row's particles — the mirror image of
     * M7's Slime Mold defect, introduced rather than fixed. `caps.particleLife`
     * is capped at `maxComputeWorkgroupsPerDimension * 64` instead, so the 1D
     * dispatch always fits (see `particleLifeCap`); at the 50,000 ceiling that
     * is 782 workgroups against a limit of 65,535.
     */
    private dispatchWorkgroups(): number {
        return Math.max(1, Math.ceil(this.particles / PARTICLE_LIFE_WORKGROUP));
    }

    /**
     * `update_background_params` (simulation.rs:2615), as a clear value.
     *
     * **This is the port of `background_render.wgsl`.** That shader is a
     * six-vertex full-screen quad whose fragment stage returns
     * `background_params.background_color` and nothing else, drawn with REPLACE
     * blending over a target that was just cleared. Writing every texel of a
     * render target with one constant colour is what a clear value *is*, so the
     * two are pixel-identical and this drops a pipeline, a bind group, a uniform
     * buffer and a render pass per frame.
     *
     * Worth recording that the Rust already contained this colour three times:
     * `update_background_params` computes it into a uniform, `render_frame`
     * computes it again inline for the trail clear (simulation.rs:3124), and
     * the constructor computes it a third time (:2122). Here it is one function.
     */
    private backgroundClear(): [number, number, number, number] {
        return particleLifeBackgroundColor(this.state, this.settings.species_count);
    }

    /** Particles straight onto the display texture, over a background clear. */
    private encodeDirect(encoder: GPUCommandEncoder): GPUBindGroup {
        const [r, g, b, a] = this.backgroundClear();
        const pass = encoder.beginRenderPass({
            label: 'particle life particles',
            colorAttachments: [
                {
                    view: this.displayTexture.createView(),
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r, g, b, a },
                },
            ],
        });
        this.drawParticles(pass);
        pass.end();
        return this.displaySource;
    }

    /**
     * The trace path: fade the other half in, then stamp the particles on top.
     *
     * `fade` is false for a paused redraw — see `renderFramePaused`.
     */
    private encodeTraces(encoder: GPUCommandEncoder, fade: boolean): GPUBindGroup {
        // The swap happens **before** the pass, not after it, so that
        // `trailWrite` always names the half holding the most recent image —
        // which is what `trailSurface` hands the L3 harness and what the next
        // frame's fade has to read. The Rust swaps at the end of `render_frame`
        // (simulation.rs:3333), which leaves `current_trail_is_a` naming the
        // half that is one frame *stale* for the whole gap between frames; that
        // is invisible there only because nothing reads it in between.
        if (fade) this.trailWrite ^= 1;
        const write = this.trailWrite;
        const [r, g, b, a] = this.backgroundClear();

        const pass = encoder.beginRenderPass({
            label: 'particle life trails',
            colorAttachments: [
                {
                    view: this.trailTextures[write].createView(),
                    // Clearing to the background and then blending the previous
                    // half over it at `1 - fade_amount` is what makes the trail
                    // decay *toward the background colour* rather than toward
                    // black. On a paused redraw there is nothing to decay, so
                    // the half is loaded rather than rebuilt.
                    loadOp: fade ? 'clear' : 'load',
                    storeOp: 'store',
                    clearValue: { r, g, b, a },
                },
            ],
        });

        if (fade) {
            pass.setPipeline(this.fadePipeline);
            pass.setBindGroup(0, this.fadeBindGroups[write ^ 1]);
            pass.draw(3);
        }

        this.drawParticles(pass);
        pass.end();
        return this.trailSources[write];
    }

    /**
     * Six vertices per particle, one instance each.
     *
     * All three bind groups, always. `render_frame_paused`'s trace branch
     * (simulation.rs:2888) sets groups 0 and 1 and omits group 2, which
     * `vertex.wgsl` statically uses for the camera and the viewport bounds —
     * so pausing the desktop build with traces enabled fails validation at the
     * draw and the frame does not appear. Setting them in one place makes that
     * unrepresentable.
     */
    private drawParticles(pass: GPURenderPassEncoder): void {
        if (!this.cameraBindGroup || this.particles === 0) return;
        pass.setPipeline(this.particlePipeline);
        pass.setBindGroup(0, this.particleBindGroup);
        pass.setBindGroup(1, this.colorBindGroup);
        pass.setBindGroup(2, this.cameraBindGroup);
        pass.draw(6, this.particles);
    }

    private advanceOwnCamera(dt: number): void {
        if (!this.ownsCamera) return;
        this.camera.update(dt);
        this.camera.uploadToGpu(this.device.queue);
    }

    private rebuildBindGroups(): void {
        this.computeBindGroup = this.device.createBindGroup({
            label: 'particle life compute',
            layout: this.computeLayout,
            entries: [
                { binding: 0, resource: { buffer: this.particleBuffer } },
                { binding: 1, resource: { buffer: this.simParamsBuffer } },
                { binding: 2, resource: { buffer: this.forceMatrixBuffer } },
            ],
        });

        this.initBindGroup = this.device.createBindGroup({
            label: 'particle life init',
            layout: this.initLayout,
            entries: [
                { binding: 0, resource: { buffer: this.particleBuffer } },
                { binding: 1, resource: { buffer: this.initParamsBuffer } },
            ],
        });

        this.particleBindGroup = this.device.createBindGroup({
            label: 'particle life pool',
            layout: this.particleLayout,
            entries: [
                { binding: 0, resource: { buffer: this.particleBuffer } },
                { binding: 1, resource: { buffer: this.simParamsBuffer } },
            ],
        });

        this.colorBindGroup = this.device.createBindGroup({
            label: 'particle life colors',
            layout: this.colorLayout,
            entries: [
                { binding: 0, resource: { buffer: this.speciesColorsBuffer } },
                { binding: 1, resource: { buffer: this.colorModeBuffer } },
            ],
        });

        const trailViews = [
            this.trailTextures[0].createView(),
            this.trailTextures[1].createView(),
        ] as const;

        this.fadeBindGroups = [
            this.createFadeBindGroup(trailViews[0], 'A'),
            this.createFadeBindGroup(trailViews[1], 'B'),
        ];

        this.displaySource = this.renderer.createSourceBindGroup(
            this.displayTexture.createView(),
            'display'
        );
        this.trailSources = [
            this.renderer.createSourceBindGroup(trailViews[0], 'trail A'),
            this.renderer.createSourceBindGroup(trailViews[1], 'trail B'),
        ];

        this.rebuildCameraBindGroup();
    }

    private createFadeBindGroup(view: GPUTextureView, suffix: string): GPUBindGroup {
        return this.device.createBindGroup({
            label: `particle life fade ${suffix}`,
            layout: this.fadeLayout,
            entries: [
                { binding: 0, resource: { buffer: this.fadeParamsBuffer } },
                { binding: 1, resource: view },
                { binding: 2, resource: this.fadeSampler },
            ],
        });
    }

    private rebuildCameraBindGroup(): void {
        const buffer = this.camera.getBuffer();
        if (!buffer) {
            this.cameraBindGroup = null;
            return;
        }
        this.cameraBindGroup = this.device.createBindGroup({
            label: 'particle life camera',
            layout: this.cameraLayout,
            entries: [
                { binding: 0, resource: { buffer } },
                { binding: 1, resource: { buffer: this.viewportParamsBuffer } },
            ],
        });
    }
}

export async function createParticleLife(gpu: GpuContext): Promise<Simulation> {
    return ParticleLifeSimulation.create(gpu);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sized, never CPU-initialised — `init.wgsl` writes every element before
 * anything reads one, exactly as Slime Mold's agent buffer works.
 *
 * `COPY_SRC` is for the L3 readbacks. The Rust additionally asks for `VERTEX`
 * usage, which nothing uses: both render pipelines are built with `buffers: &[]`
 * and pull the pool out of a storage binding instead.
 */
function createParticleBuffer(device: GPUDevice, count: number): GPUBuffer {
    return createStorageBuffer(device, Math.max(1, count) * PARTICLE_STRIDE, {
        label: 'particle life particles',
    });
}

/** `species_count²` floats. Re-created rather than resized when the count moves. */
function createForceMatrixBuffer(device: GPUDevice, speciesCount: number): GPUBuffer {
    const n = clampSpeciesCount(speciesCount);
    return createStorageBuffer(device, n * n * 4, { label: 'particle life force matrix' });
}

function createOffscreen(
    device: GPUDevice,
    width: number,
    height: number,
    label: string
): GPUTexture {
    return createTexture2d(device, width, height, {
        label,
        format: PARTICLE_LIFE_TEXTURE_FORMAT,
        usage:
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC,
    });
}

/** `rand::random::<u32>()`, which is what re-seeds `init.wgsl`. */
function randomSeed(): number {
    return Math.floor(Math.random() * 0x100000000) >>> 0;
}

/**
 * A neutral greyscale ramp, so the first frame has species colours before the
 * colour-scheme layer has fetched anything.
 *
 * The Rust loads "MATPLOTLIB_ocean" at construction; in the browser that is a
 * network fetch on the critical path to first paint, and
 * `apply_color_scheme_by_name` replaces this within a frame or two. Grey, so a
 * ramp that never got replaced looks obviously provisional rather than like a
 * colour scheme nobody chose.
 */
export function defaultParticleLifeLut(): Uint32Array {
    const lut = new Uint32Array(LUT_ENTRIES);
    for (let i = 0; i < 256; i++) {
        lut[i] = i;
        lut[256 + i] = i;
        lut[512 + i] = i;
    }
    return lut;
}
