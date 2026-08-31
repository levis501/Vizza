/**
 * Post-processing chain — a port of shared/post_processing.rs, wrapping
 * shared/blur_filter.wgsl.
 *
 * The Rust struct keeps an intermediate and an output texture so a simulation
 * can render into `intermediate`, run filters, and end up in `output` ready to
 * be presented. That shape carries across unchanged; only resource creation
 * and the render-pass encoding differ.
 */

import { getShader } from '$lib/engine/shaders';
import { createUniformBuffer } from '$lib/engine/resources/buffers';

/** Mirrors the BlurFilter struct in post_processing.rs, defaults included. */
export interface BlurFilterState {
    enabled: boolean;
    order: number;
    radius: number;
    sigma: number;
}

export interface PostProcessingState {
    blurFilter: BlurFilterState;
}

export function defaultPostProcessingState(): PostProcessingState {
    return { blurFilter: { enabled: false, order: 0, radius: 5.0, sigma: 2.0 } };
}

const BLUR_PARAMS_BYTES = 16; // radius, sigma, width, height — four f32

export class PostProcessing {
    private readonly device: GPUDevice;
    private readonly format: GPUTextureFormat;
    private readonly layout: GPUBindGroupLayout;
    private readonly pipeline: GPURenderPipeline;
    private readonly sampler: GPUSampler;
    private readonly paramsBuffer: GPUBuffer;
    private readonly params = new Float32Array(4);

    private intermediateTexture!: GPUTexture;
    private outputTexture!: GPUTexture;
    private bindGroup!: GPUBindGroup;

    width: number;
    height: number;

    constructor(device: GPUDevice, width: number, height: number, format: GPUTextureFormat) {
        this.device = device;
        this.format = format;
        this.width = Math.max(1, width);
        this.height = Math.max(1, height);

        this.paramsBuffer = createUniformBuffer(device, BLUR_PARAMS_BYTES, {
            label: 'blur params',
        });

        // Explicit layout rather than 'auto': the same layout has to be reusable
        // across the resize path, which rebuilds bind groups but not pipelines.
        this.layout = device.createBindGroupLayout({
            label: 'blur bind group layout',
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
                {
                    binding: 2,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
            ],
        });

        const module = device.createShaderModule({
            label: 'blur_filter',
            code: getShader('shared/blur_filter.wgsl'),
        });

        this.pipeline = device.createRenderPipeline({
            label: 'blur pipeline',
            layout: device.createPipelineLayout({
                label: 'blur pipeline layout',
                bindGroupLayouts: [this.layout],
            }),
            vertex: { module, entryPoint: 'vs_main' },
            fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
            primitive: { topology: 'triangle-list' },
        });

        this.sampler = device.createSampler({
            label: 'blur sampler',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
            addressModeW: 'clamp-to-edge',
            magFilter: 'linear',
            minFilter: 'linear',
            mipmapFilter: 'linear',
        });

        this.allocate();
    }

    /** Render target a simulation should draw into before filters run. */
    get intermediateView(): GPUTextureView {
        return this.intermediateTexture.createView();
    }

    get outputView(): GPUTextureView {
        return this.outputTexture.createView();
    }

    get output(): GPUTexture {
        return this.outputTexture;
    }

    updateBlurParams(
        radius: number,
        sigma: number,
        width = this.width,
        height = this.height
    ): void {
        this.params.set([radius, sigma, width, height]);
        this.device.queue.writeBuffer(this.paramsBuffer, 0, this.params);
    }

    /**
     * Encodes the blur from `intermediate` into `target`.
     *
     * A disabled filter still has to run, because the caller's chain expects the
     * pixels to land in the target; blur_filter.wgsl short-circuits to a plain
     * sample when radius or sigma is zero, so passing zeros makes it a copy.
     */
    encode(encoder: GPUCommandEncoder, target: GPUTextureView, state: BlurFilterState): void {
        this.updateBlurParams(state.enabled ? state.radius : 0, state.enabled ? state.sigma : 0);

        const pass = encoder.beginRenderPass({
            label: 'blur pass',
            colorAttachments: [
                {
                    view: target,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                },
            ],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.draw(6);
        pass.end();
    }

    resize(width: number, height: number): void {
        const nextWidth = Math.max(1, width);
        const nextHeight = Math.max(1, height);
        if (nextWidth === this.width && nextHeight === this.height) return;

        this.width = nextWidth;
        this.height = nextHeight;
        this.intermediateTexture.destroy();
        this.outputTexture.destroy();
        this.allocate();
    }

    destroy(): void {
        this.intermediateTexture.destroy();
        this.outputTexture.destroy();
        this.paramsBuffer.destroy();
    }

    private allocate(): void {
        const usage =
            GPUTextureUsage.RENDER_ATTACHMENT |
            GPUTextureUsage.TEXTURE_BINDING |
            GPUTextureUsage.COPY_SRC;
        const size = { width: this.width, height: this.height, depthOrArrayLayers: 1 };

        this.intermediateTexture = this.device.createTexture({
            label: 'post processing intermediate',
            size,
            format: this.format,
            usage,
        });
        this.outputTexture = this.device.createTexture({
            label: 'post processing output',
            size,
            format: this.format,
            usage,
        });

        this.bindGroup = this.device.createBindGroup({
            label: 'blur bind group',
            layout: this.layout,
            entries: [
                { binding: 0, resource: this.intermediateTexture.createView() },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: { buffer: this.paramsBuffer } },
            ],
        });

        this.updateBlurParams(0, 0);
    }
}
