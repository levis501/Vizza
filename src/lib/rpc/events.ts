/**
 * Local replacement for `@tauri-apps/api/event`.
 *
 * The Rust backend emitted exactly three events; the engine now emits them
 * against this in-process bus with the same `listen()` shape, so mode
 * components keep their existing subscription code.
 */

export type EventName =
    | 'fps-update'
    | 'simulation-initialized'
    | 'simulation-resumed';

export interface Event<T> {
    event: EventName;
    payload: T;
}

export type EventCallback<T> = (event: Event<T>) => void;
export type UnlistenFn = () => void;

const listeners = new Map<EventName, Set<EventCallback<unknown>>>();

/**
 * Subscribe to an engine event. Mirrors Tauri's `listen`: returns a promise
 * resolving to the unsubscribe function.
 */
export async function listen<T>(
    event: EventName,
    handler: EventCallback<T>
): Promise<UnlistenFn> {
    let set = listeners.get(event);
    if (!set) {
        set = new Set();
        listeners.set(event, set);
    }
    const cb = handler as EventCallback<unknown>;
    set.add(cb);
    return () => {
        set!.delete(cb);
    };
}

/** Emit an engine event. Engine-internal; components only listen. */
export function emit<T>(event: EventName, payload: T): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of set) {
        try {
            cb({ event, payload });
        } catch (err) {
            console.error(`[rpc] listener for "${event}" threw`, err);
        }
    }
}

/** Test helper — drops every subscription. */
export function resetEvents(): void {
    listeners.clear();
}
