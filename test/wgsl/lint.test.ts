import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Static validation of the whole WGSL corpus against core-WebGPU rules.
 *
 * These constraints are the ones that are easy to violate and expensive to
 * discover at runtime — a rejected pipeline surfaces as a blank canvas, not a
 * stack trace. Every rule here corresponds to a real defect found in the Rust
 * shaders during the port survey (see WEB_PORT.md, "WGSL remediations").
 *
 * Legality was established empirically against Chrome + SwiftShader at the
 * bind-group-layout layer; shader-module compilation alone does NOT validate
 * storage-texture access and will give a false pass.
 */

const ROOT = resolve(__dirname, '../..');
const SHADER_ROOT = join(ROOT, 'src-tauri/src/simulations');

/** Formats that core WebGPU permits with `read_write` storage access. */
const READ_WRITE_FORMATS = new Set(['r32uint', 'r32sint', 'r32float']);

/**
 * Shaders legitimately dispatched as a single invocation, where a 1x1x1
 * workgroup is correct rather than wasteful. Anything not listed here that
 * declares 1x1x1 is a per-pixel or per-element kernel and is a real perf bug.
 */
const SINGLE_INVOCATION_SHADERS = new Set([
    // Writes one element of the force matrix, to avoid a CPU round-trip — so
    // 1x1x1 is correct here, not wasteful, and it stays allow-listed rather
    // than moving into KNOWN_VIOLATIONS below.
    //
    // M8 established that it is also **dead on both builds**: the only function
    // that dispatches it, `update_force_element_gpu`
    // (particle_life/simulation.rs:2285), has no caller anywhere in `src-tauri`,
    // and neither does `randomize_force_matrix_gpu`, which owns the sibling
    // force_randomize.wgsl. Every force-matrix write that actually happens on
    // either build is CPU-side plus a `write_buffer`, which is what the browser
    // port does too. Listing it as a known *violation* would schedule a
    // remediation for a shader that has no defect and no caller; it is recorded
    // here instead so the next reader does not go looking for its dispatch.
    'src-tauri/src/simulations/particle_life/shaders/force_update.wgsl',
]);

/**
 * Defects inherited from the Rust shaders, each scheduled for a specific
 * milestone (see WEB_PORT.md, "WGSL remediations").
 *
 * These are asserted *exactly*, not merely tolerated: fixing one without
 * removing it here fails the test, and introducing a new violation fails it
 * too. The ledger empties as the port progresses.
 */
const KNOWN_VIOLATIONS = {
    // Remediation (a), (b), (c) — M12 Flow. (d) is fixed: gray_scott/paint.wgsl
    // ping-pongs, with copy-through at its early-outs.
    readWriteStorageTexture: [
        'src-tauri/src/simulations/flow/shaders/particle_update.wgsl:58',
        'src-tauri/src/simulations/flow/shaders/shape_drawing.wgsl:19',
        'src-tauri/src/simulations/flow/shaders/trail_decay_diffusion.wgsl:46',
    ],
    // Remediation (e) — M10 Pellets.
    atomicInReadStorage: ['src-tauri/src/simulations/pellets/shaders/physics_compute.wgsl:65'],
    // Remediation (f) is fixed: gray_scott/reaction_diffusion.wgsl is 8x8x1.
    singleInvocationWorkgroup: [],
};

/** Reduces "path:line  match" down to "path:line" for ledger comparison. */
function sites(violations: string[]): string[] {
    return violations.map((v) => v.split(/\s{2}/)[0]).sort();
}

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (entry.endsWith('.wgsl')) out.push(p);
    }
    return out;
}

const files = walk(SHADER_ROOT).sort();
const sources = files.map((f) => ({
    path: relative(ROOT, f),
    text: readFileSync(f, 'utf8'),
}));

/** Strips line and block comments so rules don't fire on commented-out code. */
function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function findAll(re: RegExp, text: string): { line: number; match: string }[] {
    const hits: { line: number; match: string }[] = [];
    for (const m of text.matchAll(re)) {
        hits.push({
            line: text.slice(0, m.index).split('\n').length,
            match: m[0].replace(/\s+/g, ' ').trim(),
        });
    }
    return hits;
}

describe('WGSL corpus', () => {
    it('finds the shader files', () => {
        expect(files.length).toBeGreaterThan(60);
    });

    /**
     * Core WebGPU only permits `read_write` storage-texture access on the r32
     * formats. rgba8unorm / rgba16float are rejected at pipeline creation with
     * "format does not support storage texture access".
     */
    it('has no read_write storage texture on a non-r32 format', () => {
        const violations: string[] = [];
        const re = /texture_storage_(?:1d|2d|2d_array|3d)\s*<\s*([a-z0-9]+)\s*,\s*read_write\s*>/g;

        for (const { path, text } of sources) {
            for (const hit of findAll(re, stripComments(text))) {
                const format = /<\s*([a-z0-9]+)\s*,/.exec(hit.match)?.[1] ?? '?';
                if (!READ_WRITE_FORMATS.has(format)) {
                    violations.push(`${path}:${hit.line}  ${hit.match}`);
                }
            }
        }

        expect(sites(violations), `\n${violations.join('\n')}\n`).toEqual(
            KNOWN_VIOLATIONS.readWriteStorageTexture.sort()
        );
    });

    /**
     * WGSL permits atomics only in the storage address space with read_write
     * access. `var<storage, read> … array<atomic<u32>>` is rejected at shader
     * compile: "atomic variables in 'storage' address space must have
     * read_write access".
     */
    it('has no atomic in a read-only storage binding', () => {
        const violations: string[] = [];
        const re = /var\s*<\s*storage\s*,\s*read\s*>[^;]*atomic\s*</g;

        for (const { path, text } of sources) {
            for (const hit of findAll(re, stripComments(text))) {
                violations.push(`${path}:${hit.line}  ${hit.match}`);
            }
        }

        expect(sites(violations), `\n${violations.join('\n')}\n`).toEqual(
            KNOWN_VIOLATIONS.atomicInReadStorage.sort()
        );
    });

    /**
     * A 1x1x1 workgroup dispatched once per pixel wastes ~63/64 of every GPU
     * wave. Legal, but a severe perf bug — gray_scott dispatched 2,073,600
     * workgroups at 1080p where 32,400 would do, until it was raised to 8x8x1.
     */
    it('has no 1x1x1 workgroup size', () => {
        const violations: string[] = [];
        const re = /@workgroup_size\s*\(\s*1\s*(?:,\s*1\s*)?(?:,\s*1\s*)?\)/g;

        for (const { path, text } of sources) {
            if (SINGLE_INVOCATION_SHADERS.has(path)) continue;
            for (const hit of findAll(re, stripComments(text))) {
                violations.push(`${path}:${hit.line}  ${hit.match}`);
            }
        }

        expect(sites(violations), `\n${violations.join('\n')}\n`).toEqual(
            KNOWN_VIOLATIONS.singleInvocationWorkgroup.sort()
        );
    });

    /**
     * Native-only wgpu extensions and WGSL features with no browser counterpart.
     */
    it('uses no non-core WGSL extensions', () => {
        const violations: string[] = [];
        const re = /^\s*(?:enable|requires)\s+([a-z0-9_]+)/gm;

        for (const { path, text } of sources) {
            for (const hit of findAll(re, stripComments(text))) {
                violations.push(`${path}:${hit.line}  ${hit.match}`);
            }
        }

        expect(violations, `\n${violations.join('\n')}\n`).toEqual([]);
    });
});
