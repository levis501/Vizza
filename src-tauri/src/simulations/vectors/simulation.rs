//! Vectors simulation - noise-based vector field visualization.
//!
//! Renders lines on a grid where direction and length come from a noise field.
//! Zoom changes line density; pan moves the noise field origin.
//! Line colors come from LUT lookup based on noise value.

use std::f64::consts::TAU;
use std::sync::Arc;

use bytemuck::{Pod, Zeroable};
use wgpu::util::DeviceExt;
use wgpu::{
    BindGroup, Buffer, Device, PipelineLayoutDescriptor, Queue,
    RenderPipeline, RenderPipelineDescriptor, ShaderStages, SurfaceConfiguration, TextureView,
    VertexBufferLayout, VertexState,
};

use crate::commands::AppSettings;
use crate::error::SimulationResult;
use crate::simulations::shared::camera::Camera;
use crate::simulations::shared::gpu_utils::resource_helpers;
use crate::simulations::shared::{BackgroundColorMode, ColorSchemeManager, ImageFitMode};
use crate::simulations::traits::Simulation;

use super::noise_helper::{build_cached_generator, sample_cached};
use super::settings::{Settings, VectorFieldType};
use super::state::State;

/// Resolution of the vector field image (used for both loaded images and webcam)
const VECTOR_IMAGE_RESOLUTION: u32 = 512;

#[repr(C)]
#[derive(Copy, Clone, Debug, Pod, Zeroable)]
struct LineVertex {
    position: [f32; 2],
    value: f32, // Noise value [0,1] for LUT lookup
}

impl LineVertex {
    const ATTRS: [wgpu::VertexAttribute; 2] =
        wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32];
}

#[derive(Debug)]
pub struct VectorsModel {
    pub settings: Settings,
    pub state: State,
    pub camera: Camera,

    vertex_buffer: Buffer,
    index_buffer: Buffer,
    index_count: u32,
    index_format: wgpu::IndexFormat,

    pipeline: RenderPipeline,
    camera_bind_group: BindGroup,

    pub lut_buffer: Buffer,
    color_scheme_manager: Arc<ColorSchemeManager>,

    last_time: f32,
    time: f32,
    _app_settings: AppSettings,

    // Image-based vector field support
    vector_field_image: Option<image::GrayImage>,
    vector_field_image_original: Option<image::DynamicImage>,
    webcam_capture: crate::simulations::shared::WebcamCapture,
}

impl VectorsModel {
    pub fn new(
        device: &Arc<Device>,
        queue: &Arc<Queue>,
        surface_config: &SurfaceConfiguration,
        settings: Settings,
        app_settings: &AppSettings,
        color_scheme_manager: &ColorSchemeManager,
    ) -> SimulationResult<Self> {
        let mut camera = Camera::new(
            device,
            surface_config.width as f32,
            surface_config.height as f32,
        )?;
        camera.set_position_clamp(None); // Unbounded panning for infinite noise field

        let vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Vectors vertex buffer"),
            size: 1024 * 1024,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let index_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Vectors index buffer"),
            size: 2 * 1024 * 1024,
            usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });

        let state = State::default();
        let lut_data = color_scheme_manager
            .get(&state.current_color_scheme)
            .unwrap_or_else(|_| color_scheme_manager.get_default());
        let lut_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Vectors LUT buffer"),
            contents: bytemuck::cast_slice(&lut_data.to_u32_buffer()),
            usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
        });

        let camera_bind_group_layout = device.create_bind_group_layout(
            &wgpu::BindGroupLayoutDescriptor {
                label: Some("Vectors bind group layout"),
                entries: &[
                    resource_helpers::uniform_buffer_entry(0, ShaderStages::VERTEX),
                    resource_helpers::storage_buffer_entry(1, ShaderStages::FRAGMENT, true),
                ],
            },
        );

        let camera_bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Vectors bind group"),
            layout: &camera_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: camera.buffer().as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: lut_buffer.as_entire_binding(),
                },
            ],
        });

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Vectors line shader"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("shaders/line_vertex.wgsl").into(),
            ),
        });

        let fragment_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Vectors line fragment shader"),
            source: wgpu::ShaderSource::Wgsl(
                include_str!("shaders/line_fragment.wgsl").into(),
            ),
        });

        let pipeline_layout = device.create_pipeline_layout(&PipelineLayoutDescriptor {
            label: Some("Vectors pipeline layout"),
            bind_group_layouts: &[&camera_bind_group_layout],
            push_constant_ranges: &[],
        });

        let pipeline = device.create_render_pipeline(&RenderPipelineDescriptor {
            label: Some("Vectors line pipeline"),
            layout: Some(&pipeline_layout),
            vertex: VertexState {
                module: &shader,
                entry_point: Some("main"),
                buffers: &[VertexBufferLayout {
                    array_stride: std::mem::size_of::<LineVertex>() as u64,
                    step_mode: wgpu::VertexStepMode::Vertex,
                    attributes: &LineVertex::ATTRS,
                }],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &fragment_shader,
                entry_point: Some("main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_config.format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let mut webcam_capture = crate::simulations::shared::WebcamCapture::new();
        webcam_capture.set_target_dimensions(VECTOR_IMAGE_RESOLUTION, VECTOR_IMAGE_RESOLUTION);

        let mut model = Self {
            settings,
            state,
            camera,
            vertex_buffer,
            index_buffer,
            index_count: 0,
            index_format: wgpu::IndexFormat::Uint32,
            pipeline,
            camera_bind_group,
            lut_buffer,
            color_scheme_manager: Arc::new(color_scheme_manager.clone()),
            last_time: f32::NEG_INFINITY,
            time: 0.0,
            _app_settings: app_settings.clone(),
            vector_field_image: None,
            vector_field_image_original: None,
            webcam_capture,
        };

        model.update_geometry(device, queue)?;
        Ok(model)
    }

    /// Build quads from segments (x0, y0, x1, y1, value); each line becomes a quad for LUT-colored rendering.
    fn build_quads_from_segments(
        segments: &[(f32, f32, f32, f32, f32)],
        line_width: f32,
    ) -> (Vec<LineVertex>, Vec<u32>) {
        let mut vertices = Vec::with_capacity(segments.len() * 4);
        let mut indices = Vec::with_capacity(segments.len() * 6);

        for (i, &(x0, y0, x1, y1, value)) in segments.iter().enumerate() {
            let dx = x1 - x0;
            let dy = y1 - y0;
            let len = (dx * dx + dy * dy).sqrt().max(1e-6);
            let px = -dy / len * (line_width * 0.5);
            let py = dx / len * (line_width * 0.5);

            let v0 = LineVertex {
                position: [x0 - px, y0 - py],
                value,
            };
            let v1 = LineVertex {
                position: [x0 + px, y0 + py],
                value,
            };
            let v2 = LineVertex {
                position: [x1 + px, y1 + py],
                value,
            };
            let v3 = LineVertex {
                position: [x1 - px, y1 - py],
                value,
            };

            let base = (i * 4) as u32;
            vertices.extend([v0, v1, v2, v3]);
            indices.extend([base, base + 1, base + 2, base, base + 2, base + 3]);
        }

        (vertices, indices)
    }

    fn update_geometry(&mut self, device: &Arc<Device>, queue: &Arc<Queue>) -> SimulationResult<()> {
        // View extent from camera position and zoom
        let cx = self.camera.position[0] as f64;
        let cy = self.camera.position[1] as f64;
        let zoom = self.camera.zoom as f64;
        let half_span = 1.2 / zoom; // Visible extent with margin

        let density = self.settings.density as f64;
        let line_length = self.settings.line_length as f64;
        let noise_scale = self.settings.noise_scale;
        let seed = self.settings.noise_seed;
        let time = self.time as f64 * self.settings.noise_dt_multiplier as f64;

        let spacing = density.max(0.001);
        let min_x = cx - half_span;
        let max_x = cx + half_span;
        let min_y = cy - half_span;
        let max_y = cy + half_span;

        let noise_gen = matches!(self.settings.vector_field_type, VectorFieldType::Noise)
            .then(|| build_cached_generator(&self.settings.noise_type, seed));

        let mut segments: Vec<(f32, f32, f32, f32, f32)> = Vec::new();
        let mut x = min_x;
        while x <= max_x {
            let mut y = min_y;
            while y <= max_y {
                let angle_val = match (&self.settings.vector_field_type, &self.vector_field_image) {
                    (VectorFieldType::Image, Some(img)) => {
                        // Map world [-1,1]^2 to image [0,1]^2 (image covers fixed world extent)
                        let tex_u = ((x + 1.0) * 0.5).clamp(0.0, 1.0);
                        let tex_v = (1.0 - (y + 1.0) * 0.5).clamp(0.0, 1.0);
                        let w = img.width() as f64;
                        let h = img.height() as f64;
                        let px = (tex_u * (w - 1.0).max(0.0)) as u32;
                        let py = (tex_v * (h - 1.0).max(0.0)) as u32;
                        let px = px.min(img.width().saturating_sub(1));
                        let py = py.min(img.height().saturating_sub(1));
                        let lum = img.get_pixel(px, py).0[0];
                        lum as f64 / 255.0
                    }
                    _ => {
                        if let Some(ng) = &noise_gen {
                            let sample_x = x * noise_scale;
                            let sample_y = y * noise_scale;
                            sample_cached(ng.as_ref(), sample_x, sample_y, time)
                        } else {
                            0.5 // Image mode but no image loaded: neutral default
                        }
                    }
                };
                let angle = angle_val * TAU;
                let len = line_length * (0.5 + angle_val * 0.5);
                let dx = angle.cos() * len;
                let dy = angle.sin() * len;
                let x_f = x as f32;
                let y_f = y as f32;
                segments.push((x_f, y_f, x_f + dx as f32, y_f + dy as f32, angle_val as f32));
                y += spacing;
            }
            x += spacing;
        }

        if segments.is_empty() {
            self.index_count = 0;
            self.state.last_camera_x = self.camera.position[0];
            self.state.last_camera_y = self.camera.position[1];
            self.state.last_camera_zoom = self.camera.zoom;
            self.state.last_noise_scale = noise_scale;
            return Ok(());
        }

        let (all_vertices, all_indices) =
            Self::build_quads_from_segments(&segments, self.settings.line_width);

        let vb_size = (all_vertices.len() * std::mem::size_of::<LineVertex>()) as u64;
        let ib_size = (all_indices.len() * std::mem::size_of::<u32>()) as u64;

        if vb_size > self.vertex_buffer.size() || ib_size > self.index_buffer.size() {
            self.vertex_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Vectors vertex buffer"),
                size: vb_size.max(self.vertex_buffer.size() * 2),
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.index_buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("Vectors index buffer"),
                size: ib_size.max(self.index_buffer.size() * 2),
                usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
        }

        queue.write_buffer(&self.vertex_buffer, 0, bytemuck::cast_slice(&all_vertices));
        queue.write_buffer(&self.index_buffer, 0, bytemuck::cast_slice(&all_indices));
        self.index_count = all_indices.len() as u32;
        self.index_format = wgpu::IndexFormat::Uint32;

        self.state.last_camera_x = self.camera.position[0];
        self.state.last_camera_y = self.camera.position[1];
        self.state.last_camera_zoom = self.camera.zoom;
        self.state.last_noise_scale = noise_scale;
        self.last_time = self.time;
        Ok(())
    }

    fn get_clear_color(&self) -> wgpu::Color {
        match self.settings.background_color_mode {
            BackgroundColorMode::Black => wgpu::Color::BLACK,
            BackgroundColorMode::White => wgpu::Color::WHITE,
            BackgroundColorMode::Gray18 => wgpu::Color {
                r: 0.18,
                g: 0.18,
                b: 0.18,
                a: 1.0,
            },
            BackgroundColorMode::ColorScheme => {
                self.color_scheme_manager
                    .get(&self.state.current_color_scheme)
                    .ok()
                    .and_then(|lut| lut.get_first_color())
                    .map(|v| wgpu::Color {
                        r: v.get(0).copied().unwrap_or(0.0) as f64,
                        g: v.get(1).copied().unwrap_or(0.0) as f64,
                        b: v.get(2).copied().unwrap_or(0.0) as f64,
                        a: 1.0,
                    })
                    .unwrap_or(wgpu::Color::BLACK)
            }
        }
    }

    fn geometry_dirty(&self) -> bool {
        self.webcam_capture.is_active
            || self.time != self.last_time
            || (self.camera.position[0] - self.state.last_camera_x).abs() > 1e-6
            || (self.camera.position[1] - self.state.last_camera_y).abs() > 1e-6
            || (self.camera.zoom - self.state.last_camera_zoom).abs() > 1e-6
            || (self.settings.noise_scale - self.state.last_noise_scale).abs() > 1e-9
    }
}

impl VectorsModel {
    /// Update vector field image from latest webcam frame
    fn update_vector_field_from_webcam(&mut self) -> SimulationResult<()> {
        if let Some(frame_data) = self.webcam_capture.get_latest_frame_data() {
            let target_w = VECTOR_IMAGE_RESOLUTION as usize;
            let target_h = VECTOR_IMAGE_RESOLUTION as usize;
            let expected_len = target_w * target_h;
            if frame_data.len() != expected_len {
                return Ok(());
            }
            let mut processed = frame_data;
            if self.settings.image_mirror_horizontal {
                for y in 0..target_h {
                    processed[y * target_w..(y + 1) * target_w].reverse();
                }
            }
            if self.settings.image_mirror_vertical {
                for y_top in 0..(target_h / 2) {
                    let y_bottom = target_h - 1 - y_top;
                    let top_start = y_top * target_w;
                    let bottom_start = y_bottom * target_w;
                    for x in 0..target_w {
                        processed.swap(top_start + x, bottom_start + x);
                    }
                }
            }
            if self.settings.image_invert_tone {
                for px in &mut processed {
                    *px = 255u8.saturating_sub(*px);
                }
            }
            if let Some(img) = image::GrayImage::from_raw(
                target_w as u32,
                target_h as u32,
                processed,
            ) {
                self.vector_field_image = Some(img);
            }
        }
        Ok(())
    }

    /// Load vector field image from file path
    pub fn load_vector_field_image_from_path(&mut self, path: &str) -> SimulationResult<()> {
        let img = image::open(path)
            .map_err(|e| crate::error::SimulationError::InvalidParameter(e.to_string()))?;
        self.load_vector_field_image_from_data(img)
    }

    /// Load vector field image from decoded image data
    pub fn load_vector_field_image_from_data(
        &mut self,
        img: image::DynamicImage,
    ) -> SimulationResult<()> {
        self.vector_field_image_original = Some(img.clone());
        self.reprocess_vector_field_image()
    }

    /// Reprocess the stored original image with current fit mode and transformations
    pub fn reprocess_vector_field_image(&mut self) -> SimulationResult<()> {
        let original = match &self.vector_field_image_original {
            Some(img) => img,
            None => return Ok(()),
        };
        let gray = original.to_luma8();
        let target_w = VECTOR_IMAGE_RESOLUTION;
        let target_h = VECTOR_IMAGE_RESOLUTION;
        let fit_mode = self.settings.image_fit_mode;

        let processed = match fit_mode {
            ImageFitMode::Stretch => image::imageops::resize(
                &gray,
                target_w,
                target_h,
                image::imageops::FilterType::Lanczos3,
            ),
            ImageFitMode::Center => {
                let mut canvas = image::ImageBuffer::new(target_w, target_h);
                let (img_w, img_h) = (gray.width(), gray.height());
                let start_x = if img_w < target_w { (target_w - img_w) / 2 } else { 0 };
                let start_y = if img_h < target_h { (target_h - img_h) / 2 } else { 0 };
                for (x, y, pixel) in gray.enumerate_pixels() {
                    let cx = start_x + x;
                    let cy = start_y + y;
                    if cx < target_w && cy < target_h {
                        canvas.put_pixel(cx, cy, *pixel);
                    }
                }
                canvas
            }
            ImageFitMode::FitH => {
                let scale = target_w as f32 / gray.width() as f32;
                let new_h = (gray.height() as f32 * scale) as u32;
                let resized =
                    image::imageops::resize(&gray, target_w, new_h, image::imageops::FilterType::Lanczos3);
                let mut canvas = image::ImageBuffer::new(target_w, target_h);
                let start_y = if new_h < target_h { (target_h - new_h) / 2 } else { 0 };
                for (x, y, pixel) in resized.enumerate_pixels() {
                    let cy = start_y + y;
                    if cy < target_h {
                        canvas.put_pixel(x, cy, *pixel);
                    }
                }
                canvas
            }
            ImageFitMode::FitV => {
                let scale = target_h as f32 / gray.height() as f32;
                let new_w = (gray.width() as f32 * scale) as u32;
                let resized =
                    image::imageops::resize(&gray, new_w, target_h, image::imageops::FilterType::Lanczos3);
                let mut canvas = image::ImageBuffer::new(target_w, target_h);
                let start_x = if new_w < target_w { (target_w - new_w) / 2 } else { 0 };
                for (x, y, pixel) in resized.enumerate_pixels() {
                    let cx = start_x + x;
                    if cx < target_w {
                        canvas.put_pixel(cx, y, *pixel);
                    }
                }
                canvas
            }
        };

        let mut final_img = processed;
        if self.settings.image_mirror_horizontal {
            image::imageops::flip_horizontal_in_place(&mut final_img);
        }
        if self.settings.image_mirror_vertical {
            image::imageops::flip_vertical_in_place(&mut final_img);
        }
        if self.settings.image_invert_tone {
            for pixel in final_img.pixels_mut() {
                pixel.0[0] = 255 - pixel.0[0];
            }
        }
        self.vector_field_image = Some(final_img);
        Ok(())
    }

    pub fn start_webcam_capture(&mut self, device_index: i32) -> SimulationResult<()> {
        self.webcam_capture.start_capture(device_index)
    }

    pub fn stop_webcam_capture(&mut self) {
        self.webcam_capture.stop_capture();
    }

    pub fn get_available_webcam_devices(&self) -> Vec<i32> {
        crate::simulations::shared::WebcamCapture::get_available_devices()
    }

    pub fn has_loaded_image(&self) -> bool {
        self.vector_field_image_original.is_some()
    }
}

impl Simulation for VectorsModel {
    fn render_frame(
        &mut self,
        device: &Arc<Device>,
        queue: &Arc<Queue>,
        surface_view: &TextureView,
        delta_time: f32,
    ) -> SimulationResult<()> {
        self.time += delta_time;
        self.camera.update(delta_time);

        if self.webcam_capture.is_active {
            let _ = self.update_vector_field_from_webcam();
            self.settings.vector_field_type = VectorFieldType::Image;
        }

        if self.geometry_dirty() {
            self.update_geometry(device, queue)?;
        }

        self.camera.upload_to_gpu(queue);

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Vectors render encoder"),
        });

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Vectors render pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: surface_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(self.get_clear_color()),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if self.index_count > 0 {
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &self.camera_bind_group, &[]);
                pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
                pass.set_index_buffer(self.index_buffer.slice(..), self.index_format);
                pass.draw_indexed(0..self.index_count, 0, 0..1);
            }
        }

        queue.submit(Some(encoder.finish()));
        Ok(())
    }

    fn render_frame_paused(
        &mut self,
        device: &Arc<Device>,
        queue: &Arc<Queue>,
        surface_view: &TextureView,
    ) -> SimulationResult<()> {
        self.camera.update(0.016);
        if self.geometry_dirty() {
            self.update_geometry(device, queue)?;
        }
        self.camera.upload_to_gpu(queue);

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("Vectors render encoder"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Vectors render pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: surface_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(self.get_clear_color()),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            if self.index_count > 0 {
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &self.camera_bind_group, &[]);
                pass.set_vertex_buffer(0, self.vertex_buffer.slice(..));
                pass.set_index_buffer(self.index_buffer.slice(..), self.index_format);
                pass.draw_indexed(0..self.index_count, 0, 0..1);
            }
        }
        queue.submit(Some(encoder.finish()));
        Ok(())
    }

    fn resize(
        &mut self,
        device: &Arc<Device>,
        queue: &Arc<Queue>,
        new_config: &SurfaceConfiguration,
    ) -> SimulationResult<()> {
        self.camera.resize(new_config.width as f32, new_config.height as f32);
        self.update_geometry(device, queue)
    }

    fn update_setting(
        &mut self,
        setting_name: &str,
        value: serde_json::Value,
        device: &Arc<Device>,
        queue: &Arc<Queue>,
    ) -> SimulationResult<()> {
        match setting_name {
            "vector_field_type" => {
                if let Some(s) = value.as_str() {
                    self.settings.vector_field_type = match s {
                        "Noise" | "noise" => {
                            self.webcam_capture.stop_capture();
                            VectorFieldType::Noise
                        }
                        "Image" | "image" => VectorFieldType::Image,
                        _ => self.settings.vector_field_type,
                    };
                }
            }
            "image_fit_mode" => {
                if let Some(s) = value.as_str() {
                    if let Ok(mode) = s.parse::<ImageFitMode>() {
                        self.settings.image_fit_mode = mode;
                        if self.settings.vector_field_type == VectorFieldType::Image {
                            self.reprocess_vector_field_image()?;
                        }
                    }
                }
            }
            "image_mirror_horizontal" => {
                if let Some(b) = value.as_bool() {
                    self.settings.image_mirror_horizontal = b;
                    if self.settings.vector_field_type == VectorFieldType::Image {
                        self.reprocess_vector_field_image()?;
                    }
                }
            }
            "image_mirror_vertical" => {
                if let Some(b) = value.as_bool() {
                    self.settings.image_mirror_vertical = b;
                    if self.settings.vector_field_type == VectorFieldType::Image {
                        self.reprocess_vector_field_image()?;
                    }
                }
            }
            "image_invert_tone" => {
                if let Some(b) = value.as_bool() {
                    self.settings.image_invert_tone = b;
                    if self.settings.vector_field_type == VectorFieldType::Image {
                        self.reprocess_vector_field_image()?;
                    }
                }
            }
            "noise_type" => {
                if let Some(s) = value.as_str() {
                    self.settings.noise_type = match s {
                        "OpenSimplex" => super::settings::NoiseType::OpenSimplex,
                        "Worley" => super::settings::NoiseType::Worley,
                        "Value" => super::settings::NoiseType::Value,
                        "Fbm" => super::settings::NoiseType::Fbm,
                        "FBMBillow" => super::settings::NoiseType::FBMBillow,
                        "FBMClouds" => super::settings::NoiseType::FBMClouds,
                        "FBMRidged" => super::settings::NoiseType::FBMRidged,
                        "Billow" => super::settings::NoiseType::Billow,
                        "RidgedMulti" => super::settings::NoiseType::RidgedMulti,
                        "Cylinders" => super::settings::NoiseType::Cylinders,
                        "Checkerboard" => super::settings::NoiseType::Checkerboard,
                        _ => self.settings.noise_type,
                    };
                }
            }
            "noise_seed" => {
                if let Some(n) = value.as_u64() {
                    self.settings.noise_seed = n as u32;
                }
            }
            "noise_scale" => {
                if let Some(n) = value.as_f64() {
                    self.settings.noise_scale = n;
                }
            }
            "noise_dt_multiplier" => {
                if let Some(n) = value.as_f64() {
                    self.settings.noise_dt_multiplier = n as f32;
                }
            }
            "density" => {
                if let Some(n) = value.as_f64() {
                    self.settings.density = n as f32;
                }
            }
            "line_length" => {
                if let Some(n) = value.as_f64() {
                    self.settings.line_length = n as f32;
                }
            }
            "line_width" => {
                if let Some(n) = value.as_f64() {
                    self.settings.line_width = n as f32;
                }
            }
            "background_color_mode" => {
                if let Some(s) = value.as_str() {
                    self.settings.background_color_mode = match s {
                        "Black" => BackgroundColorMode::Black,
                        "White" => BackgroundColorMode::White,
                        "Gray18" => BackgroundColorMode::Gray18,
                        "Color Scheme" => BackgroundColorMode::ColorScheme,
                        _ => self.settings.background_color_mode,
                    };
                }
            }
            _ => {}
        }
        self.update_geometry(device, queue)
    }

    fn update_state(
        &mut self,
        state_name: &str,
        value: serde_json::Value,
        _device: &Arc<Device>,
        _queue: &Arc<Queue>,
    ) -> SimulationResult<()> {
        match state_name {
            "current_color_scheme" => {
                if let Some(name) = value.as_str() {
                    self.state.current_color_scheme = name.to_string();
                }
            }
            "color_scheme_reversed" => {
                if let Some(reversed) = value.as_bool() {
                    self.state.color_scheme_reversed = reversed;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn get_settings(&self) -> serde_json::Value {
        serde_json::to_value(&self.settings).unwrap_or_default()
    }

    fn get_state(&self) -> serde_json::Value {
        serde_json::json!({
            "current_color_scheme": self.state.current_color_scheme,
            "color_scheme_reversed": self.state.color_scheme_reversed,
        })
    }

    fn handle_mouse_interaction(
        &mut self,
        _world_x: f32,
        _world_y: f32,
        _mouse_button: u32,
        _device: &Arc<Device>,
        _queue: &Arc<Queue>,
    ) -> SimulationResult<()> {
        Ok(())
    }

    fn handle_mouse_release(&mut self, _mouse_button: u32, _queue: &Arc<Queue>) -> SimulationResult<()> {
        Ok(())
    }

    fn pan_camera(&mut self, delta_x: f32, delta_y: f32) {
        self.camera.pan(delta_x, delta_y);
    }

    fn zoom_camera(&mut self, delta: f32) {
        self.camera.zoom(delta);
    }

    fn zoom_camera_to_cursor(&mut self, delta: f32, cursor_x: f32, cursor_y: f32) {
        self.camera.zoom_to_cursor(delta, cursor_x, cursor_y);
    }

    fn reset_camera(&mut self) {
        self.camera.reset();
    }

    fn get_camera_state(&self) -> serde_json::Value {
        self.camera.get_state()
    }

    fn save_preset(&self, _preset_name: &str) -> SimulationResult<()> {
        Ok(())
    }

    fn load_preset(&mut self, _preset_name: &str, _queue: &Arc<Queue>) -> SimulationResult<()> {
        Ok(())
    }

    fn apply_settings(
        &mut self,
        settings: serde_json::Value,
        device: &Arc<Device>,
        queue: &Arc<Queue>,
    ) -> SimulationResult<()> {
        if let Ok(s) = serde_json::from_value(settings) {
            self.settings = s;
            self.update_geometry(device, queue)?;
        }
        Ok(())
    }

    fn reset_runtime_state(
        &mut self,
        device: &Arc<Device>,
        queue: &Arc<Queue>,
    ) -> SimulationResult<()> {
        self.time = 0.0;
        self.update_geometry(device, queue)
    }

    fn randomize_settings(
        &mut self,
        device: &Arc<Device>,
        queue: &Arc<Queue>,
    ) -> SimulationResult<()> {
        use rand::Rng;
        let mut rng = rand::rng();
        self.settings.noise_type = match rng.random_range(0..11) {
            0 => super::settings::NoiseType::OpenSimplex,
            1 => super::settings::NoiseType::Worley,
            2 => super::settings::NoiseType::Value,
            3 => super::settings::NoiseType::Fbm,
            4 => super::settings::NoiseType::FBMBillow,
            5 => super::settings::NoiseType::FBMClouds,
            6 => super::settings::NoiseType::FBMRidged,
            7 => super::settings::NoiseType::Billow,
            8 => super::settings::NoiseType::RidgedMulti,
            9 => super::settings::NoiseType::Cylinders,
            _ => super::settings::NoiseType::Checkerboard,
        };
        self.settings.noise_seed = rng.random();
        self.settings.noise_scale = rng.random_range(0.001..0.1);
        self.update_geometry(device, queue)
    }

    fn update_color_scheme(
        &mut self,
        color_scheme: &crate::simulations::shared::ColorScheme,
        _device: &Arc<Device>,
        queue: &Arc<Queue>,
    ) -> SimulationResult<()> {
        let lut_data = color_scheme.to_u32_buffer();
        queue.write_buffer(&self.lut_buffer, 0, bytemuck::cast_slice(&lut_data));
        Ok(())
    }
}
