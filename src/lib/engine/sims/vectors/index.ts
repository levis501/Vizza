/**
 * Vectors — a port of vectors/simulation.rs (919 ln) around a **new** entry-point
 * shader, `line_instanced.wgsl`, plus `noise.wgsl` and the unmodified
 * `line_fragment.wgsl`.
 *
 * The third simulation ported, and the first that is a plain render pass: no
 * compute stage, no ping-pong, no simulation texture, and — this is the whole
 * shape of the milestone — **no vertex buffer**.
 *
 * ## What went away
 *
 * The desktop build samples the `noise` crate on the CPU, once per grid point,
 * fills a `Vec<LineVertex>` of four vertices and six indices per line, and
 * uploads both buffers in `update_geometry` (simulation.rs:261). It does that
 * whenever `geometry_dirty` (simulation.rs:393) says so — which includes
 * `self.time != self.last_time`, i.e. **every frame the clock advances**, and
 * again unconditionally at the end of every `update_setting` arm
 * (simulation.rs:782), including the one that only changes the clear colour.
 *
 * With the noise on the GPU (`shaders/noise.wgsl`, landed alongside this) the
 * grid is regular enough to derive entirely from `@builtin(instance_index)`, so
 * that whole path is gone: no vertex buffer, no index buffer, no dirty check,
 * no rebuild. One 48-byte uniform is written per frame and one
 * `draw(6, lineCount)` is issued. `VectorsSettingEffect`'s `'geometry'` is
 * therefore a no-op here, which is why `applyEffect` below does nothing for it.
 *
 * ## The CPU/GPU contract
 *
 * The CPU still decides *how many* lines there are, because that is the
 * instance count on the draw call; the GPU decides *where each one is*, from its
 * index. The two must agree exactly or the field tears at its edge or draws a
 * column twice — the same hazard as `InfiniteRenderer.calculateTileCount`, and
 * handled the same way: `vectorsGridPointAt` below is a literal port of
 * `vectors_grid_point` in the WGSL, and the L3 harness pins the pair both by
 * reading the shader text and by running the shader's own mirror functions
 * against the TypeScript.
 *
 * ## Four deliberate divergences
 *
 *   1. `vectorsGridExtent` caps the grid at `VECTORS_MAX_LINES` by *raising the
 *      spacing*. The Rust is unbounded and the UI's density minimum would ask
 *      for a 2401² grid; see that function's comment for the arithmetic.
 *   2. The noise is a re-implementation calibrated to the crate's character,
 *      not its output, so the same seed renders a different field on the two
 *      builds. See the header of `noise.wgsl`.
 *   3. `update_setting` effects are distinguished rather than all triggering a
 *      full rebuild; see `VectorsSettingEffect`. No output pixel differs.
 *   4. `applySettings` re-fits the image when a preset changes any of the four
 *      image fields. `apply_settings` (simulation.rs:862) does not, so on the
 *      desktop a preset carrying a different `image_fit_mode` leaves the
 *      previous fit on screen until some *other* control is touched. See
 *      `imageTransformChanged`.
 */

import type { GpuContext, Simulation, SimulationId } from '$lib/engine/types';
import { getShader } from '$lib/engine/shaders';
import {
    createRenderPipelineChecked,
    createShaderModuleChecked,
} from '$lib/engine/gpu/errorScopes';
import {
    createBufferWithData,
    createUniformBuffer,
    writeBuffer,
} from '$lib/engine/resources/buffers';
import { Camera, CAMERA_DEFAULTS } from '$lib/engine/core/Camera';
import { srgbToLinear } from '$lib/engine/color/ColorScheme';
import {
    decodeImageFile,
    drawFittedImage,
    grayscaleBytesFromCanvas,
} from '$lib/engine/resources/imageUpload';
import {
    defaultVectorsSettings,
    defaultVectorsState,
    normalizeVectorsSettings,
    randomizeVectorsSettings,
    updateVectorsSetting,
    updateVectorsState,
    vectorsClearColor,
    vectorsGridExtent,
    vectorsStateDocument,
    NOISE_TYPE_CODE,
    type VectorFieldType,
    type VectorsGridExtent,
    type VectorsSettingEffect,
    type VectorsSettings,
    type VectorsState,
} from './settings';

export const VECTORS_NOISE_SHADER_PATH = 'vectors/shaders/noise.wgsl';
export const VECTORS_LINE_SHADER_PATH = 'vectors/shaders/line_instanced.wgsl';
export const VECTORS_FRAGMENT_SHADER_PATH = 'vectors/shaders/line_fragment.wgsl';

/** 768 u32 entries, planar [R][G][B] — the shape of every .lut file. */
const LUT_ENTRIES = 768;

/** `struct VectorFieldParams` (line_instanced.wgsl:54): 12 scalars, 48 bytes. */
export const VECTORS_PARAM_BYTES = 48;

/** Six vertices per instance — two triangles, `vectorsQuadIndices`'s order. */
export const VECTORS_VERTICES_PER_LINE = 6;

/**
 * simulation.rs:30 — `VECTOR_IMAGE_RESOLUTION`, the square the uploaded image is
 * fitted into. Kept at the Rust's 512 rather than raised to the surface size:
 * the field samples it by nearest pixel, one sample per line, so resolution past
 * the grid density is invisible.
 */
export const VECTOR_IMAGE_RESOLUTION = 512;

/** `VectorFieldType` as the shader's `field_type` code (line_instanced.wgsl:78). */
export const VECTOR_FIELD_TYPE_CODE: Record<VectorFieldType, number> = {
    Noise: 0,
    Image: 1,
};

/**
 * The world position of one instance's sample point — the CPU half of
 * `vectors_grid_point` (line_instanced.wgsl:128).
 *
 * `x` is the outer loop and `y` the inner one, matching the two `while` loops at
 * simulation.rs:284-322, so consecutive instances walk a column. Exported
 * because it is one half of a contract: the L3 harness runs the WGSL version
 * against this one, and a disagreement is a torn or doubled field with nothing
 * in any log to say so.
 */
export function vectorsGridPointAt(
    extent: VectorsGridExtent,
    instance: number
): [x: number, y: number] {
    const ix = Math.floor(instance / extent.countY);
    const iy = instance % extent.countY;
    return [extent.minX + ix * extent.spacing, extent.minY + iy * extent.spacing];
}

/**
 * The vertex-stage source: the noise library concatenated ahead of the entry
 * point.
 *
 * `noise.wgsl` declares no bindings and no entry point precisely so this works,
 * and the corpus has no include mechanism (`engine/shaders/index.ts` hands out
 * whole files), so concatenation *is* the include. Exported so the L3 harness
 * builds its probes from the same call rather than a copy of it — a copy is how
 * the test ends up proving something the app does not do.
 */
export function vectorsVertexShaderSource(): string {
    return `${getShader(VECTORS_NOISE_SHADER_PATH)}\n${getShader(VECTORS_LINE_SHADER_PATH)}`;
}

export class VectorsSimulation implements Simulation {
    readonly id: SimulationId = 'vectors';

    private readonly device: GPUDevice;
    private readonly format: GPUTextureFormat;

    private readonly pipeline: GPURenderPipeline;
    private readonly bindGroupLayout: GPUBindGroupLayout;
    private readonly paramsBuffer: GPUBuffer;
    private readonly lutBuffer: GPUBuffer;

    /** Bound at binding 3 whenever no image is loaded; never read then. */
    private readonly placeholderImage: GPUTexture;
    private imageTexture: GPUTexture | null = null;
    /** Kept so a fit-mode or mirror change can re-fit without the file. */
    private imageSource: ImageBitmap | null = null;
    private bindGroup: GPUBindGroup;

    private readonly paramScratch = new ArrayBuffer(VECTORS_PARAM_BYTES);

    private camera: Camera;
    private ownsCamera = true;

    settings: VectorsSettings = defaultVectorsSettings();
    state: VectorsState = defaultVectorsState();

    /**
     * `ColorScheme::get_first_color()` for the current LUT, which is what
     * `BackgroundColorMode::ColorScheme` clears to (simulation.rs:377). Held as
     * three linear floats rather than re-derived per frame, and refreshed on the
     * one seam that can change it.
     */
    private lutFirstColor: [number, number, number];

    /** Lines in the most recent frame's grid — the instance count of the draw. */
    private lineCount = 0;
    private time = 0;
    private destroyed = false;

    private constructor(init: {
        device: GPUDevice;
        format: GPUTextureFormat;
        pipeline: GPURenderPipeline;
        bindGroupLayout: GPUBindGroupLayout;
        paramsBuffer: GPUBuffer;
        lutBuffer: GPUBuffer;
        lut: Uint32Array;
        placeholderImage: GPUTexture;
        camera: Camera;
    }) {
        this.device = init.device;
        this.format = init.format;
        this.pipeline = init.pipeline;
        this.bindGroupLayout = init.bindGroupLayout;
        this.paramsBuffer = init.paramsBuffer;
        this.lutBuffer = init.lutBuffer;
        this.placeholderImage = init.placeholderImage;
        this.camera = init.camera;
        this.lutFirstColor = firstLutColor(init.lut);

        this.bindGroup = this.buildBindGroup();
    }

    static async create(gpu: GpuContext, lut?: Uint32Array): Promise<VectorsSimulation> {
        const { device, format } = gpu;

        // Two modules, one pipeline, exactly as the Rust builds it
        // (simulation.rs:136-148) — and `line_fragment.wgsl` is reused verbatim,
        // because its `@location(0) value` input and its `lut_data` at binding 1
        // are already what this vertex stage emits and what the layout declares.
        const vertexModule = await createShaderModuleChecked(device, {
            label: 'vectors line vertex',
            code: vectorsVertexShaderSource(),
        });
        const fragmentModule = await createShaderModuleChecked(device, {
            label: 'vectors line fragment',
            code: getShader(VECTORS_FRAGMENT_SHADER_PATH),
        });

        const bindGroupLayout = device.createBindGroupLayout({
            label: 'vectors layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'read-only-storage' },
                },
                { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
                // Read with `textureLoad`, so no sampler and no filtering — the
                // vertex stage has no derivatives for an implicit-LOD sample
                // anyway, and the Rust indexes a pixel rather than sampling.
                {
                    binding: 3,
                    visibility: GPUShaderStage.VERTEX,
                    texture: { sampleType: 'float', viewDimension: '2d' },
                },
            ],
        });

        const pipeline = await createRenderPipelineChecked(device, {
            label: 'vectors line pipeline',
            layout: device.createPipelineLayout({
                label: 'vectors pipeline layout',
                bindGroupLayouts: [bindGroupLayout],
            }),
            vertex: { module: vertexModule, entryPoint: 'vs_main' },
            fragment: {
                module: fragmentModule,
                entryPoint: 'main',
                targets: [
                    {
                        format,
                        // `BlendState::ALPHA_BLENDING` (simulation.rs:174),
                        // transcribed. It is inert — `line_fragment.wgsl:17`
                        // returns a hardcoded alpha of 1 — but it is what the
                        // desktop pipeline asks for, and quads do overlap at
                        // high density, so the state is the thing to keep rather
                        // than the reasoning about it.
                        blend: {
                            color: {
                                srcFactor: 'src-alpha',
                                dstFactor: 'one-minus-src-alpha',
                                operation: 'add',
                            },
                            alpha: {
                                srcFactor: 'one',
                                dstFactor: 'one-minus-src-alpha',
                                operation: 'add',
                            },
                        },
                        writeMask: GPUColorWrite.ALL,
                    },
                ],
            },
            // `cull_mode: None` (simulation.rs:183). It matters here rather than
            // being a precaution: a quad's winding flips with the sign of its
            // segment normal, so half the field would vanish under either cull.
            primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
        });

        const paramsBuffer = createUniformBuffer(device, VECTORS_PARAM_BYTES, {
            label: 'vectors params',
        });
        const initialLut = lut && lut.length === LUT_ENTRIES ? lut : defaultVectorsLut();
        const lutBuffer = createBufferWithData(
            device,
            initialLut,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            'vectors lut'
        );

        // 1x1 r8unorm, matching the format a real image lands in. Binding 3 has
        // to reference something legal even in Noise mode; `params.image_size`
        // is 0 then, and the shader returns before it reads this.
        const placeholderImage = device.createTexture({
            label: 'vectors image placeholder',
            size: { width: 1, height: 1, depthOrArrayLayers: 1 },
            format: 'r8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        });

        const camera = new Camera(gpu.width, gpu.height);
        // simulation.rs:85 — unbounded panning, because the noise field is
        // infinite and the pan is what moves its origin. See `attachCamera` for
        // why the clamp is restored on teardown.
        camera.setPositionClamp(null);
        camera.attachToDevice(device, 'vectors camera uniform');
        camera.uploadToGpu(device.queue);

        return new VectorsSimulation({
            device,
            format,
            pipeline,
            bindGroupLayout,
            paramsBuffer,
            lutBuffer,
            lut: initialLut,
            placeholderImage,
            camera,
        });
    }

    // -----------------------------------------------------------------------
    // Frame
    // -----------------------------------------------------------------------

    /**
     * Advance the clock, re-derive the grid, draw it.
     *
     * There is nothing to rebuild: the grid is a function of the camera, the
     * density and the clock, and all three reach the GPU in one 48-byte uniform.
     */
    renderFrame(view: GPUTextureView, dt: number): void {
        if (this.destroyed) return;

        // simulation.rs:566 — the clock is unscaled here; `noise_dt_multiplier`
        // is applied where the sample is taken, so changing it does not jump the
        // field the way scaling the accumulator would.
        this.time += dt;
        this.state.simulation_time = this.time;

        this.advanceOwnCamera(dt);
        this.encode(view, 'vectors frame');
    }

    /**
     * A paused redraw still re-derives the grid, because the camera may have
     * moved — `render_frame_paused` (simulation.rs:614) calls `update_geometry`
     * for the same reason. The clock does not advance, so the field is still.
     */
    renderFramePaused(view: GPUTextureView): void {
        if (this.destroyed) return;
        this.encode(view, 'vectors frame (paused)');
    }

    /**
     * Nothing here is sized to the surface — no simulation texture, no vertex
     * buffer — so a resize is the camera's business alone. The Rust rebuilt the
     * geometry (simulation.rs:657); the equivalent happens on the next frame for
     * free.
     */
    resize(width: number, height: number): void {
        if (this.destroyed) return;
        this.camera.resize(width, height);
    }

    // -----------------------------------------------------------------------
    // Settings and state
    // -----------------------------------------------------------------------

    getSettings(): Record<string, unknown> {
        return { ...this.settings };
    }

    /**
     * `vectorsStateDocument` strips the four `geometry_dirty` cache fields, and
     * they are left at their defaults in `state` rather than kept current: there
     * is no dirty check here to consult them, so they are vestigial — part of
     * `State`'s shape (state.rs:2) and of nothing else.
     */
    getState(): Record<string, unknown> {
        return vectorsStateDocument({ ...this.state, simulation_time: this.time });
    }

    updateSetting(name: string, value: unknown): void {
        this.applyEffect(updateVectorsSetting(this.settings, name, value));
    }

    updateState(name: string, value: unknown): void {
        this.applyEffect(updateVectorsState(this.state, name, value));
    }

    applySettings(settings: Record<string, unknown>): void {
        const previous = this.settings;
        this.settings = normalizeVectorsSettings(settings);
        // The image is fitted on the CPU, so any of the four image fields
        // changing invalidates the fitted copy — `apply_settings`
        // (simulation.rs:862) missed this and left the old fit in place.
        if (imageTransformChanged(previous, this.settings)) this.refitImage();
    }

    randomizeSettings(): void {
        randomizeVectorsSettings(this.settings);
    }

    /** `reset_runtime_state` (simulation.rs:875) — rewind the clock. */
    resetRuntimeState(): void {
        this.time = 0;
        this.state.simulation_time = 0;
    }

    // Deliberately **no** `reset()` and no `seedRandomNoise()`. `SimulationHost`
    // treats both as optional capabilities: `resetSimulation` falls back to
    // `resetRuntimeState`, which is the only reset `vectors/simulation.rs` has,
    // and there is no field to seed — the noise is evaluated from `noise_seed`
    // in the vertex stage, and re-seeding it is what `randomize_settings` does.
    // Empty implementations would only claim capabilities that do nothing.

    /**
     * Replace the LUT.
     *
     * `lut` arrives from `ColorSchemeManager.current()` **already reversed**, so
     * it is written verbatim. Vectors has no shader-side reversal flag to
     * cancel it against — `line_fragment.wgsl` indexes the buffer directly —
     * which is why this simulation shows the reversal correctly on both builds,
     * unlike Moiré (WEB_PORT.md, M3 defect 4).
     */
    updateColorScheme(lut: Uint32Array, reversed: boolean): void {
        if (lut.length !== LUT_ENTRIES) {
            throw new Error(`LUT must be ${LUT_ENTRIES} u32 entries, got ${lut.length}`);
        }
        this.state.color_scheme_reversed = reversed;
        this.lutFirstColor = firstLutColor(lut);
        writeBuffer(this.device.queue, this.lutBuffer, lut);
    }

    // -----------------------------------------------------------------------
    // Pointer
    // -----------------------------------------------------------------------

    handleMouseInteraction(_worldX: number, _worldY: number, _button: number): void {
        // simulation.rs:819 — Vectors has no brush. The camera still pans and
        // zooms; that goes through the host, not through here.
    }

    handleMouseRelease(_button: number): void {}

    // -----------------------------------------------------------------------
    // Camera and images
    // -----------------------------------------------------------------------

    /**
     * `SimulationHost` hook — one camera on the host, not one per simulation.
     *
     * The clamp is the interesting part. Vectors is the first simulation to want
     * `set_position_clamp(None)` (simulation.rs:85), and the host's camera
     * outlives it: `Camera.reset()` restores the position and zoom but not the
     * clamp, so leaving it null would silently hand unbounded panning to
     * whichever simulation is opened next. It is therefore set here and put back
     * in `destroy()`.
     */
    attachCamera(camera: Camera): void {
        if (this.destroyed || camera === this.camera) return;

        if (this.ownsCamera) this.camera.destroy();
        this.camera = camera;
        this.ownsCamera = false;

        camera.setPositionClamp(null);
        camera.attachToDevice(this.device, 'vectors camera uniform');
        camera.uploadToGpu(this.device.queue);
        // Binding 0 is the camera's uniform buffer, and this is a different
        // buffer on a different camera, so the bind group has to be rebuilt.
        this.bindGroup = this.buildBindGroup();
    }

    /**
     * `load_vectors_vector_field_image` — the image-driven field.
     *
     * Loading an image does **not** switch `vector_field_type` to Image; the UI
     * does that separately, exactly as on the desktop, where only the webcam
     * path forced the type (simulation.rs:571) and the webcam is an omitted
     * feature of this port. Session-only, like every uploaded image here.
     *
     * @param slot always `vector_field` — Vectors registers one image command
     *             (`rpc/handlers/images.ts`), so the slot is informational.
     */
    async loadImage(file: File, slot = 'vector_field'): Promise<void> {
        if (slot !== 'vector_field') {
            throw new Error(`vectors has no image slot "${slot}"`);
        }

        const bitmap = await decodeImageFile(file);
        if (this.destroyed) {
            bitmap.close();
            return;
        }

        this.imageSource?.close();
        this.imageSource = bitmap;
        this.refitImage();
    }

    /** True once an image has been decoded and uploaded. */
    get hasImage(): boolean {
        return this.imageTexture !== null;
    }

    /** Lines drawn by the most recent frame — the draw call's instance count. */
    get instanceCount(): number {
        return this.lineCount;
    }

    /** The grid the next frame would draw, for tests and for `instanceCount`. */
    get grid(): VectorsGridExtent {
        return vectorsGridExtent(
            this.camera.position[0],
            this.camera.position[1],
            this.camera.zoom,
            this.settings.density
        );
    }

    get targetFormat(): GPUTextureFormat {
        return this.format;
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        this.paramsBuffer.destroy();
        this.lutBuffer.destroy();
        this.placeholderImage.destroy();
        this.imageTexture?.destroy();
        this.imageTexture = null;
        this.imageSource?.close();
        this.imageSource = null;

        if (this.ownsCamera) {
            this.camera.destroy();
        } else {
            // Hand the host's camera back as it was found; see `attachCamera`.
            this.camera.setPositionClamp([...CAMERA_DEFAULTS.positionClamp]);
        }
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    private applyEffect(effect: VectorsSettingEffect): void {
        switch (effect) {
            case 'geometry':
                // The payoff of moving the noise onto the GPU: the grid is
                // re-derived from the uniform on every frame, so there is
                // nothing to rebuild. On the desktop this arm re-sampled and
                // re-uploaded the whole field (simulation.rs:782).
                return;
            case 'refit-image':
                // The Rust refits only in Image mode (simulation.rs:691), and a
                // refit of an image nothing samples is wasted work either way.
                if (this.settings.vector_field_type === 'Image') this.refitImage();
                return;
            case 'clear-color':
                // Read straight off `settings` when the pass is encoded.
                return;
            case 'reload-lut':
                // The bytes arrive on the `updateColorScheme` seam, driven by
                // `apply_color_scheme_by_name`; this only recorded the name or
                // the reversed flag, which `updateVectorsState` has done.
                return;
            case 'none':
                return;
        }
    }

    /**
     * Pack `VectorFieldParams` and record the instance count.
     *
     * Written every frame rather than dirty-flagged: two of its twelve fields
     * are the camera and a third is the clock, so it is dirty on essentially
     * every frame anyway, and 48 bytes is far below the cost of tracking it.
     */
    private uploadParams(): void {
        const grid = this.grid;
        this.lineCount = grid.count;

        const view = new DataView(this.paramScratch);
        view.setFloat32(0, grid.minX, true);
        view.setFloat32(4, grid.minY, true);
        view.setFloat32(8, grid.spacing, true);
        view.setUint32(12, grid.countY, true);

        view.setFloat32(16, this.settings.line_length, true);
        view.setFloat32(20, this.settings.line_width, true);
        view.setFloat32(24, this.settings.noise_scale, true);
        // simulation.rs:272 — the multiplier scales the animated coordinate,
        // not the clock, so it can be changed mid-run without a jump.
        view.setFloat32(28, this.time * this.settings.noise_dt_multiplier, true);

        view.setUint32(32, NOISE_TYPE_CODE[this.settings.noise_type], true);
        view.setUint32(36, this.settings.noise_seed >>> 0, true);
        view.setUint32(40, VECTOR_FIELD_TYPE_CODE[this.settings.vector_field_type], true);
        view.setUint32(44, this.imageTexture ? VECTOR_IMAGE_RESOLUTION : 0, true);

        this.device.queue.writeBuffer(this.paramsBuffer, 0, this.paramScratch);
    }

    private encode(view: GPUTextureView, label: string): void {
        this.uploadParams();

        const [r, g, b, a] = vectorsClearColor(
            this.settings.background_color_mode,
            this.lutFirstColor
        );

        const encoder = this.device.createCommandEncoder({ label });
        const pass = encoder.beginRenderPass({
            label: 'vectors render pass',
            colorAttachments: [
                { view, loadOp: 'clear', storeOp: 'store', clearValue: { r, g, b, a } },
            ],
        });

        // `if self.index_count > 0` (simulation.rs:601). Unreachable in practice
        // — `vectorsGridExtent` always returns at least one point — but a draw
        // of zero instances is a wasted pass either way.
        if (this.lineCount > 0) {
            pass.setPipeline(this.pipeline);
            pass.setBindGroup(0, this.bindGroup);
            pass.draw(VECTORS_VERTICES_PER_LINE, this.lineCount);
        }
        pass.end();

        this.device.queue.submit([encoder.finish()]);
    }

    /**
     * Drive the camera only when nothing else is.
     *
     * `SimulationHost` updates and uploads the camera it owns before calling
     * `renderFrame`; doing it again here would double the smoothing rate.
     */
    private advanceOwnCamera(dt: number): void {
        if (!this.ownsCamera) return;
        this.camera.update(dt);
        this.camera.uploadToGpu(this.device.queue);
    }

    private buildBindGroup(): GPUBindGroup {
        return this.device.createBindGroup({
            label: 'vectors bind group',
            layout: this.bindGroupLayout,
            entries: [
                { binding: 0, resource: { buffer: this.camera.getBuffer()! } },
                { binding: 1, resource: { buffer: this.lutBuffer } },
                { binding: 2, resource: { buffer: this.paramsBuffer } },
                { binding: 3, resource: (this.imageTexture ?? this.placeholderImage).createView() },
            ],
        });
    }

    /**
     * Re-fit the decoded image to `VECTOR_IMAGE_RESOLUTION²` and upload it.
     *
     * **All four transforms happen on the CPU here**, unlike Moiré, where
     * mirroring and inversion are shader uniforms. That is the Rust's split, not
     * a preference: `reprocess_vector_field_image` (simulation.rs:462) fits,
     * then flips, then inverts, and hands the finished buffer to the sampler.
     */
    private refitImage(): void {
        if (!this.imageSource || this.destroyed) return;

        const size = VECTOR_IMAGE_RESOLUTION;
        const canvas = drawFittedImage(this.imageSource, size, size, {
            fitMode: this.settings.image_fit_mode,
            mirrorHorizontal: this.settings.image_mirror_horizontal,
            mirrorVertical: this.settings.image_mirror_vertical,
            invertTone: this.settings.image_invert_tone,
        });
        const bytes = grayscaleBytesFromCanvas(canvas, size, size);

        if (!this.imageTexture) {
            this.imageTexture = this.device.createTexture({
                label: 'vectors vector field image',
                size: { width: size, height: size, depthOrArrayLayers: 1 },
                format: 'r8unorm',
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
            });
            this.bindGroup = this.buildBindGroup();
        }

        // writeTexture, unlike copyBufferToTexture, puts no 256-byte alignment
        // on bytesPerRow, so a single-channel row can be written as-is.
        this.device.queue.writeTexture(
            { texture: this.imageTexture },
            bytes,
            { bytesPerRow: size, rowsPerImage: size },
            { width: size, height: size, depthOrArrayLayers: 1 }
        );
    }
}

export async function createVectors(gpu: GpuContext): Promise<Simulation> {
    return VectorsSimulation.create(gpu);
}

/** True when a change to the image settings invalidates the fitted copy. */
function imageTransformChanged(before: VectorsSettings, after: VectorsSettings): boolean {
    return (
        before.image_fit_mode !== after.image_fit_mode ||
        before.image_mirror_horizontal !== after.image_mirror_horizontal ||
        before.image_mirror_vertical !== after.image_mirror_vertical ||
        before.image_invert_tone !== after.image_invert_tone
    );
}

/**
 * `ColorScheme::get_first_color()` (color_scheme.rs:64) for a LUT already in its
 * GPU form.
 *
 * The simulation is handed 768 u32s on the `updateColorScheme` seam, not a
 * `ColorScheme`, so the first colour — which is what `BackgroundColorMode::
 * ColorScheme` clears to — is read back out of the buffer. Linear space, via
 * the same `srgbToLinear` `getColors` applies, so the clear matches the desktop
 * build's `wgpu::Color`.
 */
function firstLutColor(lut: Uint32Array): [number, number, number] {
    return [
        srgbToLinear((lut[0] ?? 0) / 255),
        srgbToLinear((lut[256] ?? 0) / 255),
        srgbToLinear((lut[512] ?? 0) / 255),
    ];
}

/**
 * A neutral greyscale ramp, so the first frame has a LUT before the
 * colour-scheme layer has fetched anything.
 *
 * The Rust loaded `State::default`'s "MATPLOTLIB_viridis" at construction
 * (simulation.rs:102); in the browser that is a network fetch on the critical
 * path to first paint, and `apply_color_scheme_by_name` replaces this within a
 * frame or two. Grey rather than an approximation of viridis, so a LUT that
 * never got replaced looks obviously provisional instead of subtly wrong — the
 * same choice Gray-Scott made.
 */
export function defaultVectorsLut(): Uint32Array {
    const lut = new Uint32Array(LUT_ENTRIES);
    for (let i = 0; i < 256; i++) {
        lut[i] = i;
        lut[256 + i] = i;
        lut[512 + i] = i;
    }
    return lut;
}
