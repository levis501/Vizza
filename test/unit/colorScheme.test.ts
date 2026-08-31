import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ColorScheme, LUT_STRIDE, srgbToLinear } from '../../src/lib/engine/color/ColorScheme';
import {
    ColorSchemeManager,
    CUSTOM_COLOR_SCHEMES_KEY,
    DEFAULT_COLOR_SCHEME_NAME,
} from '../../src/lib/engine/color/ColorSchemeManager';
import { buildGradientLut } from '../../src/lib/engine/color/spaces';
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

/**
 * The custom-scheme half of M6.
 *
 * `ColorSchemeSelector.svelte:828` calls `save_custom_color_scheme` from all
 * nine modes that embed it, so the failure modes here are nine-fold: a scheme
 * that is saved but does not appear, appears but does not survive a reload, or
 * quietly takes the name of one of the 167 built-ins.
 */
describe('custom colour schemes', () => {
    /** A LUT whose three planes differ, so a planar mix-up shows. */
    function gradientLut(): number[] {
        const data = new Array<number>(768);
        for (let i = 0; i < 256; i++) {
            data[i] = i;
            data[i + 256] = 255 - i;
            data[i + 512] = (i * 2) % 256;
        }
        return data;
    }

    async function loadedManager(storage: KeyValueStore | null = fakeStorage()) {
        const manager = new ColorSchemeManager({ fetchImpl: packedFetch(), storage });
        await manager.load();
        return manager;
    }

    it('appears in the picker alongside the 167 built-ins, and is selectable', async () => {
        const storage = fakeStorage();
        const manager = await loadedManager(storage);
        manager.saveCustom('Sunset', gradientLut());

        const names = manager.allColorSchemes();
        expect(names.length).toBe(168);
        expect(names).toContain('Sunset');
        expect(names).toContain(DEFAULT_COLOR_SCHEME_NAME);
        // Sorted, as get_available_color_schemes returns them.
        expect([...names].sort()).toEqual(names);

        // Selectable: this is the apply_color_scheme_by_name path. The manager
        // starts reversed (get_default is bone *reversed*, color_scheme.rs:223)
        // and that flag is a property of the selection, not of the scheme, so a
        // custom scheme picked while it is set comes back flipped too.
        const applied = manager.setCurrent('Sunset');
        expect(manager.currentName).toBe('Sunset');
        expect(manager.reversed).toBe(true);
        expect(applied.red[10]).toBe(245);
        expect(manager.setReversed(false).red[10]).toBe(10);
        expect(manager.current().green[10]).toBe(245);
        expect(manager.isCustom('Sunset')).toBe(true);
        expect(manager.isBuiltin('Sunset')).toBe(false);
    });

    it('survives a reload with its bytes intact', async () => {
        const storage = fakeStorage();
        const first = await loadedManager(storage);
        first.saveCustom('Sunset', gradientLut());

        // A reload is a fresh manager over the same storage — the module-level
        // `colorSchemeManager` is constructed at import time and reads
        // localStorage in its constructor, so this is exactly what a page
        // refresh does.
        const second = await loadedManager(storage);
        expect(second.allCustomNames()).toEqual(['Sunset']);
        expect(Array.from(second.get('Sunset').data)).toEqual(gradientLut());
    });

    it('refuses to shadow a built-in, rather than silently losing the scheme', async () => {
        const storage = fakeStorage();
        const manager = await loadedManager(storage);

        // PresetStore.list (PresetStore.ts:180) resolves the same collision by
        // letting the built-in win and skipping the user's entry silently.
        // Colour schemes keep that precedence but report it: both callers
        // switch the selection to the name they just saved, so a silent skip
        // would show the built-in and leave the authored gradient unreachable.
        expect(() => manager.saveCustom(DEFAULT_COLOR_SCHEME_NAME, gradientLut())).toThrow(
            /built-in colour scheme/
        );
        expect(manager.allCustomNames()).toEqual([]);
        expect(storage.map.has(CUSTOM_COLOR_SCHEMES_KEY)).toBe(false);

        // And the built-in is untouched.
        expect(manager.get(DEFAULT_COLOR_SCHEME_NAME).data).toEqual(BONE);
    });

    it('cannot be corrupted by a colliding entry left by an older build', async () => {
        // color_scheme.rs:137 concatenates embedded and custom names with no
        // collision check, so a desktop ~/Vizza/LUTs/MATPLOTLIB_bone.lut — or a
        // document written before saveCustom started refusing them — puts the
        // name in twice.
        const storage = fakeStorage({
            [CUSTOM_COLOR_SCHEMES_KEY]: JSON.stringify({
                [DEFAULT_COLOR_SCHEME_NAME]: btoa(String.fromCharCode(...new Uint8Array(768))),
            }),
        });
        const manager = await loadedManager(storage);

        const names = manager.allColorSchemes();
        expect(names.length).toBe(167);
        expect(names.filter((n) => n === DEFAULT_COLOR_SCHEME_NAME)).toHaveLength(1);
        // The built-in still wins, so the picker entry does what it says.
        expect(manager.get(DEFAULT_COLOR_SCHEME_NAME).data).toEqual(BONE);
    });

    it('keeps memory and storage in step when the quota is full', async () => {
        // A save that throws must leave nothing behind: a scheme that lives in
        // the picker until the next reload and then disappears is worse than
        // one that never appeared.
        const map = new Map<string, string>();
        const full: KeyValueStore = {
            getItem: (key) => map.get(key) ?? null,
            setItem: () => {
                throw new DOMException('exceeded', 'QuotaExceededError');
            },
            removeItem: (key) => void map.delete(key),
        };
        const manager = await loadedManager(full);

        expect(() => manager.saveCustom('Sunset', gradientLut())).toThrow(StorageError);
        expect(manager.allCustomNames()).toEqual([]);
        expect(manager.has('Sunset')).toBe(false);
        expect(manager.allColorSchemes().length).toBe(167);
    });

    it('overwriting an existing custom scheme keeps the old bytes if the write fails', async () => {
        const storage = fakeStorage();
        const manager = await loadedManager(storage);
        manager.saveCustom('Sunset', gradientLut());

        const original = manager.get('Sunset').data;
        storage.setItem = () => {
            throw new DOMException('exceeded', 'QuotaExceededError');
        };

        expect(() => manager.saveCustom('Sunset', new Array(768).fill(7))).toThrow(StorageError);
        expect(manager.get('Sunset').data).toEqual(original);
    });

    it('trims the name, and still finds the scheme by the untrimmed one', async () => {
        // ColorSchemeSelector.svelte:850 sets current_color_scheme straight
        // from the <input> and applies it by name, so an untrimmed lookup has
        // to resolve or the scheme the user just saved fails to load.
        const manager = await loadedManager();
        const saved = manager.saveCustom('  Sunset  ', gradientLut());

        expect(saved.name).toBe('Sunset');
        expect(manager.allCustomNames()).toEqual(['Sunset']);
        expect(manager.get('  Sunset  ').data).toEqual(manager.get('Sunset').data);
        expect(() => manager.saveCustom('   ', gradientLut())).toThrow(/empty name/);
    });

    it('is never chosen by getRandom, which draws from the built-ins only', async () => {
        const manager = await loadedManager();
        manager.saveCustom('Sunset', gradientLut());
        // Port of get_random_lut (color_scheme.rs:229), which indexes
        // EMBEDDED_COLOR_SCHEMES rather than the merged list.
        for (let i = 0; i < 200; i++) {
            expect(manager.getRandom().name).not.toBe('Sunset');
        }
    });

    it('skips one unreadable entry without losing the others', async () => {
        const good = btoa(String.fromCharCode(...new Uint8Array(768).fill(3)));
        const storage = fakeStorage({
            [CUSTOM_COLOR_SCHEMES_KEY]: JSON.stringify({
                Good: good,
                Truncated: btoa('too short'),
                NotBase64: '!!!!',
            }),
        });
        const manager = await loadedManager(storage);

        expect(manager.allCustomNames()).toEqual(['Good']);
        expect(manager.get('Good').red[0]).toBe(3);
    });
});

/**
 * The end-to-end path M6 de-risks: gradient stops → 768 bytes → localStorage →
 * reload → picker. `buildGradientLut` is what the two editors will call in
 * place of their four hand-rolled copies of the same loop.
 */
describe('gradient editor → custom scheme', () => {
    it('round trips an authored gradient through storage and back', async () => {
        const storage = fakeStorage();
        const stops = [
            { position: 0, color: '#0000ff' },
            { position: 0.5, color: '#ff00ff' },
            { position: 1, color: '#ffff00' },
        ];
        const lut = buildGradientLut(stops, { space: 'oklab' });

        const editor = new ColorSchemeManager({ fetchImpl: packedFetch(), storage });
        await editor.load();
        // save_custom_color_scheme sends Array.from(lut) over the invoke seam.
        editor.saveCustom('Neon Ramp', Array.from(lut));

        const afterReload = new ColorSchemeManager({ fetchImpl: packedFetch(), storage });
        await afterReload.load();
        const restored = afterReload.get('Neon Ramp');

        expect(restored.data).toEqual(lut);
        // The endpoints are the stop colours, and the planes did not get swapped.
        expect([restored.red[0], restored.green[0], restored.blue[0]]).toEqual([0x00, 0x00, 0xff]);
        expect([restored.red[255], restored.green[255], restored.blue[255]]).toEqual([
            0xff, 0xff, 0x00,
        ]);
        expect(afterReload.allColorSchemes()).toContain('Neon Ramp');
    });

    it('a reversed custom scheme is the same LUT backwards', async () => {
        const manager = new ColorSchemeManager({
            fetchImpl: packedFetch(),
            storage: fakeStorage(),
        });
        await manager.load();
        const lut = buildGradientLut([
            { position: 0, color: '#000000' },
            { position: 1, color: '#ffffff' },
        ]);
        manager.saveCustom('Ramp', Array.from(lut));

        manager.setCurrent('Ramp');
        manager.setReversed(false); // the manager starts reversed; see above
        expect(manager.current().red[0]).toBe(0);
        manager.setReversed(true);
        expect(manager.current().red[0]).toBe(255);
        // Reversing the view must not rewrite what is stored.
        expect(manager.get('Ramp').red[0]).toBe(0);
    });
});
