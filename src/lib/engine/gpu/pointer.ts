/**
 * The one place a screen coordinate becomes a canvas coordinate.
 *
 * Every mode component currently does this instead (canonical:
 * SlimeMoldMode.svelte:1182-1184, ~21 sites):
 *
 *     const physicalCursorX = mouseEvent.clientX * (window.devicePixelRatio || 1);
 *
 * which is wrong in a browser three separate ways:
 *
 *  1. `clientX` is viewport-relative, but the canvas need not start at (0,0) —
 *     any page chrome, scroll, or letterboxing shifts it.
 *  2. `devicePixelRatio` is not the backing-store scale once DPR is clamped,
 *     and WEB_PORT.md clamps it to 2 in `gpu/surface.ts`. On a 3× display the
 *     legacy line is off by 50%.
 *  3. It ignores browser zoom, CSS `zoom`/`transform` on an ancestor, and the
 *     transient mismatch during a fullscreen transition.
 *
 * The correct conversion never reads `devicePixelRatio` at all:
 *
 *     x = (clientX - rect.left) * (canvas.width  / rect.width)
 *     y = (clientY - rect.top ) * (canvas.height / rect.height)
 *
 * `canvas.width / rect.width` *is* the authoritative backing-store-to-CSS ratio,
 * measured rather than assumed, so it stays correct under all three failures
 * above by construction.
 *
 * The core function is pure — it takes the rect and the canvas dimensions as
 * plain numbers — so it is unit-testable in node with no DOM and no GPU. The
 * DOM wrapper on top is three lines.
 */

/** The parts of a `DOMRect` this needs. Structural, so a real `DOMRect` fits. */
export interface RectLike {
    left: number;
    top: number;
    width: number;
    height: number;
}

/** The parts of an `HTMLCanvasElement` this needs: its backing-store size. */
export interface CanvasSizeLike {
    width: number;
    height: number;
}

/** The parts of a `MouseEvent`/`PointerEvent`/`Touch` this needs. */
export interface ClientPointLike {
    clientX: number;
    clientY: number;
}

/** A point in canvas backing-store pixels. Feed this to `Camera.screenToWorld`. */
export interface CanvasPoint {
    x: number;
    y: number;
}

/**
 * Convert viewport-relative client pixels to canvas backing-store pixels.
 *
 * Pure. `rect` is the canvas's `getBoundingClientRect()` (CSS pixels, viewport
 * origin); `canvas` is its `width`/`height` attributes (backing-store pixels).
 *
 * A zero or non-finite rect dimension means the canvas has not been laid out
 * yet — a pointer event genuinely can arrive in that window during a fullscreen
 * transition. Rather than returning `Infinity`/`NaN` and poisoning the camera's
 * target position for the rest of the session, the ratio falls back to 1.
 */
export function clientToCanvasPx(
    clientX: number,
    clientY: number,
    rect: RectLike,
    canvas: CanvasSizeLike
): CanvasPoint {
    return {
        x: (clientX - rect.left) * ratio(canvas.width, rect.width),
        y: (clientY - rect.top) * ratio(canvas.height, rect.height),
    };
}

/** Thin DOM wrapper over `clientToCanvasPx`. */
export function eventToCanvasPx(event: ClientPointLike, canvas: HTMLCanvasElement): CanvasPoint {
    return clientToCanvasPx(event.clientX, event.clientY, canvas.getBoundingClientRect(), canvas);
}

/**
 * Undo the legacy `clientX * devicePixelRatio` idiom.
 *
 * The ~21 call sites listed above are **not** being changed during the port —
 * WEB_PORT.md schedules that codemod for M14, once every mode is proven. Until
 * then `rpc/handlers/interaction.ts` receives already-multiplied values, so it
 * divides back out here to recover `clientX`/`clientY` and then applies
 * `clientToCanvasPx`. Exactly correct because all 21 sites use an identical
 * idiom, and the round trip is lossless: the multiply and the divide use the
 * same `devicePixelRatio`, read within the same frame.
 *
 * @param dpr override for tests; defaults to `window.devicePixelRatio || 1`,
 *            matching the `|| 1` in the legacy sites.
 */
export function recoverClientFromLegacyScreenPx(
    screenX: number,
    screenY: number,
    dpr: number = devicePixelRatioOr1()
): ClientPointLike {
    // Guard a pathological dpr rather than dividing by zero.
    const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    return { clientX: screenX / scale, clientY: screenY / scale };
}

/**
 * `window.devicePixelRatio || 1`, safe outside a DOM.
 *
 * The only place in the engine that may read `devicePixelRatio`, and only to
 * undo a legacy multiplication — never to compute a coordinate.
 */
export function devicePixelRatioOr1(): number {
    return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
}

function ratio(backing: number, css: number): number {
    return Number.isFinite(css) && css > 0 && Number.isFinite(backing) ? backing / css : 1;
}
