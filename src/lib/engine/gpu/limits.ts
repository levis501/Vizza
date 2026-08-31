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
        particleLife: 500_000,
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
