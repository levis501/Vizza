import type { Caps, GpuContext, GpuFailure } from '$lib/engine/types';
import { deriveCaps } from './limits';

/**
 * Ceilings we ask for. Requesting `min(adapter, ceiling)` can never fail,
 * whereas src-tauri/src/main.rs:60-63 asks for a fixed 2 GB and takes the whole
 * app down on any device that cannot supply it.
 *
 * On the reference device every one of these already sits at the spec default,
 * so the request is a no-op there and a win on anything larger.
 */
const LIMIT_CEILINGS: Record<string, number> = {
    maxStorageBufferBindingSize: 1 << 30,
    maxBufferSize: 1 << 30,
    // Slime Mold's 16x16x1 workgroup is exactly at the 256 default, so asking for
    // more buys headroom for later workgroup tuning without ever being required.
    maxComputeInvocationsPerWorkgroup: 1024,
    maxComputeWorkgroupSizeX: 1024,
    maxStorageBuffersPerShaderStage: 10,
    maxTextureDimension2D: 16384,
};

export interface InitGpuOptions {
    /** Called if the device is lost after a successful init (driver reset, tab evicted). */
    onDeviceLost?: (info: GPUDeviceLostInfo) => void;
}

/** Narrows the union returned by initGpu(). */
export function isGpuFailure(result: GpuContext | { error: GpuFailure }): result is {
    error: GpuFailure;
} {
    return 'error' in result;
}

/** A sentence fit to put in front of a user, per failure kind. */
export function describeGpuFailure(failure: GpuFailure): string {
    switch (failure.kind) {
        case 'insecure-context':
            return `WebGPU is unavailable because ${failure.origin} is not a secure context. Use http://localhost, or allowlist this origin in chrome://flags/#unsafely-treat-insecure-origin-as-secure.`;
        case 'no-webgpu':
            return 'This browser does not support WebGPU. Chrome 113+ or Edge 113+ is required.';
        case 'no-adapter':
            return 'No WebGPU adapter is available. The GPU may be blocklisted or hardware acceleration disabled.';
        case 'device-failed':
            return `The WebGPU device could not be created: ${failure.message}`;
    }
}

export async function initGpu(
    canvas: HTMLCanvasElement,
    options: InitGpuOptions = {}
): Promise<GpuContext | { error: GpuFailure }> {
    // Checked FIRST and separately from navigator.gpu, because an insecure
    // context does not disable WebGPU — it removes `navigator.gpu` entirely.
    // Conflating the two sends you diagnosing browser support when the real
    // problem is the URL. See WEB_PORT.md "WebGPU requires a secure context".
    if (!window.isSecureContext) {
        return { error: { kind: 'insecure-context', origin: window.location.origin } };
    }

    if (!navigator.gpu) {
        return { error: { kind: 'no-webgpu' } };
    }

    let adapter: GPUAdapter | null = null;
    try {
        adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    } catch (err) {
        return { error: { kind: 'device-failed', message: String(err) } };
    }
    if (!adapter) {
        return { error: { kind: 'no-adapter' } };
    }

    let device: GPUDevice;
    try {
        device = await adapter.requestDevice({
            label: 'vizza',
            requiredLimits: negotiateLimits(adapter),
            // Deliberately no features: the reference device grants only
            // core-features-and-limits, and 'readonly-and-readwrite-storage-textures'
            // is absent on SwiftShader, so requiring it would break the GPU tests.
            requiredFeatures: [],
        });
    } catch (err) {
        return {
            error: {
                kind: 'device-failed',
                message: err instanceof Error ? err.message : String(err),
            },
        };
    }

    // A lost device is unrecoverable for the objects created from it; every
    // pipeline, buffer, and bind group has to be rebuilt against a new one.
    // Reason 'destroyed' is our own teardown and is not an error.
    void device.lost.then((info) => {
        if (info.reason === 'destroyed') return;
        console.error(`WebGPU device lost (${info.reason}): ${info.message}`);
        options.onDeviceLost?.(info);
    });

    const context = canvas.getContext('webgpu');
    if (!context) {
        return {
            error: { kind: 'device-failed', message: 'canvas.getContext("webgpu") returned null' },
        };
    }

    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device,
        format,
        // The canvas sits behind #app as the page backdrop and always covers it
        // fully; 'opaque' lets the compositor skip per-pixel blending.
        alphaMode: 'opaque',
    });

    const caps: Caps = deriveCaps(device);

    return {
        adapter,
        device,
        canvas,
        context,
        format,
        caps,
        width: canvas.width,
        height: canvas.height,
    };
}

/**
 * `min(adapter, ceiling)` for every limit we care about, skipping any the
 * adapter does not report. Never asks for more than the adapter has, so
 * requestDevice cannot reject on limits.
 */
function negotiateLimits(adapter: GPUAdapter): Record<string, number> {
    const requested: Record<string, number> = {};
    const supported = adapter.limits as unknown as Record<string, number | undefined>;

    for (const [name, ceiling] of Object.entries(LIMIT_CEILINGS)) {
        const available = supported[name];
        if (typeof available === 'number') {
            requested[name] = Math.min(available, ceiling);
        }
    }
    return requested;
}
