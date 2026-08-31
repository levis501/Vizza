/**
 * Starts the engine and hands it to the rpc layer.
 *
 * This is the only place the GPU, the host and the command surface meet. It is
 * deliberately tolerant: if WebGPU is unavailable the UI must still work, with
 * an honest message, rather than throwing during module init and leaving a
 * blank page.
 */

import { initGpu, isGpuFailure, describeGpuFailure } from './gpu/device';
import { createSurface, type Surface } from './gpu/surface';
import { SimulationHost } from './core/SimulationHost';
import { setEngineContext } from '$lib/rpc';
import { installHandlers, setPointerCanvas } from '$lib/rpc/handlers';
import { colorSchemeManager } from './color/ColorSchemeManager';

export interface Engine {
    host: SimulationHost;
    surface: Surface;
}

let engine: Engine | null = null;

/** The reason WebGPU is unavailable, if it is. Rendered by the shell. */
let failureMessage: string | null = null;

export function getEngine(): Engine | null {
    return engine;
}

export function getFailureMessage(): string | null {
    return failureMessage;
}

/**
 * Boot the engine against the canvas declared in index.html.
 *
 * Resolves either way — check `getFailureMessage()`. The command handlers are
 * installed regardless, so the stub layer keeps the UI responsive even with no
 * GPU at all.
 */
export async function startEngine(): Promise<Engine | null> {
    if (engine) return engine;

    // Install first: even on the failure path the UI issues commands, and a
    // stubbed response is far better than an unknown-command rejection.
    installHandlers();
    exposeDevHandle();

    const canvas = document.getElementById('vizza-canvas');
    if (!(canvas instanceof HTMLCanvasElement)) {
        failureMessage = 'Canvas element #vizza-canvas is missing from the page.';
        return null;
    }

    const result = await initGpu(canvas, {
        onDeviceLost: (info) => {
            console.error('[engine] WebGPU device lost:', info.message);
            failureMessage = `The WebGPU device was lost: ${info.message}`;
        },
    });

    if (isGpuFailure(result)) {
        failureMessage = describeGpuFailure(result.error);
        console.error('[engine]', failureMessage);
        return null;
    }

    const gpu = result;
    const host = new SimulationHost(gpu);

    const surface = createSurface(canvas, {
        maxTextureDimension2D: gpu.caps.maxTextureDimension2D,
        onResize: (width, height) => {
            gpu.width = width;
            gpu.height = height;
            host.resize(width, height);
        },
    });

    setEngineContext(host);
    setPointerCanvas(canvas);

    // Warm the LUT blob so the first colour-scheme command is instant. Not
    // awaited: the menu background ships its own built-in ramp precisely so
    // first paint never waits on a fetch.
    void colorSchemeManager.load().catch((err) => {
        console.error('[engine] colour schemes failed to load:', err);
    });

    engine = { host, surface };
    exposeDevHandle({ host, surface, gpu });

    return engine;
}

/** What `window.__vizza` carries in a dev build. Absent in production. */
export interface DevHandle {
    installFakeEngine?: () => unknown;
    [key: string]: unknown;
}

/**
 * A dev-only console handle, merged rather than replaced so it survives both
 * calls below.
 *
 * Two jobs. Diagnosing render problems, where "nothing is drawn" is otherwise
 * indistinguishable from "nothing ran". And `installFakeEngine`, which is how
 * the Playwright layer gets a working `EngineContext` — its launcher makes
 * `navigator.gpu` undefined, so there is no other way to drive a mode's menu
 * far enough to see a control round-trip (WEB_PORT.md, "Test strategy").
 *
 * The whole body is behind a static `import.meta.env.DEV`, and the fake is
 * reached through a dynamic import, so none of it reaches a production bundle.
 */
function exposeDevHandle(extra: Record<string, unknown> = {}): void {
    if (!import.meta.env?.DEV || typeof window === 'undefined') return;

    const target = window as unknown as { __vizza?: DevHandle };
    target.__vizza = { ...(target.__vizza ?? {}), ...extra };

    if (target.__vizza.installFakeEngine) return;
    void import('./testing/fakeEngine').then(({ installFakeEngine }) => {
        const handle = (window as unknown as { __vizza?: DevHandle }).__vizza;
        if (handle) handle.installFakeEngine = installFakeEngine;
    });
}

/** Tear everything down. Used by tests; the page itself never calls it. */
export async function stopEngine(): Promise<void> {
    if (!engine) return;
    engine.surface.dispose();
    await engine.host.dispose();
    setEngineContext(null);
    setPointerCanvas(null);
    engine = null;
}
