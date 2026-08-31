/**
 * Gradient — a port of gradient/simulation.rs (377 ln) around
 * `gradient/shaders/gradient.wgsl` (326 ln).
 *
 * Registered as a simulation like any other, but it is really the live preview
 * behind the gradient editor: one full-screen quad whose fragment shader reads
 * the 768-entry LUT storage buffer as a left-to-right ramp, with a display-mode
 * switch selecting smooth or Amiga-style ordered dithering. No compute pass, no
 * ping-pong, no camera, no settings — the smallest simulation in the repo, and
 * the only one whose entire job is to show a colour scheme.
 *
 * Follows `sims/mainMenu` rather than `sims/moire`: both are render-only
 * shader backgrounds over a LUT with no simulation state to advance, so the
 * shape — build every pipeline and bind group once in `create`, draw the same
 * thing every frame, destroy the buffers — carries across directly. The one
 * structural difference from mainMenu is that the vertex data is real: the Rust
 * pipeline feeds `vs_main` from a vertex buffer plus a u16 index buffer
 * (simulation.rs:42-60), and `vs_main`'s `VertexInput` is part of the corpus
 * shared with the desktop build, so the quad is uploaded rather than derived
 * from `@builtin(vertex_index)`.
 *
 * Three things about the shader are worth knowing before reading further, all
 * discussed in the comments where they bite:
 *
 *  1. Roughly 180 of its 326 lines — every sRGB↔linear↔XYZ↔Lab↔OKLab function
 *     and all three `interpolate_*` entry points — are **dead**. `fs_main`
 *     calls `sample_lut` and `apply_display_mode` and nothing else. The editor
 *     interpolates on the CPU (`engine/color/spaces.ts`, which replaced culori
 *     in M6) and pushes a finished 768-byte LUT, so the GPU never converts a
 *     colour space. The shader is not the reference implementation of anything
 *     the app actually runs.
 *  2. The dither is indexed from `uv`, not from `@builtin(position)`, so its
 *     cell size scales with the render target (see BAYER_PERIOD_PX below).
 *  3. The quantiser rounds where an ordered dither needs to floor, which makes
 *     the dither a no-op over the upper half of every band. Reproduced, not
 *     fixed — see the note on `apply_display_mode` below.
 */

import type { GpuContext, Simulation, SimulationId } from '$lib/engine/types';
import { getShader } from '$lib/engine/shaders';
import {
    createBindGroupChecked,
    createRenderPipelineChecked,
    createShaderModuleChecked,
} from '$lib/engine/gpu/errorScopes';
import {
    createBufferWithData,
    createUniformBuffer,
    writeBuffer,
} from '$lib/engine/resources/buffers';

export const GRADIENT_SHADER_PATH = 'gradient/shaders/gradient.wgsl';

/** 768 u32 entries, planar [R×256][G×256][B×256] — see color/ColorScheme.ts. */
const LUT_ENTRIES = 768;

/**
 * `GradientParams` (gradient.wgsl:23) — one `u32` plus three words of padding.
 * The Rust allocates the same 16 bytes at simulation.rs:82.
 */
const PARAMS_WORDS = 4;

/**
 * What `params.display_mode` selects in `apply_display_mode`
 * (gradient.wgsl:205). There are exactly two: the `else` arm at :228 falls back
 * to smooth for anything else, which `parseGradientDisplayMode` mirrors so an
 * out-of-range value never reaches the GPU in the first place.
 */
export const GRADIENT_DISPLAY_MODE = {
    /** The LUT sampled and shown as-is, bilinearly interpolated. */
    smooth: 0,
    /** Quantised to 16 levels per channel, then ordered-dithered. */
    dithered: 1,
} as const;

export type GradientDisplayMode =
    (typeof GRADIENT_DISPLAY_MODE)[keyof typeof GRADIENT_DISPLAY_MODE];

/** `quantize_color` (gradient.wgsl:192) rounds to 16 levels per channel. */
export const GRADIENT_QUANTIZATION_LEVELS = 16;

/** `255 / (levels - 1)` = 17 — the step both `quantize_color` and the dither use. */
export const GRADIENT_QUANTIZATION_STEP = 255 / (GRADIENT_QUANTIZATION_LEVELS - 1);

/**
 * Pixels per full 16×16 Bayer cell, along either axis.
 *
 * `bayer_dither` (gradient.wgsl:163) indexes the matrix as
 * `u32(fract(uv * 16.0) * 16.0)`, i.e. from the *interpolated uv*, not from
 * `@builtin(position)`. So the 16×16 threshold matrix repeats 16 times across
 * the target and each matrix entry covers `size / 256` pixels — the pattern
 * scales with the window instead of being locked to the pixel grid, and only a
 * target that is a multiple of 256 px visits all 256 thresholds. Below that the
 * sub-lattice sampled is systematically biased: at 64 px only the 16 *lowest*
 * thresholds (0..15 of 255) are ever hit, so the dither degenerates into a hard
 * threshold at each band edge. That is a property of the shader, not of the
 * port; it is called out here because it decides what a dither test must
 * render at.
 */
export const BAYER_PERIOD_PX = 256;

/** Mirrors `gradient/state.rs`, which is what `get_current_state` returns. */
export interface GradientState extends Record<string, unknown> {
    display_mode: number;
}

/**
 * The full-screen quad from simulation.rs:42-49: `[position.xy, uv.xy]` per
 * vertex, wound counter-clockwise so the pipeline's back-face culling passes.
 * `uv.x` is what `fs_main` uses as the gradient position, so vertex 0 sits at
 * the left edge and the ramp runs left to right.
 */
const QUAD_VERTICES = new Float32Array([
    -1.0, -1.0, 0.0, 0.0, 1.0, -1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0, -1.0, 1.0, 0.0, 1.0,
]);

/** simulation.rs:52 — two triangles over the four quad corners. */
const QUAD_INDICES = new Uint16Array([0, 1, 2, 0, 2, 3]);

const VERTEX_LAYOUT: GPUVertexBufferLayout = {
    arrayStride: 16,
    stepMode: 'vertex',
    attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' },
        { shaderLocation: 1, offset: 8, format: 'float32x2' },
    ],
};

export class GradientSimulation implements Simulation {
    readonly id: SimulationId = 'gradient';

    private readonly device: GPUDevice;
    private readonly format: GPUTextureFormat;
    private readonly pipeline: GPURenderPipeline;

    private readonly vertexBuffer: GPUBuffer;
    private readonly indexBuffer: GPUBuffer;
    private readonly lutBuffer: GPUBuffer;
    private readonly paramsBuffer: GPUBuffer;
    private readonly bindGroup: GPUBindGroup;

    private readonly paramScratch = new Uint32Array(PARAMS_WORDS);

    private displayMode: number = GRADIENT_DISPLAY_MODE.smooth;
    private colorSchemeReversed = false;
    private guiVisible = true;
    private destroyed = false;

    private constructor(init: {
        device: GPUDevice;
        format: GPUTextureFormat;
        pipeline: GPURenderPipeline;
        vertexBuffer: GPUBuffer;
        indexBuffer: GPUBuffer;
        lutBuffer: GPUBuffer;
        paramsBuffer: GPUBuffer;
        bindGroup: GPUBindGroup;
    }) {
        this.device = init.device;
        this.format = init.format;
        this.pipeline = init.pipeline;
        this.vertexBuffer = init.vertexBuffer;
        this.indexBuffer = init.indexBuffer;
        this.lutBuffer = init.lutBuffer;
        this.paramsBuffer = init.paramsBuffer;
        this.bindGroup = init.bindGroup;
    }

    static async create(gpu: GpuContext, lut?: Uint32Array): Promise<GradientSimulation> {
        const { device, format } = gpu;

        const module = await createShaderModuleChecked(device, {
            label: 'gradient',
            code: getShader(GRADIENT_SHADER_PATH),
        });

        // One group, matching simulation.rs:71-79: the LUT as read-only storage
        // and the params uniform, both fragment-only.
        const layout = device.createBindGroupLayout({
            label: 'gradient bind group layout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'read-only-storage' },
                },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });

        const vertexBuffer = createBufferWithData(
            device,
            QUAD_VERTICES,
            GPUBufferUsage.VERTEX,
            'gradient vertices'
        );
        const indexBuffer = createBufferWithData(
            device,
            QUAD_INDICES,
            GPUBufferUsage.INDEX,
            'gradient indices'
        );
        const lutBuffer = createBufferWithData(
            device,
            lut && lut.length === LUT_ENTRIES ? lut : defaultGradientLut(),
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            'gradient lut'
        );
        const paramsBuffer = createUniformBuffer(device, PARAMS_WORDS * 4, {
            label: 'gradient params',
        });
        // simulation.rs:86 writes the same zeroed params before first use, so
        // the buffer is never read while uninitialised.
        device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array(PARAMS_WORDS));

        const pipeline = await createRenderPipelineChecked(device, {
            label: 'gradient render pipeline',
            layout: device.createPipelineLayout({
                label: 'gradient pipeline layout',
                bindGroupLayouts: [layout],
            }),
            vertex: { module, entryPoint: 'vs_main', buffers: [VERTEX_LAYOUT] },
            fragment: {
                module,
                entryPoint: 'fs_main',
                targets: [{ format, writeMask: GPUColorWrite.ALL }],
            },
            // Matches simulation.rs:127-135. Culling a full-screen quad buys
            // nothing, but a winding mistake then fails loudly and visibly
            // rather than half-drawing.
            primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'back' },
        });

        const bindGroup = await createBindGroupChecked(device, {
            label: 'gradient bind group',
            layout,
            entries: [
                { binding: 0, resource: { buffer: lutBuffer } },
                { binding: 1, resource: { buffer: paramsBuffer } },
            ],
        });

        return new GradientSimulation({
            device,
            format,
            pipeline,
            vertexBuffer,
            indexBuffer,
            lutBuffer,
            paramsBuffer,
            bindGroup,
        });
    }

    // -----------------------------------------------------------------------
    // Simulation
    // -----------------------------------------------------------------------

    /**
     * Nothing advances, so a live frame and a paused frame are the same image —
     * as they are in the Rust, whose `render_frame_paused` just calls
     * `render_frame` (simulation.rs:230).
     */
    renderFrame(view: GPUTextureView, _dt: number): void {
        this.draw(view);
    }

    renderFramePaused(view: GPUTextureView): void {
        this.draw(view);
    }

    resize(_width: number, _height: number): void {
        // simulation.rs:322 — nothing is sized to the surface. The quad is in
        // clip space and the dither is indexed from uv, so the image simply
        // stretches. (That the dither stretches with it is the shader's own
        // choice; see BAYER_PERIOD_PX.)
    }

    /** `Settings` is a unit struct (settings.rs:4) — there is nothing to expose. */
    getSettings(): Record<string, unknown> {
        return {};
    }

    getState(): GradientState {
        return { display_mode: this.displayMode };
    }

    updateSetting(_name: string, _value: unknown): void {
        // simulation.rs:333 — the Rust accepts and ignores every setting name.
    }

    /**
     * The Rust matches on `"displayMode"` (simulation.rs:245) while `get_state`
     * serialises the field as `display_mode` — so a value read back out of
     * `get_current_state` could not be written back in. Nothing in the tree
     * exercises that path (the editor uses the dedicated
     * `set_gradient_display_mode` command), so this is a latent inconsistency
     * rather than a live bug, and both spellings are accepted here for the same
     * reason M5's noise-type parser accepts both of `NoiseType`'s: two spellings
     * that cannot diverge into a failure.
     */
    updateState(name: string, value: unknown): void {
        switch (name) {
            case 'display_mode':
            case 'displayMode':
                this.setDisplayMode(parseGradientDisplayMode(value));
                return;
            default:
                console.warn(`Unknown state parameter for Gradient: ${name}`);
        }
    }

    applySettings(_settings: Record<string, unknown>): void {
        // simulation.rs:365 — no settings to apply.
    }

    handleMouseInteraction(_worldX: number, _worldY: number, _button: number): void {
        // simulation.rs:280 — the gradient preview has no pointer interaction.
    }

    handleMouseRelease(_button: number): void {}

    resetRuntimeState(): void {
        // simulation.rs:372 — no runtime state.
    }

    randomizeSettings(): void {
        // simulation.rs:381 — nothing to randomize.
    }

    /**
     * Write a new LUT. This is both `apply_color_scheme_by_name` and the
     * editor's live `update_gradient_preview`; the Rust routes them to
     * `update_color_scheme` (simulation.rs:388) and `update_lut`
     * (simulation.rs:171) respectively, which are the same three lines.
     *
     * `reversed` is recorded and not applied: the bytes arriving here have
     * already been reversed by `ColorSchemeManager`, so reversing again would
     * cancel out. That is the M3 defect-4 arrangement — the desktop build's
     * reversal is a no-op for exactly this reason, one layer further down —
     * and `sims/mainMenu` is the one place still double-reversing.
     */
    updateColorScheme(lut: Uint32Array, reversed: boolean): void {
        if (lut.length !== LUT_ENTRIES) {
            throw new Error(`LUT must be ${LUT_ENTRIES} u32 entries, got ${lut.length}`);
        }
        this.colorSchemeReversed = reversed;
        writeBuffer(this.device.queue, this.lutBuffer, lut);
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.vertexBuffer.destroy();
        this.indexBuffer.destroy();
        this.lutBuffer.destroy();
        this.paramsBuffer.destroy();
    }

    // -----------------------------------------------------------------------
    // Beyond the Simulation interface
    // -----------------------------------------------------------------------

    /** Port of `set_display_mode` (simulation.rs:178). */
    setDisplayMode(mode: number): void {
        this.displayMode = mode;
        this.paramScratch[0] = mode;
        this.device.queue.writeBuffer(this.paramsBuffer, 0, this.paramScratch);
    }

    getDisplayMode(): number {
        return this.displayMode;
    }

    /** Whether the LUT currently on the GPU came from a reversed scheme. */
    isColorSchemeReversed(): boolean {
        return this.colorSchemeReversed;
    }

    /** simulation.rs:307 — the backend half of the `toggle_gui` command. */
    toggleGui(): boolean {
        this.guiVisible = !this.guiVisible;
        return this.guiVisible;
    }

    isGuiVisible(): boolean {
        return this.guiVisible;
    }

    /** Exposed so a host can confirm it configured the canvas with the same format. */
    get targetFormat(): GPUTextureFormat {
        return this.format;
    }

    private draw(view: GPUTextureView): void {
        if (this.destroyed) return;

        const encoder = this.device.createCommandEncoder({ label: 'gradient' });
        const pass = encoder.beginRenderPass({
            label: 'gradient render pass',
            colorAttachments: [
                {
                    view,
                    loadOp: 'clear',
                    storeOp: 'store',
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                },
            ],
        });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        pass.setVertexBuffer(0, this.vertexBuffer);
        pass.setIndexBuffer(this.indexBuffer, 'uint16');
        pass.drawIndexed(QUAD_INDICES.length);
        pass.end();

        this.device.queue.submit([encoder.finish()]);
    }
}

export async function createGradient(gpu: GpuContext): Promise<Simulation> {
    return GradientSimulation.create(gpu);
}

/**
 * Anything that is not a recognised mode is smooth.
 *
 * `apply_display_mode`'s final `else` (gradient.wgsl:228) already does this on
 * the GPU, but clamping here keeps `get_current_state` reporting a mode the
 * shader will actually take rather than the raw number it was handed.
 */
export function parseGradientDisplayMode(value: unknown): GradientDisplayMode {
    const mode = Number(value);
    return mode === GRADIENT_DISPLAY_MODE.dithered
        ? GRADIENT_DISPLAY_MODE.dithered
        : GRADIENT_DISPLAY_MODE.smooth;
}

/**
 * The identity ramp the Rust seeds at construction (simulation.rs:142-153):
 * R, G and B each 0→255, i.e. black to white.
 *
 * Reproduced rather than skipped for the reason `sims/mainMenu`'s
 * `defaultLut()` exists — a colour scheme reaches the browser through a network
 * fetch, and a fetch must not sit on the critical path to first paint. Without
 * it the first frame of the editor would be an unwritten storage buffer, which
 * reads as all zeroes and so as a solid black preview.
 */
export function defaultGradientLut(): Uint32Array {
    const lut = new Uint32Array(LUT_ENTRIES);
    for (let i = 0; i < 256; i++) {
        lut[i] = i;
        lut[256 + i] = i;
        lut[512 + i] = i;
    }
    return lut;
}
