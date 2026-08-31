import { describe, it, expect, beforeEach } from 'vitest';
import {
    cloneValue,
    isPlainObject,
    mergeSettingsWithDefaults,
    mergeValues,
} from '../../src/lib/engine/presets/merge';
import {
    PresetStore,
    StorageError,
    presetStorageKey,
    type KeyValueStore,
} from '../../src/lib/engine/presets/PresetStore';
import { getBuiltinPresets, registerBuiltinPresets } from '../../src/lib/engine/presets/builtins';

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

describe('preset deep merge', () => {
    it('fills keys the stored document is missing', () => {
        const defaults = { a: 1, b: 2, c: 3 };
        expect(mergeSettingsWithDefaults(defaults, { b: 20 })).toEqual({ a: 1, b: 20, c: 3 });
    });

    it('preserves nested user values while filling nested defaults', () => {
        const defaults = {
            top: 1,
            nested: { x: 1, y: 2, deeper: { p: 'default', q: 'default' } },
        };
        const partial = { nested: { y: 99, deeper: { q: 'user' } } };

        expect(mergeSettingsWithDefaults(defaults, partial)).toEqual({
            top: 1,
            nested: { x: 1, y: 99, deeper: { p: 'default', q: 'user' } },
        });
    });

    it('replaces arrays wholesale rather than merging element-wise', () => {
        // TOML arrays are not tables, so merge_toml_values falls through to the
        // catch-all arm. An interaction matrix must never be half-merged.
        const merged = mergeSettingsWithDefaults({ matrix: [1, 2, 3, 4] }, { matrix: [9, 9] });
        expect(merged).toEqual({ matrix: [9, 9] });
    });

    it('adopts a nested object the defaults do not have at all', () => {
        expect(mergeValues({}, { added: { deep: true } })).toEqual({ added: { deep: true } });
    });

    it('lets a scalar override a table and vice versa', () => {
        expect(mergeValues({ k: { a: 1 } }, { k: 5 })).toEqual({ k: 5 });
        expect(mergeValues({ k: 5 }, { k: { a: 1 } })).toEqual({ k: { a: 1 } });
    });

    it('never aliases the defaults it merged over', () => {
        const defaults = { nested: { x: 1 } };
        const merged = mergeSettingsWithDefaults(defaults, {}) as typeof defaults;

        merged.nested.x = 42;
        expect(defaults.nested.x).toBe(1);
    });

    it('falls back to defaults for a document that is not an object', () => {
        const defaults = { a: 1 };
        expect(mergeSettingsWithDefaults(defaults, null)).toEqual({ a: 1 });
        expect(mergeSettingsWithDefaults(defaults, 7)).toEqual({ a: 1 });
        expect(mergeSettingsWithDefaults(defaults, [1, 2])).toEqual({ a: 1 });
    });

    it('classifies values the way toml::Value::Table does', () => {
        expect(isPlainObject({})).toBe(true);
        expect(isPlainObject([])).toBe(false);
        expect(isPlainObject(null)).toBe(false);
        expect(cloneValue({ a: [1, { b: 2 }] })).toEqual({ a: [1, { b: 2 }] });
    });
});

describe('PresetStore', () => {
    // 'vectors' is used as a scratch namespace so the moiré registration that
    // builtins/index.ts ships stays intact for the assertion below.
    beforeEach(() => registerBuiltinPresets('vectors', [{ name: 'Default', settings: {} }]));

    it('round-trips a user preset through storage', () => {
        const storage = fakeStorage();
        const store = new PresetStore(storage);

        store.save('vectors', 'Mine', { speed: 3 });

        expect(store.userPresetNames('vectors')).toEqual(['Mine']);
        expect(store.hasUserPreset('vectors', 'Mine')).toBe(true);
        expect(storage.map.has(presetStorageKey('vectors'))).toBe(true);

        // A second store reading the same storage sees it — the persistence
        // path, not just the in-memory one.
        expect(new PresetStore(storage).get('vectors', 'Mine')?.settings).toEqual({ speed: 3 });
    });

    it('lists built-ins first and skips user presets that shadow one', () => {
        const store = new PresetStore(fakeStorage());
        registerBuiltinPresets('vectors', [
            { name: 'Default', settings: {} },
            { name: 'Fast', settings: { speed: 10 } },
        ]);

        store.save('vectors', 'Fast', { speed: 999 });
        store.save('vectors', 'Custom', { speed: 1 });

        const defaults = { speed: 5, colour: 'white' };
        expect(store.names('vectors', defaults)).toEqual(['Default', 'Fast', 'Custom']);

        // load_user_presets pushes only names not already present, so the
        // built-in wins the collision.
        expect(store.get('vectors', 'Fast', defaults)?.settings).toEqual({
            speed: 10,
            colour: 'white',
        });
        // Built-ins carry only their overrides, exactly like ..Settings::default().
        expect(store.get('vectors', 'Default', defaults)?.settings).toEqual(defaults);
    });

    it('loads a preset saved under an old schema after a field is added', () => {
        // Saved when the schema was just { speed, colour }.
        const storage = fakeStorage();
        new PresetStore(storage).save('vectors', 'Legacy', { speed: 9, colour: 'red' });

        // A later release adds a field and changes a default.
        const newSchemaDefaults = { speed: 5, colour: 'white', trailLength: 12, fade: 0.5 };
        const loaded = new PresetStore(storage).get('vectors', 'Legacy', newSchemaDefaults);

        expect(loaded).toBeDefined();
        expect(loaded!.settings).toEqual({
            speed: 9,
            colour: 'red',
            trailLength: 12,
            fade: 0.5,
        });
    });

    it('deletes a user preset and clears the key when it was the last one', () => {
        const storage = fakeStorage();
        const store = new PresetStore(storage);

        store.save('vectors', 'A', { x: 1 });
        store.save('vectors', 'B', { x: 2 });
        store.delete('vectors', 'A');
        expect(store.userPresetNames('vectors')).toEqual(['B']);

        store.delete('vectors', 'B');
        expect(storage.map.has(presetStorageKey('vectors'))).toBe(false);
        // Deleting something that was never there is not an error.
        expect(() => store.delete('vectors', 'B')).not.toThrow();
    });

    it('surfaces a full quota instead of silently dropping the save', () => {
        const full: KeyValueStore = {
            getItem: () => null,
            setItem: () => {
                throw new DOMException('exceeded', 'QuotaExceededError');
            },
            removeItem: () => {},
        };
        const store = new PresetStore(full);

        try {
            store.save('vectors', 'Mine', { speed: 3 });
            expect.unreachable('save should have thrown');
        } catch (err) {
            expect(err).toBeInstanceOf(StorageError);
            expect((err as StorageError).kind).toBe('quota');
            expect((err as StorageError).message).toMatch(/preset "Mine" for vectors/);
            expect((err as StorageError).message).toMatch(/storage is full/i);
        }
    });

    it('reports plainly when there is no usable storage at all', () => {
        const store = new PresetStore(null);
        expect(store.names('vectors')).toEqual(['Default']);
        expect(() => store.save('vectors', 'Mine', {})).toThrow(StorageError);
    });

    it('rejects an empty preset name', () => {
        const store = new PresetStore(fakeStorage());
        expect(() => store.save('vectors', '   ', {})).toThrow(/empty name/);
    });

    it('ignores a corrupt stored document rather than failing to start', () => {
        const storage = fakeStorage({ [presetStorageKey('vectors')]: '{not json' });
        expect(new PresetStore(storage).names('vectors')).toEqual(['Default']);
    });

    it('ships the moiré built-ins as the worked example', () => {
        // Transcribed from src-tauri/src/simulations/moire/mod.rs:14.
        expect(getBuiltinPresets('moire').map((p) => p.name)).toEqual([
            'Default',
            'Classic Moiré',
            'Psychedelic',
            'Subtle',
        ]);
        expect(getBuiltinPresets('moire')[1].settings).toMatchObject({ base_freq: 30.0 });
    });
});
