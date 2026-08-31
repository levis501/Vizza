/**
 * localStorage-backed preset CRUD, namespaced per simulation.
 *
 * The desktop app wrote one TOML file per preset under
 * `~/Vizza/<sim>/presets/` (src-tauri/src/simulation/preset_manager.rs). A
 * browser has no filesystem, so each simulation gets one localStorage key
 * holding a `{ name: settings }` object.
 *
 * Two behaviours are carried across verbatim:
 *   - built-ins first, user presets appended, **duplicate names skipped**
 *     (`load_user_presets`, preset_manager.rs:113);
 *   - every stored document is deep-merged over the simulation's current
 *     defaults, so a preset saved under an older schema still loads (see
 *     ./merge.ts).
 *
 * The quota is the new constraint. localStorage gives 5-10 MB for the whole
 * origin, shared with app settings and custom colour schemes, and a failed
 * `setItem` throws rather than truncating — so writes surface a `StorageError`
 * and the caller reports it. Silently dropping a save the user just made is the
 * one outcome worth engineering against.
 */

import type { SimulationId } from '../types';
import { mergeSettingsWithDefaults } from './merge';
import { getBuiltinPresets } from './builtins';

export type PresetSettings = Record<string, unknown>;

export interface Preset {
    name: string;
    settings: PresetSettings;
}

/**
 * The slice of `Storage` these stores actually use.
 *
 * Narrowing it to three methods is what lets the unit tests drive the store
 * with a plain object instead of standing up jsdom for its own sake.
 */
export interface KeyValueStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export class StorageError extends Error {
    readonly kind: 'quota' | 'io';
    /** The underlying DOMException, kept for the console. `Error.cause` is
     * ES2022 and this project targets ES2020. */
    readonly reason?: unknown;

    constructor(kind: 'quota' | 'io', message: string, reason?: unknown) {
        super(message);
        this.name = 'StorageError';
        this.kind = kind;
        this.reason = reason;
    }
}

/**
 * Browsers disagree on how a full quota is reported: Chrome/Safari throw a
 * DOMException named QuotaExceededError (code 22), Firefox uses
 * NS_ERROR_DOM_QUOTA_REACHED (code 1014). Name-only detection misses one of
 * them, so check both.
 */
export function isQuotaError(err: unknown): boolean {
    if (typeof DOMException !== 'undefined' && err instanceof DOMException) {
        return (
            err.name === 'QuotaExceededError' ||
            err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
            err.code === 22 ||
            err.code === 1014
        );
    }
    return err instanceof Error && /quota/i.test(err.message);
}

/**
 * `localStorage` if it exists and is usable, otherwise null.
 *
 * Accessing it throws outright in a browser configured to block site data, so
 * the probe has to be a real read, not a `typeof` check.
 */
export function safeLocalStorage(): KeyValueStore | null {
    try {
        if (typeof localStorage === 'undefined') return null;
        localStorage.getItem('vizza.probe');
        return localStorage;
    } catch {
        return null;
    }
}

/** Parse a stored JSON document, treating corruption as "not there". */
export function readJson<T>(storage: KeyValueStore | null, key: string, fallback: T): T {
    if (!storage) return fallback;
    const raw = storage.getItem(key);
    if (raw === null) return fallback;
    try {
        const parsed = JSON.parse(raw) as T;
        return parsed === null ? fallback : parsed;
    } catch {
        // A half-written or hand-edited entry must not take the app down.
        console.warn(`Discarding unreadable localStorage entry "${key}"`);
        return fallback;
    }
}

/** Write a JSON document, turning a full quota into a `StorageError`. */
export function writeJson(
    storage: KeyValueStore | null,
    key: string,
    value: unknown,
    what: string
): void {
    if (!storage) {
        throw new StorageError('io', `Cannot save ${what}: this browser has no usable storage.`);
    }
    const serialized = JSON.stringify(value);
    try {
        storage.setItem(key, serialized);
    } catch (err) {
        if (isQuotaError(err)) {
            const kb = Math.ceil(serialized.length / 1024);
            throw new StorageError(
                'quota',
                `Cannot save ${what}: browser storage is full (needed about ${kb} KB). ` +
                    `Delete some saved presets or colour schemes and try again.`,
                err
            );
        }
        throw new StorageError('io', `Cannot save ${what}: ${String(err)}`, err);
    }
}

export const PRESET_KEY_PREFIX = 'vizza.presets.';

export function presetStorageKey(simulation: SimulationId): string {
    return `${PRESET_KEY_PREFIX}${simulation}`;
}

export class PresetStore {
    private readonly storage: KeyValueStore | null;

    constructor(storage: KeyValueStore | null = safeLocalStorage()) {
        this.storage = storage;
    }

    /** Raw stored documents, as `{ name: partialSettings }`. */
    private read(simulation: SimulationId): Record<string, PresetSettings> {
        const doc = readJson<Record<string, PresetSettings>>(
            this.storage,
            presetStorageKey(simulation),
            {}
        );
        return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : {};
    }

    /**
     * User presets only, in insertion order.
     *
     * `defaults` fills fields the stored document predates; pass the
     * simulation's current `Settings::default()` equivalent.
     */
    userPresets(simulation: SimulationId, defaults: PresetSettings = {}): Preset[] {
        const doc = this.read(simulation);
        return Object.keys(doc).map((name) => ({
            name,
            settings: mergeSettingsWithDefaults(defaults, doc[name]),
        }));
    }

    userPresetNames(simulation: SimulationId): string[] {
        return Object.keys(this.read(simulation));
    }

    hasUserPreset(simulation: SimulationId, name: string): boolean {
        return Object.prototype.hasOwnProperty.call(this.read(simulation), name);
    }

    /**
     * Built-ins merged with user presets, duplicate names skipped.
     *
     * Order and precedence match `load_user_presets`: built-ins are already in
     * the list, so a user preset that shares a name is *not* loaded — the
     * built-in wins. Both are merged over `defaults`, which is also how the
     * Rust built-ins are written (`Settings { a: 1, ..Settings::default() }`),
     * so built-in registrations only need to carry the fields they change.
     */
    list(simulation: SimulationId, defaults: PresetSettings = {}): Preset[] {
        const presets: Preset[] = getBuiltinPresets(simulation).map((preset) => ({
            name: preset.name,
            settings: mergeSettingsWithDefaults(defaults, preset.settings),
        }));

        const seen = new Set(presets.map((p) => p.name));
        for (const preset of this.userPresets(simulation, defaults)) {
            if (seen.has(preset.name)) continue;
            seen.add(preset.name);
            presets.push(preset);
        }
        return presets;
    }

    /** Names in the same order `get_available_presets` returned them. */
    names(simulation: SimulationId, defaults: PresetSettings = {}): string[] {
        return this.list(simulation, defaults).map((p) => p.name);
    }

    get(simulation: SimulationId, name: string, defaults: PresetSettings = {}): Preset | undefined {
        return this.list(simulation, defaults).find((p) => p.name === name);
    }

    /**
     * Save (or overwrite) a user preset.
     *
     * Throws `StorageError` on a full quota — the caller must surface it. The
     * whole namespace is rewritten in one `setItem`, so a failure leaves the
     * previous document intact rather than a partially updated one.
     */
    save(simulation: SimulationId, name: string, settings: PresetSettings): void {
        const trimmed = name.trim();
        if (!trimmed) throw new StorageError('io', 'Cannot save a preset with an empty name.');

        const doc = this.read(simulation);
        doc[trimmed] = settings;
        writeJson(
            this.storage,
            presetStorageKey(simulation),
            doc,
            `preset "${trimmed}" for ${simulation}`
        );
    }

    /** Delete a user preset. Built-ins are not stored, so they cannot be deleted. */
    delete(simulation: SimulationId, name: string): void {
        const doc = this.read(simulation);
        if (!Object.prototype.hasOwnProperty.call(doc, name)) return;
        delete doc[name];

        const key = presetStorageKey(simulation);
        if (Object.keys(doc).length === 0) {
            this.storage?.removeItem(key);
            return;
        }
        // A delete only ever shrinks the document, so this write cannot exceed
        // the quota — but route it through the same helper for the error shape.
        writeJson(this.storage, key, doc, `presets for ${simulation}`);
    }
}

/** The app-wide store. Tests construct their own with a fake `KeyValueStore`. */
export const presetStore = new PresetStore();
