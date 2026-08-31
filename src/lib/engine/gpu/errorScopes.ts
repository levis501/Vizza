/**
 * Validation-error scopes around resource creation.
 *
 * WebGPU reports validation failures asynchronously: `createRenderPipeline`
 * returns a real-looking object, the draw call using it is silently dropped,
 * and the only symptom is a blank canvas. An error scope turns that into a
 * thrown error at the point of construction, with the driver's message.
 *
 * The scope costs a device round-trip, so it is dev-only. In a production build
 * the wrappers fall through to the bare call.
 */

// Vite defines import.meta.env; the esbuild-bundled GPU harness does not, and
// treats a missing scope as "developing", which is what a test wants.
const DEV: boolean = import.meta.env?.DEV ?? true;

/**
 * Runs `fn` inside a validation scope and rejects with any validation error it
 * produced. The value is returned regardless of whether the scope was pushed,
 * so callers get the same object in both builds.
 */
export async function withValidationScope<T>(
    device: GPUDevice,
    label: string,
    fn: () => T
): Promise<T> {
    if (!DEV) return fn();

    device.pushErrorScope('validation');
    let result: T;
    try {
        result = fn();
    } catch (err) {
        // Pop anyway — an unpopped scope leaks and swallows later errors.
        void device.popErrorScope();
        throw err;
    }

    const error = await device.popErrorScope();
    if (error) {
        throw new Error(`WebGPU validation failed creating ${label}: ${error.message}`);
    }
    return result;
}

export function createRenderPipelineChecked(
    device: GPUDevice,
    descriptor: GPURenderPipelineDescriptor
): Promise<GPURenderPipeline> {
    return withValidationScope(device, descriptor.label ?? 'render pipeline', () =>
        device.createRenderPipeline(descriptor)
    );
}

export function createComputePipelineChecked(
    device: GPUDevice,
    descriptor: GPUComputePipelineDescriptor
): Promise<GPUComputePipeline> {
    return withValidationScope(device, descriptor.label ?? 'compute pipeline', () =>
        device.createComputePipeline(descriptor)
    );
}

export function createBindGroupChecked(
    device: GPUDevice,
    descriptor: GPUBindGroupDescriptor
): Promise<GPUBindGroup> {
    return withValidationScope(device, descriptor.label ?? 'bind group', () =>
        device.createBindGroup(descriptor)
    );
}

/**
 * Compiles a shader module and rejects on any error diagnostic.
 *
 * Note this validates the *source*, not its use: storage-texture access modes
 * and bind-group compatibility are only checked when a pipeline is created, so
 * a module can compile cleanly and still be unusable. That asymmetry is why the
 * WGSL lint suite (test/wgsl) exists alongside this.
 */
export async function createShaderModuleChecked(
    device: GPUDevice,
    descriptor: GPUShaderModuleDescriptor
): Promise<GPUShaderModule> {
    const module = device.createShaderModule(descriptor);
    if (!DEV) return module;

    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === 'error');
    if (errors.length > 0) {
        const detail = errors.map((m) => `  ${m.lineNum}:${m.linePos}  ${m.message}`).join('\n');
        throw new Error(`WGSL compile failed in ${descriptor.label ?? 'shader'}:\n${detail}`);
    }
    return module;
}
