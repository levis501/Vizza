/**
 * RenderLoop — L1.
 *
 * Time and scheduling are injected, so the loop runs deterministically here
 * with no rAF, no timers, and no GPU: `clock.advance()` moves the fake clock,
 * `clock.flush()` fires whatever frame is pending.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RenderLoop } from '../../src/lib/engine/core/RenderLoop';
import { listen, resetEvents } from '../../src/lib/rpc';

/** A stub requestAnimationFrame: one pending callback, fired by hand. */
function makeClock(startMs = 1000) {
    let nowMs = startMs;
    let nextHandle = 1;
    const pending = new Map<number, (time: number) => void>();

    return {
        now: () => nowMs,
        requestFrame(callback: (time: number) => void): number {
            const handle = nextHandle++;
            pending.set(handle, callback);
            return handle;
        },
        cancelFrame(handle: number): void {
            pending.delete(handle);
        },
        advance(ms: number): void {
            nowMs += ms;
        },
        /** Fire every currently pending frame callback exactly once. */
        flush(): number {
            const callbacks = [...pending.entries()];
            pending.clear();
            for (const [, callback] of callbacks) callback(nowMs);
            return callbacks.length;
        },
        pendingCount(): number {
            return pending.size;
        },
        /** Advance then fire — one display frame. */
        frame(ms: number): void {
            nowMs += ms;
            this.flush();
        },
    };
}

type Clock = ReturnType<typeof makeClock>;

function makeLoop(clock: Clock, options: Record<string, unknown> = {}) {
    const render = vi.fn<(dt: number) => void>();
    const renderPaused = vi.fn<() => void>();
    const loop = new RenderLoop(
        { render, renderPaused },
        {
            now: clock.now,
            requestFrame: clock.requestFrame,
            cancelFrame: clock.cancelFrame,
            ...options,
        }
    );
    return { loop, render, renderPaused };
}

beforeEach(() => {
    resetEvents();
});

describe('RenderLoop start/stop', () => {
    it('renders nothing until started', () => {
        const clock = makeClock();
        const { render } = makeLoop(clock);
        expect(clock.pendingCount()).toBe(0);
        clock.frame(16);
        expect(render).not.toHaveBeenCalled();
    });

    it('renders one frame per rAF callback and keeps rescheduling', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.start();
        expect(loop.isRunning()).toBe(true);

        clock.frame(16);
        clock.frame(16);
        clock.frame(16);
        expect(render).toHaveBeenCalledTimes(3);
        expect(clock.pendingCount()).toBe(1);
    });

    it('is idempotent', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.start();
        loop.start();
        clock.frame(16);
        // Two starts must not mean two frames per tick.
        expect(render).toHaveBeenCalledTimes(1);
        expect(clock.pendingCount()).toBe(1);
    });

    it('stops and cancels the pending frame', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.start();
        clock.frame(16);
        loop.stop();

        expect(loop.isRunning()).toBe(false);
        expect(clock.pendingCount()).toBe(0);
        clock.frame(16);
        expect(render).toHaveBeenCalledTimes(1);
    });

    it('can be restarted after stopping', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.start();
        clock.frame(16);
        loop.stop();
        loop.start();
        clock.frame(16);
        expect(render).toHaveBeenCalledTimes(2);
    });
});

describe('RenderLoop delta time', () => {
    it('passes seconds since the previous frame', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.start();

        clock.frame(16);
        expect(render.mock.calls[0][0]).toBeCloseTo(0.016, 10);

        clock.frame(33);
        expect(render.mock.calls[1][0]).toBeCloseTo(0.033, 10);
    });

    it('clamps a huge gap so a backgrounded tab cannot teleport the simulation', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.start();
        clock.frame(16);

        // Tab hidden for a minute.
        clock.frame(60_000);
        expect(render.mock.calls[1][0]).toBe(0.1);
    });

    it('honours a custom clamp', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock, { maxDeltaSeconds: 0.25 });
        loop.start();
        clock.frame(16);
        clock.frame(10_000);
        expect(render.mock.calls[1][0]).toBe(0.25);
    });

    it('does not charge the pause to the first frame after resume', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.start();
        clock.frame(16);

        loop.pause();
        clock.flush(); // the one paused redraw
        clock.advance(30_000);
        loop.resume();

        clock.frame(16);
        const dt = render.mock.calls[render.mock.calls.length - 1][0];
        expect(dt).toBeCloseTo(0.016, 10);
    });
});

describe('RenderLoop pause/resume/step', () => {
    it('renders exactly one paused frame on pause, then nothing', () => {
        const clock = makeClock();
        const { loop, render, renderPaused } = makeLoop(clock);
        loop.start();
        clock.frame(16);
        render.mockClear();

        loop.pause();
        expect(loop.isPaused()).toBe(true);

        clock.frame(16);
        expect(renderPaused).toHaveBeenCalledTimes(1);
        expect(render).not.toHaveBeenCalled();

        // The Rust called render_frame_paused every frame here (manager.rs:1231);
        // the browser port must go quiet instead.
        clock.frame(16);
        clock.frame(16);
        expect(renderPaused).toHaveBeenCalledTimes(1);
        expect(clock.pendingCount()).toBe(0);
    });

    it('renders one more paused frame per requestRedraw', () => {
        const clock = makeClock();
        const { loop, renderPaused } = makeLoop(clock);
        loop.start();
        clock.frame(16);
        loop.pause();
        clock.frame(16);
        expect(renderPaused).toHaveBeenCalledTimes(1);

        loop.requestRedraw();
        clock.frame(16);
        expect(renderPaused).toHaveBeenCalledTimes(2);

        loop.requestRedraw();
        loop.requestRedraw(); // coalesced: two requests, one frame
        clock.frame(16);
        expect(renderPaused).toHaveBeenCalledTimes(3);
        expect(clock.pendingCount()).toBe(0);
    });

    it('ignores requestRedraw while running unpaused', () => {
        const clock = makeClock();
        const { loop, renderPaused } = makeLoop(clock);
        loop.start();
        loop.requestRedraw();
        clock.frame(16);
        clock.frame(16);
        expect(renderPaused).not.toHaveBeenCalled();
    });

    it('advances exactly one frame per step, with a fixed delta', () => {
        const clock = makeClock();
        const { loop, render, renderPaused } = makeLoop(clock);
        loop.start();
        clock.frame(16);
        loop.pause();
        clock.frame(16); // the pause redraw
        render.mockClear();
        renderPaused.mockClear();

        loop.step();
        clock.frame(16);
        expect(render).toHaveBeenCalledTimes(1);
        expect(render.mock.calls[0][0]).toBeCloseTo(1 / 60, 10);
        expect(renderPaused).not.toHaveBeenCalled();

        // One step, one frame — the loop does not free-run afterwards.
        clock.frame(16);
        expect(render).toHaveBeenCalledTimes(1);
    });

    it('uses a fixed step delta regardless of how long the pause lasted', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock, { stepDeltaSeconds: 0.02 });
        loop.start();
        clock.frame(16);
        loop.pause();
        clock.flush();
        render.mockClear();

        clock.advance(120_000);
        loop.step();
        clock.flush();
        expect(render.mock.calls[0][0]).toBe(0.02);
    });

    it('ignores step while not paused', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.start();
        loop.step();
        clock.frame(16);
        expect(render).toHaveBeenCalledTimes(1); // the ordinary frame, not a step
        expect(render.mock.calls[0][0]).toBeCloseTo(0.016, 10);
    });

    it('ignores pause/resume/step before start', () => {
        const clock = makeClock();
        const { loop, render, renderPaused } = makeLoop(clock);
        loop.pause();
        loop.resume();
        loop.step();
        expect(loop.isPaused()).toBe(false);
        expect(clock.pendingCount()).toBe(0);
        expect(render).not.toHaveBeenCalled();
        expect(renderPaused).not.toHaveBeenCalled();
    });

    it('resumes free-running', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.start();
        loop.pause();
        clock.frame(16);
        loop.resume();
        expect(loop.isPaused()).toBe(false);

        clock.frame(16);
        clock.frame(16);
        expect(render).toHaveBeenCalledTimes(2);
    });

    it('start() on a paused loop resumes it', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.start();
        loop.pause();
        clock.frame(16);
        loop.start();
        clock.frame(16);
        expect(render).toHaveBeenCalledTimes(1);
        expect(loop.isPaused()).toBe(false);
    });

    it('drops a pending paused frame when stopped', () => {
        const clock = makeClock();
        const { loop, renderPaused } = makeLoop(clock);
        loop.start();
        loop.pause();
        loop.stop();
        clock.frame(16);
        expect(renderPaused).not.toHaveBeenCalled();
    });
});

describe('RenderLoop FPS limiting', () => {
    it('renders every frame when uncapped', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.start();
        for (let i = 0; i < 10; i++) clock.frame(16);
        expect(render).toHaveBeenCalledTimes(10);
    });

    it('skips frames to approximate the limit', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.setFpsLimit(30);
        loop.start();

        // 60 rAF callbacks at 16.667 ms = one second of a 60 Hz display.
        for (let i = 0; i < 60; i++) clock.frame(1000 / 60);
        expect(render.mock.calls.length).toBeGreaterThanOrEqual(29);
        expect(render.mock.calls.length).toBeLessThanOrEqual(31);
    });

    it('does not halve a 60 fps limit on a 60 Hz loop', () => {
        // The classic frame-skipping bug: without a tolerance, sub-millisecond
        // jitter loses the comparison about half the time and the loop drops to
        // 30 fps.
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.setFpsLimit(60);
        loop.start();
        for (let i = 0; i < 60; i++) clock.frame(1000 / 60);
        expect(render).toHaveBeenCalledTimes(60);
    });

    it('gives the elapsed time of a skipped frame to the frame that follows', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.setFpsLimit(20); // 50 ms period
        loop.start();

        clock.frame(16); // rendered (first frame is never skipped)
        render.mockClear();
        clock.frame(16); // skipped
        clock.frame(16); // skipped
        clock.frame(16); // rendered, 48 ms after the last render...
        clock.frame(16); // ...or here, depending on the tolerance

        expect(render).toHaveBeenCalledTimes(1);
        // Time is conserved: no simulation time is lost to the skips.
        expect(render.mock.calls[0][0]).toBeGreaterThanOrEqual(0.048);
    });

    it('treats a zero or negative limit as uncapped', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.setFpsLimit(0);
        expect(loop.getFpsLimit()).toBeNull();
        loop.start();
        for (let i = 0; i < 5; i++) clock.frame(16);
        expect(render).toHaveBeenCalledTimes(5);
    });

    it('can be lifted mid-run', () => {
        const clock = makeClock();
        const { loop, render } = makeLoop(clock);
        loop.setFpsLimit(10);
        loop.start();
        for (let i = 0; i < 5; i++) clock.frame(16);
        const limited = render.mock.calls.length;

        loop.setFpsLimit(null);
        for (let i = 0; i < 5; i++) clock.frame(16);
        expect(render.mock.calls.length).toBe(limited + 5);
    });

    it('never skips a step or a paused redraw', () => {
        const clock = makeClock();
        const { loop, render, renderPaused } = makeLoop(clock);
        loop.setFpsLimit(1); // one second between frames
        loop.start();
        clock.frame(16);
        loop.pause();
        clock.frame(16);
        expect(renderPaused).toHaveBeenCalledTimes(1);

        render.mockClear();
        loop.step();
        clock.frame(16);
        expect(render).toHaveBeenCalledTimes(1);
    });
});

describe('RenderLoop fps-update event', () => {
    it('emits a rounded EMA on the rpc bus at the emit interval', async () => {
        const clock = makeClock();
        const { loop } = makeLoop(clock);
        const seen: number[] = [];
        await listen<number>('fps-update', (event) => seen.push(event.payload));

        loop.start();
        // Two seconds of a steady 60 Hz.
        for (let i = 0; i < 120; i++) clock.frame(1000 / 60);

        expect(seen.length).toBeGreaterThanOrEqual(3);
        for (const fps of seen) expect(Number.isInteger(fps)).toBe(true);
        // The EMA has a 500 ms time constant, so it is on target well inside 2 s.
        expect(seen[seen.length - 1]).toBeGreaterThanOrEqual(59);
        expect(seen[seen.length - 1]).toBeLessThanOrEqual(61);
    });

    it('does not emit more often than the emit interval', async () => {
        const clock = makeClock();
        const { loop } = makeLoop(clock, { fpsEmitIntervalMs: 500 });
        const seen: number[] = [];
        await listen<number>('fps-update', (event) => seen.push(event.payload));

        loop.start();
        for (let i = 0; i < 60; i++) clock.frame(1000 / 60); // exactly 1 s
        // 1000 ms / 500 ms — two emissions, not sixty.
        expect(seen.length).toBe(2);
    });

    it('tracks a change in frame rate', async () => {
        const clock = makeClock();
        const { loop } = makeLoop(clock);
        const seen: number[] = [];
        await listen<number>('fps-update', (event) => seen.push(event.payload));

        loop.start();
        for (let i = 0; i < 120; i++) clock.frame(1000 / 60);
        const fast = seen[seen.length - 1];

        for (let i = 0; i < 60; i++) clock.frame(1000 / 20); // drop to 20 fps
        const slow = seen[seen.length - 1];

        expect(fast).toBeGreaterThan(55);
        expect(slow).toBeGreaterThanOrEqual(19);
        expect(slow).toBeLessThanOrEqual(21);
    });

    it('reports the same value through getFps()', () => {
        const clock = makeClock();
        const { loop } = makeLoop(clock);
        loop.start();
        expect(loop.getFps()).toBe(0);
        for (let i = 0; i < 120; i++) clock.frame(1000 / 60);
        expect(loop.getFps()).toBeGreaterThan(55);
        expect(loop.getFps()).toBeLessThan(65);
    });

    it('emits nothing while paused', async () => {
        const clock = makeClock();
        const { loop } = makeLoop(clock);
        loop.start();
        for (let i = 0; i < 60; i++) clock.frame(1000 / 60);

        loop.pause();
        clock.flush();

        const seen: number[] = [];
        await listen<number>('fps-update', (event) => seen.push(event.payload));
        for (let i = 0; i < 120; i++) clock.frame(1000 / 60);
        expect(seen).toEqual([]);
    });
});

describe('RenderLoop robustness', () => {
    it('keeps running after a render callback throws', () => {
        const clock = makeClock();
        const render = vi
            .fn<(dt: number) => void>()
            .mockImplementationOnce(() => {
                throw new Error('pipeline exploded');
            })
            .mockImplementation(() => undefined);

        const loop = new RenderLoop(
            { render, renderPaused: () => undefined },
            { now: clock.now, requestFrame: clock.requestFrame, cancelFrame: clock.cancelFrame }
        );
        loop.start();

        // The successor frame is scheduled before render runs, so the throw
        // cannot kill the loop.
        expect(() => clock.frame(16)).toThrow('pipeline exploded');
        expect(clock.pendingCount()).toBe(1);

        clock.frame(16);
        expect(render).toHaveBeenCalledTimes(2);
    });
});
