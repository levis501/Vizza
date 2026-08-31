/**
 * Colour-space conversion and gradient interpolation.
 *
 * Port of the conversion half of `gradient/shaders/gradient.wgsl:33-137` — the
 * sRGB transfer function, the sRGB/XYZ matrices, CIE Lab and OKLab. Those WGSL
 * functions exist for `interpolate_rgb` / `interpolate_lab` /
 * `interpolate_oklab` (gradient.wgsl:234-312), which **nothing calls**:
 * `fs_main` (gradient.wgsl:314) only samples the already-baked LUT. All the
 * real interpolation happens on the CPU, which is why it belongs here.
 *
 * Why a new module rather than growing `ColorScheme.ts`: that file is the port
 * of `shared/color_scheme.rs`, a container for 768 bytes with no maths in it
 * beyond `srgbToLinear`. This one is the port of `gradient.wgsl`. The repo
 * keeps one module per Rust/WGSL origin, and mixing the two would leave a
 * "which file is this a port of?" question at the top of both. `srgbToLinear`
 * stays where it is and is re-exported here, so there is exactly one
 * definition of it in the app — the CPU and the GPU must agree on that one.
 *
 * Everything here is pure: no DOM, no GPU, no module state.
 *
 * ## Deliberate divergences from the WGSL
 *
 * These are all in code the shader never executes, so nothing on screen
 * changes; they are corrections, not concessions.
 *
 * 1. `gradient.wgsl:123-136`'s `oklab_to_xyz` is **not the inverse** of its own
 *    `xyz_to_oklab`. Its first row (1.2268798733, -0.5578149965, 0.2813910456)
 *    comes from the CSS Color 4 LMS→XYZ matrix while rows 2 and 3 are the
 *    inverse of Ottosson's M₁ — two different sources spliced together, so the
 *    round trip drifts by ~1.3e-4 in X. This module never routes OKLab through
 *    XYZ at all (see `linearRgbToOklab`).
 * 2. Lab uses the exact CIE constants ε = 216/24389 and κ = 24389/27 rather
 *    than the WGSL's rounded 0.008856 / 7.787. The two differ only below
 *    Y ≈ 0.0089 — 8-bit sRGB values of about 22 and darker.
 * 3. `xyz_to_linear_rgb` (gradient.wgsl:58) carries the 7-digit published
 *    inverse; this module uses the exact numerical inverse of its own forward
 *    matrix, so XYZ round trips to ~1e-9 instead of ~1e-7.
 */

import { srgbToLinear } from './ColorScheme';

export { srgbToLinear };

/** A colour as three components. Ranges depend on the space. */
export type Triplet = readonly [number, number, number];

// --- the sRGB transfer function ------------------------------------------

/**
 * Linear → sRGB, the inverse of `srgbToLinear` (ColorScheme.ts:25) and of
 * `linear_to_rgb` (gradient.wgsl:42).
 *
 * Sign-preserving, which the WGSL is not. Lab and OKLab interpolation routinely
 * lands outside the sRGB gamut, and `Math.pow(negative, 1/2.4)` is `NaN` — a
 * value that then propagates silently through the whole LUT. Mirroring the
 * curve through the origin keeps the result finite and ordered, which is what
 * the clamp in `formatHex` needs to do its job. This is the same convention
 * extended-sRGB (scRGB) uses.
 *
 * Note the two thresholds are not exact mutual inverses: 0.0031308 × 12.92 =
 * 0.040449936, not 0.04045. That 6.4e-8 discontinuity is in the published sRGB
 * constants themselves, is what every implementation in this repo already uses
 * (gradient.wgsl:33/42, color_scheme.rs:73, ParticleLifeMode.svelte:372), and
 * is far below one 8-bit code, so it is reproduced rather than "fixed".
 */
export function linearToSrgb(linear: number): number {
    const magnitude = Math.abs(linear);
    const encoded =
        magnitude <= 0.0031308 ? magnitude * 12.92 : 1.055 * Math.pow(magnitude, 1 / 2.4) - 0.055;
    return linear < 0 ? -encoded : encoded;
}

/** Per-channel `srgbToLinear`. Components in [0,1] in, linear out. */
export function srgbToLinearRgb(srgb: Triplet): Triplet {
    return [srgbToLinear(srgb[0]), srgbToLinear(srgb[1]), srgbToLinear(srgb[2])];
}

/** Per-channel `linearToSrgb`. May return values outside [0,1]; see above. */
export function linearRgbToSrgb(linear: Triplet): Triplet {
    return [linearToSrgb(linear[0]), linearToSrgb(linear[1]), linearToSrgb(linear[2])];
}

// --- linear sRGB ↔ CIE XYZ (D65) -----------------------------------------

/**
 * Linear sRGB → CIE XYZ, D65. Same coefficients as `linear_rgb_to_xyz`
 * (gradient.wgsl:51).
 */
const RGB_TO_XYZ = [
    0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041,
] as const;

/**
 * The exact numerical inverse of `RGB_TO_XYZ`, to ten digits.
 *
 * `gradient.wgsl:58` carries the seven-digit published form (3.2404542, …);
 * these are the same matrix computed to more places, so the two agree to 1e-6
 * and this one round trips cleanly.
 */
const XYZ_TO_RGB = [
    3.240454836, -1.5371388501, -0.4985315469, -0.9692663899, 1.8760109288, 0.0415560823,
    0.0556434196, -0.2040258543, 1.0572251625,
] as const;

function transform(m: readonly number[], v: Triplet): Triplet {
    return [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
        m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
    ];
}

export function linearRgbToXyz(linear: Triplet): Triplet {
    return transform(RGB_TO_XYZ, linear);
}

export function xyzToLinearRgb(xyz: Triplet): Triplet {
    return transform(XYZ_TO_RGB, xyz);
}

// --- CIE XYZ ↔ CIE L*a*b* -------------------------------------------------

/**
 * The D65 white point — `RGB_TO_XYZ`'s own row sums.
 *
 * This is **D65**, not the D50 that CSS, ICC and culori's `lab` mode use. The
 * whole app is sRGB-native, so adapting to D50 and back would only add a
 * Bradford round trip and move the numbers off the values everyone publishes
 * for sRGB primaries. The tests anchor against D65 references accordingly.
 *
 * Taken from the matrix rather than written out as `gradient.wgsl:67-69`'s
 * literal (0.95047, 1.0, 1.08883), which is a difference of 1e-7 in Y: the
 * 7-digit matrix's green row sums to 1.0000001, so with the literal white
 * point a neutral grey does not quite land on a* = b* = 0 and white is not
 * quite L* = 100. Deriving it keeps "grey stays grey" exact, which is the one
 * property of Lab a gradient editor leans on hardest.
 */
const WHITE_D65: Triplet = [
    RGB_TO_XYZ[0] + RGB_TO_XYZ[1] + RGB_TO_XYZ[2],
    RGB_TO_XYZ[3] + RGB_TO_XYZ[4] + RGB_TO_XYZ[5],
    RGB_TO_XYZ[6] + RGB_TO_XYZ[7] + RGB_TO_XYZ[8],
];

/** ε = 216/24389 and κ = 24389/27 — the exact CIE 15 constants. */
const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

function labForward(t: number): number {
    return t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116;
}

function labInverse(f: number): number {
    const cubed = f * f * f;
    return cubed > LAB_EPSILON ? cubed : (116 * f - 16) / LAB_KAPPA;
}

/** CIE XYZ (D65) → L*a*b*. L* in [0,100]; a*, b* roughly ±128. */
export function xyzToLab(xyz: Triplet): Triplet {
    const fx = labForward(xyz[0] / WHITE_D65[0]);
    const fy = labForward(xyz[1] / WHITE_D65[1]);
    const fz = labForward(xyz[2] / WHITE_D65[2]);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** L*a*b* → CIE XYZ (D65). */
export function labToXyz(lab: Triplet): Triplet {
    const fy = (lab[0] + 16) / 116;
    const fx = lab[1] / 500 + fy;
    const fz = fy - lab[2] / 200;
    return [
        labInverse(fx) * WHITE_D65[0],
        labInverse(fy) * WHITE_D65[1],
        labInverse(fz) * WHITE_D65[2],
    ];
}

// --- linear sRGB ↔ OKLab --------------------------------------------------

/**
 * Linear sRGB → OKLab's cone-response (LMS) space, and LMS' → OKLab.
 *
 * OKLab *is* defined from CIE XYZ (D65) — Ottosson's M₁ maps XYZ to LMS — so
 * routing it through XYZ is not in itself wrong. It is used here anyway because
 * Ottosson publishes this pre-composed linear-sRGB→LMS matrix as the reference
 * implementation, and it is the one every published OKLab value for the sRGB
 * primaries was computed with. Composing M₁ with `RGB_TO_XYZ` instead gives
 * answers about 1e-5 away from those, because the two derivations round the
 * sRGB primaries differently — enough to make a "known reference value" test
 * meaningless. One matrix multiply less, and exactly reproducible numbers.
 *
 * Source: Björn Ottosson, "A perceptual color space for image processing"
 * (2020), the `linear_srgb_to_oklab` listing.
 */
const LRGB_TO_LMS = [
    0.4122214708, 0.5363325363, 0.0514459929, 0.2119034982, 0.6806995451, 0.1073969566,
    0.0883024619, 0.2817188376, 0.6299787005,
] as const;

/** M₂ — LMS' (cube-rooted LMS) → OKLab. Same as `xyz_to_oklab`'s second half. */
const LMS_TO_OKLAB = [
    0.2104542553, 0.793617785, -0.0040720468, 1.9779984951, -2.428592205, 0.4505937099,
    0.0259040371, 0.7827717662, -0.808675766,
] as const;

/** Ottosson's published inverse of `LMS_TO_OKLAB`; matches it to 6e-8. */
const OKLAB_TO_LMS = [
    1.0, 0.3963377774, 0.2158037573, 1.0, -0.1055613458, -0.0638541728, 1.0, -0.0894841775,
    -1.291485548,
] as const;

/** Ottosson's published inverse of `LRGB_TO_LMS`; matches it to 9e-10. */
const LMS_TO_LRGB = [
    4.0767416621, -3.3077115913, 0.2309699292, -1.2684380046, 2.6097574011, -0.3413193965,
    -0.0041960863, -0.7034186147, 1.707614701,
] as const;

/**
 * Cube root that keeps the sign.
 *
 * `Math.cbrt` already does, but naming it makes the reason explicit: an
 * out-of-gamut linear RGB triple can drive an LMS component negative, and the
 * `pow(l, 1/3)` in `gradient.wgsl:112` returns NaN there.
 */
const cbrt = Math.cbrt;

/** Linear sRGB → OKLab. L in [0,1] for in-gamut colours; a, b roughly ±0.4. */
export function linearRgbToOklab(linear: Triplet): Triplet {
    const lms = transform(LRGB_TO_LMS, linear);
    return transform(LMS_TO_OKLAB, [cbrt(lms[0]), cbrt(lms[1]), cbrt(lms[2])]);
}

/** OKLab → linear sRGB. May land outside [0,1] — OKLab is larger than sRGB. */
export function oklabToLinearRgb(oklab: Triplet): Triplet {
    const lmsPrime = transform(OKLAB_TO_LMS, oklab);
    return transform(LMS_TO_LRGB, [
        lmsPrime[0] ** 3,
        lmsPrime[1] ** 3,
        lmsPrime[2] ** 3,
    ] as Triplet);
}

/**
 * Below this chroma a colour counts as neutral and is given no hue.
 *
 * Not zero: the published M₂ coefficients sum to about 7e-9 rather than exactly
 * 0 in the a and b rows, so a pure grey comes out of `linearRgbToOklab` with a
 * chroma of a few times 1e-9 pointing in an arbitrary direction. 1e-6 is three
 * orders above that noise and four orders below the chroma of the least
 * saturated colour 8-bit sRGB can express.
 */
const NEUTRAL_CHROMA = 1e-6;

/** OKLab → OKLCh. Chroma ≥ 0, hue in degrees [0,360). */
export function oklabToOklch(oklab: Triplet): Triplet {
    const chroma = Math.hypot(oklab[1], oklab[2]);
    // A neutral has no meaningful hue; reporting 0 rather than atan2's answer
    // for two near-zeros keeps a grey from rotating through the wheel.
    const hue =
        chroma < NEUTRAL_CHROMA
            ? 0
            : ((Math.atan2(oklab[2], oklab[1]) * 180) / Math.PI + 360) % 360;
    return [oklab[0], chroma, hue];
}

/** OKLCh → OKLab. */
export function oklchToOklab(oklch: Triplet): Triplet {
    const radians = (oklch[2] * Math.PI) / 180;
    return [oklch[0], oklch[1] * Math.cos(radians), oklch[1] * Math.sin(radians)];
}

// --- composed sRGB entry points ------------------------------------------

export function srgbToXyz(srgb: Triplet): Triplet {
    return linearRgbToXyz(srgbToLinearRgb(srgb));
}

export function xyzToSrgb(xyz: Triplet): Triplet {
    return linearRgbToSrgb(xyzToLinearRgb(xyz));
}

export function srgbToLab(srgb: Triplet): Triplet {
    return xyzToLab(srgbToXyz(srgb));
}

export function labToSrgb(lab: Triplet): Triplet {
    return xyzToSrgb(labToXyz(lab));
}

export function srgbToOklab(srgb: Triplet): Triplet {
    return linearRgbToOklab(srgbToLinearRgb(srgb));
}

export function oklabToSrgb(oklab: Triplet): Triplet {
    return linearRgbToSrgb(oklabToLinearRgb(oklab));
}

export function srgbToOklch(srgb: Triplet): Triplet {
    return oklabToOklch(srgbToOklab(srgb));
}

export function oklchToSrgb(oklch: Triplet): Triplet {
    return oklabToSrgb(oklchToOklab(oklch));
}

// --- hex ------------------------------------------------------------------

const HEX_PATTERN = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

/**
 * `#rrggbb` or `#rgb` → sRGB components in [0,1].
 *
 * Throws rather than returning a fallback colour: both gradient editors read
 * their stop colours straight out of `<input type="color">`, so a value that
 * does not parse means the caller has a bug, and quietly substituting black
 * would bake it into a 768-byte LUT.
 */
export function parseHex(hex: string): Triplet {
    const match = HEX_PATTERN.exec(hex.trim());
    if (!match) throw new Error(`Not a hex colour: "${hex}"`);

    const digits = match[1];
    const expand = (i: number): number =>
        digits.length === 3
            ? parseInt(digits[i] + digits[i], 16) / 255
            : parseInt(digits.slice(i * 2, i * 2 + 2), 16) / 255;

    return [expand(0), expand(1), expand(2)];
}

function toByte(component: number): number {
    if (!Number.isFinite(component)) {
        throw new Error(`Colour component is not finite: ${component}`);
    }
    return Math.max(0, Math.min(255, Math.round(component * 255)));
}

/**
 * sRGB components in [0,1] → `#rrggbb`, clamping out-of-gamut values.
 *
 * Clamping is the whole gamut-mapping strategy, matching what culori's
 * `formatHex` did for the two Svelte copies. A chroma-reducing map would look
 * better on saturated Lab interpolations, but it would also change every
 * existing gradient, which is an M14 visual-parity decision.
 */
export function formatHex(srgb: Triplet): string {
    const hex = (c: number): string => toByte(c).toString(16).padStart(2, '0');
    return `#${hex(srgb[0])}${hex(srgb[1])}${hex(srgb[2])}`;
}

// --- gradient interpolation ----------------------------------------------

/**
 * The colour spaces the gradient editor interpolates in.
 *
 * `rgb`, `lab` and `oklab` are exactly the three `gradient.wgsl:234-312`
 * implements. `oklch` replaces the cylindrical entry both Svelte copies
 * advertised and neither could deliver — `ColorSchemeSelector.svelte:75` offers
 * `Jzazbz` and `HSLuv`, which it maps to culori mode names culori does not
 * register (it has `jab` and `lchuv`), so picking either throws
 * `converters[color.mode].rgb is not a function`; `GradientEditorMode.svelte:105`
 * offers culori's real `jab` and `lchuv`, which work but have no counterpart in
 * the shader. OKLCh is derived from OKLab with no new matrices, so it is the
 * one cylindrical space that can be held to the same reference values.
 */
export const GRADIENT_COLOR_SPACES = ['rgb', 'lab', 'oklab', 'oklch'] as const;

export type GradientColorSpace = (typeof GRADIENT_COLOR_SPACES)[number];

/** Display names for the `<Selector>` in both editors. */
export const GRADIENT_COLOR_SPACE_LABELS: Record<GradientColorSpace, string> = {
    rgb: 'RGB',
    lab: 'Lab',
    oklab: 'OkLab',
    oklch: 'OkLCh',
};

/** The default both editors already used, and the best default to keep. */
export const DEFAULT_GRADIENT_COLOR_SPACE: GradientColorSpace = 'oklab';

/**
 * Every spelling either editor has ever produced, mapped onto the canonical
 * set.
 *
 * The two copies disagreed on case (`OkLab` vs `oklab`) and on membership, and
 * a stored gradient may carry either. Mapping instead of throwing means no
 * saved value can leave a `<Selector>` showing nothing selected — the failure
 * mode M4 fixed for Gray-Scott's mask enums. `jab`/`Jzazbz` fold to `oklab` and
 * `lchuv`/`HSLuv` to `oklch`: the nearest space of the same kind.
 */
const COLOR_SPACE_ALIASES: Record<string, GradientColorSpace> = {
    rgb: 'rgb',
    srgb: 'rgb',
    lab: 'lab',
    cielab: 'lab',
    oklab: 'oklab',
    jab: 'oklab',
    jzazbz: 'oklab',
    oklch: 'oklch',
    okclh: 'oklch',
    lchuv: 'oklch',
    hsluv: 'oklch',
};

/** Parse a stored or user-supplied space name; falls back to the default. */
export function parseGradientColorSpace(value: unknown): GradientColorSpace {
    if (typeof value !== 'string') return DEFAULT_GRADIENT_COLOR_SPACE;
    return COLOR_SPACE_ALIASES[value.trim().toLowerCase()] ?? DEFAULT_GRADIENT_COLOR_SPACE;
}

/** A gradient stop, as both editors model one. */
export interface GradientStop {
    /** In [0,1]. */
    position: number;
    /** `#rrggbb`. */
    color: string;
}

export type InterpolationMode = 'Smooth' | 'Stepped';

export interface GradientOptions {
    space?: GradientColorSpace;
    mode?: InterpolationMode;
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function lerpTriplet(a: Triplet, b: Triplet, t: number): Triplet {
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/**
 * Interpolate hue the short way round the wheel.
 *
 * Without this, mixing red (h≈29°) and blue (h≈264°) sweeps through green
 * rather than magenta — the classic cylindrical-space bug. Matches CSS Color
 * 4's default `shorter` hue-interpolation method.
 */
function lerpHue(a: number, b: number, t: number): number {
    let delta = (((b - a) % 360) + 360) % 360;
    if (delta > 180) delta -= 360;
    return (((a + delta * t) % 360) + 360) % 360;
}

/** Mix two sRGB triples in `space`. Returns sRGB, possibly out of gamut. */
export function mixSrgb(a: Triplet, b: Triplet, t: number, space: GradientColorSpace): Triplet {
    switch (space) {
        case 'rgb':
            return lerpTriplet(a, b, t);
        case 'lab':
            return labToSrgb(lerpTriplet(srgbToLab(a), srgbToLab(b), t));
        case 'oklab':
            return oklabToSrgb(lerpTriplet(srgbToOklab(a), srgbToOklab(b), t));
        case 'oklch': {
            const ca = srgbToOklch(a);
            const cb = srgbToOklch(b);
            // A neutral endpoint has no hue of its own (chroma 0), so it should
            // adopt the other end's rather than drag the mix towards hue 0.
            const ha = ca[1] < NEUTRAL_CHROMA ? cb[2] : ca[2];
            const hb = cb[1] < NEUTRAL_CHROMA ? ca[2] : cb[2];
            return oklchToSrgb([lerp(ca[0], cb[0], t), lerp(ca[1], cb[1], t), lerpHue(ha, hb, t)]);
        }
    }
}

/**
 * Mix two hex colours, as `interpolateColor` did in both editors
 * (GradientEditorMode.svelte:295, ColorSchemeSelector.svelte:441).
 */
export function mixHex(
    a: string,
    b: string,
    t: number,
    space: GradientColorSpace = DEFAULT_GRADIENT_COLOR_SPACE
): string {
    return formatHex(mixSrgb(parseHex(a), parseHex(b), t, space));
}

/**
 * Stops sorted by position, validated.
 *
 * Both editors sort in place on every edit and then read `gradientStops[0]` and
 * `[length - 1]` as the endpoints, so an unsorted array is already outside
 * their contract; sorting a copy here means callers cannot get it wrong.
 */
function normalizeStops(stops: readonly GradientStop[]): GradientStop[] {
    if (stops.length === 0) throw new Error('A gradient needs at least one stop.');
    for (const stop of stops) {
        if (!Number.isFinite(stop.position)) {
            throw new Error(`Gradient stop position is not finite: ${stop.position}`);
        }
        // Parse eagerly so a malformed colour fails here, naming the stop,
        // rather than 256 samples later inside the LUT loop.
        parseHex(stop.color);
    }
    return [...stops].sort((a, b) => a.position - b.position);
}

/**
 * The colour at `position` along the gradient.
 *
 * Follows `GradientEditorMode.svelte:408`, which is the correct of the two
 * copies: it clamps `position` to [0,1] and returns the terminal stop's colour
 * outside the stop range. `ColorSchemeSelector.svelte:418` does neither — when
 * no pair brackets the position its loop leaves `leftStop`/`rightStop` at the
 * first and last stops, so a gradient whose stops do not reach 0 and 1
 * extrapolates across the whole range with t outside [0,1] instead of holding
 * the endpoint colour.
 */
export function sampleGradient(
    stops: readonly GradientStop[],
    position: number,
    options: GradientOptions = {}
): string {
    return sampleSorted(normalizeStops(stops), position, options);
}

/** `sampleGradient` over stops already sorted and validated. */
function sampleSorted(
    sorted: readonly GradientStop[],
    position: number,
    options: GradientOptions
): string {
    const space = options.space ?? DEFAULT_GRADIENT_COLOR_SPACE;
    const stepped = options.mode === 'Stepped';

    const p = Math.max(0, Math.min(1, position));
    if (p <= sorted[0].position) return sorted[0].color;

    const last = sorted[sorted.length - 1];
    if (p >= last.position) return last.color;

    // Binary search, as GradientEditorMode does — the editors allow arbitrarily
    // many stops and this runs 256 times per LUT rebuild, per keystroke.
    let left = 0;
    let right = sorted.length - 1;
    while (right - left > 1) {
        const mid = (left + right) >> 1;
        if (sorted[mid].position <= p) left = mid;
        else right = mid;
    }

    const leftStop = sorted[left];
    const rightStop = sorted[right];
    if (stepped) return leftStop.color;

    const span = rightStop.position - leftStop.position;
    // Coincident stops are reachable by dragging one onto another; both Svelte
    // copies divide by zero here and hand culori a NaN.
    if (span <= 0) return rightStop.color;

    return mixHex(leftStop.color, rightStop.color, (p - leftStop.position) / span, space);
}

/**
 * Bake a gradient into the 768-byte planar LUT the rest of the app expects:
 * `[R×256][G×256][B×256]`, matching `ColorScheme` and the `.lut` files.
 *
 * This replaces the four hand-rolled copies of the same loop —
 * `GradientEditorMode.svelte:467` and `:750`, `ColorSchemeSelector.svelte:803`
 * and `:828`. Note that the two *export* paths
 * (`GradientEditorMode.svelte:801`, `ColorSchemeSelector.svelte:490`) build an
 * **interleaved** `r,g,b,r,g,b…` list and write it as newline-separated text,
 * which is neither the planar order nor the binary format the `.lut` files in
 * `src-tauri/src/simulations/shared/LUTs/` use — the file they download cannot
 * be loaded back by either build. Not fixed here; it is in their files.
 */
export function buildGradientLut(
    stops: readonly GradientStop[],
    options: GradientOptions = {}
): Uint8Array {
    const sorted = normalizeStops(stops);
    const lut = new Uint8Array(768);

    for (let i = 0; i < 256; i++) {
        // sampleSorted, not sampleGradient: re-validating and re-sorting the
        // stops on all 256 samples would run the hex regex 256 × n times per
        // rebuild, and the editors rebuild on every keystroke.
        const hex = sampleSorted(sorted, i / 255, options);
        // sampleGradient has already validated every stop colour, so this parse
        // cannot fail; it is the cheapest way back to bytes.
        lut[i] = parseInt(hex.slice(1, 3), 16);
        lut[i + 256] = parseInt(hex.slice(3, 5), 16);
        lut[i + 512] = parseInt(hex.slice(5, 7), 16);
    }

    return lut;
}
