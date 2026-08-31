import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ColorScheme, LUT_STRIDE, srgbToLinear } from '../../src/lib/engine/color/ColorScheme';
import {
    ColorSchemeManager,
    CUSTOM_COLOR_SCHEMES_KEY,
    DEFAULT_COLOR_SCHEME_NAME,
} from '../../src/lib/engine/color/ColorSchemeManager';
import { StorageError, type KeyValueStore } from '../../src/lib/engine/presets/PresetStore';
import { packLuts } from '../../vite-plugin-luts';

/**
 * The fixture is a real LUT out of the Rust tree, not an invented buffer — the
 * planar split is only meaningfully tested against data whose three channels
 * actually differ.
 */
const ROOT = resolve(__dirname, '../..');
const LUT_DIR = join(ROOT, 'src-tauri/src/simulations/shared/LUTs');
const BONE = new Uint8Array(readFileSync(join(LUT_DIR, 'MATPLOTLIB_bone.lut')));

function fakeStorage(seed: Record<string, string> = {}) {
    const map = new Map(Object.entries(seed));
    const store: KeyValueStore & { map: Map<string, string> } = {
        map,
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => void map.set(key, value),
        removeItem: (key) => void map.delete(key),
    };
    return store;
}

/** Serves the packed blob the Vite plugin produces, with no network. */
function packedFetch(): typeof fetch {
    const { names, blob } = packLuts(ROOT);
    return (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/luts.json')) {
            return new Response(JSON.stringify({ stride: LUT_STRIDE, names }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (url.endsWith('/luts.bin')) {
            return new Response(new Uint8Array(blob), { status: 200 });
        }
        return new Response(null, { status: 404 });
    }) as typeof fetch;
}

describe('ColorScheme', () => {
    it('parses a real 768-byte LUT with the planar split in the right place', () => {
        expect(BONE.length).toBe(768);
        const scheme = ColorScheme.fromBytes('MATPLOTLIB_bone', BONE);

        expect(scheme.red.length).toBe(256);
        expect(scheme.green.length).toBe(256);
        expect(scheme.blue.length).toBe(256);

        // bone's three channels diverge in the middle, so a swapped or
        // interleaved read cannot pass these.
        expect([scheme.red[128], scheme.green[128], scheme.blue[128]]).toEqual([112, 123, 143]);
        expect([scheme.red[64], scheme.green[64], scheme.blue[64]]).toEqual([56, 55, 77]);
        expect([scheme.red[0], scheme.green[0], scheme.blue[0]]).toEqual([0, 0, 0]);
        expect([scheme.red[255], scheme.green[255], scheme.blue[255]]).toEqual([255, 255, 255]);
    });

    it('rejects a buffer that is not 768 bytes, as from_bytes does', () => {
        expect(() => ColorScheme.fromBytes('short', new Uint8Array(767))).toThrow(/768/);
        expect(() => ColorScheme.fromBytes('long', new Uint8Array(769))).toThrow(/768/);
    });

    it('does not alias the buffer it was built from', () => {
        const source = BONE.slice();
        const scheme = ColorScheme.fromBytes('bone', source);
        scheme.reverse();
        expect(source).toEqual(BONE);
    });

    it('reverse() is an involution and reverses each channel independently', () => {
        const scheme = ColorScheme.fromBytes('bone', BONE);
        scheme.reverse();

        expect(scheme.red[0]).toBe(BONE[255]);
        expect(scheme.green[0]).toBe(BONE[256 + 255]);
        expect(scheme.blue[0]).toBe(BONE[512 + 255]);
        // A whole-buffer reverse would have put blue's last byte in red[0].
        expect(scheme.data.slice(0, 256)).not.toEqual(BONE.slice(512, 768).reverse());

        scheme.reverse();
        expect(scheme.data).toEqual(BONE);
    });

    it('reversed() copies, suffixes the name, and leaves the original alone', () => {
        const scheme = ColorScheme.fromBytes('bone', BONE);
        const flipped = scheme.reversed();

        expect(flipped.name).toBe('bone_reversed');
        expect(scheme.name).toBe('bone');
        expect(scheme.data).toEqual(BONE);
        expect(flipped.red[0]).toBe(scheme.red[255]);
    });

    it('converts sRGB to linear with the same constants as the Rust', () => {
        expect(srgbToLinear(0)).toBe(0);
        expect(srgbToLinear(1)).toBeCloseTo(1, 12);
        // Below the 0.04045 knee: the linear segment.
        expect(srgbToLinear(10 / 255)).toBeCloseTo(0.003035269835488375, 12);
        // Above it: the 2.4 power segment.
        expect(srgbToLinear(128 / 255)).toBeCloseTo(0.21586050011389926, 12);
    });

    it('getColors samples the endpoints and returns linear RGBA', () => {
        const scheme = ColorScheme.fromBytes('bone', BONE);

        const two = scheme.getColors(2);
        expect(two).toHaveLength(2);
        expect(two[0]).toEqual([0, 0, 0, 1]);
        expect(two[1]).toEqual([1, 1, 1, 1]);

        // n === 1 pins to index 0, exactly as get_colors does.
        expect(scheme.getColors(1)).toEqual([[0, 0, 0, 1]]);

        const three = scheme.getColors(3);
        expect(three).toHaveLength(3);
        // Middle stop is index (1 * 255) / 2 = 127 by integer division.
        expect(three[1][0]).toBeCloseTo(srgbToLinear(scheme.red[127] / 255), 12);
        expect(three[1][3]).toBe(1);
        // The values must be linearised, not raw sRGB.
        expect(three[1][2]).not.toBeCloseTo(scheme.blue[127] / 255, 3);

        expect(scheme.getFirstColor()).toEqual([0, 0, 0, 1]);
        expect(scheme.getLastColor()).toEqual([1, 1, 1, 1]);
    });

    it('toU32Buffer is 768 entries, one widened byte each', () => {
        const scheme = ColorScheme.fromBytes('bone', BONE);
        const buffer = scheme.toU32Buffer();

        expect(buffer).toBeInstanceOf(Uint32Array);
        expect(buffer.length).toBe(768);
        expect(buffer[0]).toBe(BONE[0]);
        expect(buffer[128]).toBe(112);
        expect(buffer[256 + 128]).toBe(123);
        expect(buffer[512 + 128]).toBe(143);
    });
});

describe('ColorSchemeManager', () => {
    async function loadedManager(storage: KeyValueStore | null = fakeStorage()) {
        const manager = new ColorSchemeManager({ fetchImpl: packedFetch(), storage });
        await manager.load();
        return manager;
    }

    it('slices schemes out of the packed blob by index', async () => {
        const manager = await loadedManager();
        const names = manager.allColorSchemes();

        expect(names.length).toBe(167);
        expect([...names].sort()).toEqual(names);
        expect(names).toContain('MATPLOTLIB_viridis');

        expect(manager.get(DEFAULT_COLOR_SCHEME_NAME).data).toEqual(BONE);
        // A neighbouring scheme must not be off by a stride.
        const viridis = manager.get('MATPLOTLIB_viridis');
        expect(viridis.data).toEqual(
            new Uint8Array(readFileSync(join(LUT_DIR, 'MATPLOTLIB_viridis.lut')))
        );
    });

    it('fetches once however many callers race for it', async () => {
        let calls = 0;
        const inner = packedFetch();
        const counting = ((...args: Parameters<typeof fetch>) => {
            calls++;
            return inner(...args);
        }) as typeof fetch;

        const manager = new ColorSchemeManager({ fetchImpl: counting, storage: null });
        await Promise.all([manager.load(), manager.load(), manager.load()]);
        // Two URLs, one round of them.
        expect(calls).toBe(2);
    });

    it('defaults to MATPLOTLIB_bone reversed, keeping the un-suffixed name', async () => {
        const manager = await loadedManager();
        const scheme = manager.getDefault();

        expect(scheme.name).toBe('MATPLOTLIB_bone');
        expect(scheme.red[0]).toBe(BONE[255]);
        expect(manager.reversed).toBe(true);
        expect(manager.currentName).toBe('MATPLOTLIB_bone');
        expect(manager.current().data).toEqual(scheme.data);
    });

    it('toggles reversed without disturbing the catalogue', async () => {
        const manager = await loadedManager();
        manager.setCurrent('MATPLOTLIB_viridis');
        manager.setReversed(false);

        const forward = manager.current();
        const backward = manager.toggleReversed();

        expect(manager.reversed).toBe(true);
        expect(backward.red[0]).toBe(forward.red[255]);
        // The stored blob is untouched, so a fresh get is still forward.
        expect(manager.get('MATPLOTLIB_viridis').data).toEqual(forward.data);
        expect(manager.currentU32().length).toBe(768);
    });

    it('saves, lists, reloads and deletes custom schemes', async () => {
        const storage = fakeStorage();
        const manager = await loadedManager(storage);

        // ColorSchemeSelector sends 768 plain numbers, not a Uint8Array.
        const data = Array.from({ length: 768 }, (_, i) => i % 256);
        manager.saveCustom('My Scheme', data);

        expect(manager.allCustomNames()).toEqual(['My Scheme']);
        expect(manager.allColorSchemes()).toContain('My Scheme');
        expect(manager.allColorSchemes().length).toBe(168);
        expect(manager.get('My Scheme').red[5]).toBe(5);

        // Survives a reload from the same storage.
        const reloaded = new ColorSchemeManager({ fetchImpl: packedFetch(), storage });
        await reloaded.load();
        expect(reloaded.get('My Scheme').data).toEqual(manager.get('My Scheme').data);

        reloaded.deleteCustom('My Scheme');
        expect(reloaded.allCustomNames()).toEqual([]);
        expect(JSON.parse(storage.map.get(CUSTOM_COLOR_SCHEMES_KEY)!)).toEqual({});
    });

    it('rejects a wrong-sized custom scheme before writing anything', async () => {
        const storage = fakeStorage();
        const manager = await loadedManager(storage);

        expect(() => manager.saveCustom('bad', new Array(700).fill(0))).toThrow(/768/);
        expect(storage.map.has(CUSTOM_COLOR_SCHEMES_KEY)).toBe(false);
    });

    it('surfaces a full quota as a StorageError rather than dropping the save', async () => {
        const full: KeyValueStore = {
            getItem: () => null,
            setItem: () => {
                throw new DOMException('exceeded', 'QuotaExceededError');
            },
            removeItem: () => {},
        };
        const manager = await loadedManager(full);

        try {
            manager.saveCustom('mine', new Uint8Array(768));
            expect.unreachable('save should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(StorageError);
            expect((err as StorageError).kind).toBe('quota');
            expect((err as StorageError).message).toMatch(/storage is full/i);
        }
    });

    it('says so plainly when asked for a scheme that does not exist', async () => {
        const manager = await loadedManager();
        expect(() => manager.get('nope')).toThrow(/Unknown colour scheme/);
    });
});
