/**
 * The frame driver.
 *
 * Replaces the tokio task at src-tauri/src/simulation/manager.rs:1183, with two
 * deliberate differences:
 *
 *  1. **rAF with a real delta**, not a fixed tokio tick. rAF is the only clock
 *     the compositor will actually honour; anything else tears or double-renders.
 *     It also stops entirely when the tab is hidden, which the tokio loop did not.
 *  2. **Paused renders happen once, on demand.** The Rust called
 *     `render_frame_paused` every single frame while paused (manager.rs:1231)
 *     purely so camera moves would show. That keeps the GPU at full duty cycle
 *     on a paused simulation and pins a laptop fan. Here, pausing schedules one
 *     redraw and then the loop stops; anything that changes what a paused frame
 *     would look like — a camera pan, a settings edit, a resize — calls
 *     `requestRedraw()` for one more.
 *
 * The FPS limiter is frame skipping rather than the Rust's thread sleep
 * (manager.rs:1332); rAF already caps at the display refresh, so a limit above
 * it is simply not reachable and a limit below it is a skip pattern.
 *
 * Timing and scheduling are injectable, so this is testable in node with fake
 * timers and a stub rAF — nothing here touches the GPU or the DOM directly.
 */

import { emit } from '$lib/rpc';

export interface RenderLoopCallbacks {
    /** Advance the simulation and draw. `dt` is seconds, already clamped. */
    render(dt: number): void;
    /** Draw without advancing, so camera moves show while paused. */
    renderPaused(): void;
}

export interface RenderLoopOptions {
    /** Milliseconds, monotonic. Defaults to `performance.now`. */
    now?: () => number;
    requestFrame?: (callback: (time: number) => void) => number;
    cancelFrame?: (handle: number) => void;
    /**
     * Ceiling on the delta handed to `render`, in seconds. A backgrounded tab,
     * a long pipeline compile, or a breakpoint produce a gap of seconds; letting
     * that through makes particles teleport and integrators explode.
     */
    maxDeltaSeconds?: number;
    /**
     * Delta used by `step()`. Fixed rather than measured: a step is usually
     * taken after an arbitrarily long pause, and "one frame" should mean one
     * frame's worth of simulation, not however long the user was looking at it.
     */
    stepDeltaSeconds?: number;
    /** Time constant of the FPS EMA, in seconds. */
    fpsSmoothingSeconds?: number;
    /** How often `fps-update` is emitted, in milliseconds. */
    fpsEmitIntervalMs?: number;
}

const DEFAULTS = {
    maxDeltaSeconds: 0.1,
    stepDeltaSeconds: 1 / 60,
    fpsSmoothingSeconds: 0.5,
    fpsEmitIntervalMs: 500,
};

/**
 * Tolerance on the FPS-limit comparison, in milliseconds.
 *
 * Without it, a 60 fps limit against a 60 Hz rAF loses the race about half the
 * time to sub-millisecond jitter and the loop drops to 30 fps — the classic
 * frame-skipping failure. One millisecond is far below any real limit's period
 * and comfortably above the jitter.
 */
const FPS_LIMIT_TOLERANCE_MS = 1;

export class RenderLoop {
    private readonly callbacks: RenderLoopCallbacks;
    private readonly now: () => number;
    private readonly requestFrame: (callback: (time: number) => void) => number;
    private readonly cancelFrame: (handle: number) => void;
    private readonly maxDeltaSeconds: number;
    private readonly stepDeltaSeconds: number;
    private readonly fpsSmoothingSeconds: number;
    private readonly fpsEmitIntervalMs: number;

    private running = false;
    private paused = false;

    /** Handle of the pending frame, whether continuous or one-shot. */
    private frameHandle: number | null = null;
    /** True when the pending frame is a paused/step one-shot. */
    private oneShotPending = false;
    /** True when the pending one-shot should advance the simulation. */
    private stepPending = false;

    private lastFrameMs = 0;
    /** Start of the frame most recently *rendered*, for the FPS limiter. */
    private lastRenderMs = 0;
    private fpsLimit: number | null = null;

    private fpsEma = 0;
    private lastFpsEmitMs = 0;

    constructor(callbacks: RenderLoopCallbacks, options: RenderLoopOptions = {}) {
        this.callbacks = callbacks;
        this.now = options.now ?? defaultNow;
        this.requestFrame = options.requestFrame ?? defaultRequestFrame;
        this.cancelFrame = options.cancelFrame ?? defaultCancelFrame;
        this.maxDeltaSeconds = options.maxDeltaSeconds ?? DEFAULTS.maxDeltaSeconds;
        this.stepDeltaSeconds = options.stepDeltaSeconds ?? DEFAULTS.stepDeltaSeconds;
        this.fpsSmoothingSeconds = options.fpsSmoothingSeconds ?? DEFAULTS.fpsSmoothingSeconds;
        this.fpsEmitIntervalMs = options.fpsEmitIntervalMs ?? DEFAULTS.fpsEmitIntervalMs;
    }

    // -----------------------------------------------------------------------
    // Control
    // -----------------------------------------------------------------------

    /** Begin rendering. Idempotent; resumes if the loop was paused. */
    start(): void {
        if (this.running) {
            if (this.paused) this.resume();
            return;
        }
        this.running = true;
        this.paused = false;
        this.resetTiming();
        this.scheduleContinuous();
    }

    /** Stop and drop any pending frame. Idempotent. */
    stop(): void {
        this.running = false;
        this.paused = false;
        this.stepPending = false;
        this.cancelPendingFrame();
    }

    /**
     * Freeze the simulation. One paused redraw is scheduled so the frame on
     * screen is current, then no further frames are requested.
     */
    pause(): void {
        if (!this.running || this.paused) return;
        this.paused = true;
        this.cancelPendingFrame();
        this.requestRedraw();
    }

    resume(): void {
        if (!this.running || !this.paused) return;
        this.paused = false;
        this.stepPending = false;
        this.cancelPendingFrame();
        // Reset the clock: the elapsed pause must not become the first delta.
        this.resetTiming();
        this.scheduleContinuous();
    }

    /** Advance exactly one frame while paused. No-op when not paused. */
    step(): void {
        if (!this.running || !this.paused) return;
        this.stepPending = true;
        this.scheduleOneShot();
    }

    /**
     * Ask for a single paused redraw.
     *
     * This is the replacement for the Rust's every-frame `render_frame_paused`.
     * Call it whenever something changes what a paused frame would look like:
     * camera pan/zoom, a settings edit, a colour-scheme swap, a resize.
     * No-op when not paused — the continuous loop already covers that case.
     */
    requestRedraw(): void {
        if (!this.running || !this.paused) return;
        this.scheduleOneShot();
    }

    /**
     * Cap the frame rate, or pass `null` to run at the display refresh.
     *
     * Mirrors `set_fps_limit` (manager.rs:1348), collapsed from the Rust's
     * `(enabled, limit)` pair into one nullable value — the pair could express
     * "enabled with limit 0", which the Rust then had to special-case.
     */
    setFpsLimit(limit: number | null): void {
        this.fpsLimit = limit !== null && limit > 0 ? limit : null;
    }

    getFpsLimit(): number | null {
        return this.fpsLimit;
    }

    isRunning(): boolean {
        return this.running;
    }

    isPaused(): boolean {
        return this.paused;
    }

    /** The smoothed frame rate, as last emitted. */
    getFps(): number {
        return this.fpsEma;
    }

    // -----------------------------------------------------------------------
    // Scheduling
    // -----------------------------------------------------------------------

    private scheduleContinuous(): void {
        if (this.frameHandle !== null) return;
        this.oneShotPending = false;
        this.frameHandle = this.requestFrame(this.tick);
    }

    private scheduleOneShot(): void {
        if (this.frameHandle !== null) return;
        this.oneShotPending = true;
        this.frameHandle = this.requestFrame(this.tick);
    }

    private cancelPendingFrame(): void {
        if (this.frameHandle === null) return;
        this.cancelFrame(this.frameHandle);
        this.frameHandle = null;
        this.oneShotPending = false;
    }

    private resetTiming(): void {
        const now = this.now();
        this.lastFrameMs = now;
        // Zero rather than `now`, so the first frame after start is never skipped
        // by the limiter regardless of how long the previous run lasted.
        this.lastRenderMs = 0;
        this.lastFpsEmitMs = now;
    }

    private tick = (): void => {
        const wasOneShot = this.oneShotPending;
        this.frameHandle = null;
        this.oneShotPending = false;

        if (!this.running) return;

        if (wasOneShot) {
            this.runOneShot();
            return;
        }

        if (this.paused) return;

        // Schedule the successor before rendering, so a slow frame does not
        // serialise behind itself and the loop survives a throwing callback.
        this.scheduleContinuous();
        this.runContinuous();
    };

    private runContinuous(): void {
        const now = this.now();

        if (this.fpsLimit !== null) {
            const intervalMs = 1000 / this.fpsLimit;
            if (now - this.lastRenderMs + FPS_LIMIT_TOLERANCE_MS < intervalMs) {
                // Skipped frames do not advance `lastFrameMs`, so the delta
                // handed to `render` still covers the whole skipped span.
                return;
            }
        }

        const dt = this.consumeDelta(now);
        this.lastRenderMs = now;
        this.callbacks.render(dt);
        this.updateFps(now, dt);
    }

    private runOneShot(): void {
        const now = this.now();

        if (this.stepPending) {
            this.stepPending = false;
            // A fixed delta — see `stepDeltaSeconds`.
            this.lastFrameMs = now;
            this.lastRenderMs = now;
            this.callbacks.render(this.stepDeltaSeconds);
            return;
        }

        this.lastFrameMs = now;
        this.callbacks.renderPaused();
    }

    /** Seconds since the last rendered frame, clamped and non-negative. */
    private consumeDelta(now: number): number {
        const seconds = (now - this.lastFrameMs) / 1000;
        this.lastFrameMs = now;
        if (!Number.isFinite(seconds) || seconds < 0) return 0;
        return Math.min(seconds, this.maxDeltaSeconds);
    }

    /**
     * Exponential moving average of the instantaneous rate, emitted as
     * `fps-update` — the same event name and integer payload the Rust emitted
     * (manager.rs:1323), so every mode's existing `listen('fps-update', ...)`
     * keeps working.
     *
     * An EMA rather than the Rust's count-per-second because a one-second
     * bucket makes the readout lag a stutter by up to a second, which is
     * precisely when someone is looking at it.
     */
    private updateFps(now: number, dt: number): void {
        if (dt > 0) {
            const instantaneous = 1 / dt;
            // Time-based weight, so the smoothing constant means the same thing
            // at 15 fps as at 144 fps.
            const alpha = 1 - Math.exp(-dt / this.fpsSmoothingSeconds);
            this.fpsEma =
                this.fpsEma === 0
                    ? instantaneous
                    : this.fpsEma + (instantaneous - this.fpsEma) * alpha;
        }

        if (now - this.lastFpsEmitMs >= this.fpsEmitIntervalMs) {
            this.lastFpsEmitMs = now;
            emit('fps-update', Math.round(this.fpsEma));
        }
    }
}

function defaultNow(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function defaultRequestFrame(callback: (time: number) => void): number {
    return requestAnimationFrame(callback);
}

function defaultCancelFrame(handle: number): void {
    cancelAnimationFrame(handle);
}
