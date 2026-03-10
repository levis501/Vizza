use std::fmt::{self, Display};

use serde::{Deserialize, Serialize};

use crate::simulations::shared::{BackgroundColorMode, ImageFitMode};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    pub vector_field_type: VectorFieldType,
    pub noise_type: NoiseType,
    pub noise_seed: u32,
    pub noise_scale: f64,
    pub noise_dt_multiplier: f32,
    pub density: f32,
    pub line_length: f32,
    pub line_width: f32,
    #[serde(default)]
    pub background_color_mode: BackgroundColorMode,

    // Image-based vector field parameters
    #[serde(default)]
    pub image_fit_mode: ImageFitMode,
    #[serde(default)]
    pub image_mirror_horizontal: bool,
    #[serde(default)]
    pub image_mirror_vertical: bool,
    #[serde(default)]
    pub image_invert_tone: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            vector_field_type: VectorFieldType::Noise,
            noise_type: NoiseType::OpenSimplex,
            noise_seed: 0,
            noise_scale: 5.0,
            noise_dt_multiplier: 1.0,
            density: 0.02,
            line_length: 0.03,
            line_width: 0.001,
            background_color_mode: BackgroundColorMode::Black,
            image_fit_mode: ImageFitMode::Stretch,
            image_mirror_horizontal: false,
            image_mirror_vertical: false,
            image_invert_tone: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum VectorFieldType {
    Noise,
    Image,
}

impl Default for VectorFieldType {
    fn default() -> Self {
        Self::Noise
    }
}


#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum NoiseType {
    OpenSimplex,
    Worley,
    Value,
    Fbm,
    FBMBillow,
    FBMClouds,
    FBMRidged,
    Billow,
    RidgedMulti,
    Cylinders,
    Checkerboard,
}

impl Display for NoiseType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}",
            match self {
                Self::OpenSimplex => "OpenSimplex",
                Self::Worley => "Worley",
                Self::Value => "Value",
                Self::Fbm => "FBM",
                Self::FBMBillow => "FBM Billow",
                Self::FBMClouds => "FBM Clouds",
                Self::FBMRidged => "FBM Ridged",
                Self::Billow => "Billow",
                Self::RidgedMulti => "Ridged Multi",
                Self::Cylinders => "Cylinders",
                Self::Checkerboard => "Checkerboard",
            }
        )
    }
}

impl Default for NoiseType {
    fn default() -> Self {
        Self::OpenSimplex
    }
}