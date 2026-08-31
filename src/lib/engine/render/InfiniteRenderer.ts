/**
 * The tiled infinite canvas — a wrapper around
 * `src-tauri/src/simulations/shared/infinite_render.wgsl` (306 ln).
 *
 * Six simulations draw through this shader (Flow, Gray-Scott, Moiré, Pellets,
 * Slime Mold, Vectors), each with its own near-identical copy of the pipeline,
 * layout and bind-group boilerplate in Rust. It lives in `engine/` rather than
 * in any one sim so the next five milestones inherit it instead of repeating it.
 *
 * How it works: one unit quad is instanced `tileCount²` times, each instance
 * offset by two world units, so the simulation texture repeats forever in every
 * direction and the camera can pan and zoom out through it. The tile count is
 * computed from the zoom on **both** sides — CPU for the instance count, GPU in
 * `calculate_tile_count` for the per-instance offset — so the two must agree
 * exactly or the grid tears at its edge. Hence `calculateTileCount` below is a
 * literal port of the WGSL, and is unit-tested against it.
 *
 * Only the `fs_main_texture` entry point is used. The module also declares
 * bindings 3-7 for Gray-Scott's storage path (`fs_main`), but WebGPU only
 * requires a layout to cover the bindings an entry point *statically uses*, so
 * the pipeline layout here is just texture + sampler + render params + camera.
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

export interface InfiniteRendererOptions {
    label?: string;
    filteringMode?: TextureFilteringMode;
    /** Defaults to clearing black, as every Rust caller does. */
    clearValue?: GPUColor;
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

    private cameraBindGroup: GPUBindGroup | null = null;
    private destroyed = false;

    private constructor(
        device: GPUDevice,
        label: string,
        pipeline: GPURenderPipeline,
        sourceLayout: GPUBindGroupLayout,
        cameraLayout: GPUBindGroupLayout,
        sampler: GPUSampler,
        renderParams: GPUBuffer,
        clearValue: GPUColor
    ) {
        this.device = device;
        this.label = label;
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

        const module = await createShaderModuleChecked(device, {
            label: `${label} shader`,
            code: getShader(INFINITE_RENDER_SHADER_PATH),
        });

        const sourceLayout = device.createBindGroupLayout({
            label: `${label} source layout`,
            entries: [
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
                { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
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
                entryPoint: 'fs_main_texture',
                targets: [
                    {
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

        const sampler = device.createSampler({
            label: `${label} sampler`,
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'nearest',
        });

        // 16 B: one u32 plus three words of padding, as RenderParams declares.
        const renderParams = createUniformBuffer(device, 16, { label: `${label} params` });
        const mode = options.filteringMode ?? TEXTURE_FILTERING.linear;
        device.queue.writeBuffer(renderParams, 0, new Uint32Array([mode, 0, 0, 0]));

        return new InfiniteRenderer(
            device,
            label,
            pipeline,
            sourceLayout,
            cameraLayout,
            sampler,
            renderParams,
            options.clearValue ?? { r: 0, g: 0, b: 0, a: 1 }
        );
    }

    /** One bind group per source texture view. */
    createSourceBindGroup(view: GPUTextureView, suffix = ''): GPUBindGroup {
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
