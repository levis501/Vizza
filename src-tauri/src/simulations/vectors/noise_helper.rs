use noise::{
    Billow, Checkerboard, Cylinders, Fbm, MultiFractal, NoiseFn, OpenSimplex, RidgedMulti, Seedable,
    Value, Worley,
};

use super::settings::NoiseType;

/// Build a noise generator once; reuse it for many samples instead of recreating per sample.
pub fn build_cached_generator(
    noise_type: &NoiseType,
    seed: u32,
) -> Box<dyn NoiseFn<f64, 3>> {
    let boxed: Box<dyn NoiseFn<f64, 3>> = match noise_type {
        NoiseType::OpenSimplex => Box::new(OpenSimplex::default().set_seed(seed)),
        NoiseType::Worley => Box::new(Worley::default().set_seed(seed)),
        NoiseType::Value => Box::new(Value::default().set_seed(seed)),
        NoiseType::Fbm => Box::new(
            Fbm::<OpenSimplex>::default()
                .set_seed(seed)
                .set_octaves(6),
        ),
        NoiseType::FBMBillow => Box::new(
            Billow::<OpenSimplex>::default()
                .set_seed(seed)
                .set_octaves(8),
        ),
        NoiseType::FBMClouds => Box::new(
            Fbm::<OpenSimplex>::default()
                .set_seed(seed)
                .set_octaves(4),
        ),
        NoiseType::FBMRidged => Box::new(
            RidgedMulti::<OpenSimplex>::default()
                .set_seed(seed)
                .set_octaves(10),
        ),
        NoiseType::Billow => Box::new(
            Billow::<OpenSimplex>::default()
                .set_seed(seed)
                .set_octaves(6),
        ),
        NoiseType::RidgedMulti => Box::new(
            RidgedMulti::<OpenSimplex>::default()
                .set_seed(seed)
                .set_octaves(6),
        ),
        NoiseType::Cylinders => Box::new(Cylinders::default()),
        NoiseType::Checkerboard => Box::new(Checkerboard::default()),
    };
    boxed
}

/// Sample a cached generator. Output is normalized to [0, 1].
#[inline]
pub fn sample_cached(noise: &dyn NoiseFn<f64, 3>, x: f64, y: f64, z: f64) -> f64 {
    let val = noise.get([x, y, z]);
    (val + 1.0) * 0.5
}
