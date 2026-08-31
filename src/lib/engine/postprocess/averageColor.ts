/**
 * Average colour of a display texture — a port of shared/average_color.rs
 * around shared/average_color.wgsl.
 *
 * Used as the backdrop when an infinite-canvas simulation is zoomed far out, so
 * the empty region matches the content rather than showing black.
 *
 * The Rust version polls the device in a loop and reads the staging buffer
 * synchronously; in the browser `mapAsync` is a promise, which is strictly
 * better — the caller awaits a result instead of sleeping for 10 ms and hoping.
 */

import { getShader } from '$lib/engine/shaders';

const RESULT_BYTES = 16; // vec4<u32>: summed r, g, b, and a visible-pixel count
const WORKGROUP = 16;

export class AverageColor {
    private readonly device: GPUDevice;
    private readonly pipeline: GPUComputePipeline;
    private readonly resultBuffer: GPUBuffer;
    private readonly stagingBuffer: GPUBuffer;
    private readonly zeros = new Uint32Array(4);

    private bindGroup: GPUBindGroup | null = null;
    private sourceView: GPUTextureView | null = null;

    /** Guards against overlapping mapAsync calls, which throw rather than queue. */
    private pending: Promise<[number, number, number, number] | null> | null = null;

    constructor(device: GPUDevice, label = 'average color') {
        this.device = device;

        const module = device.createShaderModule({
            label: 'average_color',
            code: getShader('shared/average_color.wgsl'),
        });

        this.pipeline = device.createComputePipeline({
            label: `${label} pipeline`,
            layout: 'auto',
            compute: { module, entryPoint: 'main' },
        });

        this.resultBuffer = device.createBuffer({
            label: `${label} buffer`,
            size: RESULT_BYTES,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });

        this.stagingBuffer = device.createBuffer({
            label: `${label} staging buffer`,
            size: RESULT_BYTES,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
        });
    }

    /** Rebinds after a resize; cheap enough to call every frame if need be. */
    setSource(view: GPUTextureView): void {
        if (this.sourceView === view) return;
        this.sourceView = view;
        this.bindGroup = this.device.createBindGroup({
            label: 'average color bind group',
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: view },
                { binding: 1, resource: { buffer: this.resultBuffer } },
            ],
        });
    }

    /**
     * Dispatches the reduction and reads it back, as linear 0..1 RGBA.
     * Resolves to null when every pixel was transparent — the shader counts only
     * pixels with alpha > 0, so there is no meaningful average.
     */
    async compute(
        texture: GPUTexture,
        view?: GPUTextureView
    ): Promise<[number, number, number, number] | null> {
        if (view) this.setSource(view);
        if (!this.bindGroup) throw new Error('AverageColor.setSource() must be called first');

        // A second call while the staging buffer is still mapped would throw, so
        // callers polling every frame get the in-flight result instead.
        if (this.pending) return this.pending;

        this.pending = this.run(texture, this.bindGroup).finally(() => {
            this.pending = null;
        });
        return this.pending;
    }

    private async run(
        texture: GPUTexture,
        bindGroup: GPUBindGroup
    ): Promise<[number, number, number, number] | null> {
        this.device.queue.writeBuffer(this.resultBuffer, 0, this.zeros);

        const encoder = this.device.createCommandEncoder({ label: 'average color' });
        const pass = encoder.beginComputePass({ label: 'average color pass' });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(
            Math.ceil(texture.width / WORKGROUP),
            Math.ceil(texture.height / WORKGROUP),
            1
        );
        pass.end();
        encoder.copyBufferToBuffer(this.resultBuffer, 0, this.stagingBuffer, 0, RESULT_BYTES);
        this.device.queue.submit([encoder.finish()]);

        await this.stagingBuffer.mapAsync(GPUMapMode.READ);
        const values = new Uint32Array(this.stagingBuffer.getMappedRange().slice(0));
        this.stagingBuffer.unmap();

        const count = values[3];
        if (count === 0) return null;

        return [values[0] / count / 255, values[1] / count / 255, values[2] / count / 255, 1];
    }

    destroy(): void {
        this.resultBuffer.destroy();
        this.stagingBuffer.destroy();
        this.bindGroup = null;
        this.sourceView = null;
    }
}
