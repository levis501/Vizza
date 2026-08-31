// Vectors — the whole line field as one instanced draw.
//
// **New in the browser port. The Rust build does not reference this file**, and
// deliberately so: it is the GPU half of `update_geometry`
// (`vectors/simulation.rs:261`), which on the desktop is a CPU loop. It lives in
// the shared corpus rather than under `src/` for the single-corpus reason in
// WEB_PORT.md ("One WGSL corpus, not two") — a second tree of shaders drifts
// within weeks and destroys the ability to diff a browser bug against the
// desktop reference.
//
// ## What it replaces
//
// The desktop build samples the `noise` crate on the CPU, once per grid point,
// builds a `Vec<LineVertex>` of four vertices and six indices per line, and
// uploads both buffers — and `geometry_dirty` (`simulation.rs:393`) is true on
// every frame the clock advances, so that happens *every frame*. At the UI's
// minimum density that is 5.77 M lines, a 277 MB vertex buffer and 5.77 M CPU
// noise samples per frame (see `VECTORS_MAX_LINES` in `sims/vectors/settings.ts`).
//
// The grid is regular, so none of it needs to be in a buffer at all. One
// instance is one line; its grid position comes from `@builtin(instance_index)`,
// its angle from a noise sample taken here in the vertex stage, and its four
// corners from `@builtin(vertex_index)`. There is no vertex buffer, no index
// buffer, and nothing to rebuild when a setting or the camera changes.
//
// ## Using it
//
// This module calls `noise_sample` from `vectors/shaders/noise.wgsl`, which is a
// binding-free, entry-point-free function library. The corpus has no include
// mechanism, so **the consumer concatenates `noise.wgsl` ahead of this source**
// at module-creation time — `sims/vectors/index.ts` does, and the L3 harness
// does the same for its probes. Compiled on its own this file is an unresolved
// `noise_sample`, which is expected.
//
// `line_fragment.wgsl` is reused **verbatim** as the fragment stage: it takes
// `@location(0) value: f32` and looks the colour up in `lut_data` at
// `@group(0) @binding(1)`, which is exactly what this stage emits and what the
// pipeline layout declares. Two modules, one pipeline, as the Rust already does
// (`simulation.rs:136-148`).
//
// `line_vertex.wgsl` is *not* touched: its `VertexInput` is matched by the Rust
// pipeline's vertex-buffer layout, and changing it would break the desktop
// build.

struct CameraUniform {
    transform_matrix: mat4x4<f32>,
    position: vec2<f32>,
    zoom: f32,
    aspect_ratio: f32,
}

// One frame's worth of grid and field parameters. 48 bytes; the CPU packs it in
// `sims/vectors/index.ts`, in this order.
struct VectorFieldParams {
    // Lower-left sample point, in world space: `camera - 1.2 / zoom`
    // (`simulation.rs:266`, `275`).
    grid_min: vec2<f32>,
    // World distance between adjacent sample points, after the clamp described
    // in `vectorsGridExtent`. Never the raw `density`.
    spacing: f32,
    // Points per column. The CPU walks x outermost and y innermost
    // (`simulation.rs:284-322`), so this is the stride of the instance index.
    count_y: u32,

    line_length: f32,
    line_width: f32,
    noise_scale: f32,
    // `time * noise_dt_multiplier` (`simulation.rs:272`) — the animated third
    // noise coordinate, deliberately *not* multiplied by `noise_scale`.
    noise_time: f32,

    // `NOISE_TYPE_CODE` in `sims/vectors/settings.ts`, which is the declaration
    // order of `enum NoiseType` (`settings.rs:65`) and what `noise_sample`
    // switches on.
    noise_type: u32,
    noise_seed: u32,
    // 0 = Noise, 1 = Image (`VectorFieldType`, `settings.rs:52`).
    field_type: u32,
    // Side length of the square image field, or 0 when none is loaded — which
    // is the case the Rust answers with a neutral 0.5 (`simulation.rs:308`).
    image_size: u32,
}

const VECTORS_FIELD_TYPE_IMAGE: u32 = 1u;

// `std::f64::consts::TAU`, as f32. `simulation.rs:312` turns the sample into a
// full turn, which is why the *spread* of a noise type matters as much as its
// range: a field that uses a tenth of [0, 1] draws a comb, not a flow.
const VECTORS_TAU: f32 = 6.2831853071795864769;

@group(0) @binding(0) var<uniform> camera: CameraUniform;
// Binding 1 is `lut_data`, declared and used by `line_fragment.wgsl`. It is
// absent here because this stage never reads it, and a binding a module does
// not statically use need not appear in it.
@group(0) @binding(2) var<uniform> params: VectorFieldParams;
// The image-driven field, greyscale, already fitted/mirrored/inverted on the
// CPU exactly as `reprocess_vector_field_image` (`simulation.rs:462`) does.
// Read with `textureLoad` rather than a sampler: the Rust indexes a pixel
// (`get_pixel`, `simulation.rs:299`), and the vertex stage has no derivatives
// for an implicit-LOD sample anyway.
@group(0) @binding(3) var field_image: texture_2d<f32>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    // Consumed by `line_fragment.wgsl`'s `FragmentInput`. Constant across the
    // quad, so the interpolation mode is immaterial.
    @location(0) value: f32,
}

// -----------------------------------------------------------------------------
// The CPU/GPU mirror
//
// Each of these four is a literal port of a function in
// `sims/vectors/settings.ts` (or, for `vectors_grid_point`, of the index
// arithmetic in `sims/vectors/index.ts`). They are pure and take their inputs as
// arguments rather than reading `params`, so the L3 harness can call them
// directly from a compute probe and compare against the TypeScript — the same
// discipline `InfiniteRenderer.calculateTileCount` follows, and for the same
// reason: the CPU issues the draw and the GPU places the geometry, so a
// disagreement tears or double-draws the field with nothing to see in a log.
// -----------------------------------------------------------------------------

/// The world position of one instance's sample point.
///
/// Mirrors `vectorsGridPointAt` in `sims/vectors/index.ts`. `x` is the outer
/// loop and `y` the inner one, matching `simulation.rs:284-322`, so consecutive
/// instances walk a column.
fn vectors_grid_point(grid_min: vec2<f32>, spacing: f32, count_y: u32, instance: u32) -> vec2<f32> {
    let ix = instance / count_y;
    let iy = instance % count_y;
    return grid_min + vec2<f32>(f32(ix), f32(iy)) * spacing;
}

/// The far end of the segment. Mirrors `vectorsLineSegment` (`simulation.rs:312`).
fn vectors_line_end(p0: vec2<f32>, value: f32, line_length: f32) -> vec2<f32> {
    let angle = value * VECTORS_TAU;
    let len = line_length * (0.5 + value * 0.5);
    return p0 + vec2<f32>(cos(angle), sin(angle)) * len;
}

/// One of the quad's four corners, offset along the segment normal by half the
/// line width. Mirrors `vectorsLineQuad` (`simulation.rs:222`), including its
/// `max(1e-6)` guard against a zero-length segment, which happens whenever
/// `line_length` is 0.
///
/// Corner order is the Rust's: 0 and 1 straddle the start, 2 and 3 the end.
fn vectors_quad_corner(p0: vec2<f32>, p1: vec2<f32>, line_width: f32, corner: u32) -> vec2<f32> {
    let d = p1 - p0;
    let len = max(length(d), 1e-6);
    let normal = vec2<f32>(-d.y, d.x) / len * (line_width * 0.5);

    switch (corner) {
        case 0u: {
            return p0 - normal;
        }
        case 1u: {
            return p0 + normal;
        }
        case 2u: {
            return p1 + normal;
        }
        default: {
            return p1 - normal;
        }
    }
}

/// Which corner a vertex of the two-triangle quad refers to.
///
/// Mirrors `vectorsQuadIndices` (`simulation.rs:255`): `[0, 1, 2, 0, 2, 3]`.
/// Spelled out rather than indexed out of a `const` array because a dynamically
/// indexed const array is not portable WGSL — the same reason `noise.wgsl`
/// computes its gradient set instead of tabulating it.
fn vectors_corner_index(vertex_index: u32) -> u32 {
    switch (vertex_index) {
        case 0u, 3u: {
            return 0u;
        }
        case 1u: {
            return 1u;
        }
        case 2u, 4u: {
            return 2u;
        }
        default: {
            return 3u;
        }
    }
}

// -----------------------------------------------------------------------------
// Field sampling
// -----------------------------------------------------------------------------

/// The image-driven field, in [0, 1].
///
/// `simulation.rs:289-300`: world [-1,1]^2 maps to the image's [0,1]^2 — the
/// image covers a fixed world extent and does *not* follow the camera, so
/// panning slides the grid across a stationary picture and the clamp holds the
/// border colour outside it. Faithful, and worth knowing before anyone reports
/// it as a bug.
fn vectors_image_value(p: vec2<f32>) -> f32 {
    if (params.image_size == 0u) {
        // Image mode with no image loaded: the Rust's neutral default
        // (`simulation.rs:308`), which draws a uniform comb rather than nothing.
        return 0.5;
    }

    let tex_u = clamp((p.x + 1.0) * 0.5, 0.0, 1.0);
    let tex_v = clamp(1.0 - (p.y + 1.0) * 0.5, 0.0, 1.0);
    let last = f32(params.image_size - 1u);

    let px = i32(min(tex_u * last, last));
    let py = i32(min(tex_v * last, last));
    // r8unorm, so the texel already arrives as luminance/255.
    return textureLoad(field_image, vec2<i32>(px, py), 0).r;
}

/// The sample that becomes this line's angle, length and colour, in [0, 1].
fn vectors_field_value(p: vec2<f32>) -> f32 {
    if (params.field_type == VECTORS_FIELD_TYPE_IMAGE) {
        return vectors_image_value(p);
    }

    // `simulation.rs:304-306`: x and y are scaled world position, z is animated
    // time. `noise_sample` applies the `(v + 1) * 0.5` of `sample_cached`
    // (`noise_helper.rs:57`).
    let sample = vec3<f32>(p * params.noise_scale, params.noise_time);
    return noise_sample(params.noise_type, sample, params.noise_seed);
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

/// Draw as `draw(6, lineCount)`: six vertices per instance, one instance per
/// grid point. The CPU's instance count and this shader's index arithmetic are
/// the two halves of one contract; see the mirror section above.
@vertex
fn vs_main(
    @builtin(vertex_index) vertex_index: u32,
    @builtin(instance_index) instance_index: u32,
) -> VertexOutput {
    let p0 = vectors_grid_point(params.grid_min, params.spacing, params.count_y, instance_index);
    let value = vectors_field_value(p0);
    let p1 = vectors_line_end(p0, value, params.line_length);
    let corner = vectors_quad_corner(p0, p1, params.line_width, vectors_corner_index(vertex_index));

    var output: VertexOutput;
    // Identical to `line_vertex.wgsl:22` — the same camera transform, applied to
    // a position this stage computed rather than one read from a buffer.
    output.position = camera.transform_matrix * vec4<f32>(corner, 0.0, 1.0);
    output.value = value;
    return output;
}
