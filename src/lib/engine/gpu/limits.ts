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

export function deriveCaps(device: GPUDevice): Caps {
    const limits = device.limits;
    const storageBinding = limits.maxStorageBufferBindingSize;

    return {
        slimeMoldAgents: Math.min(
            SLIME_MOLD_AGENT_CEILING,
            Math.floor((storageBinding * SLIME_MOLD_BUDGET_FRACTION) / SLIME_MOLD_AGENT_STRIDE)
        ),

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
