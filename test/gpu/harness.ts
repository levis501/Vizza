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
import { createTexture2d, readTexturePixels } from '$lib/engine/resources/textures';
import { PingPongTextures } from '$lib/engine/resources/pingPong';
import { BindGroupLayoutCache } from '$lib/engine/resources/bindGroupCache';
import { readBuffer, createStorageBuffer, align } from '$lib/engine/resources/buffers';
import { AverageColor } from '$lib/engine/postprocess/averageColor';
import { PostProcessing, defaultPostProcessingState } from '$lib/engine/postprocess/PostProcessing';
import { MainMenuSimulation, defaultLut, reverseLut } from '$lib/engine/sims/mainMenu';
import { MoireSimulation } from '$lib/engine/sims/moire';
import { defaultMoireSettings } from '$lib/engine/sims/moire/settings';
import { calculateTileCount } from '$lib/engine/render/InfiniteRenderer';
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

test('all WGSL modules compile with zero errors', async () => {
    const paths = shaderPathsNow();
    assert(paths.length >= 60, `expected the full corpus, found only ${paths.length} shaders`);

    const failures: string[] = [];
    const failedPaths = new Set<string>();

    for (const path of paths) {
        const module = gpu.device.createShaderModule({ label: path, code: getShader(path) });
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
