import { describe, it, expect } from 'vitest';
import {
    computeFitRect,
    invertToneInPlace,
    lumaFromRgb,
    parseImageFitMode,
    IMAGE_FIT_MODES,
} from '../../src/lib/engine/resources/imageUpload';

/**
 * Only the DOM-free half is covered here: the fit arithmetic is the part that
 * has to match the Rust exactly, and it is pure. The canvas path needs a real
 * browser and belongs to the L3/L4 suites.
 */

describe('parseImageFitMode', () => {
    it('accepts the display names the Selector emits', () => {
        for (const mode of IMAGE_FIT_MODES) expect(parseImageFitMode(mode)).toBe(mode);
    });

    it('accepts the lowercase and compact spellings FromStr allows', () => {
        expect(parseImageFitMode('  stretch ')).toBe('Stretch');
        expect(parseImageFitMode('FitH')).toBe('Fit H');
        expect(parseImageFitMode('fitv')).toBe('Fit V');
        expect(parseImageFitMode('fit h')).toBe('Fit H');
    });

    it('returns null for anything else', () => {
        expect(parseImageFitMode('cover')).toBeNull();
        expect(parseImageFitMode('')).toBeNull();
    });
});

describe('computeFitRect', () => {
    it('Stretch fills the target and ignores aspect', () => {
        expect(computeFitRect(100, 50, 256, 256, 'Stretch')).toEqual({
            x: 0,
            y: 0,
            width: 256,
            height: 256,
        });
    });

    it('Center pads a smaller image and crops a larger one', () => {
        expect(computeFitRect(100, 50, 256, 256, 'Center')).toEqual({
            x: 78,
            y: 103,
            width: 100,
            height: 50,
        });
        // Larger than the target: the offset goes negative so the centre of the
        // source lands in the centre of the target.
        expect(computeFitRect(512, 300, 256, 256, 'Center')).toEqual({
            x: -128,
            y: -22,
            width: 512,
            height: 300,
        });
    });

    it('Fit H matches the width and centres vertically when it fits', () => {
        // 200x100 into 256x256: scale 1.28, scaled height 128, centred.
        expect(computeFitRect(200, 100, 256, 256, 'Fit H')).toEqual({
            x: 0,
            y: 64,
            width: 256,
            height: 128,
        });
    });

    it('Fit H top-aligns rather than centring when it overflows', () => {
        // The Rust clamps offset_y to 0 instead of going negative.
        expect(computeFitRect(100, 400, 256, 256, 'Fit H')).toEqual({
            x: 0,
            y: 0,
            width: 256,
            height: 1024,
        });
    });

    it('Fit V matches the height and centres horizontally when it fits', () => {
        expect(computeFitRect(100, 200, 256, 256, 'Fit V')).toEqual({
            x: 64,
            y: 0,
            width: 128,
            height: 256,
        });
    });

    it('Fit V left-aligns rather than centring when it overflows', () => {
        expect(computeFitRect(400, 100, 256, 256, 'Fit V')).toEqual({
            x: 0,
            y: 0,
            width: 1024,
            height: 256,
        });
    });

    it('truncates the scaled dimension, as the f32-to-u32 cast does', () => {
        // 3x7 into 10 wide: 7 * 10 / 3 = 23.33 -> 23.
        expect(computeFitRect(3, 7, 10, 40, 'Fit H').height).toBe(23);
    });
});

describe('pixel helpers', () => {
    it('inverts colour channels and leaves alpha alone', () => {
        const pixels = new Uint8ClampedArray([0, 128, 255, 64, 10, 20, 30, 255]);
        invertToneInPlace(pixels);
        expect([...pixels]).toEqual([255, 127, 0, 64, 245, 235, 225, 255]);
    });

    it('uses the image crate luma weights', () => {
        expect(lumaFromRgb(255, 255, 255)).toBeCloseTo(255, 6);
        expect(lumaFromRgb(0, 0, 0)).toBe(0);
        expect(lumaFromRgb(255, 0, 0)).toBeCloseTo(54.213, 3);
        expect(lumaFromRgb(0, 255, 0)).toBeCloseTo(182.376, 3);
    });
});
