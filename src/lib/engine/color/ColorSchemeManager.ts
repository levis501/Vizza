/**
 * The colour-scheme catalogue: 167 packed LUTs plus the user's custom ones.
 *
 * Port of `ColorSchemeManager` (src-tauri/src/simulations/shared/color_scheme.rs:130).
 * The Rust embeds each `.lut` file separately with `include_dir!`; the browser
 * fetches one 128,256-byte blob and an index (see vite-plugin-luts.ts), so a
 * scheme's bytes are `blob[index * 768 .. +768]`.
 *
 * `ColorSchemeSelector.svelte` is imported by 9 of the 10 mode components, so
 * this is the highest fan-in module in the app. The API is deliberately small:
 * load once, list names, get by name, toggle reversed, save/delete custom.
 */

import { ColorScheme, LUT_STRIDE } from './ColorScheme';
import { readJson, safeLocalStorage, writeJson, type KeyValueStore } from '../presets/PresetStore';

/** get_default (color_scheme.rs:223) is bone, reversed. */
export const DEFAULT_COLOR_SCHEME_NAME = 'MATPLOTLIB_bone';
export const DEFAULT_COLOR_SCHEME_REVERSED = true;

export const CUSTOM_COLOR_SCHEMES_KEY = 'vizza.colorSchemes.custom';

export interface LutIndex {
    stride: number;
    names: string[];
}

export interface ColorSchemeManagerOptions {
    /** Injectable so tests can serve the packed blob without a network. */
    fetchImpl?: typeof fetch;
    /** Pass null to run without persistence; defaults to localStorage. */
    storage?: KeyValueStore | null;
    /** Where /luts.bin and /luts.json live. */
    baseUrl?: string;
}

/** Custom LUTs are stored base64-encoded: 768 bytes → 1024 chars. */
function encodeLut(data: Uint8Array): string {
    let binary = '';
    for (const byte of data) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function decodeLut(encoded: string): Uint8Array {
    const binary = atob(encoded);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
}

export class ColorSchemeManager {
    private readonly fetchImpl: typeof fetch;
    private readonly storage: KeyValueStore | null;
    private readonly baseUrl: string;

    private blob: Uint8Array = new Uint8Array(0);
    private builtinNames: string[] = [];
    private builtinIndex = new Map<string, number>();
    private custom = new Map<string, Uint8Array>();

    /** In-flight or completed load, so concurrent callers share one fetch. */
    private loading: Promise<void> | null = null;

    private currentNameValue = DEFAULT_COLOR_SCHEME_NAME;
    private reversedValue = DEFAULT_COLOR_SCHEME_REVERSED;

    constructor(options: ColorSchemeManagerOptions = {}) {
        this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
        this.storage = options.storage === undefined ? safeLocalStorage() : options.storage;
        this.baseUrl = options.baseUrl ?? '';
        this.loadCustom();
    }

    get loaded(): boolean {
        return this.builtinNames.length > 0;
    }

    /**
     * Fetch the packed LUTs. Idempotent, and safe to call from several places
     * at once — every mode's `onMount` races to it.
     */
    load(): Promise<void> {
        if (!this.loading) {
            this.loading = this.fetchLuts().catch((err) => {
                // Clear the memo so a transient network failure can be retried
                // rather than poisoning every later call.
                this.loading = null;
                throw err;
            });
        }
        return this.loading;
    }

    private async fetchLuts(): Promise<void> {
        const [indexResponse, blobResponse] = await Promise.all([
            this.fetchImpl(`${this.baseUrl}/luts.json`),
            this.fetchImpl(`${this.baseUrl}/luts.bin`),
        ]);
        if (!indexResponse.ok || !blobResponse.ok) {
            throw new Error(
                `Failed to load colour schemes: /luts.json ${indexResponse.status}, ` +
                    `/luts.bin ${blobResponse.status}`
            );
        }

        const index = (await indexResponse.json()) as LutIndex;
        const blob = new Uint8Array(await blobResponse.arrayBuffer());

        const stride = index.stride ?? LUT_STRIDE;
        if (stride !== LUT_STRIDE) {
            throw new Error(`Unexpected LUT stride ${stride}, expected ${LUT_STRIDE}`);
        }
        if (blob.length !== index.names.length * LUT_STRIDE) {
            throw new Error(
                `luts.bin is ${blob.length} bytes, expected ${index.names.length * LUT_STRIDE}`
            );
        }

        this.blob = blob;
        this.builtinNames = index.names;
        this.builtinIndex = new Map(index.names.map((name, i) => [name, i]));
    }

    /** Sorted built-in + custom names, as `all_color_schemes` returned them. */
    allColorSchemes(): string[] {
        return [...this.builtinNames, ...this.custom.keys()].sort();
    }

    allCustomNames(): string[] {
        return [...this.custom.keys()].sort();
    }

    has(name: string): boolean {
        return this.builtinIndex.has(name) || this.custom.has(name);
    }

    /**
     * A scheme by name, custom LUTs included.
     *
     * Returns a fresh `ColorScheme` each time; the caller may reverse it in
     * place without disturbing the catalogue.
     */
    get(name: string): ColorScheme {
        const index = this.builtinIndex.get(name);
        if (index !== undefined) {
            const offset = index * LUT_STRIDE;
            return ColorScheme.fromBytes(name, this.blob.subarray(offset, offset + LUT_STRIDE));
        }

        const customData = this.custom.get(name);
        if (customData) return ColorScheme.fromBytes(name, customData);

        throw new Error(
            this.loaded
                ? `Unknown colour scheme "${name}"`
                : `Colour schemes are not loaded yet (asked for "${name}")`
        );
    }

    /** bone, reversed — matching get_default, which keeps the un-suffixed name. */
    getDefault(): ColorScheme {
        const scheme = this.get(DEFAULT_COLOR_SCHEME_NAME);
        scheme.reverse();
        return scheme;
    }

    /** Port of get_random_lut: built-ins only, never a custom scheme. */
    getRandom(): ColorScheme {
        const name = this.builtinNames[Math.floor(Math.random() * this.builtinNames.length)];
        return this.get(name);
    }

    // --- current selection --------------------------------------------------

    get currentName(): string {
        return this.currentNameValue;
    }

    get reversed(): boolean {
        return this.reversedValue;
    }

    /** The selected scheme with the reversed flag applied. */
    current(): ColorScheme {
        const scheme = this.get(this.currentNameValue);
        if (this.reversedValue) scheme.reverse();
        return scheme;
    }

    /** What `Simulation.updateColorScheme` wants. */
    currentU32(): Uint32Array {
        return this.current().toU32Buffer();
    }

    setCurrent(name: string): ColorScheme {
        this.currentNameValue = name;
        return this.current();
    }

    setReversed(reversed: boolean): ColorScheme {
        this.reversedValue = reversed;
        return this.current();
    }

    toggleReversed(): ColorScheme {
        return this.setReversed(!this.reversedValue);
    }

    // --- custom schemes -----------------------------------------------------

    /**
     * Save a custom LUT.
     *
     * `ColorSchemeSelector` hands over `colorSchemeData` as 768 plain numbers in
     * planar order, so accept any ArrayLike. Throws `StorageError` when the
     * quota is full — 1 KB per scheme, so this only bites once presets have
     * eaten the budget, but it must not fail silently.
     */
    saveCustom(name: string, data: ArrayLike<number>): ColorScheme {
        const trimmed = name.trim();
        if (!trimmed) throw new Error('Cannot save a colour scheme with an empty name.');

        // Constructing it first means a wrong-sized buffer is rejected before
        // anything is written.
        const scheme = ColorScheme.fromBytes(trimmed, data);
        this.custom.set(trimmed, scheme.toBytes());
        this.persistCustom(`colour scheme "${trimmed}"`);
        return scheme;
    }

    deleteCustom(name: string): void {
        if (!this.custom.delete(name)) return;
        this.persistCustom('colour schemes');
    }

    private persistCustom(what: string): void {
        const doc: Record<string, string> = {};
        for (const [name, data] of this.custom) doc[name] = encodeLut(data);
        writeJson(this.storage, CUSTOM_COLOR_SCHEMES_KEY, doc, what);
    }

    private loadCustom(): void {
        const doc = readJson<Record<string, string>>(this.storage, CUSTOM_COLOR_SCHEMES_KEY, {});
        for (const [name, encoded] of Object.entries(doc)) {
            try {
                const data = decodeLut(encoded);
                if (data.length !== LUT_STRIDE) throw new Error(`${data.length} bytes`);
                this.custom.set(name, data);
            } catch (err) {
                // One corrupt entry must not cost the user the rest of them.
                console.warn(`Skipping unreadable custom colour scheme "${name}":`, err);
            }
        }
    }
}

/** The app-wide catalogue. Tests construct their own with injected deps. */
export const colorSchemeManager = new ColorSchemeManager();
