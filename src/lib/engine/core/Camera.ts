/**
 * 2D camera.
 *
 * Port of src-tauri/src/simulations/shared/camera.rs (369 ln).
 *
 * Two positions and two zooms are tracked: `target*` is what input writes and
 * what every coordinate conversion reads, `current` is the exponentially
 * smoothed value that actually reaches the GPU. Conversions deliberately read
 * the target so a click lands where the user pointed rather than where the
 * smoothing happens to be mid-flight — the Rust makes the same choice and says
 * so at camera.rs:278.
 *
 * The transform is `ndc = (world - position) * zoom`, with no aspect-ratio term.
 * NDC therefore spans [-1,1] on both axes regardless of viewport shape, which
 * means world units are non-square on a non-square viewport. That is what the
 * shaders expect (`CameraUniform.aspect_ratio` is uploaded but the matrix does
 * not use it), so it is preserved rather than "fixed".
 *
 * No GPU object is created at construction, so this module imports and
 * instantiates fine in node with no WebGPU. Call `attachToDevice()` when there
 * is a device.
 */

import type { CameraState } from '../types';
import {
    clamp,
    ndcCoords,
    screenCoords,
    worldCoords,
    type CoordinateTransform,
    type NdcCoords,
    type ScreenCoords,
    type WorldCoords,
} from './coordinates';

/** Every magic number in camera.rs, named. */
export const CAMERA_DEFAULTS = {
    /** camera.rs:104 — fraction of the remaining distance closed per 1/60 s. */
    smoothingFactor: 0.15,
    /** camera.rs:105 */
    sensitivity: 1.0,
    /** camera.rs:106 — panning is bounded to this box in world space. */
    positionClamp: [-2.0, 2.0] as [number, number],
    /** camera.rs:185 */
    minZoom: 0.005,
    /** camera.rs:185 */
    maxZoom: 50.0,
    /** camera.rs:163 — pan step is `panSpeed / zoom`, so panning slows as you zoom in. */
    panSpeed: 0.1,
    /** camera.rs:183 — one wheel notch of delta 1.0 scales zoom by 1.3. */
    zoomStep: 0.3,
    /** camera.rs:147 — smoothing is expressed per 60 Hz frame, hence the ×60. */
    smoothingReferenceHz: 60.0,
    /** camera.rs:188 — a zoom change smaller than 0.1% of current zoom is ignored. */
    zoomRelativeThreshold: 0.001,
    /** camera.rs:189 — floor on the above, so extreme zoom levels still respond. */
    zoomAbsoluteThreshold: 0.000001,
    /** camera.rs:337 */
    smoothingRange: [0.0, 1.0] as [number, number],
    /** camera.rs:357 */
    sensitivityRange: [0.1, 5.0] as [number, number],
} as const;

/** `CameraUniform` is 16 matrix floats + vec2 position + zoom + aspect = 20 floats. */
export const CAMERA_UNIFORM_FLOATS = 20;
export const CAMERA_UNIFORM_BYTES = CAMERA_UNIFORM_FLOATS * 4;

/** The shape `get_camera_state` returned from Rust (camera.rs:325). */
export interface CameraStateJson {
    /** Three elements — the Rust padded a 2D position to 3. */
    position: [number, number, number];
    zoom: number;
    viewport_width: number;
    viewport_height: number;
    aspect_ratio: number;
}

export class Camera implements CoordinateTransform {
    /** Smoothed position — what the GPU sees. */
    position: [number, number] = [0, 0];
    /** Smoothed zoom — what the GPU sees. */
    zoom = 1;

    private targetPosition: [number, number] = [0, 0];
    private targetZoom = 1;

    viewportWidth: number;
    viewportHeight: number;

    private smoothingFactor: number = CAMERA_DEFAULTS.smoothingFactor;
    private sensitivity: number = CAMERA_DEFAULTS.sensitivity;
    private positionClamp: [number, number] | null = [...CAMERA_DEFAULTS.positionClamp];

    private buffer: GPUBuffer | null = null;

    /**
     * @param viewportWidth  canvas **backing-store** width (`canvas.width`)
     * @param viewportHeight canvas **backing-store** height (`canvas.height`)
     */
    constructor(viewportWidth: number, viewportHeight: number) {
        this.viewportWidth = viewportWidth;
        this.viewportHeight = viewportHeight;
    }

    // -----------------------------------------------------------------------
    // Frame update
    // -----------------------------------------------------------------------

    /**
     * Advance the smoothing. Call once per rendered frame.
     *
     * camera.rs:145. The factor is scaled by `dt * 60` so the feel is
     * frame-rate independent, then clamped to 1 so a long frame (a backgrounded
     * tab, a stalled pipeline compile) snaps to the target instead of
     * overshooting past it and oscillating.
     */
    update(deltaTime: number): boolean {
        const smoothing = Math.min(
            this.smoothingFactor * deltaTime * CAMERA_DEFAULTS.smoothingReferenceHz,
            1.0
        );

        this.position[0] += (this.targetPosition[0] - this.position[0]) * smoothing;
        this.position[1] += (this.targetPosition[1] - this.position[1]) * smoothing;
        this.zoom += (this.targetZoom - this.zoom) * smoothing;

        return true;
    }

    /** True while the smoothed values have not yet caught up with the targets. */
    isSettling(epsilon = 1e-6): boolean {
        return (
            Math.abs(this.targetPosition[0] - this.position[0]) > epsilon ||
            Math.abs(this.targetPosition[1] - this.position[1]) > epsilon ||
            Math.abs(this.targetZoom - this.zoom) > epsilon
        );
    }

    // -----------------------------------------------------------------------
    // Input
    // -----------------------------------------------------------------------

    /**
     * Pan by a screen-space delta. camera.rs:162.
     *
     * Note the pan speed divides by the *current* (smoothed) zoom, not the
     * target. Faithful to the Rust: mid-zoom-animation pans are scaled by where
     * the animation is, not where it is going.
     */
    pan(deltaX: number, deltaY: number): void {
        const panSpeed = CAMERA_DEFAULTS.panSpeed / this.zoom;

        this.targetPosition[0] += deltaX * this.sensitivity * panSpeed;
        this.targetPosition[1] += deltaY * this.sensitivity * panSpeed;

        this.applyPositionClamp();
    }

    /**
     * Zoom about the viewport centre. camera.rs:180.
     *
     * The threshold check is not decoration: without it, a stream of tiny wheel
     * deltas would ratchet `target_zoom` by amounts too small to see while still
     * costing a uniform upload every frame. It is relative so it behaves the
     * same at zoom 0.005 as at zoom 50.
     */
    zoomBy(delta: number): void {
        const zoomFactor = 1.0 + delta * this.sensitivity * CAMERA_DEFAULTS.zoomStep;
        const newZoom = this.targetZoom * zoomFactor;
        const clampedZoom = clamp(newZoom, CAMERA_DEFAULTS.minZoom, CAMERA_DEFAULTS.maxZoom);

        const threshold = Math.max(
            this.targetZoom * CAMERA_DEFAULTS.zoomRelativeThreshold,
            CAMERA_DEFAULTS.zoomAbsoluteThreshold
        );

        if (Math.abs(clampedZoom - this.targetZoom) > threshold) {
            // The Rust saved and restored target_position around this line. That
            // was a no-op — nothing between the two touches it — so it is dropped.
            this.targetZoom = clampedZoom;
        }
    }

    /**
     * Zoom keeping the world point under the cursor stationary. camera.rs:206.
     *
     * @param cursorX canvas backing-store pixels (see `screenToWorld`)
     * @param cursorY canvas backing-store pixels
     *
     * The invariant this must hold is
     *
     *     screenToWorld(cursor)  before  ==  screenToWorld(cursor)  after
     *
     * which, since `world = ndc / zoom + position`, requires
     *
     *     position' = position + ndc * (1/zoomOld - 1/zoomNew)
     *
     * **The Rust computes this with the opposite sign** (camera.rs:223: it forms
     * `(mouse_ndc - new_ndc) / target_zoom`, which expands to
     * `ndc * (1/zoomNew - 1/zoomOld)`), so the desktop app actually pushes the
     * cursor's world point *away* under the pointer, at double the error. The
     * correct sign is used here — reproducing the bug would make the stated
     * invariant untestable and the feature wrong. Everything else about the
     * function, including doing nothing when `zoomBy` was below threshold or
     * clamped, is faithful.
     */
    zoomToCursor(delta: number, cursorX: number, cursorY: number): void {
        const oldZoom = this.targetZoom;
        this.zoomBy(delta);
        const newZoom = this.targetZoom;

        // Guard the divisions: a zero-sized viewport (canvas not laid out yet)
        // would otherwise poison target_position with NaN permanently.
        if (
            !(newZoom > 0) ||
            !(oldZoom > 0) ||
            this.viewportWidth <= 0 ||
            this.viewportHeight <= 0
        ) {
            return;
        }

        const ndc = this.screenToNdc(screenCoords(cursorX, cursorY));

        const offsetX = ndc.x * (1 / oldZoom - 1 / newZoom);
        const offsetY = ndc.y * (1 / oldZoom - 1 / newZoom);

        this.targetPosition[0] += offsetX;
        this.targetPosition[1] += offsetY;

        // camera.rs:230. Note the clamp can break the stationarity invariant at
        // the edge of the pan box; that is intended — the bound wins.
        this.applyPositionClamp();
    }

    /** camera.rs:237 — snaps both current and target, so there is no glide home. */
    reset(): void {
        this.position = [0, 0];
        this.targetPosition = [0, 0];
        this.zoom = 1;
        this.targetZoom = 1;
    }

    /**
     * camera.rs:246.
     *
     * @param width  canvas **backing-store** width (`canvas.width`)
     * @param height canvas **backing-store** height (`canvas.height`)
     */
    resize(width: number, height: number): void {
        this.viewportWidth = width;
        this.viewportHeight = height;
    }

    // -----------------------------------------------------------------------
    // Coordinate conversions — all read target position/zoom, per camera.rs:278
    // -----------------------------------------------------------------------

    /**
     * Canvas backing-store pixels -> world.
     *
     * **Input is canvas backing-store pixels** — `canvas.width`/`canvas.height`
     * space, origin at the canvas's top-left corner. It is never CSS pixels,
     * never `clientX`/`clientY`, and never `window.innerWidth`-relative. Get
     * there with `clientToCanvasPx()` from `$lib/engine/gpu/pointer`; and
     * `resize()` must be fed `canvas.width`/`canvas.height` for this to line up.
     */
    screenToWorld(screen: ScreenCoords): WorldCoords {
        const ndc = this.screenToNdc(screen);
        return this.ndcToWorld(ndc);
    }

    /** World -> canvas backing-store pixels. Exact inverse of `screenToWorld`. */
    worldToScreen(world: WorldCoords): ScreenCoords {
        return this.ndcToScreen(this.worldToNdc(world));
    }

    /** camera.rs:297. Y is flipped: screen grows downward, NDC grows upward. */
    screenToNdc(screen: ScreenCoords): NdcCoords {
        const ndcX = (screen.x / this.viewportWidth) * 2.0 - 1.0;
        const ndcY = -((screen.y / this.viewportHeight) * 2.0 - 1.0);
        return ndcCoords(ndcX, ndcY);
    }

    /** camera.rs:304. */
    ndcToScreen(ndc: NdcCoords): ScreenCoords {
        return screenCoords(
            (ndc.x + 1.0) * this.viewportWidth * 0.5,
            (-ndc.y + 1.0) * this.viewportHeight * 0.5
        );
    }

    /** camera.rs:311. */
    ndcToWorld(ndc: NdcCoords): WorldCoords {
        return worldCoords(
            ndc.x / this.targetZoom + this.targetPosition[0],
            ndc.y / this.targetZoom + this.targetPosition[1]
        );
    }

    /** camera.rs:318. Matches the transform matrix the shaders use. */
    worldToNdc(world: WorldCoords): NdcCoords {
        return ndcCoords(
            (world.x - this.targetPosition[0]) * this.targetZoom,
            (world.y - this.targetPosition[1]) * this.targetZoom
        );
    }

    // -----------------------------------------------------------------------
    // State
    // -----------------------------------------------------------------------

    /** The `CameraState` contract from engine/types.ts. Reports smoothed values. */
    getState(): CameraState {
        return { position: [this.position[0], this.position[1]], zoom: this.zoom };
    }

    /**
     * The exact JSON `get_camera_state` returned from Rust (camera.rs:325),
     * three-element position included — GrayScottMode.svelte:703 destructures
     * this shape.
     */
    getStateJson(): CameraStateJson {
        return {
            position: [this.position[0], this.position[1], 0.0],
            zoom: this.zoom,
            viewport_width: this.viewportWidth,
            viewport_height: this.viewportHeight,
            aspect_ratio: this.aspectRatio(),
        };
    }

    getTargetPosition(): [number, number] {
        return [this.targetPosition[0], this.targetPosition[1]];
    }

    getTargetZoom(): number {
        return this.targetZoom;
    }

    aspectRatio(): number {
        return this.viewportWidth / this.viewportHeight;
    }

    /** camera.rs:336. */
    setSmoothingFactor(factor: number): void {
        const [lo, hi] = CAMERA_DEFAULTS.smoothingRange;
        this.smoothingFactor = clamp(factor, lo, hi);
    }

    getSmoothingFactor(): number {
        return this.smoothingFactor;
    }

    /** camera.rs:356. */
    setSensitivity(sensitivity: number): void {
        const [lo, hi] = CAMERA_DEFAULTS.sensitivityRange;
        this.sensitivity = clamp(sensitivity, lo, hi);
    }

    getSensitivity(): number {
        return this.sensitivity;
    }

    /** camera.rs:366 — pass `null` for unbounded panning. */
    setPositionClamp(range: [number, number] | null): void {
        this.positionClamp = range === null ? null : [range[0], range[1]];
        this.applyPositionClamp();
    }

    getPositionClamp(): [number, number] | null {
        return this.positionClamp === null ? null : [this.positionClamp[0], this.positionClamp[1]];
    }

    // -----------------------------------------------------------------------
    // GPU
    // -----------------------------------------------------------------------

    /**
     * Pack `CameraUniform` (camera.rs:11): mat4x4 + vec2 position + zoom +
     * aspect_ratio = 20 floats / 80 bytes, matching the WGSL struct declared in
     * e.g. slime_mold/shaders/quad.wgsl:3.
     *
     * Derived on demand rather than cached. The Rust cached it and refreshed in
     * `update`/`reset`/`resize`, but every input is a field of this object and
     * `pan`/`zoom` only touch targets, so on-demand is equivalent with one less
     * thing to keep in sync.
     */
    getUniformData(out?: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
        const data = out ?? new Float32Array(CAMERA_UNIFORM_FLOATS);

        // Column-major orthographic transform, camera.rs:111. Scale about the
        // origin, then translate so the camera centre lands on NDC (0,0).
        data.fill(0);
        data[0] = this.zoom;
        data[5] = this.zoom;
        data[10] = 1.0;
        data[12] = -this.position[0] * this.zoom;
        data[13] = -this.position[1] * this.zoom;
        data[15] = 1.0;

        data[16] = this.position[0];
        data[17] = this.position[1];
        data[18] = this.zoom;
        data[19] = this.aspectRatio();

        return data;
    }

    /** Create the uniform buffer. Separate from the constructor so the camera is usable without a GPU. */
    attachToDevice(device: GPUDevice, label = 'Camera Uniform Buffer'): GPUBuffer {
        this.buffer?.destroy();
        this.buffer = device.createBuffer({
            label,
            size: CAMERA_UNIFORM_BYTES,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        return this.buffer;
    }

    /** camera.rs:264. No-op if no buffer has been attached. */
    uploadToGpu(queue: GPUQueue): void {
        if (!this.buffer) return;
        queue.writeBuffer(this.buffer, 0, this.getUniformData());
    }

    /** The buffer to bind, or null before `attachToDevice`. */
    getBuffer(): GPUBuffer | null {
        return this.buffer;
    }

    /** Idempotent. */
    destroy(): void {
        this.buffer?.destroy();
        this.buffer = null;
    }

    // -----------------------------------------------------------------------

    private applyPositionClamp(): void {
        if (!this.positionClamp) return;
        const [min, max] = this.positionClamp;
        this.targetPosition[0] = clamp(this.targetPosition[0], min, max);
        this.targetPosition[1] = clamp(this.targetPosition[1], min, max);
    }
}
