import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { registry } from '../../src/lib/rpc/registry';
import { toSnakeCase } from '../../src/lib/rpc/invoke';

/**
 * Guards the "mode X calls a command nobody implemented" bug class.
 *
 * The expected command list is grepped out of the .svelte/.ts sources at test
 * time rather than hardcoded, so adding an invoke() call to a component without
 * a matching handler fails here instead of at runtime with a blank canvas.
 */

const ROOT = resolve(__dirname, '../..');
const SRC = join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(svelte|ts)$/.test(entry)) out.push(p);
    }
    return out;
}

/** Literal `invoke('name')` / `invoke<T>('name')` call sites. */
function staticInvokes(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    const re = /invoke\s*(?:<[^>]*>)?\s*\(\s*['"`]([a-z_0-9]+)['"`]/g;

    for (const file of walk(SRC)) {
        // The shim itself is not a call site.
        if (file.includes('/lib/rpc/')) continue;
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(re)) {
            const list = found.get(m[1]) ?? [];
            list.push(relative(ROOT, file));
            found.set(m[1], list);
        }
    }
    return found;
}

/**
 * PostProcessingMenu.svelte builds its command name from `simulationType`.
 * The set is closed and enumerated in that file's getCommandName().
 */
const DYNAMIC_INVOKES = [
    ...[
        '',
        'particle_life_',
        'gray_scott_',
        'slime_mold_',
        'pellets_',
        'voronoi_ca_',
        'primordial_particles_',
    ].flatMap((sim) => [
        `get_${sim}post_processing_state`,
        `update_${sim}post_processing_state`,
    ]),
    // ImageSelector.svelte invokes whatever its `loadCommand` prop names.
    ...loadCommandProps(),
];

/** The closed set of `loadCommand="…"` values passed to ImageSelector. */
function loadCommandProps(): string[] {
    const names = new Set<string>();
    const re = /loadCommand\s*=\s*["']([a-z_0-9]+)["']/g;
    for (const file of walk(SRC)) {
        for (const m of readFileSync(file, 'utf8').matchAll(re)) {
            names.add(m[1]);
        }
    }
    return [...names];
}

describe('rpc registry', () => {
    const called = staticInvokes();

    it('finds the invoke call sites', () => {
        expect(called.size).toBeGreaterThan(70);
    });

    it('implements every statically-called command', () => {
        const missing: string[] = [];
        for (const [command, files] of called) {
            if (!registry.has(command)) {
                missing.push(`${command}  <- ${[...new Set(files)].join(', ')}`);
            }
        }
        expect(missing, `\nUnimplemented commands:\n${missing.join('\n')}\n`).toEqual(
            []
        );
    });

    it('implements every dynamically-built post-processing command', () => {
        const missing = DYNAMIC_INVOKES.filter((c) => !registry.has(c));
        expect(missing).toEqual([]);
    });

    it('has no unreachable handlers', () => {
        const reachable = new Set([...called.keys(), ...DYNAMIC_INVOKES]);
        const orphaned = [...registry.keys()].filter((c) => !reachable.has(c));
        expect(
            orphaned,
            `\nHandlers nothing calls:\n${orphaned.join('\n')}\n`
        ).toEqual([]);
    });
});

describe('argument key normalization', () => {
    it('converts camelCase keys to snake_case', () => {
        expect(toSnakeCase('presetName')).toBe('preset_name');
        expect(toSnakeCase('simulationType')).toBe('simulation_type');
        expect(toSnakeCase('screenX')).toBe('screen_x');
        expect(toSnakeCase('colorSchemeData')).toBe('color_scheme_data');
    });

    it('leaves already-snake_case keys alone', () => {
        expect(toSnakeCase('setting_name')).toBe('setting_name');
        expect(toSnakeCase('value')).toBe('value');
    });
});
