/**
 * L3 GPU tests — run in raw Chrome against SwiftShader.
 *
 * Playwright's launcher makes navigator.gpu undefined regardless of flags, so
 * this file is bundled by esbuild, served by test/gpu/run.mjs, and POSTs its
 * results back. See WEB_PORT.md "Test strategy".
 *
 * Assertions are deliberately statistical — mean absolute error, "not uniform",
 * "no NaN" — never exact pixel hashes. SwiftShader's floating-point ordering
 * differs from real hardware, so a hash would pass here and fail on a Mac, or
 * the reverse, and tell you nothing either way.
 */

import { initGpu, isGpuFailure, describeGpuFailure } from '$lib/engine/gpu/device';
import { deriveCaps, foldDispatch, SLIME_MOLD_AGENT_STRIDE } from '$lib/engine/gpu/limits';
import { computeBackingSize, MAX_DEVICE_PIXEL_RATIO } from '$lib/engine/gpu/surface';
import { createShaderModuleChecked } from '$lib/engine/gpu/errorScopes';
import {
    alignedBytesPerRow,
    createTexture2d,
    readTexturePixels,
} from '$lib/engine/resources/textures';
import { PingPongTextures } from '$lib/engine/resources/pingPong';
import { BindGroupLayoutCache } from '$lib/engine/resources/bindGroupCache';
import {
    readBuffer,
    createStorageBuffer,
    createUniformBuffer,
    align,
} from '$lib/engine/resources/buffers';
import { AverageColor } from '$lib/engine/postprocess/averageColor';
import { PostProcessing, defaultPostProcessingState } from '$lib/engine/postprocess/PostProcessing';
import { MainMenuSimulation, defaultLut, reverseLut } from '$lib/engine/sims/mainMenu';
import { MoireSimulation } from '$lib/engine/sims/moire';
import { defaultMoireSettings } from '$lib/engine/sims/moire/settings';
import {
    GrayScottSimulation,
    decodeFloat16,
    encodeFloat16,
    SEED_DISC_RADIUS,
} from '$lib/engine/sims/grayScott';
import {
    defaultGrayScottSettings,
    defaultGrayScottState,
    type GrayScottSettings,
} from '$lib/engine/sims/grayScott/settings';
import {
    VectorsSimulation,
    VECTORS_LINE_SHADER_PATH,
    vectorsGridPointAt,
    vectorsVertexShaderSource,
} from '$lib/engine/sims/vectors';
import {
    defaultVectorsSettings,
    vectorsGridExtent,
    vectorsLineQuad,
    vectorsLineSegment,
    vectorsQuadIndices,
    VECTORS_MAX_LINES,
} from '$lib/engine/sims/vectors/settings';
import {
    GradientSimulation,
    defaultGradientLut,
    parseGradientDisplayMode,
    BAYER_PERIOD_PX,
    GRADIENT_DISPLAY_MODE,
    GRADIENT_QUANTIZATION_STEP,
} from '$lib/engine/sims/gradient';
import { Camera } from '$lib/engine/core/Camera';
import { calculateTileCount, TEXTURE_FILTERING } from '$lib/engine/render/InfiniteRenderer';
import { ResourceLedger, instrumentDevice } from '$lib/engine/core/resourceLedger';
import type { GpuContext } from '$lib/engine/types';
import { shaderPathsNow, getShader } from './shaderShim';

// ---------------------------------------------------------------------------
// Micro test framework
// ---------------------------------------------------------------------------

interface Result {
    name: string;
    ok: boolean;
    error?: string;
    ms: number;
}

const results: Result[] = [];
const tests: Array<[string, () => Promise<void> | void]> = [];

function test(name: string, fn: () => Promise<void> | void): void {
    tests.push([name, fn]);
}

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function assertClose(actual: number, expected: number, tolerance: number, what: string): void {
    assert(
        Math.abs(actual - expected) <= tolerance,
        `${what}: expected ${expected} +/- ${tolerance}, got ${actual}`
    );
}

// ---------------------------------------------------------------------------
// Pixel helpers
// ---------------------------------------------------------------------------

/** Mean absolute error over every channel, in 0..255 units. */
function meanAbsoluteError(a: Uint8Array, b: Uint8Array): number {
    assert(a.length === b.length, `pixel buffers differ in length: ${a.length} vs ${b.length}`);
    let total = 0;
    for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
    return total / a.length;
}

/** A constant image means the shader produced nothing, which a MAE test cannot see. */
function isUniform(pixels: Uint8Array): boolean {
    for (let i = 4; i < pixels.length; i++) {
        if (pixels[i] !== pixels[i % 4]) return false;
    }
    return true;
}

function hasNonFinite(values: ArrayLike<number>): boolean {
    for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) return true;
    }
    return false;
}

function clearTo(
    device: GPUDevice,
    texture: GPUTexture,
    colour: { r: number; g: number; b: number; a: number }
): void {
    const encoder = device.createCommandEncoder({ label: 'clear' });
    encoder
        .beginRenderPass({
            colorAttachments: [
                {
                    view: texture.createView(),
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: colour,
                },
            ],
        })
        .end();
    device.queue.submit([encoder.finish()]);
}

/** Index of a channel in a texture of the given format, since bgra8unorm swaps R and B. */
function channelOffset(format: GPUTextureFormat, channel: 'r' | 'g' | 'b' | 'a'): number {
    const order = format.startsWith('bgra') ? ['b', 'g', 'r', 'a'] : ['r', 'g', 'b', 'a'];
    return order.indexOf(channel);
}

// ---------------------------------------------------------------------------
// (a) Device init and derived caps
// ---------------------------------------------------------------------------

let gpu: GpuContext;

test('initGpu succeeds in a secure context', async () => {
    const canvas = document.getElementById('gpu-canvas') as HTMLCanvasElement;
    canvas.width = 64;
    canvas.height = 64;

    const result = await initGpu(canvas);
    assert(!isGpuFailure(result), isGpuFailure(result) ? describeGpuFailure(result.error) : '');
    gpu = result;

    assert(gpu.device instanceof GPUDevice, 'expected a GPUDevice');
    assert(gpu.format.length > 0, 'expected a preferred canvas format');
});

test('granted limits satisfy every derived cap', () => {
    const limits = gpu.device.limits;
    const caps = deriveCaps(gpu.device);

    // The caps must report what the device granted, not the spec default.
    assert(
        caps.maxStorageBufferBindingSize === limits.maxStorageBufferBindingSize,
        'caps.maxStorageBufferBindingSize must mirror device.limits'
    );
    assert(
        caps.maxTextureDimension2D === limits.maxTextureDimension2D,
        'caps.maxTextureDimension2D must mirror device.limits'
    );
    assert(
        caps.maxWorkgroupsPerDimension === limits.maxComputeWorkgroupsPerDimension,
        'caps.maxWorkgroupsPerDimension must come from device.limits, not a hardcoded 65535'
    );

    // Every ceiling must be allocatable on this device.
    const agentBytes = caps.slimeMoldAgents * SLIME_MOLD_AGENT_STRIDE;
    assert(
        agentBytes <= limits.maxStorageBufferBindingSize,
        `slime mold agent buffer ${agentBytes} B exceeds the ${limits.maxStorageBufferBindingSize} B binding limit`
    );
    assert(
        agentBytes <= limits.maxBufferSize,
        `slime mold agent buffer ${agentBytes} B exceeds maxBufferSize`
    );
    assert(
        caps.grayScottMaxDim <= caps.maxTextureDimension2D &&
            caps.flowTrailMaxDim <= caps.maxTextureDimension2D,
        'texture ceilings exceed maxTextureDimension2D'
    );

    // Flow's trail map becomes atomic u32 x4 per texel in M12.
    const trailBytes = caps.flowTrailMaxDim * caps.flowTrailMaxDim * 16;
    assert(
        trailBytes <= limits.maxStorageBufferBindingSize,
        `flow trail buffer ${trailBytes} B exceeds the binding limit`
    );

    // Everything else must be small enough not to need thought.
    for (const [name, count, stride] of [
        ['flowPool', caps.flowPool, 32],
        ['particleLife', caps.particleLife, 24],
        ['pellets', caps.pellets, 48],
        ['primordial', caps.primordial, 32],
    ] as const) {
        assert(
            count * stride <= limits.maxStorageBufferBindingSize,
            `${name} at ${count} exceeds the binding limit`
        );
    }
});

test('a maximum-size storage buffer actually allocates', async () => {
    const caps = deriveCaps(gpu.device);
    const size = align(caps.slimeMoldAgents * SLIME_MOLD_AGENT_STRIDE, 4);

    // SwiftShader is a software rasteriser with a far smaller budget than a real
    // GPU, so only prove the arithmetic is allocatable up to a sane test size.
    const probe = Math.min(size, 64 * 1024 * 1024);
    gpu.device.pushErrorScope('out-of-memory');
    const buffer = createStorageBuffer(gpu.device, probe, { label: 'cap probe' });
    const oom = await gpu.device.popErrorScope();
    assert(oom === null, `allocating ${probe} B failed: ${oom?.message}`);
    buffer.destroy();
});

test('the 2D dispatch fold covers oversized workloads', () => {
    const max = deriveCaps(gpu.device).maxWorkgroupsPerDimension;

    for (const total of [1, max - 1, max, max + 1, max * 3 + 7]) {
        const [x, y] = foldDispatch(total, max);
        assert(x <= max && y <= max, `fold produced ${x}x${y}, over the ${max} limit`);
        assert(x * y >= total, `fold produced ${x}x${y} = ${x * y}, short of ${total}`);
    }
});

test('DPR is clamped to 2 and to maxTextureDimension2D', () => {
    const maxDim = deriveCaps(gpu.device).maxTextureDimension2D;

    // A 4K display at 3x DPR is the case that allocates ~1.2 GB unclamped.
    const [w, h] = computeBackingSize(3840, 2160, 3, maxDim);
    assert(
        w === 3840 * MAX_DEVICE_PIXEL_RATIO && h === 2160 * MAX_DEVICE_PIXEL_RATIO,
        `expected the DPR clamp to give 7680x4320, got ${w}x${h}`
    );

    // And the max-dimension clamp must preserve aspect ratio.
    const [cw, ch] = computeBackingSize(maxDim * 2, maxDim, 1, maxDim);
    assert(cw <= maxDim && ch <= maxDim, `clamp failed: ${cw}x${ch} exceeds ${maxDim}`);
    assertClose(cw / ch, 2, 0.01, 'aspect ratio after clamping');

    const [dw, dh] = computeBackingSize(0, 0, 2, maxDim);
    assert(dw >= 1 && dh >= 1, 'a zero-sized canvas must not produce a zero-sized texture');
});

// ---------------------------------------------------------------------------
// (b) The whole WGSL corpus compiles
// ---------------------------------------------------------------------------

/**
 * Shaders that legitimately do not compile yet, each owed to a specific
 * milestone. Asserted exactly, in the same spirit as the ledger in
 * test/wgsl/lint.test.ts: fixing one without removing it here fails the test,
 * and a new failure fails it too.
 *
 * Note this is *shorter* than the WGSL lint ledger, because shader-module
 * compilation does not validate storage-texture access modes — the four
 * `read_write` rgba8/rgba16 declarations compile fine here and are only
 * rejected at pipeline creation.
 */
const KNOWN_COMPILE_FAILURES = new Set([
    // Remediation (e) — M10 Pellets. `array<atomic<u32>>` in a `read` binding;
    // the fix is a plain `array<u32>` view of the same buffer.
    'pellets/shaders/physics_compute.wgsl',
]);

/**
 * Shaders that are *consumers of a function library* rather than standalone
 * modules, mapped to the library they are concatenated behind.
 *
 * `vectors/shaders/noise.wgsl` declares no bindings and no entry point precisely
 * so it can be prepended to a consumer's source, which is how M5 gets an include
 * mechanism the corpus does not have. Compiled on its own a consumer is an
 * unresolved `noise_sample` — a property of the arrangement, not a defect — so
 * they are compiled here exactly as `vectorsVertexShaderSource()` compiles them.
 *
 * Asserted in both directions below: a listed shader that compiles alone no
 * longer needs the entry, and an entry whose concatenation fails is a real
 * error.
 */
const CONCATENATED_SHADERS = new Map<string, string>([
    ['vectors/shaders/line_instanced.wgsl', 'vectors/shaders/noise.wgsl'],
]);

/** The source the app actually hands `createShaderModule` for this path. */
function moduleSourceFor(path: string): string {
    const library = CONCATENATED_SHADERS.get(path);
    return library ? `${getShader(library)}\n${getShader(path)}` : getShader(path);
}

async function compileErrors(label: string, code: string): Promise<GPUCompilationMessage[]> {
    const module = gpu.device.createShaderModule({ label, code });
    const info = await module.getCompilationInfo();
    return info.messages.filter((message) => message.type === 'error');
}

test('all WGSL modules compile with zero errors', async () => {
    const paths = shaderPathsNow();
    assert(paths.length >= 60, `expected the full corpus, found only ${paths.length} shaders`);

    const failures: string[] = [];
    const failedPaths = new Set<string>();

    for (const path of paths) {
        const module = gpu.device.createShaderModule({ label: path, code: moduleSourceFor(path) });
        const info = await module.getCompilationInfo();
        for (const message of info.messages) {
            if (message.type !== 'error') continue;
            failedPaths.add(path);
            if (KNOWN_COMPILE_FAILURES.has(path)) continue;
            failures.push(`${path}:${message.lineNum}:${message.linePos}  ${message.message}`);
        }
    }

    assert(
        failures.length === 0,
        `${failures.length} unexpected WGSL compile errors across ${paths.length} shaders:\n${failures.join('\n')}`
    );

    const fixed = [...KNOWN_COMPILE_FAILURES].filter((path) => !failedPaths.has(path));
    assert(
        fixed.length === 0,
        `these shaders now compile — remove them from KNOWN_COMPILE_FAILURES: ${fixed.join(', ')}`
    );
});

test('the concatenated shaders need their library, and only their library', async () => {
    for (const [path, library] of CONCATENATED_SHADERS) {
        const alone = await compileErrors(`${path} (alone)`, getShader(path));
        assert(
            alone.length > 0,
            `${path} compiles on its own — it no longer needs ${library} prepended, ` +
                `so remove it from CONCATENATED_SHADERS`
        );

        const library_alone = await compileErrors(`${library} (alone)`, getShader(library));
        assert(
            library_alone.length === 0,
            `${library} must stay a self-contained function library: ${library_alone[0]?.message}`
        );
    }
});

test('createShaderModuleChecked throws on bad WGSL', async () => {
    let threw = false;
    try {
        await createShaderModuleChecked(gpu.device, {
            label: 'deliberately broken',
            code: 'fn main() { this is not wgsl }',
        });
    } catch {
        threw = true;
    }
    assert(threw, 'a syntax error must surface as a thrown error, not a silent module');
});

// ---------------------------------------------------------------------------
// (c) Render and read pixels back
// ---------------------------------------------------------------------------

test('clear to a known colour survives copyTextureToBuffer + mapAsync', async () => {
    const texture = createTexture2d(gpu.device, 32, 24, {
        label: 'clear target',
        format: 'rgba8unorm',
    });
    clearTo(gpu.device, texture, { r: 0.25, g: 0.5, b: 0.75, a: 1 });

    const pixels = await readTexturePixels(gpu.device, texture);
    assert(pixels.length === 32 * 24 * 4, `readback length ${pixels.length}`);

    // Build the expected image and compare with MAE rather than exact equality:
    // unorm8 quantisation of 0.25/0.5/0.75 is off by fractions of a step.
    const expected = new Uint8Array(pixels.length);
    for (let i = 0; i < expected.length; i += 4) {
        expected[i] = 64;
        expected[i + 1] = 128;
        expected[i + 2] = 191;
        expected[i + 3] = 255;
    }

    const mae = meanAbsoluteError(pixels, expected);
    assert(mae <= 1.5, `clear colour readback MAE ${mae.toFixed(3)} exceeds 1.5`);
    assert(!hasNonFinite(pixels), 'readback contained non-finite values');

    texture.destroy();
});

test('row padding is unwound for a width that is not 64-aligned', async () => {
    // 17 px * 4 B = 68 B, padded to 256 B per row — the case that silently
    // returns garbage if bytesPerRow is not accounted for.
    const texture = createTexture2d(gpu.device, 17, 5, { format: 'rgba8unorm' });
    clearTo(gpu.device, texture, { r: 1, g: 0, b: 0, a: 1 });

    const pixels = await readTexturePixels(gpu.device, texture);
    assert(pixels.length === 17 * 5 * 4, `expected a tight 17x5 buffer, got ${pixels.length}`);
    for (let i = 0; i < pixels.length; i += 4) {
        assert(pixels[i] === 255 && pixels[i + 1] === 0, `row unpadding wrong at byte ${i}`);
    }
    texture.destroy();
});

// ---------------------------------------------------------------------------
// Resource helpers
// ---------------------------------------------------------------------------

test('ping-pong textures alternate and never hand out the same view twice', () => {
    const pair = new PingPongTextures(gpu.device, 8, 8, 'rgba8unorm', { label: 'test pair' });

    assert(pair.currentIndex === 0, 'a fresh pair starts on A');
    assert(pair.currentView !== pair.inactiveView, 'read and write views must differ');
    assert(pair.select('a', 'b') === 'a', 'select must follow the current index');

    const firstRead = pair.currentView;
    pair.swap();
    assert(pair.currentIndex === 1, 'swap must flip the index');
    assert(pair.currentView !== firstRead, 'after a swap the read view is the old write view');
    assert(pair.select('a', 'b') === 'b', 'select must follow the swap');

    pair.swap();
    assert(pair.currentView === firstRead, 'two swaps return to the start');

    pair.destroy();
});

test('the bind-group-layout cache returns one layout per shape', () => {
    const cache = new BindGroupLayoutCache(gpu.device);
    const shape = (): GPUBindGroupLayoutEntry[] => [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ];

    const first = cache.get(shape(), 'a');
    const second = cache.get(shape().reverse(), 'b');
    assert(first === second, 'identical shapes, in any order, must share one layout');

    const different = cache.get(
        [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }],
        'c'
    );
    assert(different !== first, 'a different shape must get its own layout');
    assert(cache.size === 2, `expected 2 cached layouts, got ${cache.size}`);
});

test('buffer readback round-trips exactly', async () => {
    const source = new Uint32Array([1, 2, 3, 0xdeadbeef, 0, 0xffffffff]);
    const buffer = createStorageBuffer(gpu.device, source.byteLength, { label: 'roundtrip' });
    gpu.device.queue.writeBuffer(buffer, 0, source);

    const back = new Uint32Array(await readBuffer(gpu.device, buffer, source.byteLength));
    for (let i = 0; i < source.length; i++) {
        assert(back[i] === source[i], `word ${i}: expected ${source[i]}, got ${back[i]}`);
    }
    buffer.destroy();
});

// ---------------------------------------------------------------------------
// Shared post-processing
// ---------------------------------------------------------------------------

test('average colour of a flat texture matches that colour', async () => {
    const texture = createTexture2d(gpu.device, 32, 32, { format: 'rgba8unorm' });
    clearTo(gpu.device, texture, { r: 0.5, g: 0.25, b: 0.75, a: 1 });

    const average = new AverageColor(gpu.device, 'test');
    const result = await average.compute(texture, texture.createView());

    assert(result !== null, 'a fully opaque texture must produce an average');
    // The shader truncates rather than rounds (u32(c * 255.0)), so allow a step.
    assertClose(result![0], 0.5, 0.01, 'average red');
    assertClose(result![1], 0.25, 0.01, 'average green');
    assertClose(result![2], 0.75, 0.01, 'average blue');

    average.destroy();
    texture.destroy();
});

test('average colour of a fully transparent texture is null', async () => {
    const texture = createTexture2d(gpu.device, 16, 16, { format: 'rgba8unorm' });
    clearTo(gpu.device, texture, { r: 0, g: 0, b: 0, a: 0 });

    const average = new AverageColor(gpu.device, 'test empty');
    const result = await average.compute(texture, texture.createView());
    assert(result === null, 'no visible pixels must mean no average, not a divide by zero');

    average.destroy();
    texture.destroy();
});

// ---------------------------------------------------------------------------
// Main menu — M2's visible result
// ---------------------------------------------------------------------------

test('the main menu renders a varied, finite image', async () => {
    const sim = await MainMenuSimulation.create(gpu);
    const target = gpu.device.createTexture({
        label: 'main menu target',
        size: { width: 64, height: 64 },
        format: gpu.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });

    sim.renderFrame(target.createView(), 1 / 60);
    const pixels = await readTexturePixels(gpu.device, target);

    assert(!hasNonFinite(pixels), 'main menu produced non-finite pixels');
    assert(!isUniform(pixels), 'main menu produced a flat image — the FBM did not run');

    // The LUT never reaches full black at either end, and the shader is opaque.
    const alphaOffset = channelOffset(gpu.format, 'a');
    for (let i = 0; i < pixels.length; i += 4) {
        assert(pixels[i + alphaOffset] === 255, `pixel ${i / 4} is not opaque`);
    }

    sim.destroy();
    target.destroy();
});

test('the main menu advances with time and holds still when paused', async () => {
    const sim = await MainMenuSimulation.create(gpu);
    const target = gpu.device.createTexture({
        size: { width: 48, height: 48 },
        format: gpu.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const view = target.createView();

    sim.renderFrame(view, 0);
    const first = await readTexturePixels(gpu.device, target);

    sim.renderFramePaused(view);
    const paused = await readTexturePixels(gpu.device, target);
    assert(
        meanAbsoluteError(first, paused) === 0,
        'renderFramePaused must not advance the animation'
    );

    // A big step, because the animation runs at 0.03x real time.
    sim.renderFrame(view, 30);
    const later = await readTexturePixels(gpu.device, target);
    assert(meanAbsoluteError(first, later) > 1, 'renderFrame must advance the animation with dt');

    sim.destroy();
    target.destroy();
});

test('a reversed colour scheme changes the output', async () => {
    const sim = await MainMenuSimulation.create(gpu);
    const target = gpu.device.createTexture({
        size: { width: 32, height: 32 },
        format: gpu.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const view = target.createView();

    const lut = defaultLut();
    sim.updateColorScheme(lut, false);
    sim.renderFramePaused(view);
    const forward = await readTexturePixels(gpu.device, target);

    sim.updateColorScheme(lut, true);
    sim.renderFramePaused(view);
    const reversed = await readTexturePixels(gpu.device, target);

    assert(meanAbsoluteError(forward, reversed) > 1, 'reversing the LUT must change the image');

    // And the reversal itself must be an involution.
    const twice = reverseLut(reverseLut(lut));
    for (let i = 0; i < lut.length; i++) {
        assert(twice[i] === lut[i], `reverseLut is not an involution at ${i}`);
    }

    sim.destroy();
    target.destroy();
});

test('create/destroy x20 leaves the device healthy', async () => {
    for (let i = 0; i < 20; i++) {
        const sim = await MainMenuSimulation.create(gpu);
        sim.destroy();
        // destroy() must be idempotent — the host calls it on both teardown
        // paths (mode switch and page unload).
        sim.destroy();
    }

    gpu.device.pushErrorScope('validation');
    const probe = createStorageBuffer(gpu.device, 256, { label: 'post-churn probe' });
    const error = await gpu.device.popErrorScope();
    assert(error === null, `device unhealthy after 20 create/destroy cycles: ${error?.message}`);
    probe.destroy();
});

test('post-processing with a zero-radius blur is a faithful pass-through', async () => {
    const post = new PostProcessing(gpu.device, 64, 64, gpu.format);
    const sim = await MainMenuSimulation.create(gpu);

    // Render the menu into the chain's intermediate texture, then run the blur
    // disabled: blur_filter.wgsl short-circuits to a plain sample, so the output
    // must match the input up to one round of bilinear resampling.
    sim.renderFramePaused(post.intermediateView);

    const encoder = gpu.device.createCommandEncoder({ label: 'blur' });
    post.encode(encoder, post.outputView, { ...defaultPostProcessingState().blurFilter });
    gpu.device.queue.submit([encoder.finish()]);

    const blurred = await readTexturePixels(gpu.device, post.output);
    assert(!hasNonFinite(blurred), 'blur produced non-finite pixels');
    assert(!isUniform(blurred), 'blur pass-through produced a flat image');

    post.resize(32, 32);
    assert(post.width === 32 && post.height === 32, 'resize must resize');

    sim.destroy();
    post.destroy();
});

// ---------------------------------------------------------------------------
// Moiré — M3
// ---------------------------------------------------------------------------

/** A tiny offscreen colour target in the canvas format, plus its view. */
function renderTarget(size: number, label: string): [GPUTexture, GPUTextureView] {
    const texture = gpu.device.createTexture({
        label,
        size: { width: size, height: size },
        format: gpu.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    return [texture, texture.createView()];
}

interface ChannelStats {
    mean: number;
    min: number;
    max: number;
    /** Population standard deviation, in 0..255 units. */
    deviation: number;
}

/** Statistics over one channel, which is how "is it still varied?" is asked. */
function channelStats(pixels: Uint8Array, offset: number): ChannelStats {
    let total = 0;
    let min = 255;
    let max = 0;
    let count = 0;

    for (let i = offset; i < pixels.length; i += 4) {
        const v = pixels[i];
        total += v;
        if (v < min) min = v;
        if (v > max) max = v;
        count++;
    }

    const mean = total / count;
    let variance = 0;
    for (let i = offset; i < pixels.length; i += 4) {
        variance += (pixels[i] - mean) ** 2;
    }
    return { mean, min, max, deviation: Math.sqrt(variance / count) };
}

/** A 64x64 PNG split black|white, so a greyscale upload is unmistakable. */
async function splitImageFile(size: number): Promise<File> {
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(size / 2, 0, size / 2, size);

    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return new File([blob], 'split.png', { type: 'image/png' });
}

test('moiré constructs and tears down with no validation error', async () => {
    gpu.device.pushErrorScope('validation');

    const sim = await MoireSimulation.create(gpu);
    const [target, view] = renderTarget(48, 'moire validation target');
    sim.renderFrame(view, 1 / 60);
    sim.renderFramePaused(view);
    sim.resize(96, 96);
    sim.renderFrame(view, 1 / 60);
    sim.destroy();
    target.destroy();

    const error = await gpu.device.popErrorScope();
    assert(error === null, `moiré produced a validation error: ${error?.message}`);
});

test('moiré settings and state round-trip through the simulation', async () => {
    const sim = await MoireSimulation.create(gpu);

    assert(
        JSON.stringify(sim.getSettings()) === JSON.stringify(defaultMoireSettings()),
        'a fresh simulation must report Settings::default()'
    );

    sim.updateSetting('base_freq', 33);
    sim.updateSetting('generator_type', 'radial');
    assert(sim.getSettings().base_freq === 33, 'base_freq did not stick');
    assert(sim.getSettings().generator_type === 'Radial', 'generator_type did not stick');

    // Applying a partial preset fills the rest from the defaults, exactly as
    // `Settings { base_freq: 30.0, ..Settings::default() }` does.
    sim.applySettings({ base_freq: 30, moire_amount: 0.8 });
    const applied = sim.getSettings();
    assert(applied.base_freq === 30, 'applySettings dropped an override');
    assert(applied.generator_type === 'Linear', 'applySettings must reset unnamed fields');
    assert(applied.curl === defaultMoireSettings().curl, 'applySettings lost a default');

    sim.updateState('color_scheme_name', 'MATPLOTLIB_cubehelix');
    const state = sim.getState();
    assert(state.color_scheme_name === 'MATPLOTLIB_cubehelix', 'state did not stick');
    assert(typeof state.time === 'number', 'state must carry the clock');
    assert(
        Array.isArray(state.camera_position) && state.camera_position.length === 2,
        'state must carry the camera position, as moire/state.rs does'
    );

    let threw = false;
    try {
        sim.updateState('not_a_state', 1);
    } catch {
        threw = true;
    }
    assert(threw, 'an unknown state name must reject, as the Rust does');

    sim.destroy();
});

test('moiré renders a varied, finite, deterministic image', async () => {
    const [target, view] = renderTarget(64, 'moire target');

    const run = async (): Promise<Uint8Array> => {
        const sim = await MoireSimulation.create(gpu);
        // Fixed dt, and nothing in the pipeline is seeded from a clock, so two
        // runs of the same length must agree.
        for (let i = 0; i < 8; i++) sim.renderFrame(view, 1 / 60);
        const pixels = await readTexturePixels(gpu.device, target);
        sim.destroy();
        return pixels;
    };

    const first = await run();
    assert(!hasNonFinite(first), 'moiré produced non-finite pixels');
    assert(!isUniform(first), 'moiré produced a flat image — the compute pass did nothing');

    const alpha = channelStats(first, channelOffset(gpu.format, 'a'));
    assert(alpha.min === 255, `moiré must be opaque; found alpha down to ${alpha.min}`);

    // "Varied" as a number: a moiré field at base_freq 20 across 64 px has
    // several periods in view, so the spread is large, not marginal.
    const red = channelStats(first, channelOffset(gpu.format, 'r'));
    assert(red.deviation > 4, `image is nearly flat: red deviation ${red.deviation.toFixed(2)}`);
    assert(red.max - red.min > 32, `image has almost no range: ${red.min}..${red.max}`);

    const second = await run();
    const mae = meanAbsoluteError(first, second);
    // Tolerance rather than equality: SwiftShader's float ordering is its own,
    // and a hash here would tell you nothing when it failed on real hardware.
    assert(mae <= 1, `two identical runs diverged by MAE ${mae.toFixed(3)}`);

    target.destroy();
});

test('moiré advection feedback stays bounded over 40 frames', async () => {
    const [target, view] = renderTarget(64, 'moire feedback target');

    // Two configurations: the shipping defaults, and the hardest case the loop
    // can be driven to while still receiving new input. compute.wgsl:307 makes
    // the new-pattern weight `1 - advect_strength * 1.2`, so 0.8 leaves only
    // 4% of each frame as fresh pattern against 96% * decay of feedback — with
    // decay at 1.0 that is as close to unity gain as the shader gets.
    // (Above 1/1.2 the weight goes negative; see the next test.)
    for (const [label, overrides] of [
        ['defaults', {}],
        ['near unity gain', { advect_strength: 0.8, decay: 1.0, speed: 1.0, curl: 1.0 }],
    ] as const) {
        const sim = await MoireSimulation.create(gpu);
        sim.applySettings({ ...defaultMoireSettings(), ...overrides });

        let previousMean = -1;
        for (let frame = 0; frame < 40; frame++) {
            sim.renderFrame(view, 1 / 60);

            // Sample partway through as well as at the end: a run that ends
            // plausibly can still have saturated to white in the middle.
            if (frame !== 19 && frame !== 39) continue;

            const pixels = await readTexturePixels(gpu.device, target);
            assert(!hasNonFinite(pixels), `${label}: non-finite pixels at frame ${frame}`);
            assert(!isUniform(pixels), `${label}: collapsed to a flat image at frame ${frame}`);

            const red = channelStats(pixels, channelOffset(gpu.format, 'r'));
            assert(
                red.mean > 2 && red.mean < 253,
                `${label}: feedback ran away at frame ${frame}, mean ${red.mean.toFixed(1)}`
            );
            assert(
                red.deviation > 1,
                `${label}: detail washed out at frame ${frame}, deviation ${red.deviation.toFixed(2)}`
            );
            previousMean = red.mean;
        }
        assert(previousMean >= 0, `${label}: never sampled`);
        sim.destroy();
    }

    target.destroy();
});

/**
 * Pins a defect inherited from the Rust shader, in the same spirit as the
 * ledger in test/wgsl/lint.test.ts: it is asserted rather than tolerated, so
 * whoever changes the blend has to come here and say so.
 *
 * compute.wgsl:306-313 computes
 *
 *     advection_mix      = advect_strength * 1.2
 *     new_pattern_weight = 1 - advection_mix
 *     final_color        = nn_color * new_pattern_weight + prev * advection_mix * decay
 *
 * so above advect_strength = 1/1.2 the freshly generated pattern is subtracted
 * rather than added. The feedback texture starts at zero, the negative term
 * clamps to zero, and nothing ever seeds the loop — the canvas is black and
 * stays black. `MoireMode.svelte` puts the Flow Strength slider's maximum at
 * **5.0**, so six sevenths of its range produce a black screen.
 *
 * Not fixed here: every candidate fix (clamping the mix, flooring the new
 * weight, changing the 1.2) alters the picture at *every* setting, which is a
 * visual-parity decision for M14 rather than a mechanical port.
 */
test('moiré blacks out above advect_strength 1/1.2 — known upstream defect', async () => {
    const sim = await MoireSimulation.create(gpu);
    const [target, view] = renderTarget(32, 'moire blackout target');

    sim.applySettings({ ...defaultMoireSettings(), advect_strength: 1.0 });
    for (let i = 0; i < 10; i++) sim.renderFrame(view, 1 / 60);

    const pixels = await readTexturePixels(gpu.device, target);
    const red = channelStats(pixels, channelOffset(gpu.format, 'r'));
    assert(
        red.max === 0,
        `the blackout no longer reproduces (red up to ${red.max}) — the blend in ` +
            `moire/compute.wgsl changed; update this test and WEB_PORT.md together`
    );

    // And it is genuinely the blend, not a broken pipeline: the same simulation
    // draws a picture again as soon as the weight is non-negative.
    sim.applySettings({ ...defaultMoireSettings(), advect_strength: 0.5 });
    for (let i = 0; i < 10; i++) sim.renderFrame(view, 1 / 60);
    const recovered = await readTexturePixels(gpu.device, target);
    assert(!isUniform(recovered), 'lowering advect_strength must bring the pattern back');

    sim.destroy();
    target.destroy();
});

test('moiré paused redraw shows the frame just rendered, not the one before', async () => {
    const sim = await MoireSimulation.create(gpu);
    const [target, view] = renderTarget(48, 'moire paused target');

    // A big time step, so consecutive frames are obviously different: the whole
    // point is to catch a ping-pong that displays the wrong half of the pair,
    // which is what moire/simulation.rs:1013 actually does.
    sim.updateSetting('speed', 3);

    sim.renderFrame(view, 0.2);
    sim.renderFrame(view, 0.2);
    const previous = await readTexturePixels(gpu.device, target);

    sim.renderFrame(view, 0.2);
    const latest = await readTexturePixels(gpu.device, target);
    assert(
        meanAbsoluteError(previous, latest) > 1,
        'the two frames are too similar for this test to mean anything'
    );

    sim.renderFramePaused(view);
    const paused = await readTexturePixels(gpu.device, target);
    assert(meanAbsoluteError(paused, latest) <= 1, 'a paused redraw must repeat the newest frame');

    sim.destroy();
    target.destroy();
});

test('moiré tiles the infinite canvas as the zoom changes', async () => {
    const sim = await MoireSimulation.create(gpu);
    const [target, view] = renderTarget(64, 'moire zoom target');

    sim.renderFrame(view, 1 / 60);
    const atUnitZoom = await readTexturePixels(gpu.device, target);

    // Zooming out has to bring more tiles into view; at 0.25 the visible world
    // is 8 units across, which is 4 copies of the pattern per axis.
    assert(calculateTileCount(0.25) >= 5, 'tile count must grow as the camera zooms out');
    const camera = (sim as unknown as { camera: { zoomBy(d: number): void } }).camera;
    for (let i = 0; i < 12; i++) camera.zoomBy(-1);
    for (let i = 0; i < 30; i++) sim.renderFrame(view, 1 / 60);

    const zoomedOut = await readTexturePixels(gpu.device, target);
    assert(!hasNonFinite(zoomedOut), 'zooming out produced non-finite pixels');
    assert(!isUniform(zoomedOut), 'zooming out produced a flat image');
    assert(
        meanAbsoluteError(atUnitZoom, zoomedOut) > 1,
        'zooming out did not change what is drawn'
    );

    sim.destroy();
    target.destroy();
});

test('moiré image mode uploads a greyscale image and uses it', async () => {
    const [target, view] = renderTarget(64, 'moire image target');

    const render = async (withImage: boolean): Promise<Uint8Array> => {
        const sim = await MoireSimulation.create(gpu);
        // No advection, so a single frame is the pattern itself rather than a
        // blend with whatever the feedback texture happened to hold.
        sim.updateSetting('advect_strength', 0);
        sim.updateSetting('image_mode_enabled', true);
        sim.updateSetting('image_interference_mode', 'Replace');
        sim.updateSetting('image_invert_tone', false);
        sim.updateSetting('image_fit_mode', 'Stretch');

        if (withImage) {
            await sim.loadImage(await splitImageFile(64));
            assert(sim.hasImage, 'loadImage must leave an image texture bound');
        }

        sim.renderFrame(view, 1 / 60);
        const pixels = await readTexturePixels(gpu.device, target);
        sim.destroy();
        return pixels;
    };

    const without = await render(false);
    const withImage = await render(true);

    assert(!hasNonFinite(withImage), 'the image path produced non-finite pixels');
    assert(
        meanAbsoluteError(without, withImage) > 5,
        'loading an image in Replace mode changed nothing'
    );

    // The image is black on the left, white on the right, and Replace mode maps
    // that straight onto the LUT — so the two halves must differ markedly. The
    // tiled quad flips y, not x, so left stays left.
    const red = channelOffset(gpu.format, 'r');
    let left = 0;
    let right = 0;
    for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
            const value = withImage[(y * 64 + x) * 4 + red];
            if (x < 24) left += value;
            else if (x >= 40) right += value;
        }
    }
    const leftMean = left / (24 * 64);
    const rightMean = right / (24 * 64);
    assert(
        Math.abs(leftMean - rightMean) > 16,
        `the image's black|white split did not survive the upload: ` +
            `${leftMean.toFixed(1)} vs ${rightMean.toFixed(1)}`
    );

    target.destroy();
});

/*
 * Not tested here: rendering through a configured `GPUCanvasContext`.
 *
 * A single `context.getCurrentTexture()` in headless Chrome + SwiftShader drops
 * the Dawn instance for the whole page — every later `getCompilationInfo` then
 * rejects with "Instance dropped" and every later `createComputePipelineAsync`
 * with "A valid external Instance reference no longer exists", so one such call
 * would fail every test after it rather than just itself. Measured directly;
 * see WEB_PORT.md, M2's environment limitation, which this extends. The canvas
 * presentation path is therefore only checkable in a real browser.
 */

test('moiré create/destroy x20 leaves the resource ledger clean', async () => {
    // A leaked buffer per mode switch is invisible in a browser until the tab
    // OOMs on the twentieth navigation, so it has to be counted, not noticed.
    const ledger = new ResourceLedger();
    const instrumented: GpuContext = { ...gpu, device: instrumentDevice(gpu.device, ledger) };

    // Allocated on the *uninstrumented* device, so the test's own target does
    // not show up in the ledger it is asserting on.
    const churnTarget = gpu.device.createTexture({
        label: 'moire churn target',
        size: { width: 32, height: 32 },
        format: gpu.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const churnView = churnTarget.createView();

    for (let i = 0; i < 20; i++) {
        const sim = await MoireSimulation.create(instrumented);
        // Render as well as construct: a resource only created lazily on the
        // first frame would otherwise never be counted at all.
        sim.renderFrame(churnView, 1 / 60);
        sim.destroy();
        // destroy() is contractually idempotent — the host calls it on both
        // teardown paths — and must not double-count.
        sim.destroy();
    }

    const stats = ledger.stats();
    assert(
        stats.created >= 20 * 6,
        `expected at least six tracked objects per simulation, saw ${stats.created} over 20`
    );
    assert(
        stats.live === 0,
        `${stats.live} GPU objects leaked over 20 cycles: ${JSON.stringify(stats.byLabel)}`
    );

    gpu.device.pushErrorScope('validation');
    const probe = createStorageBuffer(gpu.device, 256, { label: 'post-moire probe' });
    const error = await gpu.device.popErrorScope();
    assert(error === null, `device unhealthy after 20 moiré cycles: ${error?.message}`);
    probe.destroy();
    churnTarget.destroy();
});

// ---------------------------------------------------------------------------
// Gray-Scott — M4
// ---------------------------------------------------------------------------

/**
 * The concentration field, read back and decoded.
 *
 * `readTexturePixels` is rgba8-only; the field is rgba16float, so the halves
 * are decoded here with the same routine the seeding path encodes with — which
 * means a bug in `encodeFloat16` cannot hide by cancelling out, because the
 * shader has read and rewritten every value in between.
 */
async function readField(texture: GPUTexture): Promise<{ u: Float32Array; v: Float32Array }> {
    const width = texture.width;
    const height = texture.height;
    const bytesPerRow = alignedBytesPerRow(width, 8);

    const staging = gpu.device.createBuffer({
        label: 'gray-scott field readback',
        size: bytesPerRow * height,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    const encoder = gpu.device.createCommandEncoder({ label: 'gray-scott field readback' });
    encoder.copyTextureToBuffer({ texture }, { buffer: staging, bytesPerRow }, { width, height });
    gpu.device.queue.submit([encoder.finish()]);

    await staging.mapAsync(GPUMapMode.READ);
    const halves = new Uint16Array(staging.getMappedRange());
    const stride = bytesPerRow / 2;

    const u = new Float32Array(width * height);
    const v = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const src = y * stride + x * 4;
            const dst = y * width + x;
            u[dst] = decodeFloat16(halves[src]);
            v[dst] = decodeFloat16(halves[src + 1]);
        }
    }

    staging.unmap();
    staging.destroy();
    return { u, v };
}

/** Both halves of a simulation's ping-pong pair, for the coherence assertions. */
function fieldPair(sim: GrayScottSimulation): readonly [GPUTexture, GPUTexture] {
    return (sim as unknown as { textures: { all: readonly [GPUTexture, GPUTexture] } }).textures
        .all;
}

function meanAbsDiff(a: Float32Array, b: Float32Array): number {
    assert(a.length === b.length, `field lengths differ: ${a.length} vs ${b.length}`);
    let total = 0;
    for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
    return total / a.length;
}

function maxAbsDiff(a: Float32Array, b: Float32Array): number {
    let worst = 0;
    for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
    return worst;
}

function spread(values: Float32Array): number {
    let min = Infinity;
    let max = -Infinity;
    for (const value of values) {
        if (value < min) min = value;
        if (value > max) max = value;
    }
    return max - min;
}

/** Round-trip through binary16, which is what storing a value in the field costs. */
function quantizeHalf(value: number): number {
    return decodeFloat16(encodeFloat16(value));
}

/**
 * A CPU implementation of `reaction_diffusion.wgsl::main`, with the mask
 * defaults (Disabled, so `mask_factor` is 1; UV Concentration, which scales the
 * feed rate by `0.5 + mask_influence * 0.5`) and adaptive timestep off.
 *
 * Independent of the GPU path in everything but the arithmetic itself: it reads
 * a whole field and writes a whole field, so it cannot reproduce a ping-pong
 * mistake, a missed workgroup, or a bind group pointing at the wrong texture.
 * Storage quantisation *is* modelled — every result goes through binary16, as
 * the texture does — because without it the two would separate on rounding
 * alone within a few steps and the comparison would mean nothing.
 */
function referenceSteps(
    start: { u: Float32Array; v: Float32Array },
    width: number,
    height: number,
    settings: GrayScottSettings,
    steps: number
): { u: Float32Array; v: Float32Array } {
    let u = Float32Array.from(start.u);
    let v = Float32Array.from(start.v);

    // mask_factor 1 (Disabled) * mask_strength 0.5, into the UVConcentration arm.
    const influence = 1.0 * defaultGrayScottState().mask_strength;
    const feed = settings.feed_rate * (0.5 + influence * 0.5);
    const kill = settings.kill_rate;
    const dt = settings.timestep;

    for (let step = 0; step < steps; step++) {
        const nextU = new Float32Array(u.length);
        const nextV = new Float32Array(v.length);

        for (let y = 0; y < height; y++) {
            const up = ((y - 1 + height) % height) * width;
            const down = ((y + 1) % height) * width;
            const row = y * width;

            for (let x = 0; x < width; x++) {
                const i = row + x;
                const left = row + ((x - 1 + width) % width);
                const right = row + ((x + 1) % width);

                const lapU = -4 * u[i] + u[left] + u[right] + u[up + x] + u[down + x];
                const lapV = -4 * v[i] + v[left] + v[right] + v[up + x] + v[down + x];
                const reaction = u[i] * v[i] * v[i];

                const du = settings.diffusion_rate_u * lapU - reaction + feed * (1 - u[i]);
                const dv = settings.diffusion_rate_v * lapV + reaction - (kill + feed) * v[i];

                nextU[i] = quantizeHalf(Math.min(1, Math.max(0, u[i] + du * dt)));
                nextV[i] = quantizeHalf(Math.min(1, Math.max(0, v[i] + dv * dt)));
            }
        }

        u = nextU;
        v = nextV;
    }

    return { u, v };
}

/** The stable configuration the reference comparison runs at; see that test. */
function stableSettings(): GrayScottSettings {
    return { ...defaultGrayScottSettings(), timestep: 1.0 };
}

test('gray-scott constructs and tears down with no validation error', async () => {
    gpu.device.pushErrorScope('validation');

    const sim = await GrayScottSimulation.create(gpu);
    const [target, view] = renderTarget(48, 'gray-scott validation target');

    sim.renderFrame(view, 1 / 60);
    sim.renderFramePaused(view);
    sim.seedRandomNoise(7);
    sim.handleMouseInteraction(0, 0, 0);
    sim.reset();
    sim.resize(320, 320);
    sim.renderFrame(view, 1 / 60);
    sim.destroy();
    target.destroy();

    const error = await gpu.device.popErrorScope();
    assert(error === null, `gray-scott produced a validation error: ${error?.message}`);
});

test('the f16 encoder round-trips through a real rgba16float texture', async () => {
    // Values chosen for what they exercise: the seeding constants, a subnormal,
    // a half-way case that round-to-nearest-even must not bias, and an
    // overflow that must become an infinity rather than wrapping to zero.
    const values = [0, 1, 0.5, 0.99, 0.0625, 2 ** -20, -0.75, 65504, 100000];

    for (const value of values) {
        const back = decodeFloat16(encodeFloat16(value));
        if (value === 100000) {
            assert(back === Infinity, `${value} must saturate to Infinity, got ${back}`);
            continue;
        }
        // Half has an 11-bit significand, so the relative error bound is 2^-11.
        const tolerance = Math.max(Math.abs(value) * 2 ** -11, 2 ** -24);
        assertClose(back, value, tolerance, `binary16 round-trip of ${value}`);
    }

    // And through the GPU, which is the claim that actually matters: the bytes
    // this encoder produces are what an rgba16float texel means.
    const width = 4;
    const height = 2;
    const texture = createTexture2d(gpu.device, width, height, {
        label: 'f16 probe',
        format: 'rgba16float',
    });

    const texels = new Uint16Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        texels[i * 4] = encodeFloat16(i / 8);
        texels[i * 4 + 1] = encodeFloat16(1 - i / 8);
    }
    gpu.device.queue.writeTexture(
        { texture },
        texels,
        { bytesPerRow: width * 8, rowsPerImage: height },
        { width, height, depthOrArrayLayers: 1 }
    );

    const { u, v } = await readField(texture);
    for (let i = 0; i < width * height; i++) {
        assertClose(u[i], i / 8, 1e-3, `texel ${i} red`);
        assertClose(v[i], 1 - i / 8, 1e-3, `texel ${i} green`);
    }

    texture.destroy();
});

/**
 * Pins remediation (1). The Rust uploads 16-byte `UVPair`s with
 * `bytes_per_row: width * 16` into an 8-byte-per-texel texture, so `u = 1.0`
 * arrives as roughly `u = 0, v = 1.875` in even columns and `(0,0,0,0)` in odd
 * ones — a field that is *entirely* wrong, not subtly so. If this test ever
 * reports u = 0 in half the columns, the seeding has been "restored" to the
 * Rust's byte layout and the divergence note in `grayScottSeedTexels` needs
 * revisiting rather than the test.
 */
test('gray-scott seeds U=1, V=0 with a live centre disc', async () => {
    const sim = await GrayScottSimulation.create(gpu);
    const [width, height] = sim.textureSize;
    const { u, v } = await readField(sim.currentField);

    const centerX = Math.trunc(width / 2);
    const centerY = Math.trunc(height / 2);
    const far = (centerY - 3 * SEED_DISC_RADIUS) * width + 4;

    assertClose(u[far], 1, 1e-3, 'U away from the disc');
    assertClose(v[far], 0, 1e-3, 'V away from the disc');
    assert(u[0] === u[1], 'even and odd columns must agree — the f16 stride bug is back');

    const middle = centerY * width + centerX;
    assertClose(u[middle], 0.5, 1e-3, 'U at the centre of the disc');
    assertClose(v[middle], 0.99, 1e-2, 'V at the centre of the disc');

    // And exactly the disc: nothing outside the seeded square is disturbed.
    let seeded = 0;
    for (let i = 0; i < v.length; i++) if (v[i] > 0) seeded++;
    const square = (2 * SEED_DISC_RADIUS + 1) ** 2;
    assert(
        seeded > 0 && seeded < square,
        `expected the seed inside the ${square}-texel square, found ${seeded} live texels`
    );

    // The pair starts coherent: both halves hold the same initial condition.
    const [a, b] = fieldPair(sim);
    const fieldA = await readField(a);
    const fieldB = await readField(b);
    assert(meanAbsDiff(fieldA.u, fieldB.u) === 0, 'the two textures must start identical');

    sim.destroy();
});

test('gray-scott settings and state round-trip through the simulation', async () => {
    const sim = await GrayScottSimulation.create(gpu);

    assert(
        JSON.stringify(sim.getSettings()) === JSON.stringify(defaultGrayScottSettings()),
        'a fresh simulation must report Settings::default()'
    );

    sim.updateSetting('feed_rate', 0.04);
    // One of the three names the Rust silently dropped on the floor.
    sim.updateSetting('max_timestep', 3.5);
    assert(sim.getSettings().feed_rate === 0.04, 'feed_rate did not stick');
    assert(sim.getSettings().max_timestep === 3.5, 'max_timestep did not stick');

    sim.applySettings({ feed_rate: 0.03, kill_rate: 0.06 });
    const applied = sim.getSettings();
    assert(applied.feed_rate === 0.03, 'applySettings dropped an override');
    assert(
        applied.max_timestep === defaultGrayScottSettings().max_timestep,
        'applySettings must reset unnamed fields'
    );

    sim.updateState('mask_pattern', 'Radial Gradient');
    sim.updateState('current_color_scheme', 'MATPLOTLIB_prism');
    const state = sim.getState();
    assert(state.mask_pattern === 'Radial Gradient', 'mask_pattern did not stick');
    assert(state.current_color_scheme === 'MATPLOTLIB_prism', 'the scheme name did not stick');
    assert(
        state.mask_image_base === undefined && state.mask_image_raw === undefined,
        'the mask pixel arrays must never reach the state document'
    );
    assert(
        Array.isArray(state.camera_position) && state.camera_position.length === 2,
        'state must carry the camera position'
    );

    let threw = false;
    try {
        sim.updateState('not_a_state', 1);
    } catch {
        threw = true;
    }
    assert(threw, 'an unknown state name must reject, as the Rust does');

    sim.destroy();
});

/**
 * The milestone's named acceptance test.
 *
 * Ten steps of the ping-pong GPU pipeline against ten steps of an independent
 * whole-field reference, from bit-identical initial conditions. It is the test
 * that would catch a bind group reading the texture it is writing, a swap in
 * the wrong place, and — since the 8x8 workgroup covers 64 texels where the
 * shader used to declare one — a dispatch that only updates every 64th texel.
 *
 * Run at `timestep: 1.0` rather than the shipping 2.5. The von Neumann limit
 * for these diffusion rates is 0.25/(0.16+0.08) = 1.04, so the *default*
 * settings are past the stability boundary: a half-ulp of f16 rounding is
 * amplified by 1.6 per step there and no reference could agree with anything
 * after ten. That is a property of the shipping defaults, not of this port —
 * `clamp` to [0,1] is what keeps the picture from exploding.
 */
test('gray-scott ping-pong matches an in-place reference after 10 steps', async () => {
    const sim = await GrayScottSimulation.create(gpu);
    const [target, view] = renderTarget(32, 'gray-scott reference target');
    const [width, height] = sim.textureSize;

    const settings = stableSettings();
    sim.applySettings(settings);

    // Seed from noise rather than the initial disc: the disc leaves 99.7% of
    // the field at the fixed point u=1, v=0, where every implementation agrees
    // trivially and the comparison would prove nothing.
    sim.seedRandomNoise(20250101);
    const start = await readField(sim.currentField);
    assert(spread(start.u) > 0.5, 'the noise seed did not vary the field');

    for (let i = 0; i < 10; i++) sim.renderFrame(view, 1 / 60);

    const actual = await readField(sim.currentField);
    const expected = referenceSteps(start, width, height, settings, 10);

    assert(!hasNonFinite(actual.u) && !hasNonFinite(actual.v), 'the field went non-finite');
    assert(
        meanAbsDiff(actual.u, start.u) > 0.01,
        'ten steps changed almost nothing — the compute pass is not running'
    );

    const meanU = meanAbsDiff(actual.u, expected.u);
    const meanV = meanAbsDiff(actual.v, expected.v);
    assert(meanU <= 5e-3, `U diverged from the reference: mean |delta| ${meanU.toFixed(6)}`);
    assert(meanV <= 5e-3, `V diverged from the reference: mean |delta| ${meanV.toFixed(6)}`);

    // And no single texel is wildly wrong, which a mean over 65k texels hides —
    // one missed workgroup is 64 texels, 0.1% of the field.
    const worstU = maxAbsDiff(actual.u, expected.u);
    assert(worstU <= 0.1, `one texel is far off the reference: max |delta| ${worstU.toFixed(4)}`);

    sim.destroy();
    target.destroy();
});

test('the gray-scott field stays bounded and NaN-free over 60 steps', async () => {
    const [target, view] = renderTarget(32, 'gray-scott stability target');

    // Three configurations: the shipping defaults (which are past the von
    // Neumann limit, see above), and the two degenerate adaptive-timestep cases
    // the guard in `guardedSettings` exists for. `0.25 / (delta_u + delta_v)`
    // and `1.0 / (1.0 + feed + kill)` are both unguarded in the shader, and
    // settings.ts deliberately clamps nothing, so both denominators really can
    // reach zero from the UI.
    for (const [label, overrides] of [
        ['defaults', {}],
        [
            'adaptive with zero diffusion',
            { enable_adaptive_timestep: true, diffusion_rate_u: 0, diffusion_rate_v: 0 },
        ],
        [
            'adaptive with both stability limits degenerate',
            {
                enable_adaptive_timestep: true,
                diffusion_rate_u: 0,
                diffusion_rate_v: 0,
                feed_rate: -0.5,
                kill_rate: -0.5,
            },
        ],
    ] as const) {
        const sim = await GrayScottSimulation.create(gpu);
        sim.applySettings({ ...defaultGrayScottSettings(), ...overrides });
        sim.seedRandomNoise(99);

        for (let step = 0; step < 60; step++) sim.renderFrame(view, 1 / 60);

        const { u, v } = await readField(sim.currentField);
        assert(!hasNonFinite(u), `${label}: U went non-finite`);
        assert(!hasNonFinite(v), `${label}: V went non-finite`);
        for (let i = 0; i < u.length; i++) {
            assert(u[i] >= 0 && u[i] <= 1, `${label}: U left [0,1] at texel ${i}: ${u[i]}`);
            assert(v[i] >= 0 && v[i] <= 1, `${label}: V left [0,1] at texel ${i}: ${v[i]}`);
        }

        sim.destroy();
    }

    target.destroy();
});

test('noise seeding is deterministic and leaves the pair coherent', async () => {
    const first = await GrayScottSimulation.create(gpu);
    const second = await GrayScottSimulation.create(gpu);

    first.seedRandomNoise(4242);
    second.seedRandomNoise(4242);

    const [a, b] = fieldPair(first);
    const fieldA = await readField(a);
    const fieldB = await readField(b);
    assert(
        meanAbsDiff(fieldA.u, fieldB.u) === 0 && meanAbsDiff(fieldA.v, fieldB.v) === 0,
        'both halves of the pair must be seeded with the same noise, or the first ' +
            'step reads a field the paint pass never wrote'
    );
    assert(spread(fieldA.v) > 0.5, 'the noise seed produced a flat field');

    const other = await readField(second.currentField);
    assert(
        meanAbsDiff(fieldA.u, other.u) === 0,
        'the same seed must produce the same field on two simulations'
    );

    second.seedRandomNoise(4243);
    const different = await readField(second.currentField);
    assert(meanAbsDiff(fieldA.u, different.u) > 0, 'a different seed produced the same field');

    first.destroy();
    second.destroy();
});

/**
 * The copy-through invariant, which is the whole point of remediation (c).
 *
 * `paint.wgsl` used to be an in-place `read_write` pass — illegal on
 * rgba16float in core WebGPU — and is now ping-pong, so every texel of the
 * destination has to be written even where the brush does nothing. A texel the
 * shader skips is not "unchanged": it holds whatever that texture contained two
 * frames ago. The reaction step below is what makes the two halves differ, so a
 * missing copy-through shows up as a whole field jumping backwards in time
 * rather than as a subtle artefact.
 */
test('gray-scott paint writes every destination texel', async () => {
    const sim = await GrayScottSimulation.create(gpu);
    const [target, view] = renderTarget(32, 'gray-scott paint target');
    const [width, height] = sim.textureSize;

    sim.updateState('cursor_size', 0.2);
    sim.updateState('cursor_strength', 1.0);
    sim.seedRandomNoise(31337);
    // One step, so `current` and `inactive` no longer agree.
    sim.renderFrame(view, 1 / 60);

    const before = await readField(sim.currentField);
    // World (0,0) is the centre of the tile under an unmoved camera.
    sim.handleMouseInteraction(0, 0, 0);
    const after = await readField(sim.currentField);

    // paint.wgsl:44 — the brush centre and radius, in texels.
    const mouseX = Math.trunc(0.5 * width);
    const mouseY = Math.trunc(0.5 * height);
    const radius = Math.max(0.2 * (Math.min(width, height) * 0.5), 1);

    let changedInside = 0;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const distance = Math.hypot(x - mouseX, y - mouseY);

            if (distance > radius + 1) {
                // Outside the brush the shader copies the source texel through,
                // and f16 -> f32 -> f16 is exact, so this is equality and not a
                // tolerance.
                assert(
                    after.u[i] === before.u[i] && after.v[i] === before.v[i],
                    `texel (${x},${y}) outside the brush changed: ` +
                        `u ${before.u[i]} -> ${after.u[i]}. Either the paint pass ` +
                        `skipped it, leaving a two-frame-stale texel, or the brush ` +
                        `geometry no longer matches paint.wgsl.`
                );
            } else if (
                distance < radius * 0.5 &&
                (after.u[i] !== before.u[i] || after.v[i] !== before.v[i])
            ) {
                // U *and* V, because the left button mixes U towards
                // `cursor_strength` — 1.0 here — and most of the field is
                // already at U = 1, so U alone barely moves.
                changedInside++;
            }
        }
    }

    assert(changedInside > 20, `the brush changed only ${changedInside} texels`);

    sim.destroy();
    target.destroy();
});

test('gray-scott paint buttons follow the shader', async () => {
    const sim = await GrayScottSimulation.create(gpu);
    const [width, height] = sim.textureSize;

    sim.updateState('cursor_size', 0.3);
    sim.updateState('cursor_strength', 1.0);
    sim.seedRandomNoise(5150);

    const before = await readField(sim.currentField);

    // Middle button: the shader has no arm for it, so the whole field is copied
    // through unchanged — which is only true if the copy-through works.
    sim.handleMouseInteraction(0, 0, 1);
    const middle = await readField(sim.currentField);
    assert(
        meanAbsDiff(before.u, middle.u) === 0 && meanAbsDiff(before.v, middle.v) === 0,
        'the middle button must leave the field exactly as it was'
    );

    // Right button erases towards U=1, V=0 at full strength.
    sim.handleMouseInteraction(0, 0, 2);
    const erased = await readField(sim.currentField);
    const centre = Math.trunc(height / 2) * width + Math.trunc(width / 2);
    assertClose(erased.u[centre], 1, 0.01, 'right-button U at the brush centre');
    assertClose(erased.v[centre], 0, 0.01, 'right-button V at the brush centre');

    // A click outside [0,1]^2 in texture space paints nothing at all: world
    // (5, 5) is five tiles away.
    const untouched = await readField(sim.currentField);
    sim.handleMouseInteraction(5, 5, 0);
    const stillUntouched = await readField(sim.currentField);
    assert(
        meanAbsDiff(untouched.u, stillUntouched.u) === 0,
        'a click outside the field must be ignored, not wrapped into it'
    );

    sim.destroy();
});

test('gray-scott renders a varied, finite, deterministic image', async () => {
    const [target, view] = renderTarget(64, 'gray-scott render target');

    const run = async (): Promise<Uint8Array> => {
        const sim = await GrayScottSimulation.create(gpu);
        sim.applySettings(stableSettings());
        sim.seedRandomNoise(777);
        for (let i = 0; i < 12; i++) sim.renderFrame(view, 1 / 60);
        const pixels = await readTexturePixels(gpu.device, target);
        sim.destroy();
        return pixels;
    };

    const first = await run();
    assert(!hasNonFinite(first), 'gray-scott produced non-finite pixels');
    assert(!isUniform(first), 'gray-scott produced a flat image — the LUT path did nothing');

    const alpha = channelStats(first, channelOffset(gpu.format, 'a'));
    assert(alpha.min === 255, `gray-scott must be opaque; found alpha down to ${alpha.min}`);

    const red = channelStats(first, channelOffset(gpu.format, 'r'));
    assert(red.deviation > 2, `image is nearly flat: red deviation ${red.deviation.toFixed(2)}`);

    const second = await run();
    const mae = meanAbsoluteError(first, second);
    assert(mae <= 1, `two identical runs diverged by MAE ${mae.toFixed(3)}`);

    target.destroy();
});

/**
 * Pins remediation (2): `filtering_mode` is the app setting, and the default is
 * Linear.
 *
 * On the desktop the 16-byte filtering-mode buffer is built, kept up to date and
 * bound nowhere — binding 7 gets a 68-byte struct instead, so the shader reads
 * `feed_rate`'s bit pattern as the mode and always takes the Lanczos branch. The
 * two assertions here are what tells the difference: the mode must *matter*, and
 * the default must be the Linear branch rather than the Lanczos one.
 */
test('gray-scott honours the texture filtering setting', async () => {
    const sim = await GrayScottSimulation.create(gpu);
    // 48, deliberately not a divisor of the 256-texel field. At 64 every
    // fragment's `tex_x` lands exactly on a texel boundary, and there the
    // Lanczos kernel is 1 at offset 0 and *exactly* 0 at every integer offset —
    // so it degenerates to the same bilinear tap as the Linear branch and the
    // two modes are bit-identical. A real property of the shader, and a very
    // convincing way for this test to prove nothing.
    const [target, view] = renderTarget(48, 'gray-scott filtering target');

    // The raw noise field, with no reaction steps: per-texel detail at a 4:1
    // minification is where a 5x5 Lanczos gather and a 2x2 bilinear tap
    // disagree most. A settled pattern is smooth, and every filter agrees on
    // smooth.
    sim.seedRandomNoise(2024);

    sim.renderFramePaused(view);
    const byDefault = await readTexturePixels(gpu.device, target);

    sim.setFilteringMode(TEXTURE_FILTERING.lanczos);
    sim.renderFramePaused(view);
    const lanczos = await readTexturePixels(gpu.device, target);

    sim.setFilteringMode(TEXTURE_FILTERING.linear);
    sim.renderFramePaused(view);
    const linear = await readTexturePixels(gpu.device, target);

    assert(
        meanAbsoluteError(byDefault, linear) === 0,
        'the default filtering mode is not Linear — binding 7 may be the 68-byte struct again'
    );
    const lanczosDelta = meanAbsoluteError(byDefault, lanczos);
    assert(
        lanczosDelta > 0.5,
        `switching to Lanczos changed almost nothing (MAE ${lanczosDelta.toFixed(3)}), ` +
            `so filtering_mode is not being read`
    );

    sim.destroy();
    target.destroy();
});

test('the gray-scott image mask reaches the reaction', async () => {
    const [target, view] = renderTarget(32, 'gray-scott mask target');

    const run = async (withMask: boolean): Promise<Float32Array> => {
        const sim = await GrayScottSimulation.create(gpu);
        sim.applySettings(stableSettings());
        sim.updateState('mask_target', 'Feed Rate');
        sim.updateState('mask_strength', 1.0);

        if (withMask) {
            const [width] = sim.textureSize;
            await sim.loadImage(await splitImageFile(width));
            assert(sim.hasImage, 'loadImage must leave a gradient map uploaded');
            sim.updateState('mask_image_fit_mode', 'Stretch');
            sim.updateState('mask_pattern', 'Image');
        }

        sim.seedRandomNoise(8080);
        for (let i = 0; i < 20; i++) sim.renderFrame(view, 1 / 60);
        const { u } = await readField(sim.currentField);
        sim.destroy();
        return u;
    };

    const plain = await run(false);
    const masked = await run(true);

    assert(!hasNonFinite(masked), 'the mask path produced non-finite values');
    assert(
        meanAbsDiff(plain, masked) > 1e-3,
        'selecting the Image mask pattern changed nothing — the gradient buffer is ' +
            'not reaching binding 3, or the u8 image was never converted to f32'
    );

    target.destroy();
});

test('gray-scott create/destroy x20 leaves the resource ledger clean', async () => {
    const ledger = new ResourceLedger();
    const instrumented: GpuContext = { ...gpu, device: instrumentDevice(gpu.device, ledger) };

    const churnTarget = gpu.device.createTexture({
        label: 'gray-scott churn target',
        size: { width: 32, height: 32 },
        format: gpu.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const churnView = churnTarget.createView();

    for (let i = 0; i < 20; i++) {
        const sim = await GrayScottSimulation.create(instrumented);
        // Paint as well as render: the paint path is the one that could
        // plausibly allocate per event, which is exactly what the Rust does.
        sim.handleMouseInteraction(0, 0, 0);
        sim.renderFrame(churnView, 1 / 60);
        sim.destroy();
        sim.destroy();
    }

    const stats = ledger.stats();
    // Nine per simulation: five uniform/storage buffers, the two field
    // textures, the camera uniform and the renderer's params buffer.
    assert(
        stats.created >= 20 * 9,
        `expected at least nine tracked objects per simulation, saw ${stats.created} over 20`
    );
    assert(
        stats.live === 0,
        `${stats.live} GPU objects leaked over 20 cycles: ${JSON.stringify(stats.byLabel)}`
    );

    gpu.device.pushErrorScope('validation');
    const probe = createStorageBuffer(gpu.device, 256, { label: 'post-gray-scott probe' });
    const error = await gpu.device.popErrorScope();
    assert(error === null, `device unhealthy after 20 gray-scott cycles: ${error?.message}`);
    probe.destroy();
    churnTarget.destroy();
});

// ---------------------------------------------------------------------------
// Vectors — the WGSL noise library — M5
// ---------------------------------------------------------------------------

/**
 * `vectors/shaders/noise.wgsl` is a function library: no bindings, no entry
 * point, meant to be concatenated ahead of a consuming shader. This driver is
 * that consumer, which means these tests exercise the concatenation contract as
 * well as the maths — a stray binding or entry point in the library would show
 * up here as a duplicate-declaration compile error.
 */
const NOISE_SHADER_PATH = 'vectors/shaders/noise.wgsl';

const NOISE_PROBE_DRIVER = `
struct NoiseProbeParams {
    noise_type: u32,
    seed: u32,
    width: u32,
    height: u32,
    origin_x: f32,
    origin_y: f32,
    step: f32,
    z: f32,
}

@group(0) @binding(0) var<uniform> probe: NoiseProbeParams;
@group(0) @binding(1) var<storage, read_write> samples: array<f32>;

@compute @workgroup_size(8, 8, 1)
fn probe_noise(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= probe.width || gid.y >= probe.height) {
        return;
    }
    // Matches the Rust sampling geometry: x and y are scaled world position,
    // z is animated time (vectors/simulation.rs:304-306).
    let p = vec3<f32>(
        probe.origin_x + f32(gid.x) * probe.step,
        probe.origin_y + f32(gid.y) * probe.step,
        probe.z
    );
    samples[gid.y * probe.width + gid.x] = noise_sample(probe.noise_type, p, probe.seed);
}

@compute @workgroup_size(8, 8, 1)
fn probe_noise_signed(@builtin(global_invocation_id) gid: vec3<u32>) {
    if (gid.x >= probe.width || gid.y >= probe.height) {
        return;
    }
    let p = vec3<f32>(
        probe.origin_x + f32(gid.x) * probe.step,
        probe.origin_y + f32(gid.y) * probe.step,
        probe.z
    );
    samples[gid.y * probe.width + gid.x] = noise_sample_signed(probe.noise_type, p, probe.seed);
}
`;

interface NoiseProbeOptions {
    /** Grid side; the field is square. */
    size?: number;
    /** World distance between adjacent samples. */
    step?: number;
    /** Lower-left corner, offset from the origin so no type is sampled only on its lattice. */
    origin?: number;
    /** The animated third coordinate. */
    z?: number;
    /** Sample the raw [-1,1] value instead of the normalised, clamped one. */
    signed?: boolean;
}

const noiseProbePipelines = new Map<string, GPUComputePipeline>();
let noiseProbeModule: GPUShaderModule | null = null;

async function noisePipeline(entryPoint: string): Promise<GPUComputePipeline> {
    const cached = noiseProbePipelines.get(entryPoint);
    if (cached) return cached;

    if (!noiseProbeModule) {
        noiseProbeModule = await createShaderModuleChecked(gpu.device, {
            label: 'vectors noise probe',
            code: `${getShader(NOISE_SHADER_PATH)}\n${NOISE_PROBE_DRIVER}`,
        });
    }
    const pipeline = gpu.device.createComputePipeline({
        label: `vectors noise probe (${entryPoint})`,
        layout: 'auto',
        compute: { module: noiseProbeModule, entryPoint },
    });
    noiseProbePipelines.set(entryPoint, pipeline);
    return pipeline;
}

async function sampleNoise(
    noiseType: number,
    seed: number,
    options: NoiseProbeOptions = {}
): Promise<Float32Array> {
    const size = options.size ?? 48;
    const step = options.step ?? 0.17;
    const origin = options.origin ?? -3.31;
    const z = options.z ?? 0.37;

    const pipeline = await noisePipeline(options.signed ? 'probe_noise_signed' : 'probe_noise');
    const params = createUniformBuffer(gpu.device, 32, { label: 'noise probe params' });
    const output = createStorageBuffer(gpu.device, size * size * 4, { label: 'noise probe out' });

    const bytes = new ArrayBuffer(32);
    new Uint32Array(bytes, 0, 4).set([noiseType, seed, size, size]);
    new Float32Array(bytes, 16, 4).set([origin, origin, step, z]);
    gpu.device.queue.writeBuffer(params, 0, bytes);

    const bindGroup = gpu.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: params } },
            { binding: 1, resource: { buffer: output } },
        ],
    });

    const encoder = gpu.device.createCommandEncoder({ label: 'noise probe' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    const groups = Math.ceil(size / 8);
    pass.dispatchWorkgroups(groups, groups, 1);
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);

    const raw = await readBuffer(gpu.device, output, size * size * 4);
    params.destroy();
    output.destroy();

    return new Float32Array(raw, 0, size * size);
}

/** Width of the middle 90% of the samples — how much of [0,1] the field really uses. */
function centralSpread(values: Float32Array): number {
    const sorted = Float32Array.from(values).sort();
    const low = sorted[Math.floor(sorted.length * 0.05)];
    const high = sorted[Math.ceil(sorted.length * 0.95) - 1];
    return high - low;
}

function meanAbsDelta(a: Float32Array, b: Float32Array): number {
    let total = 0;
    for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
    return total / a.length;
}

/** Mean |difference| between horizontally adjacent samples. */
function meanNeighbourDelta(values: Float32Array, size: number): number {
    let total = 0;
    let count = 0;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x + 1 < size; x++) {
            total += Math.abs(values[y * size + x + 1] - values[y * size + x]);
            count++;
        }
    }
    return total / count;
}

/** Mean |difference| between samples half a grid apart — the decorrelated baseline. */
function meanDistantDelta(values: Float32Array, size: number): number {
    const span = Math.floor(size / 2);
    let total = 0;
    let count = 0;
    for (let y = 0; y < size; y++) {
        for (let x = 0; x + span < size; x++) {
            total += Math.abs(values[y * size + x + span] - values[y * size + x]);
            count++;
        }
    }
    return total / count;
}

/**
 * The eleven types of `NoiseType` (vectors/settings.rs:65), in declaration
 * order, which is the code `noise_sample` switches on.
 *
 * `seeded` records a real asymmetry rather than an oversight: Cylinders and
 * Checkerboard are analytic functions of position, and the crate's own
 * constructors take no seed for them (noise_helper.rs:47-48), so changing the
 * seed must leave those two fields bit-identical. `continuous` excludes
 * Checkerboard alone, which is a step function by definition.
 */
const NOISE_TYPES: ReadonlyArray<{
    code: number;
    name: string;
    seeded: boolean;
    continuous: boolean;
}> = [
    { code: 0, name: 'OpenSimplex', seeded: true, continuous: true },
    { code: 1, name: 'Worley', seeded: true, continuous: true },
    { code: 2, name: 'Value', seeded: true, continuous: true },
    { code: 3, name: 'Fbm', seeded: true, continuous: true },
    { code: 4, name: 'FBMBillow', seeded: true, continuous: true },
    { code: 5, name: 'FBMClouds', seeded: true, continuous: true },
    { code: 6, name: 'FBMRidged', seeded: true, continuous: true },
    { code: 7, name: 'Billow', seeded: true, continuous: true },
    { code: 8, name: 'RidgedMulti', seeded: true, continuous: true },
    { code: 9, name: 'Cylinders', seeded: false, continuous: true },
    { code: 10, name: 'Checkerboard', seeded: false, continuous: false },
];

/**
 * A field that occupies only a sliver of [0, 1] is a real defect even though
 * every sample is "valid": `simulation.rs:312` turns the value straight into an
 * angle of `value * 2pi`, so the middle 90% of the field spanning less than
 * 0.15 means nine tenths of the lines lie within 54 degrees of each other and
 * the result reads as a comb rather than a flow. Ridged and billow types are
 * asymmetric by construction and sit lowest against this bar, which is why the
 * threshold is set by what a viewer would notice rather than by a distribution.
 */
const MIN_CENTRAL_SPREAD = 0.15;

/**
 * Two seeds are uncorrelated when the mean |difference| approaches that of two
 * independent draws from the same distribution. A tenth of the range is far
 * above what a shared-structure bug (seed folded in after the lattice hash,
 * say) would produce, and far below the ~0.2-0.35 the real fields show.
 */
const MIN_SEED_DIVERGENCE = 0.05;

/**
 * Step for the smoothness check: a fiftieth of a lattice cell, so that even a
 * ten-octave fractal is sampled well inside its finest feature.
 */
const NOISE_FINE_STEP = 0.02;

/**
 * Adjacent samples must differ by less than this fraction of what samples half
 * a grid apart differ by. A per-point hash scores ~1.0 — its neighbours are as
 * unrelated as its distant samples — while the measured fields score 0.02
 * (Value) to 0.15 (Billow, whose eight octaves really are near-decorrelated at
 * their top frequency whatever the step). A third leaves that worst case a 2.1x
 * margin and still fails a hash by a factor of three.
 */
const MAX_SMOOTHNESS_RATIO = 0.33;

for (const { code, name, seeded, continuous } of NOISE_TYPES) {
    test(`noise ${name} is finite, in range, varied and deterministic`, async () => {
        const size = 48;
        const field = await sampleNoise(code, 1234, { size });

        assert(field.length === size * size, `expected ${size * size} samples`);
        assert(!hasNonFinite(field), `${name} produced a NaN or Infinity`);

        let min = Infinity;
        let max = -Infinity;
        for (const v of field) {
            min = Math.min(min, v);
            max = Math.max(max, v);
        }
        assert(min >= 0 && max <= 1, `${name} left [0,1]: min ${min}, max ${max}`);
        assert(max - min > 1e-6, `${name} is constant at ${min} — the classic mis-seeded hash`);

        const spread = centralSpread(field);
        assert(
            spread >= MIN_CENTRAL_SPREAD,
            `${name} uses only ${spread.toFixed(3)} of [0,1] in its middle 90% ` +
                `(min ${MIN_CENTRAL_SPREAD}) — a visually flat field`
        );

        // Determinism: the same inputs, a second dispatch, byte for byte. An
        // integer hash guarantees this; a sin()-based one would not across
        // drivers, which is why the library uses the former.
        const again = await sampleNoise(code, 1234, { size });
        assert(meanAbsDelta(field, again) === 0, `${name} is not deterministic`);

        const otherSeed = await sampleNoise(code, 98765, { size });
        const divergence = meanAbsDelta(field, otherSeed);
        if (seeded) {
            assert(
                divergence >= MIN_SEED_DIVERGENCE,
                `${name} barely responded to a new seed: mean |delta| ${divergence.toFixed(4)}`
            );
        } else {
            assert(
                divergence === 0,
                `${name} takes no seed in the Rust (noise_helper.rs:47-48) and must ignore it here, ` +
                    `but the field moved by ${divergence.toFixed(4)}`
            );
        }

        if (continuous) {
            // The assertion that separates noise from a plain hash: everything
            // above passes for a per-sample random number. Only a field with
            // spatial structure has neighbours that agree.
            //
            // Sampled on its own fine grid rather than reusing the field above,
            // because "adjacent" has to mean adjacent relative to the *finest*
            // feature: at the 0.17 step above, a 10-octave fractal's top octave
            // is already decorrelated between neighbours, and Cylinders has
            // covered a third of a period, so both look hash-like on a measure
            // that is really about scale.
            const fine = await sampleNoise(code, 1234, { size, step: NOISE_FINE_STEP });
            const near = meanNeighbourDelta(fine, size);
            const far = meanDistantDelta(fine, size);
            assert(
                near < far * MAX_SMOOTHNESS_RATIO,
                `${name} is not smooth: adjacent samples differ by ${near.toFixed(4)}, ` +
                    `distant ones by ${far.toFixed(4)} — this looks like a hash, not noise`
            );
        }
    });
}

test('noise fields are smooth under refinement, not merely correlated', async () => {
    // Halving the step must roughly halve the neighbour difference for
    // gradient-based types. A lattice bug that snaps to integer cells would
    // hold the difference flat instead.
    for (const code of [0, 2, 3, 5]) {
        const coarse = await sampleNoise(code, 77, { size: 32, step: 0.2 });
        const fine = await sampleNoise(code, 77, { size: 32, step: 0.05 });

        const coarseDelta = meanNeighbourDelta(coarse, 32);
        const fineDelta = meanNeighbourDelta(fine, 32);
        assert(
            fineDelta < coarseDelta * 0.6,
            `type ${code}: refining the step 4x changed the neighbour difference from ` +
                `${coarseDelta.toFixed(4)} to ${fineDelta.toFixed(4)} — not a continuous field`
        );
    }
});

test('the noise field advances with the animated third coordinate', async () => {
    // z is time in the Vectors sim, so a field that ignores it would animate
    // nothing while still passing every static assertion above.
    //
    // Cylinders is the deliberate exception, and is asserted static below
    // rather than merely skipped. It takes its radius across x and y so that it
    // produces rings in space; the version that used z was spatially uniform
    // within seconds, because `length(x, time)` is dominated by the clock. See
    // the comment on `noise_cylinders`.
    for (const { code, name } of NOISE_TYPES) {
        if (name === 'Cylinders') continue;
        const t0 = await sampleNoise(code, 4242, { size: 32, z: 0.13 });
        const t1 = await sampleNoise(code, 4242, { size: 32, z: 1.63 });
        assert(
            meanAbsDelta(t0, t1) > 1e-4,
            `${name} does not vary with z, so the simulation would be frozen`
        );
    }
});

test('Cylinders is static in time and varies in space', async () => {
    const cylinders = NOISE_TYPES.find((t) => t.name === 'Cylinders');
    assert(cylinders !== undefined, 'Cylinders is missing from NOISE_TYPES');

    const t0 = await sampleNoise(cylinders.code, 4242, { size: 32, z: 0.13 });
    const t1 = await sampleNoise(cylinders.code, 4242, { size: 32, z: 9.71 });
    assert(
        meanAbsDelta(t0, t1) < 1e-6,
        'Cylinders must ignore z — a radius mixing the clock in collapses the ' +
            'whole field to one value that sweeps round together'
    );
    assert(Math.max(...t0) - Math.min(...t0) > 1e-6, 'Cylinders must still vary across x and y');
});

/**
 * The header of `noise.wgsl` tabulates each type's range *before*
 * normalisation, and that table is the only record of which types the [0,1]
 * clamp actually touches. Pinning it here means a rescaled generator — someone
 * changing the simplex falloff constant, or swapping fBm's normalisation —
 * fails a test instead of silently making the documentation wrong.
 */
test('the signed noise range matches what the library documents', async () => {
    // Only the two plain-fBm types exceed +/-1, and only in the tail: octaves
    // are normalised by the root of their summed squares, which preserves the
    // base noise's spread at the price of a tail that occasionally lands
    // outside. Everything else is bounded by construction.
    const bounds = new Map<number, { limit: number; maxClipped: number }>([
        [3, { limit: 1.35, maxClipped: 0.02 }], // Fbm
        [5, { limit: 1.35, maxClipped: 0.02 }], // FBMClouds
    ]);

    for (const { code, name } of NOISE_TYPES) {
        const { limit, maxClipped } = bounds.get(code) ?? { limit: 1.001, maxClipped: 0 };
        const signed = await sampleNoise(code, 1234, { size: 64, signed: true });

        assert(!hasNonFinite(signed), `${name} produced a non-finite signed sample`);

        let extreme = 0;
        let clipped = 0;
        for (const v of signed) {
            extreme = Math.max(extreme, Math.abs(v));
            if (v < -1 || v > 1) clipped++;
        }
        assert(
            extreme <= limit,
            `${name} reached ${extreme.toFixed(3)}, past the documented bound of ${limit}`
        );
        const fraction = clipped / signed.length;
        assert(
            fraction <= maxClipped,
            `${name} needed the [0,1] clamp on ${(fraction * 100).toFixed(2)}% of samples, ` +
                `over the documented ${(maxClipped * 100).toFixed(0)}%`
        );
    }
});

// ---------------------------------------------------------------------------
// Vectors — the simulation — M5
// ---------------------------------------------------------------------------

/**
 * Settings that make a line field visible in a 64-pixel test target.
 *
 * `Settings::default()` is `line_width: 0.001`, `line_length: 0.03` — a line
 * ~0.03 px wide and ~1 px long here, i.e. no coverage at all and a black image
 * that would pass "is it finite" and nothing else. On the real 1920-px surface
 * those same numbers are a ~1 px line, which is the point of them. So the tests
 * scale the *geometry*, never the field: density, noise type, seed and the
 * sampling are left exactly as they ship.
 */
function visibleVectorsSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ...defaultVectorsSettings(),
        density: 0.1, // 25 x 25 lines across the padded view
        line_length: 0.2,
        line_width: 0.05,
        ...overrides,
    };
}

/** The camera a simulation constructed for itself, which is the one it drives. */
function simCamera(sim: VectorsSimulation): Camera {
    return (sim as unknown as { camera: Camera }).camera;
}

/**
 * The CPU/GPU mirror probe.
 *
 * Concatenated behind the *shipping* vertex source — noise library included —
 * so it calls the very functions `vs_main` calls. Bindings are in group 1
 * because group 0 belongs to the render pipeline; a compute entry that uses
 * neither is given an empty layout for group 0 by `layout: 'auto'`.
 *
 * `value` is synthesised from the instance index rather than sampled, because
 * what is under test here is the geometry — grid point, segment, quad corner,
 * corner order — and mixing the noise in would make a failure ambiguous.
 */
const VECTORS_MIRROR_DRIVER = `
struct MirrorProbe {
    grid_min: vec2<f32>,
    spacing: f32,
    count_y: u32,
    line_length: f32,
    line_width: f32,
    instances: u32,
    _pad: u32,
}

@group(1) @binding(0) var<uniform> mirror: MirrorProbe;
@group(1) @binding(1) var<storage, read_write> mirror_out: array<f32>;

@compute @workgroup_size(64, 1, 1)
fn probe_mirror(@builtin(global_invocation_id) gid: vec3<u32>) {
    let instance = gid.x;
    if (instance >= mirror.instances) {
        return;
    }

    let p0 = vectors_grid_point(mirror.grid_min, mirror.spacing, mirror.count_y, instance);
    let value = f32(instance) / f32(mirror.instances);
    let p1 = vectors_line_end(p0, value, mirror.line_length);

    let base = instance * 16u;
    mirror_out[base] = p0.x;
    mirror_out[base + 1u] = p0.y;
    mirror_out[base + 2u] = p1.x;
    mirror_out[base + 3u] = p1.y;

    for (var v = 0u; v < 6u; v++) {
        let corner = vectors_quad_corner(p0, p1, mirror.line_width, vectors_corner_index(v));
        mirror_out[base + 4u + v * 2u] = corner.x;
        mirror_out[base + 5u + v * 2u] = corner.y;
    }
}
`;

/** 2 for p0, 2 for p1, then the six quad vertices. */
const MIRROR_FLOATS_PER_INSTANCE = 16;

test('the vectors shader mirrors the grid arithmetic settings.ts declares', () => {
    // The text pin, in the spirit of the `calculate_tile_count` test in
    // test/unit/moire.test.ts: the CPU issues the draw and the GPU places the
    // geometry, so a silent divergence tears the field with nothing to see.
    const wgsl = getShader(VECTORS_LINE_SHADER_PATH);

    const gridPoint = wgsl.slice(wgsl.indexOf('fn vectors_grid_point'));
    assert(gridPoint.includes('let ix = instance / count_y;'), 'grid x index changed');
    assert(gridPoint.includes('let iy = instance % count_y;'), 'grid y index changed');
    assert(
        gridPoint.includes('return grid_min + vec2<f32>(f32(ix), f32(iy)) * spacing;'),
        'grid point arithmetic no longer matches vectorsGridPointAt'
    );

    // `vectorsLineSegment`: angle is the full turn, length runs from half.
    const lineEnd = wgsl.slice(wgsl.indexOf('fn vectors_line_end'));
    assert(lineEnd.includes('let angle = value * VECTORS_TAU;'), 'angle is no longer value * TAU');
    assert(
        lineEnd.includes('let len = line_length * (0.5 + value * 0.5);'),
        'segment length no longer matches vectorsLineSegment'
    );
    assert(
        wgsl.includes('const VECTORS_TAU: f32 = 6.2831853071795864769;'),
        'TAU changed, so every line angle changed with it'
    );

    // `vectorsLineQuad`: the normal, half the width each side, and the 1e-6
    // guard for a zero-length segment.
    const quadCorner = wgsl.slice(wgsl.indexOf('fn vectors_quad_corner'));
    assert(quadCorner.includes('let len = max(length(d), 1e-6);'), 'zero-length guard changed');
    assert(
        quadCorner.includes('let normal = vec2<f32>(-d.y, d.x) / len * (line_width * 0.5);'),
        'quad normal no longer matches vectorsLineQuad'
    );

    // `vectorsQuadIndices(0)` is [0, 1, 2, 0, 2, 3].
    const cornerIndex = wgsl.slice(wgsl.indexOf('fn vectors_corner_index'));
    assert(cornerIndex.includes('case 0u, 3u:'), 'quad triangle order changed');
    assert(cornerIndex.includes('case 2u, 4u:'), 'quad triangle order changed');
    assert(
        JSON.stringify(vectorsQuadIndices(0)) === JSON.stringify([0, 1, 2, 0, 2, 3]),
        'vectorsQuadIndices changed; the shader still hardcodes [0,1,2,0,2,3]'
    );
});

test('vectors grid geometry agrees between the CPU and the GPU', async () => {
    // A camera and density that exercise a non-square offset and a fractional
    // spacing, not the origin.
    const extent = vectorsGridExtent(0.37, -1.21, 1.6, 0.09);
    const instances = 96;
    assert(extent.count > instances, 'the probe must stay inside the real grid');

    const module = await createShaderModuleChecked(gpu.device, {
        label: 'vectors mirror probe',
        code: `${vectorsVertexShaderSource()}\n${VECTORS_MIRROR_DRIVER}`,
    });
    const pipeline = gpu.device.createComputePipeline({
        label: 'vectors mirror probe pipeline',
        layout: 'auto',
        compute: { module, entryPoint: 'probe_mirror' },
    });

    const lineLength = 0.03;
    const lineWidth = 0.011;

    const params = createUniformBuffer(gpu.device, 32, { label: 'mirror probe params' });
    const bytes = new ArrayBuffer(32);
    new Float32Array(bytes, 0, 3).set([extent.minX, extent.minY, extent.spacing]);
    new Uint32Array(bytes, 12, 1).set([extent.countY]);
    new Float32Array(bytes, 16, 2).set([lineLength, lineWidth]);
    new Uint32Array(bytes, 24, 2).set([instances, 0]);
    gpu.device.queue.writeBuffer(params, 0, bytes);

    const floats = instances * MIRROR_FLOATS_PER_INSTANCE;
    const output = createStorageBuffer(gpu.device, floats * 4, { label: 'mirror probe out' });

    const encoder = gpu.device.createCommandEncoder({ label: 'vectors mirror probe' });
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
        1,
        gpu.device.createBindGroup({
            layout: pipeline.getBindGroupLayout(1),
            entries: [
                { binding: 0, resource: { buffer: params } },
                { binding: 1, resource: { buffer: output } },
            ],
        })
    );
    pass.dispatchWorkgroups(Math.ceil(instances / 64), 1, 1);
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);

    const raw = new Float32Array(await readBuffer(gpu.device, output, floats * 4), 0, floats);
    params.destroy();
    output.destroy();

    assert(!hasNonFinite(raw), 'the mirror probe produced non-finite geometry');

    // f32 against f64, plus a cos/sin whose last bits are the driver's, so a
    // tolerance rather than equality — and 2e-5 is still four orders of
    // magnitude tighter than one line width.
    const tolerance = 2e-5;
    for (let instance = 0; instance < instances; instance++) {
        const base = instance * MIRROR_FLOATS_PER_INSTANCE;
        const [x, y] = vectorsGridPointAt(extent, instance);
        const value = instance / instances;
        const segment = vectorsLineSegment(x, y, value, lineLength);
        const quad = vectorsLineQuad(segment, value, lineWidth);

        assertClose(raw[base], x, tolerance, `instance ${instance} grid x`);
        assertClose(raw[base + 1], y, tolerance, `instance ${instance} grid y`);
        assertClose(raw[base + 2], segment[2], tolerance, `instance ${instance} segment end x`);
        assertClose(raw[base + 3], segment[3], tolerance, `instance ${instance} segment end y`);

        // The six drawn vertices, in `vectorsQuadIndices` order, against the
        // four `vectorsLineQuad` corners. Each CPU corner is [x, y, value].
        vectorsQuadIndices(0).forEach((corner, vertex) => {
            const at = base + 4 + vertex * 2;
            assertClose(raw[at], quad[corner * 3], tolerance, `instance ${instance} v${vertex} x`);
            assertClose(
                raw[at + 1],
                quad[corner * 3 + 1],
                tolerance,
                `instance ${instance} v${vertex} y`
            );
        });
    }
});

test('vectors constructs and tears down with no validation error', async () => {
    gpu.device.pushErrorScope('validation');

    const sim = await VectorsSimulation.create(gpu);
    const [target, view] = renderTarget(48, 'vectors validation target');
    sim.applySettings(visibleVectorsSettings());
    sim.renderFrame(view, 1 / 60);
    sim.renderFramePaused(view);
    sim.resize(96, 96);
    sim.renderFrame(view, 1 / 60);
    sim.destroy();
    sim.destroy();
    target.destroy();

    const error = await gpu.device.popErrorScope();
    assert(error === null, `vectors produced a validation error: ${error?.message}`);
});

test('vectors unclamps the host camera and puts the clamp back', async () => {
    // simulation.rs:85 — `set_position_clamp(None)`, because the pan is what
    // moves the (infinite) noise field's origin. The host's camera outlives the
    // simulation and `Camera.reset()` does not restore the clamp, so leaving it
    // off would silently hand unbounded panning to the next mode opened.
    const sim = await VectorsSimulation.create(gpu);
    const host = new Camera(64, 64);
    assert(host.getPositionClamp() !== null, 'a fresh camera is clamped');

    sim.attachCamera(host);
    assert(host.getPositionClamp() === null, 'vectors must unclamp the camera it is given');

    for (let i = 0; i < 200; i++) host.pan(-40, 0);
    host.update(1);
    assert(
        Math.abs(host.position[0]) > 2,
        `panning stayed inside the default clamp (x = ${host.position[0]})`
    );

    sim.destroy();
    assert(
        host.getPositionClamp() !== null,
        'the clamp must be restored on teardown, or the next simulation inherits it'
    );
    host.destroy();
});

test('vectors renders a varied, finite, deterministic field', async () => {
    const [target, view] = renderTarget(64, 'vectors target');

    const run = async (): Promise<Uint8Array> => {
        const sim = await VectorsSimulation.create(gpu);
        sim.applySettings(visibleVectorsSettings());
        // Fixed dt, and the field is a pure function of (camera, settings,
        // clock), so two runs of the same length must agree.
        for (let i = 0; i < 4; i++) sim.renderFrame(view, 1 / 60);
        const pixels = await readTexturePixels(gpu.device, target);
        sim.destroy();
        return pixels;
    };

    const first = await run();
    assert(!hasNonFinite(first), 'vectors produced non-finite pixels');
    assert(!isUniform(first), 'vectors produced a flat image — no line was rasterised');

    const alpha = channelStats(first, channelOffset(gpu.format, 'a'));
    assert(alpha.min === 255, `vectors must be opaque; found alpha down to ${alpha.min}`);

    // Lines on a black clear: most of the frame is background, so the check is
    // that a real minority of it is not.
    const red = channelStats(first, channelOffset(gpu.format, 'r'));
    assert(red.max > 64, `nothing bright was drawn: red tops out at ${red.max}`);
    assert(red.deviation > 4, `image is nearly flat: red deviation ${red.deviation.toFixed(2)}`);

    const second = await run();
    const mae = meanAbsoluteError(first, second);
    assert(mae <= 1, `two identical runs diverged by MAE ${mae.toFixed(3)}`);

    target.destroy();
});

test('the vectors clock animates the field and a paused redraw does not', async () => {
    const sim = await VectorsSimulation.create(gpu);
    const [target, view] = renderTarget(48, 'vectors clock target');
    // `noise_dt_multiplier` scales the animated z coordinate (simulation.rs:272),
    // so a large one makes a few frames' worth of drift unmistakable.
    sim.applySettings(visibleVectorsSettings({ noise_dt_multiplier: 40 }));

    sim.renderFrame(view, 1 / 60);
    const first = await readTexturePixels(gpu.device, target);

    sim.renderFramePaused(view);
    const paused = await readTexturePixels(gpu.device, target);
    assert(
        meanAbsoluteError(first, paused) === 0,
        'a paused redraw must not advance the noise field'
    );

    sim.renderFrame(view, 1);
    const later = await readTexturePixels(gpu.device, target);
    assert(meanAbsoluteError(first, later) > 1, 'the field did not move with the clock');

    // `reset_runtime_state` (simulation.rs:875) rewinds the clock, so the field
    // has to come back to where it started.
    sim.resetRuntimeState();
    sim.renderFrame(view, 1 / 60);
    const rewound = await readTexturePixels(gpu.device, target);
    assert(
        meanAbsoluteError(first, rewound) <= 1,
        'resetRuntimeState did not rewind the animation'
    );

    sim.destroy();
    target.destroy();
});

test('vectors honours VECTORS_MAX_LINES at the smallest density', async () => {
    const sim = await VectorsSimulation.create(gpu);
    const [target, view] = renderTarget(32, 'vectors density cap target');

    // `VectorsMode.svelte:165` puts the density minimum at exactly 0.001, which
    // the Rust would walk as a 2401 x 2401 grid: 5.77 M lines, a 277 MB vertex
    // buffer against a 256 MiB `maxBufferSize`, rebuilt every frame. The clamp
    // raises the *spacing* instead, so the field still covers the whole view.
    sim.applySettings(visibleVectorsSettings({ density: 0.001 }));

    const grid = sim.grid;
    assert(grid.clamped, 'the smallest density must trip the clamp');
    assert(
        grid.count <= VECTORS_MAX_LINES,
        `${grid.count} lines exceeds the ${VECTORS_MAX_LINES} budget`
    );
    assertClose(grid.spacing * (grid.countX - 1), 2.4, 1e-3, 'the clamped grid must span the view');

    gpu.device.pushErrorScope('validation');
    sim.renderFrame(view, 1 / 60);
    assert(
        sim.instanceCount === grid.count,
        `drew ${sim.instanceCount} instances for a ${grid.count}-line grid`
    );
    const error = await gpu.device.popErrorScope();
    assert(error === null, `the capped draw failed validation: ${error?.message}`);

    const pixels = await readTexturePixels(gpu.device, target);
    assert(!isUniform(pixels), 'the densest field drew nothing');

    // And the cap is not a permanent ceiling: an ordinary density is unclamped.
    sim.updateSetting('density', 0.02);
    assert(!sim.grid.clamped, 'the default density must not be clamped');

    sim.destroy();
    target.destroy();
});

test('panning moves the vectors field and zooming changes its density', async () => {
    const sim = await VectorsSimulation.create(gpu);
    const [target, view] = renderTarget(64, 'vectors camera target');
    sim.applySettings(visibleVectorsSettings());

    sim.renderFrame(view, 1 / 60);
    const atOrigin = await readTexturePixels(gpu.device, target);
    const linesAtOrigin = sim.instanceCount;

    // Pan: the grid origin is `camera - 1.2 / zoom` (simulation.rs:266), so the
    // sample coordinates move and a different part of the noise is drawn. The
    // line *count* must not change — same zoom, same density.
    const camera = simCamera(sim);
    for (let i = 0; i < 20; i++) camera.pan(-30, 12);
    for (let i = 0; i < 25; i++) sim.renderFrame(view, 1 / 60);
    const panned = await readTexturePixels(gpu.device, target);

    assert(!hasNonFinite(panned), 'panning produced non-finite pixels');
    assert(!isUniform(panned), 'panning produced a flat image');
    assert(meanAbsoluteError(atOrigin, panned) > 1, 'panning did not move the field');
    assert(
        sim.instanceCount === linesAtOrigin,
        `panning changed the line count from ${linesAtOrigin} to ${sim.instanceCount}`
    );

    // Zoom: the half-span is 1.2 / zoom, so zooming out covers more world at the
    // same spacing and there are strictly more lines to draw. Four notches
    // rather than a dramatic one — the line count grows as 1/zoom² and every one
    // of them is six vertices through a software rasteriser.
    for (let i = 0; i < 4; i++) camera.zoomBy(-1);
    for (let i = 0; i < 25; i++) sim.renderFrame(view, 1 / 60);

    assert(camera.zoom < 1, `zoomBy(-1) did not zoom out (zoom = ${camera.zoom})`);
    assert(
        sim.instanceCount > linesAtOrigin,
        `zooming out drew ${sim.instanceCount} lines, no more than the ${linesAtOrigin} at zoom 1`
    );
    const zoomedOut = await readTexturePixels(gpu.device, target);
    assert(!isUniform(zoomedOut), 'zooming out produced a flat image');
    assert(meanAbsoluteError(panned, zoomedOut) > 1, 'zooming out did not change what is drawn');

    sim.destroy();
    target.destroy();
});

test('each vector field type draws a different picture', async () => {
    const [target, view] = renderTarget(64, 'vectors field type target');

    const render = async (
        overrides: Record<string, unknown>,
        withImage = false
    ): Promise<Uint8Array> => {
        const sim = await VectorsSimulation.create(gpu);
        sim.applySettings(visibleVectorsSettings(overrides));
        if (withImage) {
            await sim.loadImage(await splitImageFile(64), 'vector_field');
            assert(sim.hasImage, 'loadImage must leave an image texture bound');
        }
        sim.renderFrame(view, 1 / 60);
        const pixels = await readTexturePixels(gpu.device, target);
        sim.destroy();
        return pixels;
    };

    const noise = await render({ vector_field_type: 'Noise' });
    const imageless = await render({ vector_field_type: 'Image' });
    const image = await render({ vector_field_type: 'Image' }, true);

    // Image mode with no image is the Rust's neutral 0.5 everywhere
    // (simulation.rs:308): every line the same angle, length and colour, i.e. a
    // comb. That is a different picture from the noise field, and from the
    // picture the same mode draws once a real image arrives.
    assert(
        meanAbsoluteError(noise, imageless) > 1,
        'switching to Image mode changed nothing — field_type is not reaching the shader'
    );
    assert(
        meanAbsoluteError(imageless, image) > 1,
        'loading an image changed nothing — binding 3 is still the placeholder'
    );
    assert(!hasNonFinite(image), 'the image path produced non-finite pixels');
    assert(!isUniform(image), 'the image path drew nothing');
});

test('the vectors image field reaches the render, split for split', async () => {
    const sim = await VectorsSimulation.create(gpu);
    const [target, view] = renderTarget(64, 'vectors image target');

    // The default LUT is a grey ramp, so a sample of 0 draws black-on-black and
    // a sample of 1 draws white: a black|white image must therefore come out as
    // an empty left half and a bright right half. That is the whole chain —
    // decode, fit, greyscale, r8unorm upload, `textureLoad` in the vertex stage,
    // LUT lookup in the fragment stage — asserted in one number.
    sim.applySettings(visibleVectorsSettings({ vector_field_type: 'Image' }));
    await sim.loadImage(await splitImageFile(64), 'vector_field');
    sim.renderFrame(view, 1 / 60);

    const pixels = await readTexturePixels(gpu.device, target);
    const red = channelOffset(gpu.format, 'r');
    let left = 0;
    let right = 0;
    for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
            const value = pixels[(y * 64 + x) * 4 + red];
            if (x < 24) left += value;
            else if (x >= 40) right += value;
        }
    }
    const leftMean = left / (24 * 64);
    const rightMean = right / (24 * 64);
    assert(
        rightMean - leftMean > 8,
        `the image's black|white split did not survive the upload: ` +
            `left ${leftMean.toFixed(1)} vs right ${rightMean.toFixed(1)}`
    );

    // Inverting the tone is a CPU re-fit (simulation.rs:532), not a shader flag
    // as it is in Moiré, so it has to actually re-upload the texture.
    sim.updateSetting('image_invert_tone', true);
    sim.renderFrame(view, 1 / 60);
    const inverted = await readTexturePixels(gpu.device, target);
    assert(
        meanAbsoluteError(pixels, inverted) > 1,
        'inverting the tone did not re-fit and re-upload the image'
    );

    sim.destroy();
    target.destroy();
});

test('vectors create/destroy x20 leaves the resource ledger clean', async () => {
    const ledger = new ResourceLedger();
    const instrumented: GpuContext = { ...gpu, device: instrumentDevice(gpu.device, ledger) };

    // Allocated on the *uninstrumented* device, so the test's own target does
    // not show up in the ledger it is asserting on.
    const churnTarget = gpu.device.createTexture({
        label: 'vectors churn target',
        size: { width: 32, height: 32 },
        format: gpu.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const churnView = churnTarget.createView();

    for (let i = 0; i < 20; i++) {
        const sim = await VectorsSimulation.create(instrumented);
        sim.applySettings(visibleVectorsSettings());
        // Load an image on half the cycles: the image texture is the one
        // resource created after construction, so a leak there would otherwise
        // never be exercised.
        if (i % 2 === 0) await sim.loadImage(await splitImageFile(16), 'vector_field');
        sim.renderFrame(churnView, 1 / 60);
        sim.destroy();
        sim.destroy();
    }

    const stats = ledger.stats();
    // Four per simulation: the params uniform, the LUT storage buffer, the
    // placeholder image texture and the camera uniform.
    assert(
        stats.created >= 20 * 4,
        `expected at least four tracked objects per simulation, saw ${stats.created} over 20`
    );
    assert(
        stats.live === 0,
        `${stats.live} GPU objects leaked over 20 cycles: ${JSON.stringify(stats.byLabel)}`
    );

    gpu.device.pushErrorScope('validation');
    const probe = createStorageBuffer(gpu.device, 256, { label: 'post-vectors probe' });
    const error = await gpu.device.popErrorScope();
    assert(error === null, `device unhealthy after 20 vectors cycles: ${error?.message}`);
    probe.destroy();
    churnTarget.destroy();
});

// ---------------------------------------------------------------------------
// Gradient — M6
// ---------------------------------------------------------------------------

/**
 * Everything here renders at exactly `BAYER_PERIOD_PX`.
 *
 * `bayer_dither` (gradient.wgsl:163) indexes its 16×16 matrix off the
 * interpolated `uv` rather than off `@builtin(position)`, so the threshold
 * lattice is a fraction of the target rather than a fixed pixel grid. At 256 px
 * every one of the 256 thresholds is visited exactly once per 256×256 block,
 * which is the shader at its intended resolution; at the 48–64 px the other
 * sims test at, only the sixteen *lowest* thresholds (0..15 of 255) are ever
 * sampled and the dither collapses into a hard edge that would pass a
 * carelessly-written test while showing almost nothing.
 */
const GRADIENT_SIZE = BAYER_PERIOD_PX;

/** Mean of one channel down each column — i.e. the horizontal ramp itself. */
function columnMeans(pixels: Uint8Array, size: number, offset: number): Float64Array {
    const means = new Float64Array(size);
    for (let x = 0; x < size; x++) {
        let total = 0;
        for (let y = 0; y < size; y++) total += pixels[(y * size + x) * 4 + offset];
        means[x] = total / size;
    }
    return means;
}

/**
 * Columns whose channel value is not constant top to bottom.
 *
 * `fs_main` derives its colour from `uv.x` alone *except* through the dither,
 * which is the only term that reads `uv.y`. So this count is a direct measure
 * of whether the dither ran: it is 0 for smooth mode and for a dither that has
 * silently become a plain quantiser, and large otherwise.
 */
function verticallyVaryingColumns(pixels: Uint8Array, size: number, offset: number): number[] {
    const columns: number[] = [];
    for (let x = 0; x < size; x++) {
        let min = 255;
        let max = 0;
        for (let y = 0; y < size; y++) {
            const v = pixels[(y * size + x) * 4 + offset];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        // >1 rather than >0: unorm8 rounding, not the dither, is worth a step.
        if (max - min > 1) columns.push(x);
    }
    return columns;
}

/** Render one frame of a gradient simulation into a fresh target and read it back. */
async function renderGradient(sim: GradientSimulation): Promise<Uint8Array> {
    const [target, view] = renderTarget(GRADIENT_SIZE, 'gradient target');
    sim.renderFrame(view, 1 / 60);
    const pixels = await readTexturePixels(gpu.device, target);
    target.destroy();
    return pixels;
}

test('gradient constructs and tears down with no validation error', async () => {
    gpu.device.pushErrorScope('validation');

    const sim = await GradientSimulation.create(gpu);
    const [target, view] = renderTarget(48, 'gradient validation target');
    sim.renderFrame(view, 1 / 60);
    sim.renderFramePaused(view);
    // resize is a no-op (simulation.rs:322) but the host calls it on every
    // ResizeObserver tick, so it must at least not invalidate the pipeline.
    sim.resize(96, 96);
    sim.setDisplayMode(GRADIENT_DISPLAY_MODE.dithered);
    sim.renderFrame(view, 1 / 60);
    sim.destroy();
    target.destroy();

    const error = await gpu.device.popErrorScope();
    assert(error === null, `gradient produced a validation error: ${error?.message}`);
});

test('gradient shows the default identity ramp before any LUT is pushed', async () => {
    // The Rust seeds R=G=B=0..255 at construction (simulation.rs:142-153). In a
    // browser a colour scheme arrives over a fetch, so without this seed the
    // first frame would read an unwritten storage buffer — solid black, and
    // indistinguishable from a broken pipeline.
    const sim = await GradientSimulation.create(gpu);
    const pixels = await renderGradient(sim);

    assert(!hasNonFinite(pixels), 'the gradient produced non-finite pixels');
    assert(!isUniform(pixels), 'the default ramp rendered flat — the LUT was never seeded');

    const red = channelOffset(gpu.format, 'r');
    const green = channelOffset(gpu.format, 'g');
    const blue = channelOffset(gpu.format, 'b');

    // A grey ramp: all three channels carry the same value at every pixel.
    for (let i = 0; i < pixels.length; i += 4) {
        assert(
            Math.abs(pixels[i + red] - pixels[i + green]) <= 1 &&
                Math.abs(pixels[i + red] - pixels[i + blue]) <= 1,
            `the identity ramp is not grey at byte ${i}: ` +
                `${pixels[i + red]}/${pixels[i + green]}/${pixels[i + blue]}`
        );
    }

    // `sample_lut` maps uv.x through `clamp(index * 255, 0, 255)` with bilinear
    // interpolation, so column x lands on (x + 0.5) * 255 / 256.
    const means = columnMeans(pixels, GRADIENT_SIZE, red);
    let error = 0;
    for (let x = 0; x < GRADIENT_SIZE; x++) {
        error += Math.abs(means[x] - ((x + 0.5) * 255) / 256);
    }
    error /= GRADIENT_SIZE;
    assert(error <= 2, `identity ramp deviates from the LUT by ${error.toFixed(2)} levels`);

    assert(means[0] <= 4, `the ramp starts at ${means[0].toFixed(1)}, not near black`);
    assert(
        means[GRADIENT_SIZE - 1] >= 250,
        `the ramp ends at ${means[GRADIENT_SIZE - 1].toFixed(1)}, not near white`
    );
    for (let x = 1; x < GRADIENT_SIZE; x++) {
        assert(
            means[x] >= means[x - 1] - 1,
            `the ramp is not monotonic at column ${x}: ${means[x - 1]} -> ${means[x]}`
        );
    }

    sim.destroy();
});

test('gradient repaints when a LUT is pushed', async () => {
    const sim = await GradientSimulation.create(gpu);
    const before = await renderGradient(sim);

    // Each channel gets a distinct shape, so the planar [R][G][B] layout is
    // asserted as well as "something changed": a transposed LUT would show up
    // as the wrong channel ramping.
    const lut = new Uint32Array(768);
    for (let i = 0; i < 256; i++) {
        lut[i] = i; // red ramps up
        lut[256 + i] = 255 - i; // green ramps down
        lut[512 + i] = 128; // blue constant
    }
    sim.updateColorScheme(lut, false);

    const after = await renderGradient(sim);
    assert(!hasNonFinite(after), 'the pushed LUT produced non-finite pixels');
    assert(
        meanAbsoluteError(before, after) > 20,
        'pushing a LUT did not change the image — update_gradient_preview reaches nothing'
    );

    const red = columnMeans(after, GRADIENT_SIZE, channelOffset(gpu.format, 'r'));
    const green = columnMeans(after, GRADIENT_SIZE, channelOffset(gpu.format, 'g'));
    const blueStats = channelStats(after, channelOffset(gpu.format, 'b'));

    assert(
        red[GRADIENT_SIZE - 1] - red[0] > 200,
        `red should ramp up across the quad, got ${red[0].toFixed(1)} -> ${red[GRADIENT_SIZE - 1].toFixed(1)}`
    );
    assert(
        green[0] - green[GRADIENT_SIZE - 1] > 200,
        `green should ramp down across the quad, got ${green[0].toFixed(1)} -> ${green[GRADIENT_SIZE - 1].toFixed(1)}`
    );
    assertClose(blueStats.mean, 128, 2, 'the constant blue plane');
    assert(
        blueStats.max - blueStats.min <= 2,
        `blue was declared constant but spans ${blueStats.min}..${blueStats.max}`
    );

    // A LUT of the wrong length is a caller bug that would otherwise write a
    // short buffer and leave the tail of the previous scheme showing.
    let threw = false;
    try {
        sim.updateColorScheme(new Uint32Array(256), false);
    } catch {
        threw = true;
    }
    assert(threw, 'a 256-entry LUT must be rejected, not written');

    sim.destroy();
});

test('gradient display modes produce distinct images', async () => {
    const sim = await GradientSimulation.create(gpu);

    sim.setDisplayMode(GRADIENT_DISPLAY_MODE.smooth);
    const smooth = await renderGradient(sim);
    assert(sim.getState().display_mode === 0, 'state must report the mode that was set');

    sim.setDisplayMode(GRADIENT_DISPLAY_MODE.dithered);
    const dithered = await renderGradient(sim);
    assert(sim.getState().display_mode === 1, 'state must report the mode that was set');

    assert(
        meanAbsoluteError(smooth, dithered) > 3,
        'smooth and dithered rendered the same image — params never reached the shader'
    );

    // `quantize_color` (gradient.wgsl:192) rounds to 16 levels, and the dither
    // only ever adds one whole step, so every byte must sit on the lattice.
    const step = GRADIENT_QUANTIZATION_STEP;
    const red = channelOffset(gpu.format, 'r');
    let offLattice = 0;
    let samples = 0;
    for (let i = red; i < dithered.length; i += 4) {
        samples++;
        if (Math.abs(dithered[i] - Math.round(dithered[i] / step) * step) > 1) offLattice++;
    }
    assert(
        offLattice / samples < 0.02,
        `${((offLattice / samples) * 100).toFixed(1)}% of dithered pixels are off the ` +
            `16-level lattice — the quantiser did not run`
    );

    // The unknown-mode arm (gradient.wgsl:228) falls back to smooth, and the
    // parser clamps to it so get_current_state never reports a mode the shader
    // will not take.
    assert(parseGradientDisplayMode(7) === GRADIENT_DISPLAY_MODE.smooth, 'unknown -> smooth');
    assert(parseGradientDisplayMode('1') === GRADIENT_DISPLAY_MODE.dithered, '"1" -> dithered');
    sim.updateState('display_mode', 9);
    assert(sim.getState().display_mode === 0, 'an out-of-range mode must clamp to smooth');
    sim.updateState('displayMode', 1);
    assert(sim.getState().display_mode === 1, 'the Rust spelling must work too');

    sim.destroy();
});

test('the Bayer dither breaks the bands it is there to break', async () => {
    // A dither that silently becomes a no-op looks fine in a screenshot — the
    // image is still a gradient, just a banded one — so it is measured rather
    // than eyeballed. Here: the dithered image must vary along y, since the
    // threshold is the only term in fs_main that reads uv.y at all, and the
    // smooth image must not. The sibling test below then checks that the
    // variation averages back to the right colour rather than merely existing.
    const sim = await GradientSimulation.create(gpu);
    const red = channelOffset(gpu.format, 'r');

    sim.setDisplayMode(GRADIENT_DISPLAY_MODE.smooth);
    const smooth = await renderGradient(sim);
    const smoothVarying = verticallyVaryingColumns(smooth, GRADIENT_SIZE, red);
    assert(
        smoothVarying.length === 0,
        `smooth mode varies down ${smoothVarying.length} columns — fs_main should ` +
            `depend on uv.x alone when the dither is off`
    );

    sim.setDisplayMode(GRADIENT_DISPLAY_MODE.dithered);
    const dithered = await renderGradient(sim);
    const varying = verticallyVaryingColumns(dithered, GRADIENT_SIZE, red);
    assert(
        varying.length >= 60,
        `only ${varying.length} of ${GRADIENT_SIZE} columns dither — a plain quantiser ` +
            `would give 0, so the Bayer threshold is barely reaching the comparison`
    );

    // Adjacent pixels must actually alternate, not merely differ somewhere down
    // the column: the point of an ordered dither is the high-frequency mix.
    let alternating = 0;
    for (const x of varying) {
        for (let y = 1; y < GRADIENT_SIZE; y++) {
            const a = dithered[((y - 1) * GRADIENT_SIZE + x) * 4 + red];
            const b = dithered[(y * GRADIENT_SIZE + x) * 4 + red];
            if (Math.abs(a - b) >= GRADIENT_QUANTIZATION_STEP - 1) alternating++;
        }
    }
    assert(
        alternating > varying.length * 4,
        `only ${alternating} adjacent-pixel level swaps across ${varying.length} dithering ` +
            `columns — the threshold pattern is not spatially varied`
    );

    /*
     * Pins a defect in the shader, reproduced rather than fixed.
     *
     * `apply_display_mode` (gradient.wgsl:216-224) quantises with `round` and
     * then tests `color > quantized + threshold * step`. For any colour *below*
     * its nearest level that test is false at every threshold, so the upper
     * half of every band is snapped hard and never dithers; only the lower half
     * mixes, and it can only ever reach a 50% mix. An ordered dither wants
     * `floor(color / step + threshold) * step`, which dithers the whole band.
     *
     * Consequence: every band is half dithered and half hard-edged, so banding
     * survives at each band's midpoint — exactly what the pass exists to
     * remove. Not fixed here because the shader is shared with the desktop
     * build and the change alters the dithered preview at every colour: an M14
     * visual-parity decision, in the same class as M3's `advect_strength`
     * blend. Asserted as-is so that when someone does change it, this says so.
     */
    const step = GRADIENT_QUANTIZATION_STEP;
    const smoothMeans = columnMeans(smooth, GRADIENT_SIZE, red);
    let aboveNearestLevel = 0;
    let belowNearestLevel = 0;
    for (const x of varying) {
        const c = smoothMeans[x];
        const level = Math.round(c / step) * step;
        if (c > level + 1) aboveNearestLevel++;
        else if (c < level - 1) belowNearestLevel++;
    }
    assert(
        aboveNearestLevel > 40,
        `only ${aboveNearestLevel} dithering columns sit above their nearest level`
    );
    assert(
        belowNearestLevel === 0,
        `${belowNearestLevel} columns below their nearest level now dither — the ` +
            `round-instead-of-floor defect at gradient.wgsl:216 has been fixed; ` +
            `record it in WEB_PORT.md and update this assertion`
    );

    sim.destroy();
});

test('the dither averages back to the colour quantisation would have lost', async () => {
    /*
     * The measurement above says the dither *moves* pixels; this one says it
     * moves them to the right place, which is the whole reason banding is worth
     * trading for noise.
     *
     * It uses a flat LUT rather than the ramp deliberately. Averaged down a
     * single column the ramp gives a misleading answer: the 16 thresholds a
     * column sees are one column of the Bayer matrix, and those are strongly
     * clustered ({0,3,12,15,48,51,60,63,192,…} for x=0) even though the matrix
     * as a whole is equidistributed. A dither is only accurate over a 2D
     * neighbourhood, so the whole image has to be one colour for the mean to
     * mean anything.
     */
    const flat = 124;
    const step = GRADIENT_QUANTIZATION_STEP;
    const nearestLevel = Math.round(flat / step) * step; // 119
    assert(
        Math.abs(flat - nearestLevel) > 3,
        'the probe colour must sit well away from a quantisation level'
    );

    const lut = new Uint32Array(768).fill(flat);
    const sim = await GradientSimulation.create(gpu, lut);
    const red = channelOffset(gpu.format, 'r');

    sim.setDisplayMode(GRADIENT_DISPLAY_MODE.smooth);
    const smooth = await renderGradient(sim);
    assertClose(channelStats(smooth, red).mean, flat, 1, 'a flat LUT in smooth mode');

    sim.setDisplayMode(GRADIENT_DISPLAY_MODE.dithered);
    const dithered = await renderGradient(sim);
    const stats = channelStats(dithered, red);

    // Two levels and only two: the dither adds exactly one step, never more.
    assertClose(stats.min, nearestLevel, 1, 'the lower dither level');
    assertClose(stats.max, nearestLevel + step, 1, 'the upper dither level');

    const ditherError = Math.abs(stats.mean - flat);
    const quantiseError = Math.abs(nearestLevel - flat);
    assert(
        ditherError < quantiseError * 0.25,
        `the dithered mean is off by ${ditherError.toFixed(2)} where plain quantisation ` +
            `is off by ${quantiseError.toFixed(2)} — the dither is decorative`
    );

    // Every one of the 256 thresholds is visited once per 256x256 block, so the
    // mix is not merely close on average but exactly the expected count.
    const expectedFraction = Math.ceil((256 * (flat - nearestLevel)) / step) / 256;
    let raised = 0;
    let total = 0;
    for (let i = red; i < dithered.length; i += 4) {
        total++;
        if (dithered[i] > nearestLevel + step / 2) raised++;
    }
    assertClose(raised / total, expectedFraction, 0.01, 'the fraction of raised pixels');

    sim.destroy();
});

test('gradient create/destroy x20 leaves the resource ledger clean', async () => {
    const ledger = new ResourceLedger();
    const instrumented: GpuContext = { ...gpu, device: instrumentDevice(gpu.device, ledger) };

    // Allocated on the *uninstrumented* device, so the test's own target does
    // not show up in the ledger it is asserting on.
    const churnTarget = gpu.device.createTexture({
        label: 'gradient churn target',
        size: { width: 32, height: 32 },
        format: gpu.format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const churnView = churnTarget.createView();
    const lut = defaultGradientLut();

    for (let i = 0; i < 20; i++) {
        const sim = await GradientSimulation.create(instrumented);
        sim.renderFrame(churnView, 1 / 60);
        sim.updateColorScheme(lut, false);
        sim.setDisplayMode(i % 2);
        sim.renderFrame(churnView, 1 / 60);
        sim.destroy();
        // destroy() is contractually idempotent — the host calls it on both
        // teardown paths — and must not double-count.
        sim.destroy();
    }

    const stats = ledger.stats();
    assert(
        stats.created >= 20 * 4,
        `expected four tracked buffers per simulation, saw ${stats.created} over 20`
    );
    assert(
        stats.live === 0,
        `${stats.live} GPU objects leaked over 20 cycles: ${JSON.stringify(stats.byLabel)}`
    );

    gpu.device.pushErrorScope('validation');
    const probe = createStorageBuffer(gpu.device, 256, { label: 'post-gradient probe' });
    const error = await gpu.device.popErrorScope();
    assert(error === null, `device unhealthy after 20 gradient cycles: ${error?.message}`);
    probe.destroy();
    churnTarget.destroy();
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const corpus = await fetch('/shaders.json').then((r) => r.json());
    globalThis.__VIZZA_SHADERS__ = corpus;

    for (const [name, fn] of tests) {
        const started = performance.now();
        try {
            await fn();
            results.push({ name, ok: true, ms: performance.now() - started });
        } catch (err) {
            results.push({
                name,
                ok: false,
                error: err instanceof Error ? `${err.message}` : String(err),
                ms: performance.now() - started,
            });
            // Everything after a failed device init would fail identically and
            // bury the real cause, so stop there.
            if (name.startsWith('initGpu')) break;
        }
    }

    await fetch('/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ results, shaderCount: shaderPathsNow().length }),
    });
}

main().catch(async (err) => {
    await fetch('/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            results: [
                {
                    name: 'harness',
                    ok: false,
                    error: String(err && err.stack ? err.stack : err),
                    ms: 0,
                },
            ],
        }),
    });
});
