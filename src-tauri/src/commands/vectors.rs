use crate::simulation::SimulationManager;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn set_vectors_vector_field_type(
    manager: State<'_, Arc<tokio::sync::Mutex<SimulationManager>>>,
    vector_field_type: String,
) -> Result<String, String> {
    let mut sim_manager = manager.lock().await;
    let sim = sim_manager.vectors_simulation_mut()?;
    sim.settings.vector_field_type = match vector_field_type.as_str() {
        "Noise" | "noise" => {
            sim.stop_webcam_capture();
            crate::simulations::vectors::VectorFieldType::Noise
        }
        "Image" | "image" => crate::simulations::vectors::VectorFieldType::Image,
        _ => return Err("Invalid vector field type. Must be 'Noise' or 'Image'".to_string()),
    };
    Ok("Vector field type updated successfully".to_string())
}

#[tauri::command]
pub async fn set_vectors_image_fit_mode(
    manager: State<'_, Arc<tokio::sync::Mutex<SimulationManager>>>,
    fit_mode: String,
) -> Result<String, String> {
    let mut sim_manager = manager.lock().await;

    let sim = sim_manager.vectors_simulation_mut()?;
    sim.settings.image_fit_mode = match fit_mode.parse::<crate::simulations::shared::ImageFitMode>()
    {
        Ok(m) => m,
        Err(_) => {
            return Err(
                "Invalid fit mode. Must be 'Stretch', 'Center', 'Fit H', or 'Fit V'".to_string(),
            );
        }
    };

    if sim.settings.vector_field_type == crate::simulations::vectors::VectorFieldType::Image
        && sim.has_loaded_image()
    {
        sim.reprocess_vector_field_image()
            .map_err(|e| format!("Failed to reprocess image: {}", e))?;
    }

    Ok("Image fit mode updated successfully".to_string())
}

#[tauri::command]
pub async fn set_vectors_image_mirror_horizontal(
    manager: State<'_, Arc<tokio::sync::Mutex<SimulationManager>>>,
    mirror: bool,
) -> Result<String, String> {
    let mut sim_manager = manager.lock().await;

    let sim = sim_manager.vectors_simulation_mut()?;
    sim.settings.image_mirror_horizontal = mirror;

    if sim.settings.vector_field_type == crate::simulations::vectors::VectorFieldType::Image
        && sim.has_loaded_image()
    {
        sim.reprocess_vector_field_image()
            .map_err(|e| format!("Failed to reprocess image: {}", e))?;
    }

    Ok("Image mirror horizontal setting updated successfully".to_string())
}

#[tauri::command]
pub async fn set_vectors_image_mirror_vertical(
    manager: State<'_, Arc<tokio::sync::Mutex<SimulationManager>>>,
    mirror: bool,
) -> Result<String, String> {
    let mut sim_manager = manager.lock().await;

    let sim = sim_manager.vectors_simulation_mut()?;
    sim.settings.image_mirror_vertical = mirror;

    if sim.settings.vector_field_type == crate::simulations::vectors::VectorFieldType::Image
        && sim.has_loaded_image()
    {
        sim.reprocess_vector_field_image()
            .map_err(|e| format!("Failed to reprocess image: {}", e))?;
    }

    Ok("Image mirror vertical setting updated successfully".to_string())
}

#[tauri::command]
pub async fn set_vectors_image_invert_tone(
    manager: State<'_, Arc<tokio::sync::Mutex<SimulationManager>>>,
    invert: bool,
) -> Result<String, String> {
    let mut sim_manager = manager.lock().await;

    let sim = sim_manager.vectors_simulation_mut()?;
    sim.settings.image_invert_tone = invert;

    if sim.settings.vector_field_type == crate::simulations::vectors::VectorFieldType::Image
        && sim.has_loaded_image()
    {
        sim.reprocess_vector_field_image()
            .map_err(|e| format!("Failed to reprocess image: {}", e))?;
    }

    Ok("Image invert tone setting updated successfully".to_string())
}

#[tauri::command]
pub async fn load_vectors_vector_field_image(
    manager: State<'_, Arc<tokio::sync::Mutex<SimulationManager>>>,
    image_path: String,
) -> Result<String, String> {
    let mut sim_manager = manager.lock().await;

    let sim = sim_manager.vectors_simulation_mut()?;
    sim.load_vector_field_image_from_path(&image_path)
        .map_err(|e| format!("Failed to load vector field image: {}", e))?;

    sim.settings.vector_field_type = crate::simulations::vectors::VectorFieldType::Image;

    Ok("Vector field image loaded and applied successfully".to_string())
}

#[tauri::command]
pub async fn load_vectors_vector_field_image_bytes(
    manager: State<'_, Arc<tokio::sync::Mutex<SimulationManager>>>,
    data: Vec<u8>,
) -> Result<String, String> {
    let mut sim_manager = manager.lock().await;

    let sim = sim_manager.vectors_simulation_mut()?;
    let img = image::load_from_memory(&data)
        .map_err(|e| format!("Failed to decode image bytes: {}", e))?;

    sim.load_vector_field_image_from_data(img)
        .map_err(|e| format!("Failed to load vector field image: {}", e))?;

    sim.settings.vector_field_type = crate::simulations::vectors::VectorFieldType::Image;

    Ok("Vector field image loaded from bytes and applied successfully".to_string())
}

#[tauri::command]
pub async fn start_vectors_webcam_capture(
    manager: State<'_, Arc<tokio::sync::Mutex<SimulationManager>>>,
) -> Result<String, String> {
    let mut sim_manager = manager.lock().await;
    let sim = sim_manager.vectors_simulation_mut()?;
    let devices = sim.get_available_webcam_devices();
    if devices.is_empty() {
        return Err("No webcam devices available".to_string());
    }
    sim.start_webcam_capture(devices[0])
        .map_err(|e| e.to_string())?;
    Ok("Vectors webcam started".to_string())
}

#[tauri::command]
pub async fn stop_vectors_webcam_capture(
    manager: State<'_, Arc<tokio::sync::Mutex<SimulationManager>>>,
) -> Result<String, String> {
    let mut sim_manager = manager.lock().await;
    let sim = sim_manager.vectors_simulation_mut()?;
    sim.stop_webcam_capture();
    Ok("Vectors webcam stopped".to_string())
}

#[tauri::command]
pub async fn get_available_vectors_webcam_devices(
    manager: State<'_, Arc<tokio::sync::Mutex<SimulationManager>>>,
) -> Result<Vec<i32>, String> {
    let sim_manager = manager.lock().await;
    let sim = sim_manager.vectors_simulation()?;
    Ok(sim.get_available_webcam_devices())
}
