import { describe, it, expect } from 'vitest';
import {
    GRADIENT_COLOR_SPACES,
    DEFAULT_GRADIENT_COLOR_SPACE,
    buildGradientLut,
    formatHex,
    labToSrgb,
    labToXyz,
    linearRgbToOklab,
    linearRgbToSrgb,
    linearRgbToXyz,
    linearToSrgb,
    mixHex,
    oklabToLinearRgb,
    oklabToOklch,
    oklabToSrgb,
    oklchToOklab,
    parseGradientColorSpace,
    parseHex,
    sampleGradient,
    srgbToLab,
    srgbToLinear,
    srgbToLinearRgb,
    srgbToOklab,
    srgbToOklch,
    xyzToLab,
    xyzToLinearRgb,
    type GradientColorSpace,
    type Triplet,
} from '../../src/lib/engine/color/spaces';
import { LUT_STRIDE } from '../../src/lib/engine/color/ColorScheme';

/**
 * Tolerances, and why each one is what it is.
 *
 * This milestone's core is exactly computable, so the tolerances are set by
 * arithmetic rather than by taste:
 *
 * - `ROUND_TRIP` (1e-9) is for a conversion composed with its own exact
 *   numerical inverse — sRGB↔linear, XYZ↔linear RGB, Lab↔XYZ, OKLab↔OKLCh.
 *   Only f64 rounding stands between input and output, which over three matrix
 *   rows and a cube root costs at most a few units in the last place of a
 *   number of order 1.
 * - `PUBLISHED_INVERSE` (5e-6) is for OKLab↔linear RGB, whose inverse matrices
 *   are Ottosson's *published* ten-digit constants rather than the exact
 *   numerical inverse. Measured drift from exact is 9e-10 in one matrix and
 *   6e-8 in the other; cubing LMS' and then sRGB-encoding amplifies that to
 *   about 1e-6 near black, where the 1/2.4 power has a steep slope. 5e-6
 *   leaves headroom for that and still catches a transposed or mistyped row,
 *   which moves a component by 1e-2 or more.
 * - `ANCHOR_LAB` (5e-4) and `ANCHOR_OKLAB` (5e-7) are the precision the
 *   reference values below are quoted to, not a measure of our error.
 *
 * Assertions are on the absolute difference rather than `toBeCloseTo`, whose
 * digit argument means a tolerance of 0.5 × 10⁻ⁿ — half of what the name of
 * each constant here says.
 */
const ROUND_TRIP = 1e-9;
const PUBLISHED_INVERSE = 5e-6;
const ANCHOR_LAB = 5e-4;
const ANCHOR_OKLAB = 5e-7;

function expectClose(actual: Triplet, expected: Triplet, tolerance: number, what = '') {
    for (let i = 0; i < 3; i++) {
        expect(
            Math.abs(actual[i] - expected[i]),
            `${what} component ${i}: ${actual[i]} vs ${expected[i]}`
        ).toBeLessThanOrEqual(tolerance);
    }
}

/** A spread of colours to round-trip: primaries, greys, near-black, near-white. */
const SAMPLES: Triplet[] = [
    [0, 0, 0],
    [1, 1, 1],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [128 / 255, 128 / 255, 128 / 255],
    [0.5, 0.25, 0.75],
    [0.01, 0.02, 0.03],
    [0.99, 0.98, 0.97],
    [1 / 255, 0, 254 / 255],
];

describe('sRGB transfer function', () => {
    it('agrees exactly with the one the shaders use', () => {
        // gradient.wgsl:33-40 divides by 255 first and branches on
        // `normalized > 0.04045`; color_scheme.rs:73 and ColorScheme.ts:25
        // branch on `<= 0.04045`. Same partition, so the two agree everywhere,
        // including at the knee itself.
        expect(srgbToLinear(0.04045)).toBeCloseTo(0.04045 / 12.92, 15);
        expect(srgbToLinear(0)).toBe(0);
        expect(srgbToLinear(1)).toBeCloseTo(1, 15);
    });

    it('round trips through linearToSrgb', () => {
        for (let i = 0; i <= 255; i++) {
            const v = i / 255;
            expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 9);
        }
    });

    it('is continuous across the linear-segment knee', () => {
        // The two published thresholds are not exact mutual inverses:
        // 0.0031308 × 12.92 = 0.040449936, not 0.04045. The kink is real and is
        // in the sRGB constants, so it is asserted rather than smoothed away.
        const belowKnee = linearToSrgb(0.0031308);
        const aboveKnee = linearToSrgb(0.0031308 + 1e-12);
        expect(Math.abs(belowKnee - aboveKnee)).toBeLessThan(1e-6);
        expect(belowKnee).toBeCloseTo(0.0031308 * 12.92, 12);
        expect(belowKnee).toBeCloseTo(0.040449936, 9);
        expect(Math.abs(belowKnee - 0.04045)).toBeGreaterThan(6e-8);
    });

    it('is sign-preserving, so out-of-gamut linear values do not become NaN', () => {
        // Lab and OKLab interpolation routinely produces negative linear RGB.
        // `Math.pow(-0.1, 1/2.4)` is NaN, which would poison a whole LUT
        // channel; gradient.wgsl:42 has exactly that hazard.
        expect(linearToSrgb(-0.5)).toBe(-linearToSrgb(0.5));
        expect(Number.isFinite(linearToSrgb(-0.5))).toBe(true);
        expect(Number.isFinite(linearToSrgb(-1e-9))).toBe(true);
    });

    it('round trips the vector forms', () => {
        for (const sample of SAMPLES) {
            expectClose(linearRgbToSrgb(srgbToLinearRgb(sample)), sample, ROUND_TRIP);
        }
    });
});

describe('linear sRGB ↔ CIE XYZ', () => {
    it('round trips to the exact-inverse tolerance', () => {
        for (const sample of SAMPLES) {
            const linear = srgbToLinearRgb(sample);
            expectClose(xyzToLinearRgb(linearRgbToXyz(linear)), linear, ROUND_TRIP);
        }
    });

    it('maps white to the D65 white point', () => {
        // The matrix's row sums are the white point it was derived for. sRGB is
        // a D65 space, so this is (0.95047, 1.0, 1.08883) — the same constants
        // gradient.wgsl:67-69 hardcodes for Lab, which is what makes the two
        // consistent.
        expectClose(linearRgbToXyz([1, 1, 1]), [0.95047, 1.0, 1.08883], 1e-6);
    });

    it('gives green the luminance the Y row says it should', () => {
        // Y is luminance by construction, so pure green's Y is the matrix's
        // middle row, middle entry.
        expect(linearRgbToXyz([0, 1, 0])[1]).toBeCloseTo(0.7151522, 9);
    });
});

describe('CIE Lab', () => {
    /**
     * Reference values for sRGB (D65) primaries, from Bruce Lindbloom's
     * colour calculator (brucelindbloom.com) with reference white D65 and the
     * sRGB companding model — the same source the sRGB↔XYZ matrix in
     * gradient.wgsl:51 comes from. These are *not* the CSS/ICC D50 values, and
     * they are not culori's `lab` output either: culori's `lab` mode is D50 and
     * reports red as L=54.29, a=80.81, b=69.89.
     */
    const ANCHORS: Array<[string, Triplet]> = [
        ['#ffffff', [100, 0, 0]],
        ['#000000', [0, 0, 0]],
        ['#808080', [53.585, 0, 0]],
        ['#ff0000', [53.2408, 80.0925, 67.2032]],
        ['#00ff00', [87.7347, -86.1827, 83.1793]],
        ['#0000ff', [32.297, 79.1875, -107.8602]],
    ];

    it.each(ANCHORS)('%s has the published D65 Lab value', (hex, expected) => {
        expectClose(srgbToLab(parseHex(hex)), expected, ANCHOR_LAB, hex);
    });

    it('puts every neutral on the a*=b*=0 axis', () => {
        for (let i = 0; i <= 255; i += 17) {
            const lab = srgbToLab([i / 255, i / 255, i / 255]);
            expect(Math.abs(lab[1])).toBeLessThan(1e-6);
            expect(Math.abs(lab[2])).toBeLessThan(1e-6);
        }
    });

    it('has an L* that increases monotonically with grey level', () => {
        let previous = -1;
        for (let i = 0; i <= 255; i++) {
            const l = srgbToLab([i / 255, i / 255, i / 255])[0];
            expect(l).toBeGreaterThan(previous);
            previous = l;
        }
    });

    it('round trips XYZ↔Lab, including through the linear segment', () => {
        // The κ/ε branch is only taken below Y ≈ 0.0089 — 8-bit sRGB about 22
        // and darker — so the dark samples here are what exercise it.
        for (const sample of SAMPLES.concat([[0.001, 0.002, 0.0005]])) {
            const xyz = linearRgbToXyz(srgbToLinearRgb(sample));
            expectClose(labToXyz(xyzToLab(xyz)), xyz, ROUND_TRIP);
        }
    });

    it('round trips sRGB↔Lab', () => {
        for (const sample of SAMPLES) {
            expectClose(labToSrgb(srgbToLab(sample)), sample, ROUND_TRIP);
        }
    });

    it('uses the exact CIE constants, not the WGSL rounding', () => {
        // ε = 216/24389 = 0.008856451679…, against gradient.wgsl:75's 0.008856,
        // and κ/116 = 7.787037…, against its 7.787. Take a Y just inside the
        // linear segment and check L* is 903.2963·Y, not 903.3·Y.
        const y = 0.005;
        const l = xyzToLab([0.95047 * y, y, 1.08883 * y])[0];
        // The 1e-6 slack is the white point's own 1e-7 in Y (see WHITE_D65),
        // not the constant under test; κ and 903.3 differ by 1.85e-5 here, an
        // order clear of it.
        expect(Math.abs(l - (24389 / 27) * y)).toBeLessThan(1e-6);
        expect(Math.abs(l - 903.3 * y)).toBeGreaterThan(1e-5);
    });
});

describe('OKLab', () => {
    /**
     * Björn Ottosson, "A perceptual color space for image processing" (2020) —
     * the values printed in the post's table for the sRGB primaries, and its
     * defining normalisation that white has L = 1.
     *
     * These are reproducible only with Ottosson's pre-composed linear-sRGB→LMS
     * matrix. Going linear RGB → XYZ → LMS with the matrices in gradient.wgsl
     * lands about 1e-5 away, because the two derivations round the sRGB
     * primaries differently — which is why `linearRgbToOklab` does not route
     * through XYZ.
     */
    const ANCHORS: Array<[string, Triplet]> = [
        ['#ffffff', [1.0, 0.0, 0.0]],
        ['#000000', [0.0, 0.0, 0.0]],
        ['#ff0000', [0.6279554, 0.2248631, 0.1258463]],
        ['#00ff00', [0.8664396, -0.2338876, 0.1794985]],
        ['#0000ff', [0.4520137, -0.032457, -0.3115281]],
    ];

    it.each(ANCHORS)('%s has the published OKLab value', (hex, expected) => {
        expectClose(srgbToOklab(parseHex(hex)), expected, ANCHOR_OKLAB, hex);
    });

    it('normalises white to L = 1 exactly', () => {
        // The defining property of the M₂ row: its coefficients sum to 1, so a
        // neutral with LMS' = (1,1,1) has L = 1.
        expect(srgbToOklab([1, 1, 1])[0]).toBeCloseTo(1.0, 7);
    });

    it('is perceptually uniform in L: mid-grey sits near the middle', () => {
        // OKLab's L is intended to be near-uniform, so 50% sRGB grey should
        // land close to 0.5 — it is 0.5999 — while CIE L* puts it at 0.536 of
        // its range. The claim under test is only that OKLab's L is *not* the
        // linear-luminance value, which for this grey is 0.2159.
        const l = srgbToOklab([128 / 255, 128 / 255, 128 / 255])[0];
        expect(l).toBeCloseTo(0.5998708, 6);
        expect(l).toBeGreaterThan(srgbToLinear(128 / 255));
    });

    it('puts every neutral on the a=b=0 axis', () => {
        for (let i = 0; i <= 255; i += 17) {
            const oklab = srgbToOklab([i / 255, i / 255, i / 255]);
            // Not exactly zero: the a and b rows of the published M₂ sum to
            // about 7e-9 rather than 0. That is the floor, and it is four
            // orders below the chroma of the least saturated 8-bit colour.
            expect(Math.abs(oklab[1])).toBeLessThan(1e-7);
            expect(Math.abs(oklab[2])).toBeLessThan(1e-7);
        }
    });

    it('round trips linear RGB↔OKLab to the published-inverse tolerance', () => {
        for (const sample of SAMPLES) {
            const linear = srgbToLinearRgb(sample);
            expectClose(oklabToLinearRgb(linearRgbToOklab(linear)), linear, PUBLISHED_INVERSE);
        }
    });

    it('round trips sRGB↔OKLab', () => {
        for (const sample of SAMPLES) {
            expectClose(oklabToSrgb(srgbToOklab(sample)), sample, PUBLISHED_INVERSE);
        }
    });

    it('survives an out-of-gamut OKLab without producing NaN', () => {
        // A chroma this high has no sRGB equivalent; the cube in
        // oklabToLinearRgb goes negative and linearToSrgb must stay finite.
        const wild = oklabToSrgb([0.7, 0.35, -0.35]);
        expect(wild.every(Number.isFinite)).toBe(true);
        expect(Math.min(...wild)).toBeLessThan(0);
        expect(formatHex(wild)).toMatch(/^#[0-9a-f]{6}$/);
    });

    it('round trips OKLab↔OKLCh for anything with a hue', () => {
        for (const sample of SAMPLES) {
            const oklab = srgbToOklab(sample);
            if (Math.hypot(oklab[1], oklab[2]) < 1e-6) continue; // see next test
            expectClose(
                oklchToOklab(oklabToOklch(oklab)),
                oklab,
                ROUND_TRIP,
                JSON.stringify(sample)
            );
        }
    });

    it('reports no hue for a neutral, and does not round trip its 1e-8 of noise', () => {
        // A grey's a and b are a few times 1e-8 — the published M₂ rows do not
        // sum to exactly zero — pointing in whatever direction that noise
        // happens to take. Collapsing everything below 1e-6 chroma to hue 0 is
        // deliberate: it stops a black→white ramp acquiring a tint in OKLCh.
        // The cost is that the round trip below that threshold moves the
        // residue into a and drops b, which is asserted here rather than
        // papered over with a loose tolerance on the test above.
        for (const grey of [0, 0.25, 0.5, 0.75, 1]) {
            expect(srgbToOklch([grey, grey, grey])[2]).toBe(0);
            expect(srgbToOklch([grey, grey, grey])[1]).toBeLessThan(1e-6);
        }
        const white = srgbToOklab([1, 1, 1]);
        const viaOklch = oklchToOklab(oklabToOklch(white));
        expect(viaOklch[2]).toBe(0);
        expect(Math.abs(viaOklch[1])).toBeLessThan(1e-6);
    });
});

describe('mixHex', () => {
    it.each(GRADIENT_COLOR_SPACES)('%s reproduces its endpoints exactly', (space) => {
        expect(mixHex('#123456', '#abcdef', 0, space)).toBe('#123456');
        expect(mixHex('#123456', '#abcdef', 1, space)).toBe('#abcdef');
    });

    it('interpolates RGB as a plain channel lerp', () => {
        expect(mixHex('#000000', '#ffffff', 0.5, 'rgb')).toBe('#808080');
    });

    it('differs between spaces, which is the whole point of offering them', () => {
        const spaces: GradientColorSpace[] = ['rgb', 'lab', 'oklab'];
        const midpoints = spaces.map((s) => mixHex('#0000ff', '#ffff00', 0.5, s));
        expect(new Set(midpoints).size).toBe(spaces.length);
    });

    it('takes the short way round the hue wheel in OKLCh', () => {
        // Red (h≈29°) to blue (h≈264°) is 125° the short way through magenta,
        // 235° the long way through green. A naive hue lerp goes green.
        const mid = parseHex(mixHex('#ff0000', '#0000ff', 0.5, 'oklch'));
        expect(mid[1]).toBeLessThan(mid[0]); // less green than red
        expect(mid[1]).toBeLessThan(mid[2]); // less green than blue
    });

    it('adopts the coloured endpoint hue when the other end is neutral', () => {
        // Black has chroma 0 and therefore no hue; without the neutral guard it
        // would drag the mix towards hue 0 and tint a black→blue ramp purple.
        const mid = parseHex(mixHex('#000000', '#0000ff', 0.5, 'oklch'));
        expect(mid[2]).toBeGreaterThan(mid[0]);
        expect(mid[2]).toBeGreaterThan(mid[1]);
    });

    it('keeps a grey ramp neutral in every space', () => {
        for (const space of GRADIENT_COLOR_SPACES) {
            const mid = parseHex(mixHex('#000000', '#ffffff', 0.5, space));
            expect(Math.abs(mid[0] - mid[1]), space).toBeLessThan(1 / 255);
            expect(Math.abs(mid[1] - mid[2]), space).toBeLessThan(1 / 255);
        }
    });
});

describe('hex parsing and formatting', () => {
    it('round trips every 8-bit code', () => {
        for (let i = 0; i <= 255; i++) {
            const hex = `#${i.toString(16).padStart(2, '0')}0000`;
            expect(formatHex(parseHex(hex))).toBe(hex);
        }
    });

    it('accepts the short form and a missing #', () => {
        expect(parseHex('#f0a')).toEqual(parseHex('#ff00aa'));
        expect(parseHex('ff00aa')).toEqual(parseHex('#ff00aa'));
        expect(parseHex(' #FF00AA ')).toEqual(parseHex('#ff00aa'));
    });

    it.each(['', '#', '#12345', '#gggggg', '#12345678', 'rebeccapurple'])(
        'rejects %o rather than substituting a colour',
        (bad) => {
            expect(() => parseHex(bad)).toThrow(/Not a hex colour/);
        }
    );

    it('clamps out-of-gamut components instead of wrapping them', () => {
        expect(formatHex([-0.5, 0.5, 1.5])).toBe('#0080ff');
    });

    it('rejects NaN and Infinity rather than emitting "#NaNNaNNaN"', () => {
        expect(() => formatHex([NaN, 0, 0])).toThrow(/not finite/);
        expect(() => formatHex([Infinity, 0, 0])).toThrow(/not finite/);
        expect(() => formatHex([0, -Infinity, 0])).toThrow(/not finite/);
    });
});

describe('parseGradientColorSpace', () => {
    it('accepts both editors’ spellings', () => {
        // GradientEditorMode.svelte:261 stores lowercase culori mode names;
        // ColorSchemeSelector.svelte:311 stores its own display names.
        expect(parseGradientColorSpace('oklab')).toBe('oklab');
        expect(parseGradientColorSpace('OkLab')).toBe('oklab');
        expect(parseGradientColorSpace('RGB')).toBe('rgb');
        expect(parseGradientColorSpace('Lab')).toBe('lab');
    });

    it('folds the spaces that were dropped onto the nearest kept one', () => {
        expect(parseGradientColorSpace('jab')).toBe('oklab');
        expect(parseGradientColorSpace('Jzazbz')).toBe('oklab');
        expect(parseGradientColorSpace('lchuv')).toBe('oklch');
        expect(parseGradientColorSpace('HSLuv')).toBe('oklch');
    });

    it('falls back to the default rather than throwing', () => {
        // A throw here is what left Gray-Scott's mask <Selector> showing
        // nothing selected after a sync (see WEB_PORT.md, M4 defect 4).
        expect(parseGradientColorSpace('nonsense')).toBe(DEFAULT_GRADIENT_COLOR_SPACE);
        expect(parseGradientColorSpace(undefined)).toBe(DEFAULT_GRADIENT_COLOR_SPACE);
        expect(parseGradientColorSpace(42)).toBe(DEFAULT_GRADIENT_COLOR_SPACE);
    });
});

describe('sampleGradient', () => {
    const stops = [
        { position: 0, color: '#0000ff' },
        { position: 1, color: '#ffff00' },
    ];

    it('returns the endpoint colours exactly', () => {
        expect(sampleGradient(stops, 0)).toBe('#0000ff');
        expect(sampleGradient(stops, 1)).toBe('#ffff00');
    });

    it('clamps out-of-range positions to the endpoints', () => {
        expect(sampleGradient(stops, -5)).toBe('#0000ff');
        expect(sampleGradient(stops, 5)).toBe('#ffff00');
    });

    it('holds the terminal colour outside the stop range', () => {
        // This is where the two Svelte copies disagree.
        // GradientEditorMode.svelte:413-418 returns the endpoint;
        // ColorSchemeSelector.svelte:423-431 finds no bracketing pair, leaves
        // left/right at the first and last stop, and extrapolates with t<0.
        const inset = [
            { position: 0.25, color: '#ff0000' },
            { position: 0.75, color: '#00ff00' },
        ];
        expect(sampleGradient(inset, 0)).toBe('#ff0000');
        expect(sampleGradient(inset, 0.1)).toBe('#ff0000');
        expect(sampleGradient(inset, 1)).toBe('#00ff00');
        expect(sampleGradient(inset, 0.5)).toBe(mixHex('#ff0000', '#00ff00', 0.5));
    });

    it('steps rather than blends in Stepped mode', () => {
        expect(sampleGradient(stops, 0.99, { mode: 'Stepped' })).toBe('#0000ff');
        expect(sampleGradient(stops, 1, { mode: 'Stepped' })).toBe('#ffff00');
    });

    it('sorts the stops it is given without mutating the caller’s array', () => {
        const unsorted = [
            { position: 1, color: '#ffffff' },
            { position: 0, color: '#000000' },
        ];
        const snapshot = JSON.stringify(unsorted);
        expect(sampleGradient(unsorted, 0)).toBe('#000000');
        expect(JSON.stringify(unsorted)).toBe(snapshot);
    });

    it('does not divide by zero when two stops coincide', () => {
        // Reachable by dragging one handle onto another; both Svelte copies
        // produce t = NaN here and hand it to culori.
        const coincident = [
            { position: 0, color: '#000000' },
            { position: 0.5, color: '#ff0000' },
            { position: 0.5, color: '#00ff00' },
            { position: 1, color: '#ffffff' },
        ];
        expect(sampleGradient(coincident, 0.5)).toMatch(/^#[0-9a-f]{6}$/);
        for (let i = 0; i <= 100; i++) {
            expect(sampleGradient(coincident, i / 100)).toMatch(/^#[0-9a-f]{6}$/);
        }
    });

    it('rejects an empty stop list, a non-finite position and a bad colour', () => {
        expect(() => sampleGradient([], 0.5)).toThrow(/at least one stop/);
        expect(() => sampleGradient([{ position: NaN, color: '#000000' }], 0.5)).toThrow(
            /not finite/
        );
        expect(() => sampleGradient([{ position: Infinity, color: '#000' }], 0.5)).toThrow(
            /not finite/
        );
        expect(() => sampleGradient([{ position: 0, color: 'blue' }], 0.5)).toThrow(
            /Not a hex colour/
        );
    });

    it('handles a single stop as a constant gradient', () => {
        const one = [{ position: 0.5, color: '#123456' }];
        expect(sampleGradient(one, 0)).toBe('#123456');
        expect(sampleGradient(one, 0.5)).toBe('#123456');
        expect(sampleGradient(one, 1)).toBe('#123456');
    });
});

describe('buildGradientLut', () => {
    const stops = [
        { position: 0, color: '#0000ff' },
        { position: 1, color: '#ffff00' },
    ];

    it('is 768 bytes, matching LUT_STRIDE and the .lut files', () => {
        const lut = buildGradientLut(stops);
        expect(lut.length).toBe(LUT_STRIDE);
        expect(lut).toBeInstanceOf(Uint8Array);
    });

    it('is planar [R×256][G×256][B×256], not interleaved', () => {
        const lut = buildGradientLut(stops);
        // Blue→yellow: the red plane climbs 0→255, green climbs 0→255, blue
        // falls 255→0. Interleaved storage would put 0x00,0x00,0xff first.
        expect([lut[0], lut[256], lut[512]]).toEqual([0x00, 0x00, 0xff]);
        expect([lut[255], lut[511], lut[767]]).toEqual([0xff, 0xff, 0x00]);
    });

    it('reproduces the stop colours exactly at the endpoints', () => {
        const lut = buildGradientLut([
            { position: 0, color: '#123456' },
            { position: 1, color: '#abcdef' },
        ]);
        expect([lut[0], lut[256], lut[512]]).toEqual([0x12, 0x34, 0x56]);
        expect([lut[255], lut[511], lut[767]]).toEqual([0xab, 0xcd, 0xef]);
    });

    it.each(GRADIENT_COLOR_SPACES)(
        'is monotonic per channel for a two-stop ramp in %s',
        (space) => {
            // Black→white has no hue to detour through, so every channel of every
            // space must be non-decreasing. A transposed matrix or a hue
            // interpolation going the long way round shows up here immediately.
            const lut = buildGradientLut(
                [
                    { position: 0, color: '#000000' },
                    { position: 1, color: '#ffffff' },
                ],
                { space }
            );
            for (let plane = 0; plane < 3; plane++) {
                for (let i = 1; i < 256; i++) {
                    expect(lut[plane * 256 + i]).toBeGreaterThanOrEqual(lut[plane * 256 + i - 1]);
                }
            }
        }
    );

    it('produces a piecewise-constant LUT in Stepped mode', () => {
        const lut = buildGradientLut(
            [
                { position: 0, color: '#ff0000' },
                { position: 0.5, color: '#00ff00' },
                { position: 1, color: '#0000ff' },
            ],
            { mode: 'Stepped' }
        );
        const distinct = new Set<string>();
        for (let i = 0; i < 256; i++) distinct.add(`${lut[i]},${lut[i + 256]},${lut[i + 512]}`);
        expect(distinct).toEqual(new Set(['255,0,0', '0,255,0', '0,0,255']));
    });

    it('never emits a byte outside 0-255, even for out-of-gamut interpolation', () => {
        // A saturated blue↔yellow Lab ramp leaves the sRGB gamut in the middle.
        for (const space of GRADIENT_COLOR_SPACES) {
            const lut = buildGradientLut(
                [
                    { position: 0, color: '#0000ff' },
                    { position: 1, color: '#ffff00' },
                ],
                { space }
            );
            for (const byte of lut) {
                expect(Number.isInteger(byte)).toBe(true);
                expect(byte).toBeGreaterThanOrEqual(0);
                expect(byte).toBeLessThanOrEqual(255);
            }
        }
    });

    it('is deterministic', () => {
        expect(buildGradientLut(stops)).toEqual(buildGradientLut(stops));
    });
});
