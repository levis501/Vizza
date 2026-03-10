struct CameraUniform {
    transform_matrix: mat4x4<f32>,
    position: vec2<f32>,
    zoom: f32,
    aspect_ratio: f32,
}

struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) value: f32,
}

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) value: f32,
}

@group(0) @binding(0) var<uniform> camera: CameraUniform;

@vertex
fn main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let pos = vec4<f32>(input.position, 0.0, 1.0);
    output.position = camera.transform_matrix * pos;
    output.value = input.value;
    return output;
}
