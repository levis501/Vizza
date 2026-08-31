/**
 * GPU resource accounting.
 *
 * Split out of `SimulationHost` so the L3 harness can use it: the host imports
 * `SimulationRegistry`, which is built on `import.meta.glob` and therefore only
 * resolvable by Vite, while the harness is bundled with esbuild. Nothing here
 * needs a registry, a render loop, or a camera.
 */

export interface ResourceStats {
    created: number;
    destroyed: number;
    /** created − destroyed. Must return to its baseline after a teardown. */
    live: number;
    /** Live count per label, so a leak names itself. */
    byLabel: Record<string, number>;
}

/**
 * A counter for GPU objects, so "create/destroy ×20 is clean" is assertable.
 *
 * `reset_graphics_resources` exists in the Rust app (commands, and the stub at
 * rpc/registry.ts) because simulations were poisoning global GPU state on
 * teardown. Natively that surfaced as a crash. In a browser, one leaked buffer
 * per mode switch is completely invisible until the tab OOMs on the twentieth
 * navigation — so it has to be counted rather than noticed.
 */
export class ResourceLedger {
    private createdCounts = new Map<string, number>();
    private destroyedCounts = new Map<string, number>();

    create(label: string, count = 1): void {
        this.createdCounts.set(label, (this.createdCounts.get(label) ?? 0) + count);
    }

    destroy(label: string, count = 1): void {
        this.destroyedCounts.set(label, (this.destroyedCounts.get(label) ?? 0) + count);
    }

    stats(): ResourceStats {
        const byLabel: Record<string, number> = {};
        let created = 0;
        let destroyed = 0;

        const labels = new Set([...this.createdCounts.keys(), ...this.destroyedCounts.keys()]);
        for (const label of labels) {
            const c = this.createdCounts.get(label) ?? 0;
            const d = this.destroyedCounts.get(label) ?? 0;
            created += c;
            destroyed += d;
            if (c - d !== 0) byLabel[label] = c - d;
        }

        return { created, destroyed, live: created - destroyed, byLabel };
    }

    reset(): void {
        this.createdCounts.clear();
        this.destroyedCounts.clear();
    }
}

/**
 * Wrap a device so every buffer and texture it hands out is counted, and
 * counted again when destroyed.
 *
 * Returns a `Proxy`, not a copy, so it can be dropped into `GpuContext.device`
 * and every existing call site keeps working. Only used by the leak tests and
 * by dev builds — instrumenting the device in production would add a property
 * lookup to the hottest path in the app for no benefit.
 *
 * Deliberately structural rather than `GPUDevice`-specific so a hand-rolled
 * fake device works in a node test with no WebGPU.
 */
export function instrumentDevice<T extends object>(device: T, ledger: ResourceLedger): T {
    const wrapFactory = (fn: (...args: never[]) => unknown, label: string) =>
        function (this: unknown, ...args: never[]): unknown {
            const resource = fn.apply(device, args) as { destroy?: () => void } | null;
            if (!resource || typeof resource !== 'object') return resource;

            ledger.create(label);

            const originalDestroy = resource.destroy;
            if (typeof originalDestroy === 'function') {
                let released = false;
                // `destroy()` is contractually idempotent (types.ts on
                // Simulation.destroy), so double-destroy must not double-count.
                resource.destroy = function (this: unknown): void {
                    if (!released) {
                        released = true;
                        ledger.destroy(label);
                    }
                    originalDestroy.call(resource);
                };
            }
            return resource;
        };

    const FACTORIES: Record<string, string> = {
        createBuffer: 'buffer',
        createTexture: 'texture',
        createQuerySet: 'querySet',
    };

    return new Proxy(device, {
        get(target, property) {
            // No receiver: a real GPUDevice's accessors (`limits`, `queue`) read
            // internal slots and throw "Illegal invocation" if `this` is the proxy.
            const value = Reflect.get(target, property);
            const label = typeof property === 'string' ? FACTORIES[property] : undefined;
            if (label && typeof value === 'function') {
                return wrapFactory(value as (...args: never[]) => unknown, label);
            }
            // Methods read off a Proxy lose their receiver, and WebGPU objects
            // hold internal slots, so bind everything else back to the target.
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
}
