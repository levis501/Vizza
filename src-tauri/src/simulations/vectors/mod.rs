mod noise_helper;
mod simulation;
mod settings;
mod state;

pub use settings::{Settings, VectorFieldType};
pub use simulation::VectorsModel;

use crate::simulation::preset_manager::{Preset, VectorsPresetManager};

pub fn init_presets(preset_manager: &mut VectorsPresetManager) {
    preset_manager.add_preset(Preset::new("Default".to_string(), Settings::default()));
    preset_manager.capture_built_in_presets();
    if let Err(e) = preset_manager.load_user_presets() {
        eprintln!("Warning: Could not load Vectors user presets: {}", e);
    }
}
