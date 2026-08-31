/**
 * Strongly-typed 2D coordinate spaces.
 *
 * Port of src-tauri/src/simulations/shared/coordinates.rs (142 ln).
 *
 * The Rust used four distinct structs so a screen coordinate could never be
 * silently passed where a world coordinate was expected. TypeScript's structural
 * typing would collapse four `{ x, y }` interfaces into one, so the spaces are
 * kept apart with a phantom brand: the brand property exists only in the type,
 * never at runtime, which keeps the values plain `{ x, y }` objects for
 * `JSON.stringify`, destructuring, and buffer packing.
 *
 * Mixing spaces is exactly the bug class this port is most exposed to — see
 * WEB_PORT.md "The mouse-coordinate fix", where ~21 call sites feed the wrong
 * space into the camera.
 */

declare const coordinateSpace: unique symbol;

/** A point tagged with the space it lives in. The tag is compile-time only. */
export interface Coords<Space extends string> {
    readonly x: number;
    readonly y: number;
    /** Phantom — never present at runtime. */
    readonly [coordinateSpace]: Space;
}

/**
 * Pixels in the canvas **backing store** (i.e. `canvas.width`/`canvas.height`),
 * origin top-left, Y increasing downward.
 *
 * These are NOT CSS pixels and NOT `clientX`/`clientY`. Use
 * `clientToCanvasPx()` from `$lib/engine/gpu/pointer` to get here from a DOM
 * event.
 */
export type ScreenCoords = Coords<'screen'>;

/** Simulation world space. The camera maps NDC into it. */
export type WorldCoords = Coords<'world'>;

/** Normalized device coordinates: [-1,1] on both axes, Y increasing upward. */
export type NdcCoords = Coords<'ndc'>;

/** Texture space: [0,1] on both axes. */
export type TextureCoords = Coords<'texture'>;

// The brand is erased, so every constructor is a cast over a plain object.
// Written out per space rather than generically so call sites read as the Rust
// did (`ScreenCoords::new(x, y)`).

export function screenCoords(x: number, y: number): ScreenCoords {
    return { x, y } as ScreenCoords;
}

export function worldCoords(x: number, y: number): WorldCoords {
    return { x, y } as WorldCoords;
}

export function ndcCoords(x: number, y: number): NdcCoords {
    return { x, y } as NdcCoords;
}

export function textureCoords(x: number, y: number): TextureCoords {
    return { x, y } as TextureCoords;
}

/** Mirrors `*::to_array`. Handy for uniform packing. */
export function toArray(coords: Coords<string>): [number, number] {
    return [coords.x, coords.y];
}

export function screenFromArray(coords: readonly [number, number]): ScreenCoords {
    return screenCoords(coords[0], coords[1]);
}

export function worldFromArray(coords: readonly [number, number]): WorldCoords {
    return worldCoords(coords[0], coords[1]);
}

export function ndcFromArray(coords: readonly [number, number]): NdcCoords {
    return ndcCoords(coords[0], coords[1]);
}

export function textureFromArray(coords: readonly [number, number]): TextureCoords {
    return textureCoords(coords[0], coords[1]);
}

/** Mirrors `TextureCoords::clamp` — clamp into the valid [0,1] range. */
export function clampTextureCoords(coords: TextureCoords): TextureCoords {
    return textureCoords(clamp(coords.x, 0, 1), clamp(coords.y, 0, 1));
}

/** Mirrors `TextureCoords::is_valid`. */
export function isValidTextureCoords(coords: TextureCoords): boolean {
    return coords.x >= 0 && coords.x <= 1 && coords.y >= 0 && coords.y <= 1;
}

/**
 * Mirrors `WorldCoords::to_texture_coords`.
 *
 * No Y flip: the camera's screen->world conversion already flipped Y, so
 * flipping again here would undo it. The Rust carries the same comment.
 */
export function worldToTextureCoords(world: WorldCoords): TextureCoords {
    return textureCoords(world.x, world.y);
}

/** Mirrors `TextureCoords::to_world_coords`. Also no Y flip, for the same reason. */
export function textureToWorldCoords(texture: TextureCoords): WorldCoords {
    return worldCoords(texture.x, texture.y);
}

/**
 * Mirrors the Rust `CoordinateTransform` trait. `Camera` implements it.
 *
 * Note every method here consumes and produces branded coordinates, so a
 * caller cannot pass raw client pixels by accident.
 */
export interface CoordinateTransform {
    screenToWorld(screen: ScreenCoords): WorldCoords;
    worldToScreen(world: WorldCoords): ScreenCoords;
    screenToNdc(screen: ScreenCoords): NdcCoords;
    ndcToWorld(ndc: NdcCoords): WorldCoords;
    worldToNdc(world: WorldCoords): NdcCoords;
}

/** `f32::clamp` semantics, minus the NaN panic. */
export function clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
}
