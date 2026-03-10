@group(0) @binding(1) var<storage, read> lut_data: array<u32>;

struct FragmentInput {
    @location(0) value: f32,
}

fn get_lut_color(intensity: f32) -> vec3<f32> {
    let idx = u32(clamp(intensity * 255.0, 0.0, 255.0));
    let r_srgb = f32(lut_data[idx]) / 255.0;
    let g_srgb = f32(lut_data[idx + 256u]) / 255.0;
    let b_srgb = f32(lut_data[idx + 512u]) / 255.0;
    return vec3<f32>(r_srgb, g_srgb, b_srgb);
}

@fragment
fn main(input: FragmentInput) -> @location(0) vec4<f32> {
    let color = get_lut_color(input.value);
    return vec4<f32>(color, 1.0);
}
