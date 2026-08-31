/**
 * Local replacement for `@tauri-apps/api/core`'s `invoke`.
 *
 * The Rust backend's command surface was a string-keyed, JSON-valued, async,
 * rejectable protocol. That is not a Tauri artifact — `Simulation::update_setting
 * (name, Value)` in src-tauri/src/simulations/traits.rs is the same shape — so
 * the browser engine keeps it rather than rewriting 319 call sites.
 *
 * Rejectability matters: src/lib/utils/sync.ts rolls back optimistic UI updates
 * in a `catch`, so a failed command must reject, not resolve.
 */

import { registry } from './registry';

/**
 * Tauri converted camelCase argument *keys* to snake_case parameter names.
 *
 * Per .cursorrules, the string *values* of `settingName` / `stateName` are
 * already snake_case and must pass through untouched — only keys are converted.
 */
function toSnakeCase(key: string): string {
    return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function normalizeArgs(
    args: Record<string, unknown> | undefined
): Record<string, unknown> {
    if (!args) return {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
        // Keys are normalized; values are never touched.
        out[toSnakeCase(key)] = value;
    }
    return out;
}

export async function invoke<T = unknown>(
    command: string,
    args?: Record<string, unknown>
): Promise<T> {
    const handler = registry.get(command);

    if (!handler) {
        throw new Error(`[rpc] unknown command: "${command}"`);
    }

    // Always async, so a handler may await GPU work (pipeline creation, buffer
    // reallocation) without the caller needing to know.
    return (await handler(normalizeArgs(args))) as T;
}

/** Exposed for the registry-completeness test. */
export { toSnakeCase };
