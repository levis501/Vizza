// GPU noise library for the Vectors simulation.
//
// The desktop build samples the Rust `noise` crate on the CPU, one call per
// grid point, and uploads the results in a vertex buffer
// (`vectors/noise_helper.rs:55`, called from `vectors/simulation.rs:306`). The
// browser build has no `noise` crate, so the eleven generators it exposes
// (`vectors/settings.rs:65`) are re-implemented here and evaluated on the GPU.
//
// **This is a re-implementation calibrated to the crate's _character_, not to
// its output.** No permutation table, gradient set, or scaling constant is
// transcribed from `noise`, so the desktop and browser builds render *different
// fields for the same seed*. What is preserved is what the setting means: which
// type is smooth gradient noise, which is cellular, which is fractal and over
// how many octaves, and roughly how much of the output range each occupies. Bit
// parity was considered and rejected — the field is decorative, and the crate's
// tables would be a large, fragile hand-transcription with no way to verify it
// (there is no Rust toolchain in the browser build's environment).
//
// ## Using it
//
// This file declares **no bindings and no entry point** — nothing but functions
// and constants. The corpus has no include mechanism (`engine/shaders/index.ts`
// hands out whole files), so a consumer concatenates this source ahead of its
// own and calls the dispatcher:
//
//     noise_sample(noise_type, vec3<f32>(x, y, z), seed) -> f32 in [0, 1]
//
// Every identifier is prefixed `noise_` / `NOISE_` so concatenation cannot
// collide with the consuming shader.
//
// Coordinates follow the Rust: `x`/`y` are world position times `noise_scale`
// and `z` is animated time (`simulation.rs:304-306`), which is why `z` is *not*
// scaled and why the fields drift rather than scroll.
//
// ## Output ranges
//
// `noise_sample` clamps to [0, 1] after `(v + 1) * 0.5`, matching
// `sample_cached` (`noise_helper.rs:57`). The clamp is a deviation: the Rust
// leaves an out-of-range sample alone. It earns its place on the two plain-fBm
// types alone — `Fbm` and `FBMClouds`, whose tail passes ±1 on about 1% of
// samples — and the alternative there is a vertex value that indexes off the
// end of a LUT.
//
// Pre-normalisation range of each type, measured over a 64x64 grid at 0.17
// world units, seed 1234, on SwiftShader. `spread` is the width of the middle
// 90% of the *normalised* output, i.e. how much of [0, 1] the field really
// uses — the number that decides whether a type looks like a field or a comb.
//
//   type          mean     sd    [min,    max]    clipped  spread
//   OpenSimplex  -0.014  0.425  [-0.965, 0.961]     0%      0.70
//   Worley        0.025  0.340  [-0.951, 1.000]     0%      0.57
//   Value         0.016  0.361  [-0.932, 0.838]     0%      0.61
//   Fbm          -0.013  0.421  [-1.230, 1.183]   1.1%      0.70
//   FBMBillow    -0.296  0.275  [-0.951, 0.545]     0%      0.45
//   FBMClouds    -0.013  0.420  [-1.234, 1.182]   1.1%      0.69
//   FBMRidged    -0.457  0.331  [-0.998, 0.320]     0%      0.52
//   Billow       -0.296  0.278  [-0.958, 0.559]     0%      0.45
//   RidgedMulti  -0.449  0.336  [-0.998, 0.340]     0%      0.53
//   Cylinders    -0.035  0.601  [-0.990, 0.996]     0%      0.96
//   Checkerboard  0.000  1.000  {-1, +1}            0%      1.00
//
// Billow and ridged are asymmetric *by construction* — folding at zero throws
// away half the range, and that low-biased histogram with bright ridges is the
// look — so they are deliberately not re-centred. They are, however, normalised
// by a scheme that keeps their spread within a factor of 1.6 of the base
// noise's; see `noise_fbm` for why that is not the obvious division.

// Noise type codes: the declaration order of `enum NoiseType`
// (`settings.rs:65`), which is the discriminant `NoiseType as u32` produces. The
// browser's `sims/vectors/settings.ts` has to map its enum onto these same
// codes, and the L3 tests pin the pairing name by name.
const NOISE_OPEN_SIMPLEX: u32 = 0u;
const NOISE_WORLEY: u32 = 1u;
const NOISE_VALUE: u32 = 2u;
const NOISE_FBM: u32 = 3u;
const NOISE_FBM_BILLOW: u32 = 4u;
const NOISE_FBM_CLOUDS: u32 = 5u;
const NOISE_FBM_RIDGED: u32 = 6u;
const NOISE_BILLOW: u32 = 7u;
const NOISE_RIDGED_MULTI: u32 = 8u;
const NOISE_CYLINDERS: u32 = 9u;
const NOISE_CHECKERBOARD: u32 = 10u;

// Octave counts, one per fractal type, from the generator table in
// `noise_helper.rs:17-46`. Note `FBMBillow` is a `Billow` and `FBMRidged` a
// `RidgedMulti` — the `FBM` prefix in those two names is a misnomer upstream,
// so they fold and ridge exactly as their unprefixed siblings do.
const NOISE_OCTAVES_FBM: u32 = 6u;
const NOISE_OCTAVES_FBM_BILLOW: u32 = 8u;
const NOISE_OCTAVES_FBM_CLOUDS: u32 = 4u;
const NOISE_OCTAVES_FBM_RIDGED: u32 = 10u;
const NOISE_OCTAVES_BILLOW: u32 = 6u;
const NOISE_OCTAVES_RIDGED_MULTI: u32 = 6u;

// The crate's stated defaults for its multifractals. (noise 0.9's own constants
// are believed to differ — lacunarity 2*PI/3 rather than 2, and RidgedMulti
// persistence 1.0 — but the crate source is not available here to confirm, and
// 2.0/0.5 is both the textbook choice and visually indistinguishable at these
// octave counts.)
const NOISE_LACUNARITY: f32 = 2.0;
const NOISE_PERSISTENCE: f32 = 0.5;

// RidgedMulti's weight feedback: each octave is attenuated by the previous
// octave's signal, which is what concentrates detail onto the ridges instead of
// spreading it evenly the way plain fBm does.
const NOISE_RIDGED_ATTENUATION: f32 = 2.0;

// -----------------------------------------------------------------------------
// Hashing
// -----------------------------------------------------------------------------

// Integer avalanche hash, the same one the corpus already uses at
// `gray_scott/shaders/noise_seed.wgsl:18`. Integer-only on purpose: a
// sin()-based hash varies in the last bits between drivers, which would make
// the field non-reproducible across machines rather than merely different from
// the desktop's.
fn noise_hash_u32(value: u32) -> u32 {
    var x = value;
    x = ((x >> 16u) ^ x) * 0x45d9f3bu;
    x = ((x >> 16u) ^ x) * 0x45d9f3bu;
    x = (x >> 16u) ^ x;
    return x;
}

// Hashes a lattice cell. The seed is avalanched before it is mixed in so that
// adjacent seeds (which is what the octave loop below produces) give
// uncorrelated fields rather than shifted ones.
//
// The three coordinates are folded together with XOR after distinct odd
// multipliers. That admits collisions along contrived diagonals, which the
// final avalanche hides completely at this scale; the alternative — one hash
// round per axis — triples the cost of the innermost loop for no visible gain.
fn noise_hash_cell(cell: vec3<i32>, seed: u32) -> u32 {
    let x = bitcast<u32>(cell.x) * 0x9e3779b1u;
    let y = bitcast<u32>(cell.y) * 0x85ebca77u;
    let z = bitcast<u32>(cell.z) * 0xc2b2ae3du;
    let s = noise_hash_u32(seed * 0x27d4eb2fu + 0x165667b1u);
    return noise_hash_u32(x ^ y ^ z ^ s);
}

/// A hash mapped to [-1, 1].
fn noise_hash_signed(h: u32) -> f32 {
    return f32(h) * (2.0 / 4294967295.0) - 1.0;
}

// -----------------------------------------------------------------------------
// OpenSimplex — gradient noise on a simplectic lattice
// -----------------------------------------------------------------------------

// Perlin's improved-noise gradient set: the twelve midpoints of a cube's edges,
// picked by four bits of the hash. Computed rather than table-indexed because a
// dynamically indexed const array is not portable WGSL, and a `var<private>`
// table would give this library module state it otherwise has none of.
fn noise_gradient_dot(h: u32, d: vec3<f32>) -> f32 {
    let k = h & 15u;
    let u = select(d.y, d.x, k < 8u);
    var v = d.z;
    if (k < 4u) {
        v = d.y;
    } else if (k == 12u || k == 14u) {
        v = d.x;
    }
    let su = select(u, -u, (k & 1u) != 0u);
    let sv = select(v, -v, (k & 2u) != 0u);
    return su + sv;
}

// One corner's contribution, with the usual (r^2 - d.d)^4 falloff.
fn noise_simplex_corner(cell: vec3<i32>, d: vec3<f32>, seed: u32) -> f32 {
    var t = 0.6 - dot(d, d);
    if (t <= 0.0) {
        return 0.0;
    }
    t = t * t;
    return t * t * noise_gradient_dot(noise_hash_cell(cell, seed), d);
}

/// 3D simplex noise, in [-1, 1].
///
/// This stands in for the crate's `OpenSimplex`. The two are different lattices
/// — OpenSimplex was designed to remove the faint directional bias simplex has
/// — but both are gradient noise over a non-cubic lattice, so both are smooth,
/// isotropic, and free of the axis-aligned creases that give a value-noise
/// stand-in away. Simplex is chosen because it is short enough to be read and
/// checked; the visible difference between them is smaller than the difference
/// either has from value noise.
fn noise_open_simplex(p: vec3<f32>, seed: u32) -> f32 {
    let f3 = 1.0 / 3.0;
    let g3 = 1.0 / 6.0;

    // Skew into the simplectic lattice and find the containing cell.
    let skew = (p.x + p.y + p.z) * f3;
    let cell_f = floor(p + vec3<f32>(skew));
    let unskew = (cell_f.x + cell_f.y + cell_f.z) * g3;
    let d0 = p - (cell_f - vec3<f32>(unskew));

    // Rank the three coordinates to pick which of the six tetrahedra in the
    // cell the point fell into; i1 and i2 are the second and third corners.
    var i1: vec3<f32>;
    var i2: vec3<f32>;
    if (d0.x >= d0.y) {
        if (d0.y >= d0.z) {
            i1 = vec3<f32>(1.0, 0.0, 0.0);
            i2 = vec3<f32>(1.0, 1.0, 0.0);
        } else if (d0.x >= d0.z) {
            i1 = vec3<f32>(1.0, 0.0, 0.0);
            i2 = vec3<f32>(1.0, 0.0, 1.0);
        } else {
            i1 = vec3<f32>(0.0, 0.0, 1.0);
            i2 = vec3<f32>(1.0, 0.0, 1.0);
        }
    } else {
        if (d0.y < d0.z) {
            i1 = vec3<f32>(0.0, 0.0, 1.0);
            i2 = vec3<f32>(0.0, 1.0, 1.0);
        } else if (d0.x < d0.z) {
            i1 = vec3<f32>(0.0, 1.0, 0.0);
            i2 = vec3<f32>(0.0, 1.0, 1.0);
        } else {
            i1 = vec3<f32>(0.0, 1.0, 0.0);
            i2 = vec3<f32>(1.0, 1.0, 0.0);
        }
    }

    let d1 = d0 - i1 + vec3<f32>(g3);
    let d2 = d0 - i2 + vec3<f32>(2.0 * g3);
    let d3 = d0 - vec3<f32>(1.0) + vec3<f32>(3.0 * g3);

    let cell = vec3<i32>(cell_f);
    var n = noise_simplex_corner(cell, d0, seed);
    n += noise_simplex_corner(cell + vec3<i32>(i1), d1, seed);
    n += noise_simplex_corner(cell + vec3<i32>(i2), d2, seed);
    n += noise_simplex_corner(cell + vec3<i32>(1, 1, 1), d3, seed);

    // 32 is the conventional scale for the 0.6 falloff with unit-edge
    // gradients; it puts the extremes just inside ±1.
    return 32.0 * n;
}

// -----------------------------------------------------------------------------
// Value — interpolated lattice noise
// -----------------------------------------------------------------------------

fn noise_lattice_value(cell: vec3<i32>, seed: u32) -> f32 {
    return noise_hash_signed(noise_hash_cell(cell, seed));
}

/// Trilinearly interpolated lattice noise, in [-1, 1].
///
/// The interpolant is Perlin's quintic 6t^5 - 15t^4 + 10t^3, not smoothstep and
/// certainly not linear: linear interpolation leaves a visible crease on every
/// lattice plane, and smoothstep still has a discontinuous second derivative
/// there, which shows up as faint banding once the field drives line angles.
fn noise_value_3d(p: vec3<f32>, seed: u32) -> f32 {
    let cell_f = floor(p);
    let f = p - cell_f;
    let w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let c = vec3<i32>(cell_f);

    let v000 = noise_lattice_value(c + vec3<i32>(0, 0, 0), seed);
    let v100 = noise_lattice_value(c + vec3<i32>(1, 0, 0), seed);
    let v010 = noise_lattice_value(c + vec3<i32>(0, 1, 0), seed);
    let v110 = noise_lattice_value(c + vec3<i32>(1, 1, 0), seed);
    let v001 = noise_lattice_value(c + vec3<i32>(0, 0, 1), seed);
    let v101 = noise_lattice_value(c + vec3<i32>(1, 0, 1), seed);
    let v011 = noise_lattice_value(c + vec3<i32>(0, 1, 1), seed);
    let v111 = noise_lattice_value(c + vec3<i32>(1, 1, 1), seed);

    let x00 = mix(v000, v100, w.x);
    let x10 = mix(v010, v110, w.x);
    let x01 = mix(v001, v101, w.x);
    let x11 = mix(v011, v111, w.x);

    return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z);
}

// -----------------------------------------------------------------------------
// Worley — cellular / Voronoi noise
// -----------------------------------------------------------------------------

/// F1 cellular noise: the distance to the nearest of one feature point per unit
/// cell, in [-1, 1].
///
/// The crate's `Worley::default()` may return the nearest point's *value*
/// rather than its distance, which would give flat-shaded Voronoi cells instead
/// of distance ramps. Distance is implemented deliberately: it is what the
/// milestone asks for, it reads as cellular either way, and a field of constant
/// per-cell angles makes a markedly duller vector field.
fn noise_worley(p: vec3<f32>, seed: u32) -> f32 {
    let base = floor(p);
    var closest = 1.0e9;

    for (var dz = -1; dz <= 1; dz++) {
        for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
                let cell_f = base + vec3<f32>(f32(dx), f32(dy), f32(dz));
                let h = noise_hash_cell(vec3<i32>(cell_f), seed);
                // Three independent 10-bit fields of one avalanched hash place
                // the feature point anywhere in its cell.
                let jitter = vec3<f32>(
                    f32(h & 0x3ffu),
                    f32((h >> 10u) & 0x3ffu),
                    f32((h >> 20u) & 0x3ffu)
                ) * (1.0 / 1023.0);
                let diff = cell_f + jitter - p;
                closest = min(closest, dot(diff, diff));
            }
        }
    }

    // F1 over a unit lattice runs 0..~1.2 and averages near 0.55, so doubling
    // and centring uses the range; the tail past 1 is clipped rather than
    // compressing every mid-tone to fit a handful of cell corners.
    return clamp(sqrt(closest) * 2.0 - 1.0, -1.0, 1.0);
}

// -----------------------------------------------------------------------------
// Fractal constructions
// -----------------------------------------------------------------------------

/// Octave-summed simplex noise (fBm), in [-1, 1].
///
/// Normalised by sqrt(sum of amplitude^2) rather than by the sum of amplitudes.
/// Octaves are independent, so their variances add: dividing by the root of the
/// summed squares leaves the result with the same spread as a single octave
/// (measured sd 0.421 against OpenSimplex's 0.425), while dividing by the
/// summed amplitudes — 1.97 for six octaves against 1.15 — would shrink it by
/// 42% and hand the simulation a visibly flatter field than the base noise it
/// is built from, for no reason a viewer could name. The cost is a tail past
/// ±1 on ~1% of samples, which `noise_sample` clamps.
fn noise_fbm(p: vec3<f32>, seed: u32, octaves: u32) -> f32 {
    var sum = 0.0;
    var amplitude = 1.0;
    var frequency = 1.0;
    var power = 0.0;

    for (var i = 0u; i < octaves; i++) {
        sum += amplitude * noise_open_simplex(p * frequency, seed + i);
        power += amplitude * amplitude;
        frequency *= NOISE_LACUNARITY;
        amplitude *= NOISE_PERSISTENCE;
    }

    return sum * inverseSqrt(power);
}

/// Billow: fBm over |n| folded back to [-1, 1] per octave, giving the puffy,
/// low-biased field the name describes. In [-1, 1].
///
/// Normalised by the summed amplitudes here, unlike `noise_fbm`: each octave's
/// signal is already bounded in [-1, 1] and, crucially, is *not* zero-mean, so
/// the variance argument does not apply and the amplitude sum is what keeps the
/// result in range without clipping the dark majority of the field.
fn noise_billow(p: vec3<f32>, seed: u32, octaves: u32) -> f32 {
    var sum = 0.0;
    var amplitude = 1.0;
    var frequency = 1.0;
    var total = 0.0;

    for (var i = 0u; i < octaves; i++) {
        let n = noise_open_simplex(p * frequency, seed + i);
        sum += amplitude * (2.0 * abs(n) - 1.0);
        total += amplitude;
        frequency *= NOISE_LACUNARITY;
        amplitude *= NOISE_PERSISTENCE;
    }

    return sum / total;
}

/// Ridged multifractal: 1 - |n|, squared for sharpness, with each octave
/// weighted by the previous octave's signal. In [-1, 1].
///
/// The weight feedback is the whole point of the construction — it suppresses
/// detail in the valleys and keeps it on the ridges — so it is reproduced here
/// even though the rest of the fractal machinery is generic.
fn noise_ridged(p: vec3<f32>, seed: u32, octaves: u32) -> f32 {
    var sum = 0.0;
    var amplitude = 1.0;
    var frequency = 1.0;
    var total = 0.0;
    var weight = 1.0;

    for (var i = 0u; i < octaves; i++) {
        var signal = 1.0 - abs(noise_open_simplex(p * frequency, seed + i));
        signal *= signal;
        signal *= weight;
        weight = clamp(signal / NOISE_RIDGED_ATTENUATION, 0.0, 1.0);

        sum += amplitude * signal;
        total += amplitude;
        frequency *= NOISE_LACUNARITY;
        amplitude *= NOISE_PERSISTENCE;
    }

    // Every signal is in [0, 1], so sum/total is too; centre it like the rest.
    return (sum / total) * 2.0 - 1.0;
}

// -----------------------------------------------------------------------------
// Analytic types
// -----------------------------------------------------------------------------

/// Concentric unit cylinders about the y axis, in [-1, 1]. Exact.
///
/// Distance is taken in the xz plane, as the crate does, which means that with
/// the Vectors sim feeding z = time the pattern reads on screen as bands in x
/// that breathe as time advances, rather than as rings. That is inherited
/// behaviour, not a port artefact.
fn noise_cylinders(p: vec3<f32>) -> f32 {
    let r = length(vec2<f32>(p.x, p.z));
    let inner = r - floor(r);
    let nearest = min(inner, 1.0 - inner);
    return 1.0 - nearest * 4.0;
}

/// 3D checkerboard of unit cells, alternating -1 / +1. Exact.
///
/// The crate casts each floored coordinate to an unsigned integer before
/// XOR-folding, which saturates negatives to zero and makes its pattern
/// degenerate for x < 0 or y < 0. Deliberately not reproduced: the Vectors grid
/// is centred on the origin, so half of it would be a flat field.
fn noise_checkerboard(p: vec3<f32>) -> f32 {
    let c = vec3<i32>(floor(p));
    let parity = (c.x ^ c.y ^ c.z) & 1;
    return select(1.0, -1.0, parity != 0);
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------

/// Samples one of the eleven types, in [-1, 1] — the range before the
/// normalisation `sample_cached` applies.
fn noise_sample_signed(noise_type: u32, p: vec3<f32>, seed: u32) -> f32 {
    switch (noise_type) {
        case 0u: {
            return noise_open_simplex(p, seed);
        }
        case 1u: {
            return noise_worley(p, seed);
        }
        case 2u: {
            return noise_value_3d(p, seed);
        }
        case 3u: {
            return noise_fbm(p, seed, NOISE_OCTAVES_FBM);
        }
        case 4u: {
            return noise_billow(p, seed, NOISE_OCTAVES_FBM_BILLOW);
        }
        case 5u: {
            return noise_fbm(p, seed, NOISE_OCTAVES_FBM_CLOUDS);
        }
        case 6u: {
            return noise_ridged(p, seed, NOISE_OCTAVES_FBM_RIDGED);
        }
        case 7u: {
            return noise_billow(p, seed, NOISE_OCTAVES_BILLOW);
        }
        case 8u: {
            return noise_ridged(p, seed, NOISE_OCTAVES_RIDGED_MULTI);
        }
        case 9u: {
            return noise_cylinders(p);
        }
        case 10u: {
            return noise_checkerboard(p);
        }
        // An unknown code means the settings enum and these constants have
        // drifted apart; fall back to the default type (`settings.rs:101`)
        // rather than to a flat field, which would look like a dead shader.
        default: {
            return noise_open_simplex(p, seed);
        }
    }
}

/// Samples one of the eleven types, normalised to [0, 1] exactly as
/// `sample_cached` does (`noise_helper.rs:57`), plus a clamp — see the header.
fn noise_sample(noise_type: u32, p: vec3<f32>, seed: u32) -> f32 {
    return clamp((noise_sample_signed(noise_type, p, seed) + 1.0) * 0.5, 0.0, 1.0);
}
