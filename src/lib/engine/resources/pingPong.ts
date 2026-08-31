/**
 * Ping-pong texture and buffer pairs.
 *
 * Ports of shared/ping_pong_textures.rs and shared/ping_pong_buffers.rs. The
 * point of the abstraction is the same as in Rust: a pass that reads A and
 * writes B, then forgets to swap, produces a plausible-looking but stale
 * result that is very hard to spot. Here the caller never names an index.
 *
 * In the browser this becomes structural rather than stylistic — WebGPU
 * rejects `texture_storage_2d<rgba8unorm, read_write>` outright, so four Rust
 * shaders that did in-place read-modify-write *must* become ping-pong
 * (WEB_PORT.md remediations a, c, d).
 */

import { SIM_TEXTURE_USAGE } from './textures';

export interface PingPongTextureOptions {
    label?: string;
    usage?: GPUTextureUsageFlags;
}

export class PingPongTextures {
    private readonly textures: [GPUTexture, GPUTexture];
    private readonly views: [GPUTextureView, GPUTextureView];
    private index: 0 | 1 = 0;

    constructor(
        device: GPUDevice,
        readonly width: number,
        readonly height: number,
        readonly format: GPUTextureFormat,
        options: PingPongTextureOptions = {}
    ) {
        const label = options.label ?? 'ping-pong';
        const usage = options.usage ?? SIM_TEXTURE_USAGE;

        const make = (suffix: string) =>
            device.createTexture({
                label: `${label} ${suffix}`,
                size: {
                    width: Math.max(1, width),
                    height: Math.max(1, height),
                    depthOrArrayLayers: 1,
                },
                mipLevelCount: 1,
                sampleCount: 1,
                dimension: '2d',
                format,
                usage,
            });

        this.textures = [make('A'), make('B')];
        this.views = [this.textures[0].createView(), this.textures[1].createView()];
    }

    /** The texture holding the current state — the one a pass should read. */
    get current(): GPUTexture {
        return this.textures[this.index];
    }

    get currentView(): GPUTextureView {
        return this.views[this.index];
    }

    /** The scratch texture a pass should write into. */
    get inactive(): GPUTexture {
        return this.textures[1 - this.index];
    }

    get inactiveView(): GPUTextureView {
        return this.views[1 - this.index];
    }

    get currentIndex(): 0 | 1 {
        return this.index;
    }

    swap(): void {
        this.index = this.index === 0 ? 1 : 0;
    }

    /** Picks the bind group matching the current orientation. See bindGroupCache. */
    select<T>(forA: T, forB: T): T {
        return this.index === 0 ? forA : forB;
    }

    get all(): readonly [GPUTexture, GPUTexture] {
        return this.textures;
    }

    get allViews(): readonly [GPUTextureView, GPUTextureView] {
        return this.views;
    }

    destroy(): void {
        this.textures[0].destroy();
        this.textures[1].destroy();
    }
}

export class PingPongBuffers {
    private readonly buffers: [GPUBuffer, GPUBuffer];
    private index: 0 | 1 = 0;

    constructor(device: GPUDevice, size: number, usage: GPUBufferUsageFlags, label = 'ping-pong') {
        const make = (suffix: string) =>
            device.createBuffer({ label: `${label} ${suffix}`, size, usage });
        this.buffers = [make('A'), make('B')];
    }

    get current(): GPUBuffer {
        return this.buffers[this.index];
    }

    get inactive(): GPUBuffer {
        return this.buffers[1 - this.index];
    }

    get currentIndex(): 0 | 1 {
        return this.index;
    }

    swap(): void {
        this.index = this.index === 0 ? 1 : 0;
    }

    select<T>(forA: T, forB: T): T {
        return this.index === 0 ? forA : forB;
    }

    get all(): readonly [GPUBuffer, GPUBuffer] {
        return this.buffers;
    }

    destroy(): void {
        this.buffers[0].destroy();
        this.buffers[1].destroy();
    }
}
