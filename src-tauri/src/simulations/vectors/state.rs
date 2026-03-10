#[derive(Debug)]
pub struct State {
    pub current_color_scheme: String,
    pub color_scheme_reversed: bool,
    pub gui_visible: bool,
    pub simulation_time: f32,
    pub is_running: bool,
    /// Cached for geometry dirty check (camera drives the view)
    pub last_camera_x: f32,
    pub last_camera_y: f32,
    pub last_camera_zoom: f32,
    pub last_noise_scale: f64,
}

impl Default for State {
    fn default() -> Self {
        Self {
            current_color_scheme: "MATPLOTLIB_viridis".to_string(),
            color_scheme_reversed: false,
            gui_visible: true,
            simulation_time: 0.0,
            is_running: true,
            last_camera_x: 0.0,
            last_camera_y: 0.0,
            last_camera_zoom: 1.0,
            last_noise_scale: 5.0,
        }
    }
}