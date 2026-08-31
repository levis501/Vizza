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

    /**
     * Sorted built-in + custom names, as `all_color_schemes` returned them —
     * but deduplicated.
     *
     * `color_scheme.rs:137` concatenates the two sets and sorts without
     * checking for collisions, so a custom `~/Vizza/LUTs/MATPLOTLIB_bone.lut`
     * makes the desktop picker list that name twice, with the second entry
     * unreachable because `get` (color_scheme.rs:152) always answers from the
     * embedded set. `saveCustom` refuses to create such a collision now, but a
     * document written by an earlier build can still hold one, and one bad
     * entry must not put a duplicate into a 167-item `<Selector>`.
     */
    allColorSchemes(): string[] {
        const names = new Set(this.builtinNames);
        for (const name of this.custom.keys()) names.add(name);
        return [...names].sort();
    }

    allCustomNames(): string[] {
        return [...this.custom.keys()].sort();
    }

    has(name: string): boolean {
        return this.builtinIndex.has(name) || this.custom.has(name);
    }

    /** True for one of the 167 packed schemes. */
    isBuiltin(name: string): boolean {
        return this.builtinIndex.has(name);
    }

    /** True for a scheme the user saved from the gradient editor. */
    isCustom(name: string): boolean {
        return this.custom.has(name);
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

        // `saveCustom` trims, but ColorSchemeSelector.svelte:850 sets
        // `current_color_scheme` from the raw <input> and then applies it by
        // name, so a name typed with a trailing space would be saved and then
        // immediately fail to load. Retry trimmed rather than making the user
        // guess.
        const trimmed = name.trim();
        const trimmedData = trimmed === name ? undefined : this.custom.get(trimmed);
        if (trimmedData) return ColorScheme.fromBytes(trimmed, trimmedData);

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
     *
     * **A built-in's name is refused.** `PresetStore.list` (PresetStore.ts:180)
     * handles the same collision by letting the built-in win and silently
     * skipping the user's entry, which is faithful to `load_user_presets`; the
     * precedence is right, but silence is not right *here*. A preset is saved
     * from a panel the user can re-open; a colour scheme is saved at the end of
     * the gradient editor, and both callers then switch the selection to that
     * name — which would quietly show the built-in instead, with the authored
     * gradient nowhere in the picker and no way to reach it. Same precedence,
     * reported instead of swallowed, so the user renames and keeps their work.
     */
    saveCustom(name: string, data: ArrayLike<number>): ColorScheme {
        const trimmed = name.trim();
        if (!trimmed) throw new Error('Cannot save a colour scheme with an empty name.');
        if (this.builtinIndex.has(trimmed)) {
            throw new Error(
                `"${trimmed}" is a built-in colour scheme. Pick a different name — a custom ` +
                    `scheme cannot replace a built-in one.`
            );
        }

        // Constructing it first means a wrong-sized buffer is rejected before
        // anything is written.
        const scheme = ColorScheme.fromBytes(trimmed, data);
        const previous = this.custom.get(trimmed);
        this.custom.set(trimmed, scheme.toBytes());
        try {
            this.persistCustom(`colour scheme "${trimmed}"`);
        } catch (err) {
            // Without this the scheme survives in memory and shows up in the
            // picker, then vanishes on reload — the worst of both outcomes for
            // a user who has just been told the save failed.
            if (previous) this.custom.set(trimmed, previous);
            else this.custom.delete(trimmed);
            throw err;
        }
        return scheme;
    }

    deleteCustom(name: string): void {
        const previous = this.custom.get(name);
        if (previous === undefined) return;
        this.custom.delete(name);
        try {
            this.persistCustom('colour schemes');
        } catch (err) {
            // A delete only shrinks the document, so this is not the quota —
            // it is storage being unavailable. Put it back either way, so the
            // catalogue keeps matching what a reload would produce.
            this.custom.set(name, previous);
            throw err;
        }
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
