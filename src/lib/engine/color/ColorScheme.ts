/**
 * A 768-byte planar colour LUT.
 *
 * Straight port of src-tauri/src/simulations/shared/color_scheme.rs. The wire
 * format is the same on both sides — the `.lut` files are read by the Rust
 * build through `include_dir!` and by the browser build through the Vite plugin
 * that concatenates them (see vite-plugin-luts.ts), so there is one corpus, not
 * two.
 */

import type { ColorScheme as ColorSchemeContract } from '../types';

/** Bytes per scheme: 3 channels × 256 entries. */
export const LUT_STRIDE = 768;

/** Entries per channel. */
export const CHANNEL_LENGTH = 256;

/**
 * sRGB → linear, matching the closure at color_scheme.rs:73.
 *
 * The shaders and the species-colour uniforms all work in linear space, so
 * skipping this is not a subtle difference — it visibly washes colours out.
 */
export function srgbToLinear(srgb: number): number {
    return srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

export class ColorScheme implements ColorSchemeContract {
    readonly name: string;

    /** 768 bytes, planar: [R×256][G×256][B×256]. */
    readonly data: Uint8Array;

    constructor(name: string, data: Uint8Array) {
        if (data.length !== LUT_STRIDE) {
            // Mirrors from_bytes' length check — a short buffer here would
            // otherwise surface much later as a garbled gradient.
            throw new Error(
                `Invalid LUT data size for "${name}": ${data.length} bytes, expected ${LUT_STRIDE}`
            );
        }
        this.name = name;
        this.data = data;
    }

    /**
     * Copies `data` so the scheme never aliases a slice of the packed blob —
     * `reverse()` mutates in place and would otherwise corrupt every other
     * scheme sharing that ArrayBuffer.
     */
    static fromBytes(name: string, data: ArrayLike<number>): ColorScheme {
        return new ColorScheme(name, Uint8Array.from(data));
    }

    /** Views onto `data`, so mutating one mutates the scheme. */
    get red(): Uint8Array {
        return this.data.subarray(0, CHANNEL_LENGTH);
    }

    get green(): Uint8Array {
        return this.data.subarray(CHANNEL_LENGTH, CHANNEL_LENGTH * 2);
    }

    get blue(): Uint8Array {
        return this.data.subarray(CHANNEL_LENGTH * 2, CHANNEL_LENGTH * 3);
    }

    /** Reverse each channel independently, in place. */
    reverse(): void {
        this.red.reverse();
        this.green.reverse();
        this.blue.reverse();
    }

    /**
     * A reversed copy, named `<name>_reversed`.
     *
     * Note the asymmetry with `reverse()`, which is faithful to the Rust: the
     * in-place form keeps the name, which is why the default scheme reports as
     * "MATPLOTLIB_bone" even though it is served reversed.
     */
    reversed(): ColorScheme {
        const copy = this.clone(`${this.name}_reversed`);
        copy.reverse();
        return copy;
    }

    clone(name: string = this.name): ColorScheme {
        return new ColorScheme(name, this.data.slice());
    }

    /** The 768-byte planar form, for persistence. */
    toBytes(): Uint8Array {
        return this.data.slice();
    }

    /**
     * n equidistant stops as RGBA in **linear** space, alpha always 1.
     *
     * Port of get_colors (color_scheme.rs:64). The index arithmetic is integer
     * division in Rust, so it is floored here too.
     */
    getColors(n: number): number[][] {
        const colors: number[][] = [];
        for (let i = 0; i < n; i++) {
            const index = Math.min(n === 1 ? 0 : Math.floor((i * 255) / (n - 1)), 255);
            colors.push([
                srgbToLinear(this.red[index] / 255),
                srgbToLinear(this.green[index] / 255),
                srgbToLinear(this.blue[index] / 255),
                1.0,
            ]);
        }
        return colors;
    }

    getFirstColor(): number[] | undefined {
        return this.getColors(1)[0];
    }

    getLastColor(): number[] | undefined {
        return this.getColors(2)[1];
    }

    /**
     * The GPU form: 768 u32s, one widened u8 each.
     *
     * Four bytes to carry one is wasteful, but it is the layout every shader
     * binds (`array<u32, 768>`), so changing it would mean touching the WGSL
     * corpus shared with the Rust build.
     */
    toU32Buffer(): Uint32Array {
        return Uint32Array.from(this.data);
    }
}
