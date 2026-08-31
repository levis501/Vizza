/**
 * The tiled infinite canvas — a wrapper around
 * `src-tauri/src/simulations/shared/infinite_render.wgsl` (306 ln).
 *
 * Five simulations draw through this shader (Flow, Gray-Scott, Moiré, Pellets,
 * Slime Mold), each with its own near-identical copy of the pipeline, layout and
 * bind-group boilerplate in Rust. It lives in `engine/` rather than in any one
 * sim so the remaining milestones inherit it instead of repeating it.
 *
 * Vectors was listed here until M5 and does not belong: `vectors/simulation.rs`
 * renders straight to the surface with a clear colour, no tiling and no infinite
 * canvas at all.
 *
 * How it works: one unit quad is instanced `tileCount²` times, each instance
 * offset by two world units, so the simulation texture repeats forever in every
 * direction and the camera can pan and zoom out through it. The tile count is
 * computed from the zoom on **both** sides — CPU for the instance count, GPU in
 * `calculate_tile_count` for the per-instance offset — so the two must agree
 * exactly or the grid tears at its edge. Hence `calculateTileCount` below is a
 * literal port of the WGSL, and is unit-tested against it.
 *
 * Two of the module's three fragment entry points are used, and a renderer is
 * built for one or the other (`path` below):
 *
 *   'texture' — `fs_main_texture`, bindings 0/1/2. Flow, Moiré, Pellets, Slime
 *               Mold: sample an rgba texture and show it as-is.
 *   'storage' — `fs_main`, a one-line wrapper around `fs_main_storage`, bindings
 *               3/4/5/7. Gray-Scott: sample one *scalar* field out of the red
 *               channel and colour it through a LUT.
 *
 * WebGPU only requires a layout to cover the bindings an entry point
 * *statically uses*, so each path declares its own and neither carries the
 * other's. Binding 6 (`params: SimulationParams`) is used by no entry point at
 * all and appears in neither — sparse binding numbers with gaps are legal.
 */

import { getShader } from '$lib/engine/shaders';
import {
    createRenderPipelineChecked,
    createShaderModuleChecked,
} from '$lib/engine/gpu/errorScopes';
import { createUniformBuffer } from '$lib/engine/resources/buffers';

export const INFINITE_RENDER_SHADER_PATH = 'shared/infinite_render.wgsl';

/** `RenderParams.filtering_mode` (infinite_render.wgsl:64). */
export const TEXTURE_FILTERING = {
    nearest: 0,
    /** The AppSettings default (commands/app_settings.rs:76). */
    linear: 1,
    lanczos: 2,
} as const;

export type TextureFilteringMode = (typeof TEXTURE_FILTERING)[keyof typeof TEXTURE_FILTERING];

/** Tiles are two world units across, matching the quad's [-1,1] extent. */
export const TILE_WORLD_SIZE = 2.0;

/** infinite_render.wgsl:76 — a hard ceiling of 1024x1024 instances. */
export const MAX_TILES_PER_AXIS = 1024;

/**
 * Port of `calculate_tile_count` (infinite_render.wgsl:71, and the identical
 * Rust at moire/simulation.rs:125).
 *
 * A non-positive or non-finite zoom would make `2/zoom` infinite and
 * `i32(ceil(...))` undefined, so it is floored to the minimum tiling rather
 * than allowed to produce an absurd instance count.
 */
export function calculateTileCount(zoom: number): number {
    const minTiles = zoom < 0.1 ? 7 : 5;
    if (!Number.isFinite(zoom) || zoom <= 0) return minTiles;

    const visibleWorldSize = TILE_WORLD_SIZE / zoom;
    const tilesNeeded = Math.ceil(visibleWorldSize / TILE_WORLD_SIZE) + 6;
    return Math.min(Math.max(tilesNeeded, minTiles), MAX_TILES_PER_AXIS);
}

/**
 * Which fragment entry point — and therefore which bind-group shape — this
 * renderer is built for. See the module comment.
 */
export type InfiniteRenderPath = 'texture' | 'storage';

export interface InfiniteRendererOptions {
    label?: string;
    filteringMode?: TextureFilteringMode;
    /** Defaults to clearing black, as every Rust caller does. */
    clearValue?: GPUColor;
    /** Defaults to 'texture', which is what the four RGBA simulations want. */
    path?: InfiniteRenderPath;
}

export class InfiniteRenderer {
    private readonly device: GPUDevice;
    private readonly label: string;
    private readonly pipeline: GPURenderPipeline;
    private readonly sourceLayout: GPUBindGroupLayout;
    private readonly cameraLayout: GPUBindGroupLayout;
    private readonly sampler: GPUSampler;
    private readonly renderParams: GPUBuffer;
    private readonly clearValue: GPUColor;
    readonly path: InfiniteRenderPath;

    private cameraBindGroup: GPUBindGroup | null = null;
    private destroyed = false;

    private constructor(
        device: GPUDevice,
        label: string,
        path: InfiniteRenderPath,
        pipeline: GPURenderPipeline,
        sourceLayout: GPUBindGroupLayout,
        cameraLayout: GPUBindGroupLayout,
        sampler: GPUSampler,
        renderParams: GPUBuffer,
        clearValue: GPUColor
    ) {
        this.device = device;
        this.label = label;
        this.path = path;
        this.pipeline = pipeline;
        this.sourceLayout = sourceLayout;
        this.cameraLayout = cameraLayout;
        this.sampler = sampler;
        this.renderParams = renderParams;
        this.clearValue = clearValue;
    }

    static async create(
        device: GPUDevice,
        format: GPUTextureFormat,
        options: InfiniteRendererOptions = {}
    ): Promise<InfiniteRenderer> {
        const label = options.label ?? 'infinite render';
        const path = options.path ?? 'texture';
        const storage = path === 'storage';

        const module = await createShaderModuleChecked(device, {
            label: `${label} shader`,
            code: getShader(INFINITE_RENDER_SHADER_PATH),
        });

        // `fs_main_storage` reads `simulation_data`/`simulation_sampler` at 3/4,
        // `lut_data` at 5 and `render_params` at 7 — and nothing at 0, 1, 2 or 6.
        const sourceLayout = device.createBindGroupLayout({
            label: `${label} source layout`,
            entries: storage
                ? [
                      {
                          binding: 3,
                          visibility: GPUShaderStage.FRAGMENT,
                          texture: { sampleType: 'float', viewDimension: '2d' },
                      },
                      {
                          binding: 4,
                          visibility: GPUShaderStage.FRAGMENT,
                          sampler: { type: 'filtering' },
                      },
                      {
                          binding: 5,
                          visibility: GPUShaderStage.FRAGMENT,
                          buffer: { type: 'read-only-storage' },
                      },
                      {
                          binding: 7,
                          visibility: GPUShaderStage.FRAGMENT,
                          buffer: { type: 'uniform' },
                      },
                  ]
                : [
                      {
                          binding: 0,
                          visibility: GPUShaderStage.FRAGMENT,
                          texture: { sampleType: 'float', viewDimension: '2d' },
                      },
                      {
                          binding: 1,
                          visibility: GPUShaderStage.FRAGMENT,
                          sampler: { type: 'filtering' },
                      },
                      {
                          binding: 2,
                          visibility: GPUShaderStage.FRAGMENT,
                          buffer: { type: 'uniform' },
                      },
                  ],
        });

        const cameraLayout = device.createBindGroupLayout({
            label: `${label} camera layout`,
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
            ],
        });

        const pipeline = await createRenderPipelineChecked(device, {
            label: `${label} pipeline`,
            layout: device.createPipelineLayout({
                label: `${label} pipeline layout`,
                bindGroupLayouts: [sourceLayout, cameraLayout],
            }),
            vertex: { module, entryPoint: 'vs_main' },
            fragment: {
                module,
                entryPoint: storage ? 'fs_main' : 'fs_main_texture',
                targets: [
                    {
                        // One/zero, i.e. REPLACE. The Rust asked for
                        // ALPHA_BLENDING on the Gray-Scott pipeline
                        // (simulation.rs:452), which is the same thing here:
                        // `fs_main_storage` returns a hardcoded alpha of 1.0 and
                        // discards anything else, so nothing is ever blended.
                        format,
                        blend: {
                            color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
                            alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
                        },
                        writeMask: GPUColorWrite.ALL,
                    },
                ],
            },
            // No culling: the tiles are wound CCW but a mirrored camera would
            // silently drop every one of them, which is a very confusing blank.
            primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
        });

        // The storage path wraps, the texture path clamps.
        //
        // Both are transcriptions, not preferences: gray_scott/simulation.rs:404
        // asks for Repeat on all three axes and Linear mipmap filtering, while
        // every texture-path caller asks for ClampToEdge. It matters — the
        // Gray-Scott field is toroidal (the reaction wraps in `get_laplacian`)
        // and the canvas tiles it, so clamping would smear the last row of
        // texels across every tile seam.
        const sampler = device.createSampler({
            label: `${label} sampler`,
            addressModeU: storage ? 'repeat' : 'clamp-to-edge',
            addressModeV: storage ? 'repeat' : 'clamp-to-edge',
            addressModeW: storage ? 'repeat' : 'clamp-to-edge',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: storage ? 'linear' : 'nearest',
        });

        // 16 B: one u32 plus three words of padding, as RenderParams declares.
        //
        // This is also remediation (2) for Gray-Scott. The Rust builds a
        // correct 16-byte filtering-mode buffer from the app setting
        // (`texture_render_params_buffer`, simulation.rs:400, kept up to date by
        // `update_app_settings` at :683) and then **binds it nowhere**: binding 7
        // gets the 68-byte `RenderSimulationParams` instead (simulation.rs:1330).
        // The shader reads that as a 16-byte `RenderParams`, so `filtering_mode`
        // is the f32 bit pattern of `feed_rate` — 0.055 gives ~1.03e9, neither 0
        // nor 1 — and `fs_main_storage` falls into its `else` branch on every
        // frame. The desktop build is therefore *always* Lanczos whatever the app
        // setting says; binding the right 16 bytes makes Gray-Scott default to
        // Linear like everything else, which is a visible change of appearance.
        const renderParams = createUniformBuffer(device, 16, { label: `${label} params` });
        const mode = options.filteringMode ?? TEXTURE_FILTERING.linear;
        device.queue.writeBuffer(renderParams, 0, new Uint32Array([mode, 0, 0, 0]));

        return new InfiniteRenderer(
            device,
            label,
            path,
            pipeline,
            sourceLayout,
            cameraLayout,
            sampler,
            renderParams,
            options.clearValue ?? { r: 0, g: 0, b: 0, a: 1 }
        );
    }

    /** One bind group per source texture view. Texture path only. */
    createSourceBindGroup(view: GPUTextureView, suffix = ''): GPUBindGroup {
        this.requirePath('texture', 'createSourceBindGroup');
        return this.device.createBindGroup({
            label: `${this.label} source${suffix ? ` ${suffix}` : ''}`,
            layout: this.sourceLayout,
            entries: [
                { binding: 0, resource: view },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: { buffer: this.renderParams } },
            ],
        });
    }

    /** Both orientations of a ping-pong pair, indexed by `currentIndex`. */
    createSourceBindGroups(
        views: readonly [GPUTextureView, GPUTextureView]
    ): [GPUBindGroup, GPUBindGroup] {
        return [
            this.createSourceBindGroup(views[0], 'A'),
            this.createSourceBindGroup(views[1], 'B'),
        ];
    }

    /**
     * One bind group per source view for the storage path, which additionally
     * needs the 768-entry planar LUT the fragment shader colours through.
     *
     * `lut` is a `var<storage, read> array<u32>` rather than a texture — the
     * same buffer shape Moiré's compute pass takes, indexed `[i]`, `[i+256]`,
     * `[i+512]`.
     */
    createStorageSourceBindGroup(view: GPUTextureView, lut: GPUBuffer, suffix = ''): GPUBindGroup {
        this.requirePath('storage', 'createStorageSourceBindGroup');
        return this.device.createBindGroup({
            label: `${this.label} source${suffix ? ` ${suffix}` : ''}`,
            layout: this.sourceLayout,
            entries: [
                { binding: 3, resource: view },
                { binding: 4, resource: this.sampler },
                { binding: 5, resource: { buffer: lut } },
                { binding: 7, resource: { buffer: this.renderParams } },
            ],
        });
    }

    /** Both orientations of a ping-pong pair, indexed by `currentIndex`. */
    createStorageSourceBindGroups(
        views: readonly [GPUTextureView, GPUTextureView],
        lut: GPUBuffer
    ): [GPUBindGroup, GPUBindGroup] {
        return [
            this.createStorageSourceBindGroup(views[0], lut, 'A'),
            this.createStorageSourceBindGroup(views[1], lut, 'B'),
        ];
    }

    /**
     * A bind group built for the wrong entry point is a validation error whose
     * message names binding numbers rather than the mistake, so it is caught
     * here instead.
     */
    private requirePath(expected: InfiniteRenderPath, method: string): void {
        if (this.path === expected) return;
        throw new Error(
            `${method} needs an InfiniteRenderer created with path: '${expected}', ` +
                `but this one is '${this.path}'`
        );
    }

    /**
     * Point the vertex stage at a camera uniform.
     *
     * Separate from construction because `SimulationHost` hands its camera to a
     * simulation only *after* the factory has run, and the camera's buffer does
     * not exist until then.
     */
    setCameraBuffer(buffer: GPUBuffer): void {
        this.cameraBindGroup = this.device.createBindGroup({
            label: `${this.label} camera`,
            layout: this.cameraLayout,
            entries: [{ binding: 0, resource: { buffer } }],
        });
    }

    setFilteringMode(mode: TextureFilteringMode): void {
        this.device.queue.writeBuffer(this.renderParams, 0, new Uint32Array([mode, 0, 0, 0]));
    }

    /**
     * Draw the tiled canvas into `target`.
     *
     * A no-op without a camera buffer rather than a validation error: the host
     * may issue a paused redraw between constructing a simulation and attaching
     * its camera, and a dropped frame there is invisible where a device error
     * would poison the rest of the session.
     */
    encode(
        encoder: GPUCommandEncoder,
        target: GPUTextureView,
        source: GPUBindGroup,
        zoom: number
    ): void {
        if (this.destroyed || !this.cameraBindGroup) return;

        const tileCount = calculateTileCount(zoom);

        const pass = encoder.beginRenderPass({
            label: `${this.label} pass`,
            colorAttachments: [
                { view: target, loadOp: 'clear', storeOp: 'store', clearValue: this.clearValue },
            ],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, source);
        pass.setBindGroup(1, this.cameraBindGroup);
        pass.draw(6, tileCount * tileCount);
        pass.end();
    }

    /** Idempotent. Only the uniform buffer owns memory worth releasing. */
    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.cameraBindGroup = null;
        this.renderParams.destroy();
    }
}
