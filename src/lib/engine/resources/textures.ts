/**
 * Texture creation and the full-screen blit used to move a simulation's output
 * onto the canvas (and between post-processing stages).
 */

export interface TextureOptions {
    label?: string;
    format?: GPUTextureFormat;
    usage?: GPUTextureUsageFlags;
}

/**
 * The usage set a simulation's working texture almost always needs: readable
 * from a shader, writable as a storage texture, and copyable both ways.
 * RENDER_ATTACHMENT is included so the same texture can also be drawn into,
 * which the ping-pong render path relies on.
 */
export const SIM_TEXTURE_USAGE =
    GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.STORAGE_BINDING |
    GPUTextureUsage.COPY_SRC |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.RENDER_ATTACHMENT;

export function createTexture2d(
    device: GPUDevice,
    width: number,
    height: number,
    options: TextureOptions = {}
): GPUTexture {
    return device.createTexture({
        label: options.label,
        size: { width: Math.max(1, width), height: Math.max(1, height), depthOrArrayLayers: 1 },
        mipLevelCount: 1,
        sampleCount: 1,
        dimension: '2d',
        format: options.format ?? 'rgba8unorm',
        usage: options.usage ?? SIM_TEXTURE_USAGE,
    });
}

/** Uploads an ImageBitmap/canvas straight into a texture, no CPU copy. */
export function createTextureFromImage(
    device: GPUDevice,
    source: ImageBitmap | HTMLCanvasElement | OffscreenCanvas,
    options: TextureOptions = {}
): GPUTexture {
    const texture = device.createTexture({
        label: options.label,
        size: { width: source.width, height: source.height, depthOrArrayLayers: 1 },
        format: options.format ?? 'rgba8unorm',
        usage:
            options.usage ??
            GPUTextureUsage.TEXTURE_BINDING |
                GPUTextureUsage.COPY_DST |
                GPUTextureUsage.RENDER_ATTACHMENT,
    });

    device.queue.copyExternalImageToTexture(
        { source },
        { texture },
        { width: source.width, height: source.height }
    );
    return texture;
}

const BLIT_WGSL = /* wgsl */ `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@group(0) @binding(0) var src_texture: texture_2d<f32>;
@group(0) @binding(1) var src_sampler: sampler;

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 6>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>(-1.0,  1.0),
        vec2<f32>(-1.0,  1.0),
        vec2<f32>( 1.0, -1.0),
        vec2<f32>( 1.0,  1.0),
    );
    let pos = positions[vertex_index];
    var out: VertexOutput;
    out.position = vec4<f32>(pos, 0.0, 1.0);
    // Clip space is y-up, texture space is y-down.
    out.uv = vec2<f32>(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
    return out;
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    return textureSample(src_texture, src_sampler, uv);
}
`;

/**
 * A reusable texture-to-attachment copy.
 *
 * `copyTextureToTexture` would be cheaper but requires identical formats and
 * cannot target the canvas when the simulation works in rgba16float, which is
 * the usual case — so the blit goes through a sampled draw.
 */
export class Blit {
    private readonly pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
    private readonly module: GPUShaderModule;
    private readonly sampler: GPUSampler;

    constructor(private readonly device: GPUDevice) {
        this.module = device.createShaderModule({ label: 'blit', code: BLIT_WGSL });
        this.sampler = device.createSampler({
            label: 'blit sampler',
            magFilter: 'linear',
            minFilter: 'linear',
            addressModeU: 'clamp-to-edge',
            addressModeV: 'clamp-to-edge',
        });
    }

    /** One pipeline per destination format; there are only ever two or three. */
    private pipelineFor(format: GPUTextureFormat): GPURenderPipeline {
        let pipeline = this.pipelines.get(format);
        if (!pipeline) {
            pipeline = this.device.createRenderPipeline({
                label: `blit -> ${format}`,
                layout: 'auto',
                vertex: { module: this.module, entryPoint: 'vs_main' },
                fragment: { module: this.module, entryPoint: 'fs_main', targets: [{ format }] },
                primitive: { topology: 'triangle-list' },
            });
            this.pipelines.set(format, pipeline);
        }
        return pipeline;
    }

    encode(
        encoder: GPUCommandEncoder,
        source: GPUTextureView,
        target: GPUTextureView,
        targetFormat: GPUTextureFormat
    ): void {
        const pipeline = this.pipelineFor(targetFormat);
        const bindGroup = this.device.createBindGroup({
            label: 'blit bind group',
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: source },
                { binding: 1, resource: this.sampler },
            ],
        });

        const pass = encoder.beginRenderPass({
            label: 'blit',
            colorAttachments: [
                {
                    view: target,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                },
            ],
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(6);
        pass.end();
    }

    destroy(): void {
        this.pipelines.clear();
    }
}

/** Bytes per row must be a multiple of 256 for texture-to-buffer copies. */
export const BYTES_PER_ROW_ALIGNMENT = 256;

export function alignedBytesPerRow(width: number, bytesPerPixel = 4): number {
    return Math.ceil((width * bytesPerPixel) / BYTES_PER_ROW_ALIGNMENT) * BYTES_PER_ROW_ALIGNMENT;
}

/**
 * Reads a texture back to the CPU, undoing the 256-byte row padding so the
 * result is a tight width*height*4 array.
 */
export async function readTexturePixels(
    device: GPUDevice,
    texture: GPUTexture,
    width = texture.width,
    height = texture.height
): Promise<Uint8Array> {
    const bytesPerRow = alignedBytesPerRow(width);
    const staging = device.createBuffer({
        label: 'texture readback',
        size: bytesPerRow * height,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const encoder = device.createCommandEncoder({ label: 'texture readback' });
    encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow }, { width, height });
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const padded = new Uint8Array(staging.getMappedRange());

    const tight = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        tight.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
    }

    staging.unmap();
    staging.destroy();
    return tight;
}
