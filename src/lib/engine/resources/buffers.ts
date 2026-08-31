/**
 * Buffer creation and std140/std430 layout helpers.
 *
 * WebGPU is stricter than wgpu-on-native about sizes: `writeBuffer` requires a
 * multiple of 4, and a uniform struct's size is rounded up to its alignment,
 * which is 16 whenever it contains a vec3/vec4 or a nested struct. Getting this
 * wrong produces a validation error at bind time rather than at write time, so
 * the padding is centralised here.
 */

export const UNIFORM_ALIGNMENT = 16;
export const COPY_ALIGNMENT = 4;

export function align(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

export interface BufferOptions {
    label?: string;
    /** Extra usage flags beyond the ones implied by the helper. */
    usage?: GPUBufferUsageFlags;
}

/**
 * A `var<storage>` buffer. Sized to a multiple of 4 so the whole range is
 * writable, and always COPY_DST so it can be re-seeded without reallocation.
 */
export function createStorageBuffer(
    device: GPUDevice,
    byteLength: number,
    options: BufferOptions = {}
): GPUBuffer {
    return device.createBuffer({
        label: options.label,
        size: Math.max(COPY_ALIGNMENT, align(byteLength, COPY_ALIGNMENT)),
        usage:
            GPUBufferUsage.STORAGE |
            GPUBufferUsage.COPY_DST |
            GPUBufferUsage.COPY_SRC |
            (options.usage ?? 0),
    });
}

/** A `var<uniform>` buffer, padded to 16 B — the alignment of any struct with a vec4. */
export function createUniformBuffer(
    device: GPUDevice,
    byteLength: number,
    options: BufferOptions = {}
): GPUBuffer {
    return device.createBuffer({
        label: options.label,
        size: Math.max(UNIFORM_ALIGNMENT, align(byteLength, UNIFORM_ALIGNMENT)),
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | (options.usage ?? 0),
    });
}

/** A buffer seeded at creation, avoiding a queue round-trip for immutable data. */
export function createBufferWithData(
    device: GPUDevice,
    data: ArrayBufferView,
    usage: GPUBufferUsageFlags,
    label?: string
): GPUBuffer {
    const size = Math.max(COPY_ALIGNMENT, align(data.byteLength, COPY_ALIGNMENT));
    const buffer = device.createBuffer({ label, size, usage, mappedAtCreation: true });

    const view = new Uint8Array(buffer.getMappedRange());
    view.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    buffer.unmap();

    return buffer;
}

/**
 * Writes a typed array, padding the tail to 4 B when the source is not already
 * a multiple of 4 (a Uint8Array of odd length, typically).
 */
export function writeBuffer(
    queue: GPUQueue,
    buffer: GPUBuffer,
    data: ArrayBufferView,
    byteOffset = 0
): void {
    const remainder = data.byteLength % COPY_ALIGNMENT;
    if (remainder === 0) {
        queue.writeBuffer(buffer, byteOffset, data.buffer, data.byteOffset, data.byteLength);
        return;
    }

    const padded = new Uint8Array(data.byteLength + (COPY_ALIGNMENT - remainder));
    padded.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    queue.writeBuffer(buffer, byteOffset, padded);
}

/**
 * Copies a GPU buffer back to the CPU.
 *
 * Always goes through a fresh staging buffer: MAP_READ cannot be combined with
 * STORAGE, and reusing one staging buffer across in-flight reads is a
 * use-after-map waiting to happen.
 */
export async function readBuffer(
    device: GPUDevice,
    source: GPUBuffer,
    byteLength: number = source.size,
    sourceOffset = 0
): Promise<ArrayBuffer> {
    const size = align(byteLength, COPY_ALIGNMENT);
    const staging = device.createBuffer({
        label: 'readback staging',
        size,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const encoder = device.createCommandEncoder({ label: 'readback' });
    encoder.copyBufferToBuffer(source, sourceOffset, staging, 0, size);
    device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    // Copy out before unmapping: the mapped range is invalidated by unmap().
    const copy = staging.getMappedRange().slice(0);
    staging.unmap();
    staging.destroy();

    return copy;
}
