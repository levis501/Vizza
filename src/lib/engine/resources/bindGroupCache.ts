/**
 * Bind-group-layout memoisation.
 *
 * Layouts are immutable value objects — two with identical entries are
 * interchangeable — but every simulation declares its own, and ping-pong needs
 * *two* bind groups per pipeline against the *same* layout. Creating a fresh
 * layout each time works, yet it multiplies the pipeline-layout objects the
 * driver has to reconcile and makes "are these two pipelines compatible?"
 * impossible to answer by identity.
 *
 * Ported in spirit from shared/gpu_utils.rs's CommonBindGroupLayouts, which
 * hands out one shared layout per well-known shape.
 */

export class BindGroupLayoutCache {
    private readonly layouts = new Map<string, GPUBindGroupLayout>();

    constructor(private readonly device: GPUDevice) {}

    get(entries: GPUBindGroupLayoutEntry[], label?: string): GPUBindGroupLayout {
        const key = layoutKey(entries);
        let layout = this.layouts.get(key);
        if (!layout) {
            layout = this.device.createBindGroupLayout({ label, entries });
            this.layouts.set(key, layout);
        }
        return layout;
    }

    get size(): number {
        return this.layouts.size;
    }

    clear(): void {
        this.layouts.clear();
    }
}

/**
 * A stable string for a layout's shape. Entries are sorted by binding because
 * declaration order carries no meaning, and the label is excluded because two
 * differently-labelled layouts are still interchangeable.
 */
function layoutKey(entries: GPUBindGroupLayoutEntry[]): string {
    return entries
        .slice()
        .sort((a, b) => a.binding - b.binding)
        .map((entry) => {
            const resource =
                (entry.buffer &&
                    `buf:${entry.buffer.type ?? 'uniform'}:${entry.buffer.hasDynamicOffset ? 1 : 0}:${entry.buffer.minBindingSize ?? 0}`) ||
                (entry.texture &&
                    `tex:${entry.texture.sampleType ?? 'float'}:${entry.texture.viewDimension ?? '2d'}:${entry.texture.multisampled ? 1 : 0}`) ||
                (entry.storageTexture &&
                    `st:${entry.storageTexture.access ?? 'write-only'}:${entry.storageTexture.format}:${entry.storageTexture.viewDimension ?? '2d'}`) ||
                (entry.sampler && `smp:${entry.sampler.type ?? 'filtering'}`) ||
                (entry.externalTexture && 'ext') ||
                'none';
            return `${entry.binding}=${entry.visibility}|${resource}`;
        })
        .join(';');
}

// ---------------------------------------------------------------------------
// Ping-pong bind groups
// ---------------------------------------------------------------------------

/** Builds the entries for one orientation, given the read and write resources. */
export type PingPongEntries<T> = (read: T, write: T) => GPUBindGroupEntry[];

/**
 * The two bind groups a ping-pong pass alternates between: [0] reads A writes B,
 * [1] reads B writes A. Index with `pair[textures.currentIndex]` — matching the
 * `current`/`inactive` convention in pingPong.ts, so the orientation can never
 * be chosen by hand.
 */
export function createPingPongBindGroups<T>(
    device: GPUDevice,
    layout: GPUBindGroupLayout,
    resources: readonly [T, T],
    entries: PingPongEntries<T>,
    label = 'ping-pong'
): [GPUBindGroup, GPUBindGroup] {
    return [
        device.createBindGroup({
            label: `${label} A->B`,
            layout,
            entries: entries(resources[0], resources[1]),
        }),
        device.createBindGroup({
            label: `${label} B->A`,
            layout,
            entries: entries(resources[1], resources[0]),
        }),
    ];
}
