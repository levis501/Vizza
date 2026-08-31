/**
 * Pointer conversion — L1.
 *
 * The whole point of `clientToCanvasPx` is that it is correct in the cases the
 * legacy `clientX * devicePixelRatio` idiom gets wrong, so the cases here are
 * chosen to be exactly those: a canvas that does not start at (0,0), and a
 * backing store whose scale is not `devicePixelRatio` because DPR was clamped.
 */

import { describe, expect, it } from 'vitest';
import {
    clientToCanvasPx,
    recoverClientFromLegacyScreenPx,
    type CanvasSizeLike,
    type RectLike,
} from '../../src/lib/engine/gpu/pointer';

/** A canvas filling the viewport at DPR 1 — the trivial case. */
const identityRect: RectLike = { left: 0, top: 0, width: 800, height: 600 };
const identityCanvas: CanvasSizeLike = { width: 800, height: 600 };

describe('clientToCanvasPx', () => {
    it('is the identity when the canvas is at the origin at 1:1', () => {
        expect(clientToCanvasPx(0, 0, identityRect, identityCanvas)).toEqual({ x: 0, y: 0 });
        expect(clientToCanvasPx(400, 300, identityRect, identityCanvas)).toEqual({
            x: 400,
            y: 300,
        });
        expect(clientToCanvasPx(800, 600, identityRect, identityCanvas)).toEqual({
            x: 800,
            y: 600,
        });
    });

    it('subtracts a non-zero rect origin', () => {
        // A canvas inset by page chrome — failure mode 1 of the legacy idiom,
        // which never subtracts an offset at all.
        const rect: RectLike = { left: 120, top: 48, width: 800, height: 600 };
        expect(clientToCanvasPx(120, 48, rect, identityCanvas)).toEqual({ x: 0, y: 0 });
        expect(clientToCanvasPx(520, 348, rect, identityCanvas)).toEqual({ x: 400, y: 300 });
    });

    it('handles a fractional rect origin', () => {
        const rect: RectLike = { left: 10.5, top: 20.25, width: 800, height: 600 };
        const point = clientToCanvasPx(110.5, 120.25, rect, identityCanvas);
        expect(point.x).toBeCloseTo(100, 10);
        expect(point.y).toBeCloseTo(100, 10);
    });

    it('scales by the backing-store ratio at DPR 2', () => {
        const canvas: CanvasSizeLike = { width: 1600, height: 1200 };
        expect(clientToCanvasPx(400, 300, identityRect, canvas)).toEqual({ x: 800, y: 600 });
    });

    it('uses the canvas ratio, not devicePixelRatio, when DPR is clamped', () => {
        // WEB_PORT.md clamps DPR to 2 in gpu/surface.ts. On a 3x display the
        // backing store is therefore 2x the CSS size while devicePixelRatio
        // still reports 3 — failure mode 2. The legacy idiom would return 1200.
        const rect: RectLike = { left: 0, top: 0, width: 800, height: 600 };
        const canvas: CanvasSizeLike = { width: 1600, height: 1200 };
        const dprIfWeHadBeenSilly = 3;

        const correct = clientToCanvasPx(400, 300, rect, canvas);
        expect(correct.x).toBe(800);
        expect(400 * dprIfWeHadBeenSilly).toBe(1200); // what the legacy line gives
    });

    it('is correct under browser/CSS zoom, where the rect grows but the backing store does not', () => {
        // Failure mode 3: at 150% page zoom the canvas measures 1200x900 CSS
        // px while its backing store stays 800x600.
        const rect: RectLike = { left: 0, top: 0, width: 1200, height: 900 };
        const canvas: CanvasSizeLike = { width: 800, height: 600 };
        const point = clientToCanvasPx(600, 450, rect, canvas);
        expect(point.x).toBeCloseTo(400, 10);
        expect(point.y).toBeCloseTo(300, 10);
    });

    it('handles independent x and y ratios (a letterboxed canvas)', () => {
        const rect: RectLike = { left: 0, top: 0, width: 800, height: 300 };
        const canvas: CanvasSizeLike = { width: 1600, height: 1200 };
        expect(clientToCanvasPx(400, 150, rect, canvas)).toEqual({ x: 800, y: 600 });
    });

    it('maps the corners of a fully general rect onto the corners of the backing store', () => {
        const rect: RectLike = { left: 33, top: 77, width: 1234, height: 567 };
        const canvas: CanvasSizeLike = { width: 2468, height: 1134 };

        const topLeft = clientToCanvasPx(rect.left, rect.top, rect, canvas);
        expect(topLeft.x).toBeCloseTo(0, 10);
        expect(topLeft.y).toBeCloseTo(0, 10);

        const bottomRight = clientToCanvasPx(
            rect.left + rect.width,
            rect.top + rect.height,
            rect,
            canvas
        );
        expect(bottomRight.x).toBeCloseTo(canvas.width, 10);
        expect(bottomRight.y).toBeCloseTo(canvas.height, 10);
    });

    it('extrapolates outside the canvas rather than clamping', () => {
        // A drag that leaves the canvas must keep producing a monotonic
        // coordinate, or panning snaps at the edge.
        const rect: RectLike = { left: 100, top: 100, width: 800, height: 600 };
        const point = clientToCanvasPx(0, 0, rect, identityCanvas);
        expect(point.x).toBe(-100);
        expect(point.y).toBe(-100);
    });

    it('falls back to a 1:1 ratio for an unlaid-out canvas instead of returning NaN', () => {
        // A pointer event genuinely arrives in this window during a fullscreen
        // transition; NaN here would poison the camera target permanently.
        const rect: RectLike = { left: 0, top: 0, width: 0, height: 0 };
        const point = clientToCanvasPx(10, 20, rect, identityCanvas);
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
        expect(point).toEqual({ x: 10, y: 20 });
    });

    it('never reads devicePixelRatio', () => {
        // The guarantee is structural: the function takes no DPR and the module
        // exposes it only through recoverClientFromLegacyScreenPx. Assert it by
        // making any global read throw.
        const globalScope = globalThis as { window?: unknown };
        const hadWindow = 'window' in globalScope;
        const previous = globalScope.window;
        globalScope.window = new Proxy(
            {},
            {
                get(_target, property) {
                    if (property === 'devicePixelRatio') {
                        throw new Error('clientToCanvasPx read devicePixelRatio');
                    }
                    return undefined;
                },
            }
        );
        try {
            expect(() =>
                clientToCanvasPx(400, 300, identityRect, { width: 1600, height: 1200 })
            ).not.toThrow();
        } finally {
            if (hadWindow) globalScope.window = previous;
            else delete globalScope.window;
        }
    });
});

describe('recoverClientFromLegacyScreenPx', () => {
    it('inverts the legacy clientX * devicePixelRatio multiplication', () => {
        // SlimeMoldMode.svelte:1182 and ~20 siblings.
        const clientX = 412.5;
        const clientY = 233.25;
        const dpr = 2;
        const legacy = { screenX: clientX * dpr, screenY: clientY * dpr };

        const recovered = recoverClientFromLegacyScreenPx(legacy.screenX, legacy.screenY, dpr);
        expect(recovered.clientX).toBeCloseTo(clientX, 10);
        expect(recovered.clientY).toBeCloseTo(clientY, 10);
    });

    it('round-trips at a fractional DPR', () => {
        const dpr = 1.75;
        const recovered = recoverClientFromLegacyScreenPx(300 * dpr, 200 * dpr, dpr);
        expect(recovered.clientX).toBeCloseTo(300, 10);
        expect(recovered.clientY).toBeCloseTo(200, 10);
    });

    it('is the identity at DPR 1', () => {
        expect(recoverClientFromLegacyScreenPx(400, 300, 1)).toEqual({
            clientX: 400,
            clientY: 300,
        });
    });

    it('treats a non-positive or non-finite DPR as 1', () => {
        expect(recoverClientFromLegacyScreenPx(400, 300, 0)).toEqual({
            clientX: 400,
            clientY: 300,
        });
        expect(recoverClientFromLegacyScreenPx(400, 300, NaN)).toEqual({
            clientX: 400,
            clientY: 300,
        });
    });

    it('composes with clientToCanvasPx to undo the legacy path end to end', () => {
        // The exact chain rpc/handlers/interaction.ts will use: a mode
        // multiplied by DPR 3, but the backing store is clamped to 2x and the
        // canvas is inset.
        const dpr = 3;
        const rect: RectLike = { left: 64, top: 32, width: 800, height: 600 };
        const canvas: CanvasSizeLike = { width: 1600, height: 1200 };

        const trueClientX = 464; // 400 CSS px into the canvas
        const trueClientY = 332; // 300 CSS px into the canvas
        const legacyScreenX = trueClientX * dpr;
        const legacyScreenY = trueClientY * dpr;

        const client = recoverClientFromLegacyScreenPx(legacyScreenX, legacyScreenY, dpr);
        const point = clientToCanvasPx(client.clientX, client.clientY, rect, canvas);

        expect(point.x).toBeCloseTo(800, 8);
        expect(point.y).toBeCloseTo(600, 8);
    });
});
