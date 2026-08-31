/**
 * Camera and pointer commands.
 *
 * The coordinate handling here is the load-bearing part. Every mode component
 * computes `clientX * devicePixelRatio` with no canvas offset (canonical:
 * SlimeMoldMode.svelte:1182-1184, ~21 identical sites), because the Tauri build
 * targeted a fullscreen native surface where that happened to be right.
 *
 * Rather than edit 21 call sites mid-port, we undo that idiom here and apply
 * the correct transform once. A later milestone codemods the components and
 * deletes `recoverClientFromLegacyScreenPx` along with them.
 */

import { register } from '../registry';
import { getEngineContext, hasEngineContext } from '../context';
import {
    clientToCanvasPx,
    recoverClientFromLegacyScreenPx,
} from '$lib/engine/gpu/pointer';

/** Set by the bootstrap so the handlers can measure the live canvas. */
let canvasRef: HTMLCanvasElement | null = null;

export function setPointerCanvas(canvas: HTMLCanvasElement | null): void {
    canvasRef = canvas;
}

/** Legacy physical-pixel pair from a mode component -> canvas backing pixels. */
function legacyToCanvas(screenX: unknown, screenY: unknown): [number, number] {
    const { clientX, clientY } = recoverClientFromLegacyScreenPx(
        Number(screenX),
        Number(screenY)
    );
    if (!canvasRef) return [clientX, clientY];
    const { x, y } = clientToCanvasPx(clientX, clientY, canvasRef.getBoundingClientRect(), {
        width: canvasRef.width,
        height: canvasRef.height,
    });
    return [x, y];
}

/**
 * Camera commands issued before the engine finishes booting are dropped.
 *
 * App.svelte restores app settings in onMount and immediately calls
 * set_camera_sensitivity, which races initGpu's async device request. Throwing
 * there produces a scary console error for a command that is simply early —
 * and the setting is reapplied from the store once a simulation starts.
 */
function ifReady(fn: () => void): null {
    if (hasEngineContext()) fn();
    return null;
}

export function registerCameraHandlers(): void {
    register('pan_camera', async (args) =>
        ifReady(() =>
            getEngineContext().panCamera(Number(args.delta_x), Number(args.delta_y))
        )
    );

    register('zoom_camera', async (args) =>
        ifReady(() => getEngineContext().zoomCamera(Number(args.delta)))
    );

    register('zoom_camera_to_cursor', async (args) =>
        ifReady(() => {
            const [x, y] = legacyToCanvas(args.cursor_x, args.cursor_y);
            getEngineContext().zoomCameraToCursor(Number(args.delta), x, y);
        })
    );

    register('reset_camera', async () => ifReady(() => getEngineContext().resetCamera()));

    register('get_camera_state', async () => {
        if (!hasEngineContext()) return { position: [0, 0], zoom: 1 };
        const state = getEngineContext().getCameraState();
        // The frontend reads snake_case fields off this object.
        return { position: state.position, zoom: state.zoom };
    });

    register('set_camera_sensitivity', async (args) =>
        ifReady(() => getEngineContext().setCameraSensitivity(Number(args.sensitivity)))
    );

    register('handle_mouse_interaction_screen', async (args) =>
        ifReady(() => {
            const [x, y] = legacyToCanvas(args.screen_x, args.screen_y);
            getEngineContext().handleMouseInteraction(x, y, Number(args.mouse_button ?? 0));
        })
    );

    register('handle_mouse_release', async (args) =>
        ifReady(() => getEngineContext().handleMouseRelease(Number(args.mouse_button ?? 0)))
    );
}
