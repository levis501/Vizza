/**
 * Main-menu background — a port of main_menu/simulation.rs around
 * main_menu/shaders/combined.wgsl.
 *
 * Render-only: no compute passes, no ping-pong, no camera. One full-screen
 * triangle pair whose fragment shader is an animated 3D-simplex FBM, coloured
 * through a LUT. That makes it the smallest possible end-to-end exercise of the
 * device, the shader corpus, the buffer helpers, and the render loop.
 */

import type { GpuContext, Simulation, SimulationId } from '$lib/engine/types';
import { getShader } from '$lib/engine/shaders';
import {
    createShaderModuleChecked,
    createRenderPipelineChecked,
} from '$lib/engine/gpu/errorScopes';
import {
    createBufferWithData,
    createUniformBuffer,
    writeBuffer,
} from '$lib/engine/resources/buffers';

/** 256 entries per channel, planar [R][G][B] — the shape of every .lut file. */
const LUT_ENTRIES = 768;

/**
 * The Rust build runs the animation at `elapsed_secs * 0.03`. The FBM's own
 * frequency terms are large, so anything near real time strobes.
 */
const TIME_SCALE = 0.03;

export class MainMenuSimulation implements Simulation {
    readonly id: SimulationId = 'main_menu';

    private readonly device: GPUDevice;
    private readonly format: GPUTextureFormat;
    private readonly pipeline: GPURenderPipeline;
    private readonly timeBuffer: GPUBuffer;
    private readonly lutBuffer: GPUBuffer;
    private readonly timeBindGroup: GPUBindGroup;
    private readonly lutBindGroup: GPUBindGroup;

    private readonly timeScratch = new Float32Array(1);
    private time = 0;
    private guiVisible = false;
    private destroyed = false;

    private constructor(
        device: GPUDevice,
        format: GPUTextureFormat,
        pipeline: GPURenderPipeline,
        timeBuffer: GPUBuffer,
        lutBuffer: GPUBuffer,
        timeBindGroup: GPUBindGroup,
        lutBindGroup: GPUBindGroup
    ) {
        this.device = device;
        this.format = format;
        this.pipeline = pipeline;
        this.timeBuffer = timeBuffer;
        this.lutBuffer = lutBuffer;
        this.timeBindGroup = timeBindGroup;
        this.lutBindGroup = lutBindGroup;
    }

    static async create(gpu: GpuContext, lut?: Uint32Array): Promise<MainMenuSimulation> {
        const { device, format } = gpu;

        const module = await createShaderModuleChecked(device, {
            label: 'main_menu_combined',
            code: getShader('main_menu/shaders/combined.wgsl'),
        });

        // Two groups, matching the shader: @group(0) the time uniform,
        // @group(1) the LUT. Both are fragment-only.
        const timeLayout = device.createBindGroupLayout({
            label: 'main menu time layout',
            entries: [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
            ],
        });
        const lutLayout = device.createBindGroupLayout({
            label: 'main menu lut layout',
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    buffer: { type: 'read-only-storage' },
                },
            ],
        });

        const timeBuffer = createUniformBuffer(device, 4, { label: 'main menu time' });
        const lutBuffer = createBufferWithData(
            device,
            lut && lut.length === LUT_ENTRIES ? lut : defaultLut(),
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
            'main menu lut'
        );

        const pipeline = await createRenderPipelineChecked(device, {
            label: 'main menu background',
            layout: device.createPipelineLayout({
                label: 'main menu pipeline layout',
                bindGroupLayouts: [timeLayout, lutLayout],
            }),
            vertex: { module, entryPoint: 'vs_main' },
            fragment: {
                module,
                entryPoint: 'fs_main',
                targets: [{ format, writeMask: GPUColorWrite.ALL }],
            },
            // The vertex data is wound CCW; back-face culling matches the Rust
            // pipeline so a winding mistake fails loudly rather than half-drawing.
            primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'back' },
        });

        return new MainMenuSimulation(
            device,
            format,
            pipeline,
            timeBuffer,
            lutBuffer,
            device.createBindGroup({
                label: 'main menu time bind group',
                layout: timeLayout,
                entries: [{ binding: 0, resource: { buffer: timeBuffer } }],
            }),
            device.createBindGroup({
                label: 'main menu lut bind group',
                layout: lutLayout,
                entries: [{ binding: 0, resource: { buffer: lutBuffer } }],
            })
        );
    }

    renderFrame(view: GPUTextureView, dt: number): void {
        // Driven by the frame delta rather than a wall clock, so a paused or
        // backgrounded tab resumes where it left off instead of jumping.
        this.time += dt * TIME_SCALE;
        this.draw(view);
    }

    renderFramePaused(view: GPUTextureView): void {
        this.draw(view);
    }

    resize(_width: number, _height: number): void {
        // Everything is derived from the fragment's UV, so there is nothing
        // sized to the surface to rebuild.
    }

    getSettings(): Record<string, unknown> {
        return {};
    }

    getState(): Record<string, unknown> {
        return { time: this.time, gui_visible: this.guiVisible };
    }

    updateSetting(_name: string, _value: unknown): void {
        // No configurable settings, matching MainMenuModel::update_setting.
    }

    updateState(name: string, value: unknown): void {
        if (name === 'gui_visible') {
            this.guiVisible = Boolean(value);
            return;
        }
        console.warn(`Unknown state parameter for MainMenu: ${name}`);
    }

    applySettings(_settings: Record<string, unknown>): void {}

    handleMouseInteraction(_worldX: number, _worldY: number, _button: number): void {}

    handleMouseRelease(_button: number): void {}

    resetRuntimeState(): void {
        this.time = 0;
    }

    randomizeSettings(): void {}

    updateColorScheme(lut: Uint32Array, reversed: boolean): void {
        if (lut.length !== LUT_ENTRIES) {
            throw new Error(`LUT must be ${LUT_ENTRIES} u32 entries, got ${lut.length}`);
        }
        writeBuffer(this.device.queue, this.lutBuffer, reversed ? reverseLut(lut) : lut);
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;
        this.timeBuffer.destroy();
        this.lutBuffer.destroy();
    }

    /** Exposed so a host can confirm it configured the canvas with the same format. */
    get targetFormat(): GPUTextureFormat {
        return this.format;
    }

    private draw(view: GPUTextureView): void {
        if (this.destroyed) return;

        this.timeScratch[0] = this.time;
        this.device.queue.writeBuffer(this.timeBuffer, 0, this.timeScratch);

        const encoder = this.device.createCommandEncoder({ label: 'main menu' });
        const pass = encoder.beginRenderPass({
            label: 'main menu background',
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
        pass.setBindGroup(0, this.timeBindGroup);
        pass.setBindGroup(1, this.lutBindGroup);
        pass.draw(6);
        pass.end();

        this.device.queue.submit([encoder.finish()]);
    }
}

export async function createMainMenu(gpu: GpuContext): Promise<Simulation> {
    return MainMenuSimulation.create(gpu);
}

/** Reverses each 256-entry channel plane independently, as color_scheme.rs does. */
export function reverseLut(lut: Uint32Array): Uint32Array {
    const out = new Uint32Array(LUT_ENTRIES);
    for (let channel = 0; channel < 3; channel++) {
        const base = channel * 256;
        for (let i = 0; i < 256; i++) {
            out[base + i] = lut[base + 255 - i];
        }
    }
    return out;
}

/**
 * A built-in gradient so the menu renders before the colour-scheme layer has
 * loaded anything — the Rust build picks a random LUT at construction, which in
 * the browser would mean an async fetch on the critical path to first paint.
 * Replaced the moment updateColorScheme() is called.
 */
export function defaultLut(): Uint32Array {
    // Dark plum -> magenta -> amber -> near-white; a magma-like ramp that reads
    // well behind the title text at any point in the FBM's range.
    const stops: Array<[number, number, number, number]> = [
        [0.0, 8, 4, 24],
        [0.25, 82, 18, 96],
        [0.5, 176, 42, 92],
        [0.75, 240, 122, 44],
        [1.0, 252, 232, 190],
    ];

    const lut = new Uint32Array(LUT_ENTRIES);
    for (let i = 0; i < 256; i++) {
        const t = i / 255;
        let upper = 1;
        while (upper < stops.length - 1 && stops[upper][0] < t) upper++;

        const [t0, r0, g0, b0] = stops[upper - 1];
        const [t1, r1, g1, b1] = stops[upper];
        const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);

        lut[i] = Math.round(r0 + (r1 - r0) * k);
        lut[256 + i] = Math.round(g0 + (g1 - g0) * k);
        lut[512 + i] = Math.round(b0 + (b1 - b0) * k);
    }
    return lut;
}
