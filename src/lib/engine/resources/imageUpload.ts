/**
 * Image upload: `<input type="file">` → `createImageBitmap` → a bitmap sized
 * and oriented for `copyExternalImageToTexture`.
 *
 * The desktop app opened a native dialog, handed Rust a filesystem path, and
 * did the fitting with the `image` crate (canonical implementations:
 * slime_mold/simulation.rs:1638 for the mask/position images,
 * vectors/simulation.rs:462 for the vector field). Here the browser decodes the
 * file and a 2D canvas does the fitting, which keeps the whole path off the GPU
 * queue until the final copy.
 *
 * Five simulations need this — Slime Mold (position + mask), Gray-Scott
 * (nutrient), Flow (vector field), Moiré, Vectors — which is why it lands in M2
 * rather than five times over.
 *
 * **Decoded images are session-only and are never persisted.** Base64 of a 4K
 * image is several megabytes and localStorage gives the whole origin 5-10 MB,
 * so writing one there would evict every preset the user has. This is a
 * documented omission in WEB_PORT.md, not an oversight.
 */

/**
 * Mirrors `ImageFitMode` (src-tauri/src/simulations/shared/types.rs:4).
 *
 * The string values are the serde/display names, which is what
 * `ImageSelector.svelte` puts in its Selector and what the `set_*_image_fit_mode`
 * commands carry.
 */
export type ImageFitMode = 'Stretch' | 'Center' | 'Fit H' | 'Fit V';

export const IMAGE_FIT_MODES: readonly ImageFitMode[] = ['Stretch', 'Center', 'Fit H', 'Fit V'];

export const DEFAULT_IMAGE_FIT_MODE: ImageFitMode = 'Stretch';

/**
 * Port of `FromStr for ImageFitMode` (types.rs:40): exact display names first,
 * then lowercase and compact forms. The compact ones matter because
 * `ImageSelector.svelte` types its callback as `'FitH' | 'FitV'` even though it
 * emits `'Fit H'` / `'Fit V'`, so both spellings are live in the codebase.
 */
export function parseImageFitMode(value: string): ImageFitMode | null {
    const trimmed = value.trim();
    if ((IMAGE_FIT_MODES as readonly string[]).includes(trimmed)) {
        return trimmed as ImageFitMode;
    }
    switch (trimmed.toLowerCase()) {
        case 'stretch':
            return 'Stretch';
        case 'center':
            return 'Center';
        case 'fit h':
        case 'fith':
            return 'Fit H';
        case 'fit v':
        case 'fitv':
            return 'Fit V';
        default:
            return null;
    }
}

/** The per-simulation image flags, all of which exist in the Rust settings. */
export interface ImageTransform {
    fitMode: ImageFitMode;
    mirrorHorizontal: boolean;
    mirrorVertical: boolean;
    invertTone: boolean;
}

export const DEFAULT_IMAGE_TRANSFORM: ImageTransform = {
    fitMode: DEFAULT_IMAGE_FIT_MODE,
    mirrorHorizontal: false,
    mirrorVertical: false,
    invertTone: false,
};

/** Destination rectangle for the source image, in target pixels. */
export interface FitRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * Where the source image lands inside a `dstW × dstH` target.
 *
 * Pure and DOM-free, so the fit arithmetic is unit-testable without a canvas.
 * Semantics follow the slime-mold/gray-scott implementation:
 *
 *   Stretch  fill the target, aspect ignored
 *   Center   no scaling; centred, cropped if larger, zero-padded if smaller
 *   Fit H    scale to the target width; centred vertically when it fits,
 *            top-aligned when it overflows
 *   Fit V    scale to the target height; centred horizontally when it fits,
 *            left-aligned when it overflows
 *
 * The overflow alignments look arbitrary but are what the Rust does — its
 * `offset` is clamped to 0 rather than going negative in the Fit cases (see
 * simulation.rs:1725 and :1762) — and preset screenshots depend on it.
 */
export function computeFitRect(
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number,
    mode: ImageFitMode
): FitRect {
    switch (mode) {
        case 'Stretch':
            return { x: 0, y: 0, width: dstW, height: dstH };

        case 'Center':
            // Integer division in Rust, and it goes negative to crop.
            return {
                x: dstW > srcW ? Math.floor((dstW - srcW) / 2) : -Math.floor((srcW - dstW) / 2),
                y: dstH > srcH ? Math.floor((dstH - srcH) / 2) : -Math.floor((srcH - dstH) / 2),
                width: srcW,
                height: srcH,
            };

        case 'Fit H': {
            const scaledH = Math.trunc((srcH * dstW) / srcW);
            return {
                x: 0,
                y: scaledH < dstH ? Math.floor((dstH - scaledH) / 2) : 0,
                width: dstW,
                height: scaledH,
            };
        }

        case 'Fit V': {
            const scaledW = Math.trunc((srcW * dstH) / srcH);
            return {
                x: scaledW < dstW ? Math.floor((dstW - scaledW) / 2) : 0,
                y: 0,
                width: scaledW,
                height: dstH,
            };
        }
    }
}

/**
 * Invert every colour channel in place, leaving alpha alone.
 *
 * The Rust works on Luma8 and does `255 - v`; on RGBA the same operation per
 * channel is equivalent once the result is greyscaled.
 */
export function invertToneInPlace(pixels: Uint8ClampedArray): void {
    for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = 255 - pixels[i];
        pixels[i + 1] = 255 - pixels[i + 1];
        pixels[i + 2] = 255 - pixels[i + 2];
    }
}

/**
 * Rec.709 luma, matching the `image` crate's `to_luma8` weights.
 *
 * Applied to the raw sRGB channel values, not linearised ones — that is what
 * the crate does, and the mask/vector-field buffers are compared against
 * gamma-space thresholds downstream.
 */
export function lumaFromRgb(r: number, g: number, b: number): number {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export interface DecodedImage {
    /** Valid as the `source` of `copyExternalImageToTexture`. */
    bitmap: ImageBitmap;
    width: number;
    height: number;
}

/**
 * Decode a `File` from `<input type="file">`.
 *
 * `ImageSelector.svelte` collects the File and passes it as `imageFile`; this
 * is the other end of that hand-off. `createImageBitmap` decodes off the main
 * thread, unlike an `<img>` round-trip.
 */
export async function decodeImageFile(file: File): Promise<ImageBitmap> {
    try {
        return await createImageBitmap(file);
    } catch (err) {
        throw new Error(`Could not decode "${file.name}" as an image: ${String(err)}`);
    }
}

function createCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

type Canvas2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function context2d(canvas: OffscreenCanvas | HTMLCanvasElement): Canvas2D {
    // willReadFrequently: the invert-tone path reads the whole buffer back.
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as Canvas2D | null;
    if (!ctx) throw new Error('Could not acquire a 2D context to process the image');
    return ctx;
}

/**
 * Fit, mirror and invert a decoded image into a `width × height` canvas.
 *
 * Mirroring is applied to the whole target rather than to the source rect,
 * which is exactly what the Rust does — it flips the finished buffer
 * (`flip_horizontal_in_place`, vectors/simulation.rs:526) — and matters
 * whenever the fit crops asymmetrically.
 */
export function drawFittedImage(
    source: ImageBitmap,
    width: number,
    height: number,
    transform: Partial<ImageTransform> = {}
): OffscreenCanvas | HTMLCanvasElement {
    const { fitMode, mirrorHorizontal, mirrorVertical, invertTone } = {
        ...DEFAULT_IMAGE_TRANSFORM,
        ...transform,
    };

    const canvas = createCanvas(width, height);
    const ctx = context2d(canvas);

    // Areas the image does not cover read as 0 in the Rust, not as transparent
    // black bleeding through whatever the texture held before.
    ctx.clearRect(0, 0, width, height);

    const rect = computeFitRect(source.width, source.height, width, height, fitMode);

    // 1:1 blits must not be resampled; browsers otherwise soften them, and
    // 'Center' is defined as a straight paste.
    ctx.imageSmoothingEnabled = rect.width !== source.width || rect.height !== source.height;
    ctx.imageSmoothingQuality = 'high';

    ctx.save();
    if (mirrorHorizontal) {
        ctx.translate(width, 0);
        ctx.scale(-1, 1);
    }
    if (mirrorVertical) {
        ctx.translate(0, height);
        ctx.scale(1, -1);
    }
    ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height);
    ctx.restore();

    if (invertTone) {
        const image = ctx.getImageData(0, 0, width, height);
        invertToneInPlace(image.data);
        ctx.putImageData(image, 0, 0);
    }

    return canvas;
}

/**
 * The whole path: File → decoded, fitted, oriented bitmap.
 *
 * The intermediate decode is closed before returning, so a 4K upload does not
 * keep two full-resolution surfaces alive.
 */
export async function loadImageFile(
    file: File,
    width: number,
    height: number,
    transform: Partial<ImageTransform> = {}
): Promise<DecodedImage> {
    const decoded = await decodeImageFile(file);
    try {
        return await fitImage(decoded, width, height, transform);
    } finally {
        decoded.close();
    }
}

/** Re-fit an already-decoded image, for when only the fit mode changed. */
export async function fitImage(
    source: ImageBitmap,
    width: number,
    height: number,
    transform: Partial<ImageTransform> = {}
): Promise<DecodedImage> {
    const canvas = drawFittedImage(source, width, height, transform);
    const bitmap = await createImageBitmap(canvas);
    return { bitmap, width, height };
}

/**
 * Greyscale float buffer, row-major, values in 0..1.
 *
 * This is the form the mask and vector-field paths want — the Rust uploads
 * exactly this to `mask_buffer` (simulation.rs:1789) — as opposed to a texture.
 */
export function grayscaleFromCanvas(
    canvas: OffscreenCanvas | HTMLCanvasElement,
    width: number,
    height: number
): Float32Array {
    const { data } = context2d(canvas).getImageData(0, 0, width, height);
    const out = new Float32Array(width * height);
    for (let i = 0; i < out.length; i++) {
        const p = i * 4;
        out[i] = lumaFromRgb(data[p], data[p + 1], data[p + 2]) / 255;
    }
    return out;
}

/**
 * Greyscale byte buffer, row-major — the `to_luma8()` result the Rust uploads
 * into an `R8Unorm` texture (moire/simulation.rs:578).
 *
 * Separate from `grayscaleFromCanvas` because these two consumers want
 * genuinely different things: a mask is read as a float in a storage buffer,
 * whereas an image *texture* has to be 8-bit texels. Rounding rather than
 * truncating, so a mid-grey does not drift a step darker on every re-fit.
 */
export function grayscaleBytesFromCanvas(
    canvas: OffscreenCanvas | HTMLCanvasElement,
    width: number,
    height: number
): Uint8Array<ArrayBuffer> {
    const { data } = context2d(canvas).getImageData(0, 0, width, height);
    const out = new Uint8Array(width * height);
    for (let i = 0; i < out.length; i++) {
        const p = i * 4;
        out[i] = Math.round(lumaFromRgb(data[p], data[p + 1], data[p + 2]));
    }
    return out;
}

/** File → fitted greyscale buffer, for mask/vector-field uploads. */
export async function loadImageFileAsGrayscale(
    file: File,
    width: number,
    height: number,
    transform: Partial<ImageTransform> = {}
): Promise<Float32Array> {
    const decoded = await decodeImageFile(file);
    try {
        return grayscaleFromCanvas(
            drawFittedImage(decoded, width, height, transform),
            width,
            height
        );
    } finally {
        decoded.close();
    }
}

/**
 * Copy a decoded image into an existing texture.
 *
 * `flipY: false` and `premultipliedAlpha: false` keep the texels byte-identical
 * to what the Rust uploaded; the shaders index these images by pixel and do
 * their own orientation, so any implicit flip here would silently mirror five
 * simulations.
 */
export function uploadImageToTexture(
    device: GPUDevice,
    image: DecodedImage,
    texture: GPUTexture,
    origin: GPUOrigin3DDict = {}
): void {
    device.queue.copyExternalImageToTexture(
        { source: image.bitmap, flipY: false },
        { texture, origin, premultipliedAlpha: false },
        { width: image.width, height: image.height }
    );
}
