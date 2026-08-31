/**
 * The WGSL corpus, read from the Rust tree rather than copied into src/.
 *
 * The Rust build embeds these same files with `include_dir!`, so there is one
 * source of truth for 8,808 lines of shader. Forking the corpus would let the
 * two drift apart within weeks and destroy the ability to diff a browser bug
 * against the desktop reference. `vite.config.ts` allows serving from
 * `src-tauri` for exactly this.
 */

const PREFIX = '/src-tauri/src/simulations/';

const raw = import.meta.glob('/src-tauri/src/simulations/**/*.wgsl', {
    query: '?raw',
    import: 'default',
    eager: true,
}) as Record<string, string>;

/** Keyed by path relative to the simulations root, e.g. 'main_menu/shaders/combined.wgsl'. */
export const shaders: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(raw).map(([path, source]) => [path.slice(PREFIX.length), source])
);

export const shaderPaths: readonly string[] = Object.keys(shaders).sort();

/**
 * A missing shader is always a typo or a moved file, and the resulting
 * `undefined` would otherwise surface as an opaque WGSL parse error several
 * frames later, so name the near misses here.
 */
export function getShader(path: string): string {
    const source = shaders[path];
    if (source !== undefined) return source;

    const suggestions = nearMatches(path);
    const hint = suggestions.length
        ? `\nDid you mean:\n${suggestions.map((s) => `  ${s}`).join('\n')}`
        : `\nThe corpus holds ${shaderPaths.length} shaders; none resemble that path.`;

    throw new Error(`No WGSL shader at '${path}'.${hint}`);
}

function nearMatches(path: string, limit = 5): string[] {
    const needle = path.toLowerCase();
    const base = needle.split('/').pop() ?? needle;

    // Same basename first (a wrong directory is the common case), then anything
    // sharing a path segment.
    const byBasename = shaderPaths.filter((p) => p.toLowerCase().endsWith(`/${base}`));
    const bySegment = shaderPaths.filter(
        (p) => !byBasename.includes(p) && sharesSegment(p.toLowerCase(), needle)
    );

    return [...byBasename, ...bySegment].slice(0, limit);
}

function sharesSegment(candidate: string, needle: string): boolean {
    return needle
        .split(/[/.]/)
        .filter((segment) => segment.length >= 4)
        .some((segment) => candidate.includes(segment));
}
