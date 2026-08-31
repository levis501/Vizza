/**
 * Camera — L1.
 *
 * Expected values are derived from src-tauri/src/simulations/shared/camera.rs
 * by hand, not captured from this implementation, so the test can actually
 * disagree with the port. `camera.rs` carries no `#[cfg(test)]` module of its
 * own, so there was nothing to lift.
 */

import { describe, expect, it } from 'vitest';
import { Camera, CAMERA_DEFAULTS, CAMERA_UNIFORM_FLOATS } from '../../src/lib/engine/core/Camera';
import { ndcCoords, screenCoords, worldCoords } from '../../src/lib/engine/core/coordinates';

const WIDTH = 800;
const HEIGHT = 600;

function camera(): Camera {
    return new Camera(WIDTH, HEIGHT);
}

/** Run the smoothing to completion so `position`/`zoom` equal the targets. */
function settle(cam: Camera, frames = 400): void {
    for (let i = 0; i < frames; i++) cam.update(1 / 60);
}

describe('Camera defaults', () => {
    it('starts centred at zoom 1, matching Camera::new', () => {
        const cam = camera();
        expect(cam.position).toEqual([0, 0]);
        expect(cam.zoom).toBe(1);
        expect(cam.getTargetPosition()).toEqual([0, 0]);
        expect(cam.getTargetZoom()).toBe(1);
        expect(cam.getSmoothingFactor()).toBe(0.15);
        expect(cam.getSensitivity()).toBe(1);
        expect(cam.getPositionClamp()).toEqual([-2, 2]);
        expect(cam.aspectRatio()).toBeCloseTo(800 / 600, 12);
    });
});

describe('Camera.pan', () => {
    it('moves the target by delta * sensitivity * (0.1 / zoom)', () => {
        const cam = camera();
        // camera.rs:163 — pan_speed = 0.1 / zoom, and zoom is 1 here.
        cam.pan(1, -2);
        expect(cam.getTargetPosition()[0]).toBeCloseTo(0.1, 12);
        expect(cam.getTargetPosition()[1]).toBeCloseTo(-0.2, 12);
    });

    it('does not move the smoothed position until update() runs', () => {
        const cam = camera();
        cam.pan(1, 0);
        expect(cam.position[0]).toBe(0);

        // camera.rs:147 — smoothing = 0.15 * dt * 60, so one 60 Hz frame closes
        // 15% of the gap.
        cam.update(1 / 60);
        expect(cam.position[0]).toBeCloseTo(0.1 * 0.15, 12);
    });

    it('slows down as zoom increases', () => {
        const cam = camera();
        cam.zoomBy(1); // target 1.3
        settle(cam); // current zoom now 1.3 too
        cam.pan(1, 0);
        // pan_speed uses the *current* zoom (camera.rs:163), now 1.3.
        expect(cam.getTargetPosition()[0]).toBeCloseTo(0.1 / 1.3, 6);
    });

    it('scales by sensitivity', () => {
        const cam = camera();
        cam.setSensitivity(2);
        cam.pan(1, 0);
        expect(cam.getTargetPosition()[0]).toBeCloseTo(0.2, 12);
    });

    it('clamps the target position to +/-2', () => {
        const cam = camera();
        // 0.1 world units per unit delta, so 100 units overshoots the bound.
        for (let i = 0; i < 100; i++) cam.pan(1, -1);
        expect(cam.getTargetPosition()).toEqual([2, -2]);

        for (let i = 0; i < 200; i++) cam.pan(-1, 1);
        expect(cam.getTargetPosition()).toEqual([-2, 2]);
    });

    it('pans without bound once the clamp is removed', () => {
        const cam = camera();
        cam.setPositionClamp(null);
        for (let i = 0; i < 100; i++) cam.pan(1, 0);
        expect(cam.getTargetPosition()[0]).toBeCloseTo(10, 6);
    });

    it('re-clamps an out-of-range position when a clamp is installed', () => {
        const cam = camera();
        cam.setPositionClamp(null);
        for (let i = 0; i < 100; i++) cam.pan(1, 0);
        cam.setPositionClamp([-2, 2]);
        expect(cam.getTargetPosition()[0]).toBe(2);
    });
});

describe('Camera.zoomBy', () => {
    it('multiplies the target zoom by 1 + delta * 0.3', () => {
        const cam = camera();
        cam.zoomBy(1);
        expect(cam.getTargetZoom()).toBeCloseTo(1.3, 12);
        cam.zoomBy(1);
        expect(cam.getTargetZoom()).toBeCloseTo(1.69, 12);
        cam.zoomBy(-1);
        expect(cam.getTargetZoom()).toBeCloseTo(1.69 * 0.7, 12);
    });

    it('clamps to [0.005, 50]', () => {
        const cam = camera();
        for (let i = 0; i < 500; i++) cam.zoomBy(1);
        expect(cam.getTargetZoom()).toBe(CAMERA_DEFAULTS.maxZoom);

        for (let i = 0; i < 5000; i++) cam.zoomBy(-1);
        expect(cam.getTargetZoom()).toBe(CAMERA_DEFAULTS.minZoom);
    });

    it('ignores a change below the 0.1% relative threshold', () => {
        const cam = camera();
        // 0.001 * 0.3 = 0.0003 relative change, under the 0.001 threshold.
        cam.zoomBy(0.001);
        expect(cam.getTargetZoom()).toBe(1);

        // 0.01 * 0.3 = 0.003 relative change, over it.
        cam.zoomBy(0.01);
        expect(cam.getTargetZoom()).toBeCloseTo(1.003, 12);
    });

    it('stays responsive at extreme zoom, where the relative threshold is tiny', () => {
        const cam = camera();
        for (let i = 0; i < 5000; i++) cam.zoomBy(-1);
        expect(cam.getTargetZoom()).toBe(CAMERA_DEFAULTS.minZoom);
        cam.zoomBy(1);
        expect(cam.getTargetZoom()).toBeCloseTo(CAMERA_DEFAULTS.minZoom * 1.3, 12);
    });

    it('scales by sensitivity', () => {
        const cam = camera();
        cam.setSensitivity(2);
        cam.zoomBy(1);
        expect(cam.getTargetZoom()).toBeCloseTo(1.6, 12);
    });
});

describe('Camera.update smoothing', () => {
    it('closes smoothingFactor * dt * 60 of the gap per frame', () => {
        const cam = camera();
        cam.setPositionClamp(null);
        cam.pan(10, 0); // target x = 1.0
        cam.update(1 / 60);
        expect(cam.position[0]).toBeCloseTo(0.15, 12);
        cam.update(1 / 60);
        expect(cam.position[0]).toBeCloseTo(0.15 + 0.85 * 0.15, 12);
    });

    it('clamps the smoothing coefficient at 1 so a long frame cannot overshoot', () => {
        const cam = camera();
        cam.setPositionClamp(null);
        cam.pan(10, 0);
        // 0.15 * 10 * 60 = 90, clamped to 1 -> snaps exactly onto the target.
        cam.update(10);
        expect(cam.position[0]).toBeCloseTo(1, 12);
        expect(cam.isSettling()).toBe(false);
    });

    it('converges to the target', () => {
        const cam = camera();
        cam.pan(5, -5);
        cam.zoomBy(1);
        settle(cam);
        expect(cam.position[0]).toBeCloseTo(cam.getTargetPosition()[0], 9);
        expect(cam.position[1]).toBeCloseTo(cam.getTargetPosition()[1], 9);
        expect(cam.zoom).toBeCloseTo(cam.getTargetZoom(), 9);
        expect(cam.isSettling()).toBe(false);
    });
});

describe('Camera.reset', () => {
    it('snaps current and target back to the origin at zoom 1', () => {
        const cam = camera();
        cam.pan(7, 3);
        cam.zoomBy(2);
        settle(cam);

        cam.reset();

        expect(cam.position).toEqual([0, 0]);
        expect(cam.zoom).toBe(1);
        expect(cam.getTargetPosition()).toEqual([0, 0]);
        expect(cam.getTargetZoom()).toBe(1);
        // No glide home: reset is instantaneous in camera.rs:237.
        expect(cam.isSettling()).toBe(false);
    });
});

describe('Camera coordinate conversions', () => {
    it('maps the viewport corners and centre to the expected NDC', () => {
        const cam = camera();
        expect(cam.screenToNdc(screenCoords(0, 0))).toEqual({ x: -1, y: 1 });
        expect(cam.screenToNdc(screenCoords(WIDTH, HEIGHT))).toEqual({ x: 1, y: -1 });
        // The Y negation produces -0 at the centre; -0 renders identically and
        // compares equal under `===`, so match numerically rather than deeply.
        const centre = cam.screenToNdc(screenCoords(WIDTH / 2, HEIGHT / 2));
        expect(centre.x).toBe(0);
        expect(centre.y === 0).toBe(true);
    });

    it('flips Y — screen grows downward, NDC and world grow upward', () => {
        const cam = camera();
        const top = cam.screenToWorld(screenCoords(400, 0));
        const bottom = cam.screenToWorld(screenCoords(400, HEIGHT));
        expect(top.y).toBeGreaterThan(bottom.y);
    });

    it('screenToWorld -> worldToScreen round-trips', () => {
        const cam = camera();
        cam.pan(3, -4);
        cam.zoomBy(1);
        settle(cam);

        for (const [sx, sy] of [
            [0, 0],
            [WIDTH, HEIGHT],
            [123.5, 456.25],
            [400, 300],
            [-50, 700], // outside the viewport is still well-defined
        ]) {
            const world = cam.screenToWorld(screenCoords(sx, sy));
            const back = cam.worldToScreen(world);
            expect(back.x).toBeCloseTo(sx, 9);
            expect(back.y).toBeCloseTo(sy, 9);
        }
    });

    it('worldToScreen -> screenToWorld round-trips', () => {
        const cam = camera();
        cam.pan(-2, 6);
        cam.zoomBy(-1);
        settle(cam);

        for (const [wx, wy] of [
            [0, 0],
            [0.25, -0.75],
            [3, 5],
        ]) {
            const screen = cam.worldToScreen(worldCoords(wx, wy));
            const back = cam.screenToWorld(screen);
            expect(back.x).toBeCloseTo(wx, 9);
            expect(back.y).toBeCloseTo(wy, 9);
        }
    });

    it('ndcToWorld and worldToNdc are inverses', () => {
        const cam = camera();
        cam.pan(1, 1);
        cam.zoomBy(1);
        const world = cam.ndcToWorld(ndcCoords(0.3, -0.7));
        const ndc = cam.worldToNdc(world);
        expect(ndc.x).toBeCloseTo(0.3, 12);
        expect(ndc.y).toBeCloseTo(-0.7, 12);
    });

    it('reads target position/zoom, not the smoothed values', () => {
        const cam = camera();
        cam.pan(10, 0); // target moves; `position` is still 0
        // camera.rs:278 uses target_* deliberately, "for immediate response
        // (no smoothing lag)".
        const world = cam.screenToWorld(screenCoords(WIDTH / 2, HEIGHT / 2));
        expect(world.x).toBeCloseTo(cam.getTargetPosition()[0], 12);
        expect(cam.position[0]).toBe(0);
    });

    it('places the viewport centre exactly on the camera position', () => {
        const cam = camera();
        cam.pan(4, -3);
        const world = cam.screenToWorld(screenCoords(WIDTH / 2, HEIGHT / 2));
        expect(world.x).toBeCloseTo(cam.getTargetPosition()[0], 12);
        expect(world.y).toBeCloseTo(cam.getTargetPosition()[1], 12);
    });

    it('follows the viewport after resize', () => {
        const cam = camera();
        cam.resize(1920, 1080);
        expect(cam.aspectRatio()).toBeCloseTo(1920 / 1080, 12);
        expect(cam.screenToNdc(screenCoords(1920, 0))).toEqual({ x: 1, y: 1 });
    });
});

describe('Camera.zoomToCursor', () => {
    /**
     * The whole point of the function: whatever world point is under the
     * cursor before the wheel event is still under it afterwards.
     *
     * NOTE this fails against a literal transcription of camera.rs:206 — the
     * Rust forms the correction offset with the sign inverted, so the point
     * under the cursor drifts. See the comment on `Camera.zoomToCursor`.
     */
    for (const [label, cx, cy] of [
        ['viewport centre', 400, 300],
        ['top-left corner', 0, 0],
        ['bottom-right corner', 800, 600],
        ['off-centre', 137, 521],
    ] as const) {
        for (const delta of [1, -1, 0.5, -0.5]) {
            it(`keeps the world point under the cursor fixed (${label}, delta ${delta})`, () => {
                const cam = camera();
                cam.setPositionClamp(null); // the clamp legitimately breaks the invariant

                const before = cam.screenToWorld(screenCoords(cx, cy));
                cam.zoomToCursor(delta, cx, cy);
                const after = cam.screenToWorld(screenCoords(cx, cy));

                expect(cam.getTargetZoom()).not.toBeCloseTo(1, 6); // the zoom did happen
                expect(after.x).toBeCloseTo(before.x, 9);
                expect(after.y).toBeCloseTo(before.y, 9);
            });
        }
    }

    it('holds the invariant across a run of wheel events from an off-origin camera', () => {
        const cam = camera();
        cam.setPositionClamp(null);
        cam.pan(3, -2);
        settle(cam);

        const cx = 610;
        const cy = 95;
        for (const delta of [1, 1, -0.5, 1, -1, -1, 0.25]) {
            const before = cam.screenToWorld(screenCoords(cx, cy));
            cam.zoomToCursor(delta, cx, cy);
            const after = cam.screenToWorld(screenCoords(cx, cy));
            expect(after.x).toBeCloseTo(before.x, 9);
            expect(after.y).toBeCloseTo(before.y, 9);
        }
    });

    it('applies the same zoom step as zoomBy', () => {
        const withCursor = camera();
        const plain = camera();
        withCursor.zoomToCursor(1, 400, 300);
        plain.zoomBy(1);
        expect(withCursor.getTargetZoom()).toBeCloseTo(plain.getTargetZoom(), 12);
    });

    it('does not move the camera when the zoom is below threshold', () => {
        const cam = camera();
        cam.zoomToCursor(0.001, 0, 0);
        expect(cam.getTargetZoom()).toBe(1);
        expect(cam.getTargetPosition()).toEqual([0, 0]);
    });

    it('does not move the camera when the zoom is already clamped', () => {
        const cam = camera();
        cam.setPositionClamp(null);
        for (let i = 0; i < 500; i++) cam.zoomBy(1);
        expect(cam.getTargetZoom()).toBe(CAMERA_DEFAULTS.maxZoom);

        const positionBefore = cam.getTargetPosition();
        cam.zoomToCursor(1, 0, 0);
        expect(cam.getTargetPosition()).toEqual(positionBefore);
    });

    it('still clamps the resulting position', () => {
        const cam = camera();
        // Zoom out hard at a corner: the correction offset is large, so without
        // the clamp the camera would leave the +/-2 box.
        for (let i = 0; i < 40; i++) cam.zoomToCursor(-1, 0, 0);
        const [x, y] = cam.getTargetPosition();
        expect(x).toBeGreaterThanOrEqual(-2);
        expect(x).toBeLessThanOrEqual(2);
        expect(y).toBeGreaterThanOrEqual(-2);
        expect(y).toBeLessThanOrEqual(2);
    });

    it('survives a zero-sized viewport without producing NaN', () => {
        const cam = new Camera(0, 0);
        cam.zoomToCursor(1, 0, 0);
        expect(Number.isFinite(cam.getTargetPosition()[0])).toBe(true);
        expect(Number.isFinite(cam.getTargetPosition()[1])).toBe(true);
    });
});

describe('Camera setters', () => {
    it('clamps the smoothing factor to [0, 1]', () => {
        const cam = camera();
        cam.setSmoothingFactor(5);
        expect(cam.getSmoothingFactor()).toBe(1);
        cam.setSmoothingFactor(-1);
        expect(cam.getSmoothingFactor()).toBe(0);
    });

    it('clamps sensitivity to [0.1, 5]', () => {
        const cam = camera();
        cam.setSensitivity(99);
        expect(cam.getSensitivity()).toBe(5);
        cam.setSensitivity(0);
        expect(cam.getSensitivity()).toBe(0.1);
    });

    it('freezes the camera at smoothing factor 0', () => {
        const cam = camera();
        cam.setSmoothingFactor(0);
        cam.pan(10, 0);
        settle(cam);
        expect(cam.position[0]).toBe(0);
        expect(cam.getTargetPosition()[0]).toBeCloseTo(1, 12);
    });
});

describe('Camera uniform packing', () => {
    it('matches the WGSL CameraUniform layout', () => {
        const cam = camera();
        cam.pan(2, -4); // target x = 0.2, y = -0.4
        settle(cam);
        cam.zoomBy(1);
        settle(cam);

        const data = cam.getUniformData();
        expect(data.length).toBe(CAMERA_UNIFORM_FLOATS);
        expect(data.byteLength).toBe(80);

        const [px, py] = cam.position;
        const z = cam.zoom;

        // Column-major: scale on the diagonal, translation in the last column.
        expect(data[0]).toBeCloseTo(z, 6);
        expect(data[5]).toBeCloseTo(z, 6);
        expect(data[10]).toBe(1);
        expect(data[12]).toBeCloseTo(-px * z, 6);
        expect(data[13]).toBeCloseTo(-py * z, 6);
        expect(data[15]).toBe(1);
        // Every off-diagonal, off-translation entry stays zero.
        for (const i of [1, 2, 3, 4, 6, 7, 8, 9, 11, 14]) {
            expect(data[i]).toBe(0);
        }

        expect(data[16]).toBeCloseTo(px, 6);
        expect(data[17]).toBeCloseTo(py, 6);
        expect(data[18]).toBeCloseTo(z, 6);
        expect(data[19]).toBeCloseTo(WIDTH / HEIGHT, 6);
    });

    it('reuses a caller-supplied array', () => {
        const cam = camera();
        const out = new Float32Array(CAMERA_UNIFORM_FLOATS);
        expect(cam.getUniformData(out)).toBe(out);
        expect(out[18]).toBe(1);
    });

    it('sends the camera through the transform matrix consistently with worldToNdc', () => {
        const cam = camera();
        cam.pan(3, 2);
        cam.zoomBy(1);
        settle(cam);

        const data = cam.getUniformData();
        const world = worldCoords(0.4, -0.1);
        // clip = M * (world, 0, 1), column-major.
        const clipX = data[0] * world.x + data[12];
        const clipY = data[5] * world.y + data[13];

        const ndc = cam.worldToNdc(world);
        expect(clipX).toBeCloseTo(ndc.x, 6);
        expect(clipY).toBeCloseTo(ndc.y, 6);
    });

    it('needs no GPU device', () => {
        const cam = camera();
        expect(cam.getBuffer()).toBeNull();
        expect(() => cam.uploadToGpu(undefined as unknown as GPUQueue)).not.toThrow();
        expect(() => cam.destroy()).not.toThrow();
        expect(() => cam.destroy()).not.toThrow();
    });
});

describe('Camera.getState', () => {
    it('reports the CameraState contract from engine/types.ts', () => {
        const cam = camera();
        cam.pan(1, 1);
        settle(cam);
        const state = cam.getState();
        expect(state.position).toHaveLength(2);
        expect(state.zoom).toBeCloseTo(1, 12);
    });

    it('reports the Rust get_state JSON shape, three-element position included', () => {
        const cam = camera();
        const json = cam.getStateJson();
        // GrayScottMode.svelte:703 destructures exactly these keys.
        expect(json).toEqual({
            position: [0, 0, 0],
            zoom: 1,
            viewport_width: WIDTH,
            viewport_height: HEIGHT,
            aspect_ratio: WIDTH / HEIGHT,
        });
    });
});
