/**
 * Forward-compatible deep merge for preset settings.
 *
 * Port of `merge_settings_with_defaults` / `merge_toml_values`
 * (src-tauri/src/simulation/preset_manager.rs:169-212). The Rust round-trips a
 * simulation's `Settings::default()` through TOML and deep-merges the user's
 * partial document over it, so a preset written before a field existed still
 * loads after that field is added — the missing key just comes from defaults.
 *
 * The same problem is worse in a browser: presets live in localStorage, so they
 * outlive every deploy and there is no migration step to hang a fixup on.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
    [key: string]: JsonValue;
}

/**
 * True for a plain object — the JSON analogue of `toml::Value::Table`.
 *
 * Arrays are excluded deliberately: TOML arrays are not tables, so the Rust
 * falls through to the catch-all arm and replaces them wholesale. An interaction
 * matrix or a colour list must be taken from the preset entire, never merged
 * element-wise with a differently-shaped default.
 */
export function isPlainObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep clone, so a merged result never aliases the defaults it was built from. */
export function cloneValue<T>(value: T): T {
    if (Array.isArray(value)) return value.map(cloneValue) as unknown as T;
    if (isPlainObject(value)) {
        const out: JsonObject = {};
        for (const key of Object.keys(value)) out[key] = cloneValue(value[key]);
        return out as unknown as T;
    }
    return value;
}

/**
 * Recursively merge two values, the override winning.
 *
 * Literal port of `merge_toml_values`: two tables merge key by key; anything
 * else is replaced. A key the base lacks is merged against an empty table,
 * which for a nested object means it is adopted whole.
 */
export function mergeValues(base: JsonValue, override: JsonValue): JsonValue {
    if (isPlainObject(base) && isPlainObject(override)) {
        const result: JsonObject = cloneValue(base);
        for (const key of Object.keys(override)) {
            const baseChild = Object.prototype.hasOwnProperty.call(base, key) ? base[key] : {};
            result[key] = mergeValues(baseChild, override[key]);
        }
        return result;
    }
    return cloneValue(override);
}

/**
 * Fill a partial settings document out of a simulation's defaults.
 *
 * Divergence from the Rust, deliberate: `merge_settings_with_defaults` finishes
 * by deserializing into `Settings`, and serde silently drops keys the struct
 * does not know. We keep them. There is no runtime schema on this side to prune
 * against, and pruning by "keys present in defaults" would destroy map-valued
 * settings whose default is an empty object. An unknown key is inert — nothing
 * reads it — whereas a deleted one is data loss.
 */
export function mergeSettingsWithDefaults<T extends object>(defaults: T, partial: unknown): T {
    if (!isPlainObject(partial)) {
        // A non-object document has nothing mergeable in it; the Rust fails
        // deserialization at this point, which the caller sees as "preset
        // unreadable, fall back to defaults".
        return cloneValue(defaults);
    }
    return mergeValues(defaults as unknown as JsonObject, partial) as T;
}
