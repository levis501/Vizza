/**
 * Canvas sizing.
 *
 * Two clamps, both load-bearing:
 *
 *  - **DPR is clamped to 2.** Gray-Scott sizes its simulation texture to the
 *    surface (traits.rs:~262). On a 4K display at an unclamped 3x DPR that is an
 *    11520x6480 rgba16float ping-pong pair — about 1.2 GB, an instant device
 *    loss. Above 2x the extra detail is invisible anyway.
 *  - **Backing size is clamped to maxTextureDimension2D.** The canvas backing
 *    store is a texture; exceeding the limit makes configure() fail and the
 *    canvas go blank with no error at the call site.
 */

export const MAX_DEVICE_PIXEL_RATIO = 2;

export interface SurfaceOptions {
    /** From device.limits — 8192 on the reference device. */
    maxTextureDimension2D: number;
    /** Called on every actual change of backing-store size, including the first. */
    onResize?: (width: number, height: number) => void;
}

export interface Surface {
    /** Backing-store width, i.e. canvas.width. Never CSS pixels. */
    readonly width: number;
    readonly height: number;
    /** The clamped ratio actually in use — not window.devicePixelRatio. */
    readonly pixelRatio: number;
    /** Re-measure now, e.g. after a layout change ResizeObserver cannot see. */
    refresh(): void;
    dispose(): void;
}

/**
 * Pure sizing arithmetic, split out so it can be unit-tested without a DOM.
 *
 * Aspect ratio is preserved when the max-dimension clamp bites, because a
 * squashed backing store would stretch every simulation's world space.
 */
export function computeBackingSize(
    cssWidth: number,
    cssHeight: number,
    devicePixelRatio: number,
    maxDimension: number
): [width: number, height: number] {
    const ratio = Math.min(Math.max(devicePixelRatio, 1), MAX_DEVICE_PIXEL_RATIO);

    // A detached or display:none canvas measures 0; a zero-sized texture is
    // invalid, so floor at one pixel rather than propagate the degenerate size.
    let width = Math.max(1, Math.floor(cssWidth * ratio));
    let height = Math.max(1, Math.floor(cssHeight * ratio));

    const overshoot = Math.max(width, height) / maxDimension;
    if (overshoot > 1) {
        width = Math.max(1, Math.floor(width / overshoot));
        height = Math.max(1, Math.floor(height / overshoot));
    }

    return [width, height];
}

export function createSurface(canvas: HTMLCanvasElement, options: SurfaceOptions): Surface {
    let width = 0;
    let height = 0;
    let pixelRatio = 1;

    const apply = (cssWidth: number, cssHeight: number) => {
        const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), MAX_DEVICE_PIXEL_RATIO);
        const [nextWidth, nextHeight] = computeBackingSize(
            cssWidth,
            cssHeight,
            dpr,
            options.maxTextureDimension2D
        );

        if (nextWidth === width && nextHeight === height) return;

        width = nextWidth;
        height = nextHeight;
        pixelRatio = dpr;
        canvas.width = width;
        canvas.height = height;

        options.onResize?.(width, height);
    };

    const measure = () => {
        const rect = canvas.getBoundingClientRect();
        // A fixed-position canvas with inset:0 has no layout box until the page
        // has painted; fall back to the viewport so the first frame is not 1x1.
        apply(rect.width || window.innerWidth, rect.height || window.innerHeight);
    };

    // ResizeObserver reports device-pixel content boxes on browsers that support
    // it, but the CSS box plus our own clamped ratio is both simpler and correct
    // under CSS zoom, which devicePixelRatio alone does not capture.
    const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const box = entry.contentRect;
        apply(box.width || window.innerWidth, box.height || window.innerHeight);
    });
    observer.observe(canvas);

    // ResizeObserver fires on element size changes but not on a DPR change from
    // dragging the window to a different-density display, which leaves the
    // backing store at the old scale.
    const onDprChange = () => measure();
    window.addEventListener('resize', onDprChange);

    measure();

    return {
        get width() {
            return width;
        },
        get height() {
            return height;
        },
        get pixelRatio() {
            return pixelRatio;
        },
        refresh: measure,
        dispose() {
            observer.disconnect();
            window.removeEventListener('resize', onDprChange);
        },
    };
}
