/**
 * Drop-in replacement for the Tauri APIs the frontend was built against.
 *
 * Components import `invoke` and `listen` from here instead of
 * `@tauri-apps/api/core` and `@tauri-apps/api/event`. The signatures are
 * identical, so no call site needs to change.
 */

export { invoke } from './invoke';
export { listen, emit, resetEvents } from './events';
export type { Event, EventCallback, EventName, UnlistenFn } from './events';
export { register, registry } from './registry';
export { setEngineContext, getEngineContext, hasEngineContext } from './context';
export type { EngineContext } from './context';
