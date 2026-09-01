import type { Caps } from '$lib/engine/types';

/**
 * Every ceiling in the app is derived from what the adapter actually granted,
 * never hardcoded. See WEB_PORT.md "Buffer budget" and "Reference device".
 *
 * The reference machine (Apple Metal-3, Chrome 152) grants exactly the WebGPU
 * spec defaults, so these numbers are the real constraints in production —
 * not a theoretical worst case.
 */

/** 16 B per agent: vec2 position + vec2 velocity, f32 each. */
export const SLIME_MOLD_AGENT_STRIDE = 16;

/**
 * Leave a tenth of the storage-binding budget unspent. The agent buffer is the
 * largest allocation in Slime Mold but not the only one — trail map, settings,
 * and LUT all have to fit alongside it in the same device.
 */
export const SLIME_MOLD_BUDGET_FRACTION = 0.9;

/** Absolute cap regardless of a generous device: 8 M agents is already ~130 MB. */
export const SLIME_MOLD_AGENT_CEILING = 8_000_000;

/**
 * The agent ceiling implied by a given storage-binding budget.
 *
 * Split out of `deriveCaps` because two callers need it without a device: the
 * `get_agent_count_limit` stub, answered before the engine has booted (or on a
 * browser with no WebGPU at all), and the fake engine the DOM tests drive.
 */
export function slimeMoldAgentCap(storageBufferBindingSize: number): number {
    return Math.min(
        SLIME_MOLD_AGENT_CEILING,
        Math.floor(
            (storageBufferBindingSize * SLIME_MOLD_BUDGET_FRACTION) / SLIME_MOLD_AGENT_STRIDE
        )
    );
}

/** 24 B per particle: vec2 position + vec2 velocity + u32 species + u32 pad. */
export const PARTICLE_LIFE_STRIDE = 24;

/**
 * Particle Life's ceiling, which is a *compute* ceiling, not a memory one.
 *
 * 50,000 particles is 1.2 MB — under 1% of the binding budget — so the buffer
 * is never the constraint. `particle_life/compute.wgsl:144` is O(n²) with no
 * spatial grid (its own comment says so), which puts 50,000 particles at 2.5
 * billion pair evaluations per frame. Past that the GPU does not fail, it
 * stalls long enough for the browser to reset the context, which looks to the
 * user exactly like the device loss an oversized Slime Mold pool causes and is
 * harder to diagnose. 50,000 is also the desktop UI's own maximum
 * (ParticleLifeMode.svelte:216); the Rust backend clamps to 100,000
 * (simulation.rs:3984), i.e. to twice what its own UI offers.
 *
 * Two device-derived bounds sit above it and neither binds on any plausible
 * adapter, but both are computed rather than assumed:
 *
 *  - the storage binding, at 24 B a particle; and
 *  - `maxComputeWorkgroupsPerDimension x 64`. Both particle kernels index by a
 *    plain `global_invocation_id.x` with **no** reconstructed row stride, so
 *    unlike Slime Mold's agents this dispatch cannot be folded into two
 *    dimensions — `foldDispatch` here would silently drop every particle past
 *    the first row. Capping the count so the 1D dispatch always fits is the
 *    fix that needs no shader change.
 */
export const PARTICLE_LIFE_CEILING = 50_000;

/** `@compute @workgroup_size(64)` — compute.wgsl:130 and init.wgsl:270. */
export const PARTICLE_LIFE_WORKGROUP = 64;

export function particleLifeCap(
    storageBufferBindingSize: number,
    maxWorkgroupsPerDimension: number
): number {
    return Math.min(
        PARTICLE_LIFE_CEILING,
        Math.floor(storageBufferBindingSize / PARTICLE_LIFE_STRIDE),
        maxWorkgroupsPerDimension * PARTICLE_LIFE_WORKGROUP
    );
}

/**
 * `maxStorageBufferBindingSize` every conformant WebGPU implementation must
 * grant — 128 MiB, and exactly what the reference device grants (WEB_PORT.md,
 * "Reference device"). Using it as the no-device answer understates a generous
 * adapter by at most 6% and can never overstate one.
 */
export const SPEC_MINIMUM_STORAGE_BUFFER_BINDING_SIZE = 134_217_728;

/** The agent ceiling on a device granting exactly the spec minimum: 7,549,747. */
export const SPEC_MINIMUM_SLIME_MOLD_AGENTS = slimeMoldAgentCap(
    SPEC_MINIMUM_STORAGE_BUFFER_BINDING_SIZE
);

export function deriveCaps(device: GPUDevice): Caps {
    const limits = device.limits;
    const storageBinding = limits.maxStorageBufferBindingSize;

    return {
        slimeMoldAgents: slimeMoldAgentCap(storageBinding),

        // Everything below Slime Mold is under 3% of the 128 MiB default binding
        // size at its UI maximum, so these are product decisions, not limits.
        flowPool: 1_000_000,

        // M8 lowered this from a flat 500,000 — ten times the desktop UI's own
        // maximum — to a derived value that respects the O(n²) kernel and the
        // un-foldable 1D dispatch. See `particleLifeCap`.
        particleLife: particleLifeCap(storageBinding, limits.maxComputeWorkgroupsPerDimension),
        pellets: 50_000,
        primordial: 1_000_000,

        // Deliberately independent of surface size and DPR: Gray-Scott sizes its
        // sim texture to the surface in the Rust build, which on a 4K display at
        // 3x DPR would allocate an ~11520x6480 rgba16float pair (~1.2 GB).
        grayScottMaxDim: 2048,

        // 2048^2 as atomic u32 x4 is 67 MB — the largest single allocation in the
        // app once Flow's scatter deposit becomes an atomic buffer (M12).
        flowTrailMaxDim: 2048,

        // The Rust hardcodes 65535 in three places (slime_mold/simulation.rs:1024
        // among them). Reading it keeps the 2D dispatch fold honest on any device.
        maxWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension,
        maxStorageBufferBindingSize: storageBinding,
        maxTextureDimension2D: limits.maxTextureDimension2D,
    };
}

/**
 * Folds an oversized 1D dispatch into two dimensions.
 *
 * Port of slime_mold/simulation.rs:1024. Without it, any workload above
 * maxComputeWorkgroupsPerDimension workgroups is silently truncated — the
 * shader must therefore reconstruct its linear index as
 * `id.y * workgroupsX * workgroupSize + id.x`.
 */
export function foldDispatch(
    totalWorkgroups: number,
    maxPerDimension: number
): [x: number, y: number] {
    const x = Math.min(totalWorkgroups, maxPerDimension);
    const y = Math.ceil(totalWorkgroups / maxPerDimension);
    return [x, y];
}
