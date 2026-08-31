// Compute shader for Physarum simulation
// Each agent is represented by a vec4<f32>: x, y, angle, speed

const TAU: f32 = 6.28318530718; // 2π

struct SimSizeUniform {
    width: u32,
    height: u32,
    decay_rate: f32,
    agent_jitter: f32,
    agent_speed_min: f32,
    agent_speed_max: f32,
    agent_turn_rate: f32,
    agent_sensor_angle: f32,
    agent_sensor_distance: f32,
    diffusion_rate: f32,
    pheromone_deposition_rate: f32,
    mask_pattern: u32,
    mask_target: u32,
    mask_strength: f32,
    mask_curve: f32,
    mask_mirror_horizontal: u32,
    mask_mirror_vertical: u32,
    mask_invert_tone: u32,
    random_seed: u32,
    position_generator: u32,
};

struct CursorParams {
    is_active: u32, // 0=inactive, 1=attract, 2=repel
    x: f32,
    y: f32,
    strength: f32,
    size: f32,
    _pad1: u32,
    _pad2: u32,
};

// agents are stored as 4 floats each (x, y, angle, speed)
@group(0) @binding(0)
var<storage, read_write> agents: array<vec4<f32>>;

@group(0) @binding(1)
var<storage, read_write> trail_map: array<f32>;

@group(0) @binding(2)
var<uniform> sim_size: SimSizeUniform;

@group(0) @binding(3)
var<storage, read> mask_map: array<f32>;

@group(0) @binding(4)
var<uniform> cursor: CursorParams;

// Helper function for bilinear interpolation
fn sample_trail_map(pos: vec2<f32>) -> f32 {
    let width = i32(sim_size.width);
    let height = i32(sim_size.height);

    let x0 = ((i32(floor(pos.x)) % width) + width) % width;
    let y0 = ((i32(floor(pos.y)) % height) + height) % height;
    let x1 = (x0 + 1) % width;
    let y1 = (y0 + 1) % height;

    let dx = pos.x - f32(i32(floor(pos.x)));
    let dy = pos.y - f32(i32(floor(pos.y)));

    let v00 = trail_map[y0 * width + x0];
    let v10 = trail_map[y0 * width + x1];
    let v01 = trail_map[y1 * width + x0];
    let v11 = trail_map[y1 * width + x1];

    let v0 = mix(v00, v10, dx);
    let v1 = mix(v01, v11, dx);
    return mix(v0, v1, dy);
}

// Fast sampling using nearest neighbor (much faster)
fn sample_trail_map_fast(pos: vec2<f32>) -> f32 {
    let width = i32(sim_size.width);
    let height = i32(sim_size.height);
    
    let x = ((i32(round(pos.x)) % width) + width) % width;
    let y = ((i32(round(pos.y)) % height) + height) % height;
    
    return trail_map[y * width + x];
}

// Helper function to sample mask map
fn sample_mask_map(pos: vec2<f32>) -> f32 {
    let width = i32(sim_size.width);
    let height = i32(sim_size.height);

    let x0 = ((i32(floor(pos.x)) % width) + width) % width;
    let y0 = ((i32(floor(pos.y)) % height) + height) % height;
    let x1 = (x0 + 1) % width;
    let y1 = (y0 + 1) % height;

    let dx = pos.x - f32(i32(floor(pos.x)));
    let dy = pos.y - f32(i32(floor(pos.y)));

    let v00 = mask_map[y0 * width + x0];
    let v10 = mask_map[y0 * width + x1];
    let v01 = mask_map[y1 * width + x0];
    let v11 = mask_map[y1 * width + x1];

    let v0 = mix(v00, v10, dx);
    let v1 = mix(v01, v11, dx);
    return mix(v0, v1, dy);
}

// Unified mask sampling with mirror + tone inversion applied consistently
fn sample_mask_with_mirror_invert(pos: vec2<f32>) -> f32 {
    // Normalize for mirroring
    var sx = pos.x / f32(sim_size.width);
    var sy = pos.y / f32(sim_size.height);

    if (sim_size.mask_mirror_horizontal != 0u) { sx = 1.0 - sx; }
    if (sim_size.mask_mirror_vertical != 0u) { sy = 1.0 - sy; }

    // Convert back to texture space and use bilinear sampling
    let mirrored_pos = vec2<f32>(sx * f32(sim_size.width), sy * f32(sim_size.height));
    var v = sample_mask_map(mirrored_pos);
    if (sim_size.mask_invert_tone != 0u) { v = 1.0 - v; }
    return v;
}

// `MaskPattern::Disabled` — slot 11 of SimSizeUniform, and gradient.wgsl's
// MASK_DISABLED. Repeated rather than shared because the two shaders are
// separate modules.
const MASK_DISABLED: u32 = 0u;

// The mask's shaped value at a position, in [0, 1].
//
// This is the *pattern* alone: whatever `generate_mask` wrote, mirrored and
// tone-inverted as configured, then shaped by `mask_curve`. `mask_strength` is
// deliberately **not** folded in here — it is a blend weight, not a scale, and
// keeping the two apart is what makes the Strength control observable; see
// `mask_blend` below.
//
// Returns 0 for a Disabled pattern instead of reading `mask_map`, because the
// buffer's contents are undefined while no pattern is selected: the desktop
// build skips its `generate_mask` dispatch for Disabled *and* Image
// (simulation.rs:993), so the previous pattern sits there indefinitely.
fn mask_value_at(x: f32, y: f32) -> f32 {
    if (sim_size.mask_pattern == MASK_DISABLED) {
        return 0.0;
    }
    let raw = sample_mask_with_mirror_invert(vec2<f32>(x, y));
    return pow(clamp(raw, 0.0, 1.0), max(0.0001, sim_size.mask_curve));
}

// How far the mask displaces a parameter from the value the user authored.
//
// 0 means the mask has no effect at all — the parameter is exactly what the
// control says, and the simulation is indistinguishable from a Disabled mask.
// 1 hands the parameter entirely to the mask's target range. A Disabled pattern
// is 0 by construction, which is what stops a stale `mask_target` from acting
// on a mask that is not there.
//
// **This is a deliberate change of meaning for `mask_strength`, shared with the
// desktop build.** It used to be a multiplier folded into the mask value before
// the target branches, which made those branches quadratic in it — and for the
// Pheromone Deposition target, whose range maximum (100) is also the deposition
// rate's default *and* the UI's maximum, exactly cancelling: on a hard 0/1
// pattern the deposition rate came out at 100 for every strength. See the M7
// notes in WEB_PORT.md.
fn mask_blend() -> f32 {
    if (sim_size.mask_pattern == MASK_DISABLED) {
        return 0.0;
    }
    return clamp(sim_size.mask_strength, 0.0, 1.0);
}

// Combined function to sample both trail and mask
//
// The mask contribution is scaled by `mask_blend()` and shaped by `mask_curve`,
// so a mask the agents can smell obeys the same two controls as a mask that
// modulates a parameter. Before, this route added the *raw* mask value and was
// structurally deaf to both: at 1 M agents it is the dominant visible effect of
// the mask, and it did not change by a pixel as Strength swept 0 to 1.
fn sample_combined_map(pos: vec2<f32>) -> f32 {
    let trail_value = sample_trail_map(pos);
    return trail_value + mask_value_at(pos.x, pos.y) * mask_blend();
}

// Fast combined sampling for performance-critical paths.
// Must stay in lockstep with `sample_combined_map`: the two feed the same
// sensors, so any divergence makes agents behave differently depending only on
// which sampler the caller happened to pick.
fn sample_combined_map_fast(pos: vec2<f32>) -> f32 {
    let trail_value = sample_trail_map_fast(pos);
    return trail_value + mask_value_at(pos.x, pos.y) * mask_blend();
}

// Parameters for the simulation (now mostly from uniform)
const TIME_STEP: f32 = 0.016; // Affects how far agents move per frame based on their speed

// Constants for spatial partitioning
const WORKGROUP_SIZE_X: u32 = 16u;
const WORKGROUP_SIZE_Y: u32 = 16u;
const CELL_SIZE: f32 = 20.0;  // Size of each cell in the spatial grid

// Shared memory for storing local agent positions
var<workgroup> local_agents: array<vec4<f32>, 256>;

@compute @workgroup_size(16, 16, 1)
fn update_agents(
    @builtin(global_invocation_id) id: vec3<u32>,
    @builtin(local_invocation_id) local_id: vec3<u32>,
    @builtin(num_workgroups) num_workgroups: vec3<u32>
) {
    // Calculate linear agent index from 2D global invocation.
    //
    // The row stride is the *dispatched* width, not a hardcoded 65535: the
    // caller folds an oversized 1D dispatch as `x = min(total, max_per_dim)`,
    // `y = ceil(total / max_per_dim)`, so x is only 65535 once the agent count
    // passes 16.7 M. Below that a constant 65535 stride skipped 15 of every 16
    // agents — at 1 M agents only 62,512 of them were ever updated, and at the
    // desktop default of 10 M about 38% sat frozen. Reading `num_workgroups.x`
    // makes the mapping dense for every dispatch shape the caller can produce.
    let agents_per_row = num_workgroups.x * 16u;
    let agent_index = id.x + id.y * agents_per_row;
    
    // For consistent random seeding, create a sequential index (preserves old preset behavior)
    // This ensures random patterns remain the same regardless of dispatch method
    let workgroup_linear_id = (id.x / 16u) + (id.y / 16u) * 65535u; 
    let thread_in_workgroup = (id.x % 16u) + (id.y % 16u) * 16u;
    let random_seed_index = workgroup_linear_id * 256u + thread_in_workgroup;
    
    // Bounds check - exit if this thread doesn't correspond to a valid agent
    if (agent_index >= arrayLength(&agents)) {
        return;
    }

    // Get agent data
    let agent = agents[agent_index];
    var x = agent.x;
    var y = agent.y;
    var angle = agent.z;
    var speed = agent.w;

    // The mask's shaped pattern value here, and how far it is allowed to move a
    // parameter. Every branch below is `mix(authored, target, mask_weight)`, so
    // a strength of 0 leaves the simulation exactly as the controls describe it
    // and 1 hands the parameter over entirely — monotone in Strength for every
    // target, which the old single `mask_factor` was not.
    let mask_value = mask_value_at(x, y);
    let mask_weight = mask_blend();

    // Apply mask to parameters based on target
    var effective_sensor_distance = sim_size.agent_sensor_distance;
    var effective_speed = speed;
    var effective_turn_rate = sim_size.agent_turn_rate;
    var effective_deposition_rate = sim_size.pheromone_deposition_rate;

    if (sim_size.mask_target == 0u) { // PheromoneDeposition (0..100)
        let target_min = 0.0;
        let target_max = 100.0;
        let target_value = mix(target_min, target_max, mask_value);
        effective_deposition_rate = mix(effective_deposition_rate, target_value, mask_weight);
    } else if (sim_size.mask_target == 3u) { // AgentSpeed (normalize within min/max)
        let speed_min = sim_size.agent_speed_min;
        let speed_max = sim_size.agent_speed_max;
        let speed_norm = clamp((effective_speed - speed_min) / max(0.0001, speed_max - speed_min), 0.0, 1.0);
        let target_norm = mask_value; // 0..1 in normalized space
        let mixed_norm = mix(speed_norm, target_norm, mask_weight);
        effective_speed = speed_min + mixed_norm * (speed_max - speed_min);
    } else if (sim_size.mask_target == 4u) { // AgentTurnRate (0..pi)
        let target_min = 0.0;
        let target_max = 3.14159265;
        let target_value = mix(target_min, target_max, mask_value);
        effective_turn_rate = mix(effective_turn_rate, target_value, mask_weight);
    } else if (sim_size.mask_target == 5u) { // AgentSensorDistance (0..500 per UI)
        let target_min = 0.0;
        let target_max = 500.0;
        let target_value = mix(target_min, target_max, mask_value);
        effective_sensor_distance = mix(effective_sensor_distance, target_value, mask_weight);
    } else if (sim_size.mask_target == 6u) { // TrailMap (direct trail map modification)
        // For TrailMap target, we'll apply the mask factor directly to the deposition rate
        // This allows the mask to control how much pheromone is deposited in different areas
        // Make the effect more pronounced by using a wider range
        let min_deposition = 0.0;
        let max_deposition = effective_deposition_rate * 2.0;
        let target_value = mix(min_deposition, max_deposition, mask_value);
        effective_deposition_rate = mix(effective_deposition_rate, target_value, mask_weight);
    }

    // Sample trail map at sensor positions
    let sensor_angle = sim_size.agent_sensor_angle;
    
    // Calculate sensor positions
    let left_angle = angle - sensor_angle;
    let right_angle = angle + sensor_angle;
    
    let left_pos = vec2<f32>(
        x + cos(left_angle) * effective_sensor_distance,
        y + sin(left_angle) * effective_sensor_distance
    );
    let right_pos = vec2<f32>(
        x + cos(right_angle) * effective_sensor_distance,
        y + sin(right_angle) * effective_sensor_distance
    );
    
    // Sample combined trail + gradient maps at sensor positions
    // Use fast sampling for better performance (sacrifices some accuracy for speed)
    let left_value = sample_combined_map_fast(left_pos);
    let right_value = sample_combined_map_fast(right_pos);
    
    // Update angle based on sensor readings
    if (left_value > right_value) {
        // Calculate shortest path to turn left
        let target_angle = angle - TAU;
        let angle_diff = target_angle - angle;
        angle += min(effective_turn_rate, abs(angle_diff)) * sign(angle_diff);
    } else if (right_value > left_value) {
        // Calculate shortest path to turn right
        let target_angle = angle + TAU;
        let angle_diff = target_angle - angle;
        angle += min(effective_turn_rate, abs(angle_diff)) * sign(angle_diff);
    } else {
        // If equal, do nothing
    }

    // Update agent position
    let move_dist = effective_speed * TIME_STEP;
    x = x + move_dist * cos(angle);
    y = y + move_dist * sin(angle);

    // --- CURSOR INTERACTION ---
    if (cursor.is_active > 0u) {
        let cursor_pos = vec2<f32>(cursor.x, cursor.y);
        let delta = cursor_pos - vec2<f32>(x, y);
        let dist = length(delta);
        if (dist < cursor.size && dist > 0.01) {
            let dir = normalize(delta);
            let force = cursor.strength * (1.0 - dist / cursor.size);
            if (cursor.is_active == 1u) {
                // Attract with swirling effect
                x += dir.x * force;
                y += dir.y * force;
                
                // Add swirling force (tangential component) for black hole effect
                let tangential_dir = vec2<f32>(-dir.y, dir.x);
                let swirl_force = force * 0.8; // 80% of radial force
                x += tangential_dir.x * swirl_force;
                y += tangential_dir.y * swirl_force;
                
            } else if (cursor.is_active == 2u) {
                // Repel with swirling effect
                x -= dir.x * force;
                y -= dir.y * force;
                
                // Add swirling force (tangential component) for centrifugal effect
                let tangential_dir = vec2<f32>(dir.y, -dir.x);
                let swirl_force = force * 0.8; // 80% of radial force
                x += tangential_dir.x * swirl_force;
                y += tangential_dir.y * swirl_force;
            }
        }
    }
    // --- END CURSOR INTERACTION ---

    // Apply jitter with proper random distribution
    let jitter_strength = sim_size.agent_jitter;
    let jitter_x_seed = hash(random_seed_index * 2654435761u + 1013904223u);
    let jitter_y_seed = hash(random_seed_index * 1664525u + 1073741827u);
    let random_x = random_float(jitter_x_seed);
    let random_y = random_float(jitter_y_seed);
    x += (random_x * 2.0 - 1.0) * jitter_strength;
    y += (random_y * 2.0 - 1.0) * jitter_strength;

    // Wrap agent position to stay within bounds (toroidal)
    x = x % f32(sim_size.width);
    if (x < 0.0) { x = x + f32(sim_size.width); }
    y = y % f32(sim_size.height);
    if (y < 0.0) { y = y + f32(sim_size.height); }

    // Deposit trail
    let deposit_x = i32(x);
    let deposit_y = i32(y);
    if (deposit_x >= 0 && deposit_x < i32(sim_size.width) && deposit_y >= 0 && deposit_y < i32(sim_size.height)) {
        let idx = deposit_y * i32(sim_size.width) + deposit_x;
        trail_map[idx] = clamp(trail_map[idx] + effective_deposition_rate * 0.01, 0.0, 1.0);
    }

    // Update agent in the buffer
    agents[agent_index] = vec4<f32>(x, y, angle, speed);
}

// Add a new compute entry point for trail decay
@compute @workgroup_size(16, 16, 1)
fn decay_trail(@builtin(global_invocation_id) id: vec3<u32>) {
    let x = id.x;
    let y = id.y;
    if (x >= sim_size.width || y >= sim_size.height) {
        return;
    }
    let idx = y * sim_size.width + x;
    
    // The mask's shaped pattern value here, and its blend weight; see
    // `mask_value_at` / `mask_blend`.
    let mask_value = mask_value_at(f32(x), f32(y));
    let mask_weight = mask_blend();

    // Apply mask to decay rate if target is PheromoneDecay
    var effective_decay_rate = sim_size.decay_rate;
    if (sim_size.mask_target == 1u) { // PheromoneDecay (0..10000)
        let target_min = 0.0;
        let target_max = 10000.0;
        let target_value = mix(target_min, target_max, mask_value);
        // Weighted by the mask, not by a hardcoded 1.0. That literal made this
        // an unconditional *override* — `mix(a, b, 1.0)` is just `b` — so the
        // authored decay rate was discarded wherever the mask was dark, and a
        // Disabled pattern (mask 0 everywhere) pinned the effective decay rate
        // to 0 and saturated the whole field to a solid mat. Reachable by
        // ordinary use: pick this target, then set the pattern to Disabled, at
        // which point the target selector hides but the value persists.
        effective_decay_rate = mix(effective_decay_rate, target_value, mask_weight);
    } else if (sim_size.mask_target == 6u) { // TrailMap (direct trail map modification)
        // Blend trail toward the mask pattern each pass for a clear effect.
        trail_map[idx] = mix(trail_map[idx], mask_value, mask_weight);
    }
    
    // Apply decay rate
    let decay_rate = effective_decay_rate * 0.0001;
    trail_map[idx] = max(0.0, trail_map[idx] - decay_rate);
}

// Add a new compute entry point for diffusion
@compute @workgroup_size(16, 16, 1)
fn diffuse_trail(@builtin(global_invocation_id) id: vec3<u32>) {
    let x = id.x;
    let y = id.y;
    if (x >= sim_size.width || y >= sim_size.height) {
        return;
    }
    let idx = y * sim_size.width + x;
    
    // The mask's shaped pattern value here, and its blend weight. This pass
    // used to read the raw mask and apply neither `mask_curve` nor
    // `mask_strength`, so the Diffusion target ignored both controls outright.
    let mask_value = mask_value_at(f32(x), f32(y));
    let mask_weight = mask_blend();

    // Apply mask to diffusion rate if target is PheromoneDiffusion
    var effective_diffusion_rate = sim_size.diffusion_rate;
    if (sim_size.mask_target == 2u) { // PheromoneDiffusion (0..100)
        let target_min = 0.0;
        let target_max = 100.0;
        let target_value = mix(target_min, target_max, mask_value);
        // Weighted, not the old hardcoded 1.0 — same override bug as the decay
        // pass above, with the same Disabled-pattern consequence (diffusion
        // pinned to 0, so trails never spread).
        effective_diffusion_rate = mix(effective_diffusion_rate, target_value, mask_weight);
    }
    
    // Get neighboring values with toroidal wrapping
    let x_prev = (x + sim_size.width - 1) % sim_size.width;
    let x_next = (x + 1) % sim_size.width;
    let y_prev = (y + sim_size.height - 1) % sim_size.height;
    let y_next = (y + 1) % sim_size.height;
    
    // Read from trail_map
    let center = trail_map[y * sim_size.width + x];
    let left = trail_map[y * sim_size.width + x_prev];
    let right = trail_map[y * sim_size.width + x_next];
    let up = trail_map[y_prev * sim_size.width + x];
    let down = trail_map[y_next * sim_size.width + x];
    
    // Simple diffusion: average of neighbors
    let diffusion_rate = effective_diffusion_rate * 0.01;
    let new_value = center * (1.0 - diffusion_rate) + 
                   (left + right + up + down) * (diffusion_rate * 0.25);
    
    // Clamp to prevent numerical instability and negative values
    let clamped_value = max(0.0, min(1.0, new_value));
    
    // Write back to trail_map (ping-pong will be handled at higher level)
    trail_map[y * sim_size.width + x] = clamped_value;
}

@compute @workgroup_size(16, 16, 1)
fn update_agent_speeds(
    @builtin(global_invocation_id) id: vec3<u32>,
    @builtin(num_workgroups) num_workgroups: vec3<u32>
) {
    // Same dense 2D index as `update_agents`; see the comment there.
    let agents_per_row = num_workgroups.x * 16u;
    let agent_index = id.x + id.y * agents_per_row;
    
    // Bounds check - exit if this thread doesn't correspond to a valid agent
    if (agent_index >= arrayLength(&agents)) {
        return;
    }
    
    // Get current agent data
    let agent = agents[agent_index];
    let x = agent.x;
    let y = agent.y;
    let angle = agent.z;
    
    // Generate new random speed within the current range
    let random_speed = fract(sin(f32(agent_index) * 12.9898 + 78.233) * 43758.5453);
    let speed_range = sim_size.agent_speed_max - sim_size.agent_speed_min;
    let new_speed = sim_size.agent_speed_min + random_speed * speed_range;
    
    // Update agent with new speed
    agents[agent_index] = vec4<f32>(x, y, angle, new_speed);
}

// Better random number generation using multiple hash functions
fn hash(seed: u32) -> u32 {
    var x = seed;
    x = ((x >> 16u) ^ x) * 0x45d9f3bu;
    x = ((x >> 16u) ^ x) * 0x45d9f3bu;
    x = (x >> 16u) ^ x;
    return x;
}

fn random_float(seed: u32) -> f32 {
    return f32(hash(seed)) / f32(0xffffffffu);
}

fn random_range(seed: u32, min_val: f32, max_val: f32) -> f32 {
    return min_val + random_float(seed) * (max_val - min_val);
}

// Position generation functions for slime mold agents
fn generate_random_position(seed: u32, width: f32, height: f32) -> vec2<f32> {
    let x = random_range(seed * 2u, 0.0, width);
    let y = random_range(seed * 3u, 0.0, height);
    return vec2<f32>(x, y);
}

fn generate_center_position(seed: u32, width: f32, height: f32) -> vec2<f32> {
    let center_x = width * 0.5;
    let center_y = height * 0.5;
    let scale = 0.3; // Scale around center
    let x = center_x + (random_range(seed * 2u, -1.0, 1.0) * width * scale);
    let y = center_y + (random_range(seed * 3u, -1.0, 1.0) * height * scale);
    return vec2<f32>(x, y);
}

fn generate_uniform_circle_position(seed: u32, width: f32, height: f32) -> vec2<f32> {
    let center_x = width * 0.5;
    let center_y = height * 0.5;
    let max_radius = min(width, height) * 0.4; // Scale for the smaller dimension
    let angle = random_range(seed * 2u, 0.0, TAU);
    let radius = sqrt(random_range(seed * 3u, 0.0, 1.0)) * max_radius;
    return vec2<f32>(center_x + cos(angle) * radius, center_y + sin(angle) * radius);
}

fn generate_centered_circle_position(seed: u32, width: f32, height: f32) -> vec2<f32> {
    let center_x = width * 0.5;
    let center_y = height * 0.5;
    let max_radius = min(width, height) * 0.4;
    let angle = random_range(seed * 2u, 0.0, TAU);
    let radius = random_range(seed * 3u, 0.0, max_radius);
    return vec2<f32>(center_x + cos(angle) * radius, center_y + sin(angle) * radius);
}

fn generate_ring_position(seed: u32, width: f32, height: f32) -> vec2<f32> {
    let center_x = width * 0.5;
    let center_y = height * 0.5;
    let ring_radius = min(width, height) * 0.35;
    let ring_width = min(width, height) * 0.01;
    let angle = random_range(seed * 2u, 0.0, TAU);
    let radius = ring_radius + (random_range(seed * 3u, -1.0, 1.0) * ring_width);
    return vec2<f32>(center_x + cos(angle) * radius, center_y + sin(angle) * radius);
}

fn generate_line_position(seed: u32, width: f32, height: f32) -> vec2<f32> {
    let x = random_range(seed * 2u, 0.0, width);
    let y = height * 0.5 + (random_range(seed * 3u, -1.0, 1.0) * height * 0.3);
    return vec2<f32>(x, y);
}

fn generate_spiral_position(seed: u32, width: f32, height: f32) -> vec2<f32> {
    let center_x = width * 0.5;
    let center_y = height * 0.5;
    let max_radius = min(width, height) * 0.45;
    let max_rotations = 2.0;
    let f = random_range(seed * 2u, 0.0, 1.0);
    let angle = max_rotations * TAU * f;
    let spread = max_radius * 0.25 * min(f, 0.2);
    let radius = max_radius * f + spread * (random_range(seed * 3u, -1.0, 1.0));
    return vec2<f32>(center_x + radius * cos(angle), center_y + radius * sin(angle));
}

fn generate_image_position(seed: u32, width: f32, height: f32) -> vec2<f32> {
    // Use rejection sampling to generate positions based on mask image intensity
    // Higher intensity areas are more likely to be selected
    
    let max_attempts = 100u; // Prevent infinite loops
    var attempts = 0u;
    
    while (attempts < max_attempts) {
        // Generate random position
        let x = random_range(seed * 2u + attempts, 0.0, width);
        let y = random_range(seed * 3u + attempts, 0.0, height);
        
        // Sample mask intensity using unified mirror/invert sampler
        var intensity = sample_mask_with_mirror_invert(vec2<f32>(x, y));
        
        // Generate random threshold
        let threshold = random_range(seed * 4u + attempts, 0.0, 1.0);
        
        // Accept position if intensity is above threshold
        if (intensity >= threshold) {
            return vec2<f32>(x, y);
        }
        
        attempts++;
    }
    
    // Fallback to random position if rejection sampling fails
    return generate_random_position(seed, width, height);
}

@compute @workgroup_size(64, 1, 1)
fn reset_agents(
    @builtin(global_invocation_id) global_id: vec3<u32>,
    @builtin(num_workgroups) num_workgroups: vec3<u32>
) {
    // With 2D dispatch and workgroup_size(64, 1, 1):
    // global_id.x = linear thread index across all workgroups
    // global_id.y = second dimension for large dispatches
    //
    // This one was already dense with the old hardcoded 65535 stride, because
    // the fold makes x exactly 65535 whenever y > 1. It reads num_workgroups
    // anyway so all three agent kernels state the same rule, and so the caller
    // may fold against `maxComputeWorkgroupsPerDimension` rather than a literal.
    let agent_index = global_id.x + global_id.y * num_workgroups.x * 64u;
    let total_agents = arrayLength(&agents);
    
    if (agent_index >= total_agents) {
        return;
    }
    
    // Use multiple different seeds for better randomness, incorporating the random seed
    let base_seed = agent_index * 2654435761u + sim_size.random_seed;
    let x_seed = hash(base_seed);
    let y_seed = hash(base_seed + 1013904223u);
    let angle_seed = hash(base_seed + 1664525u);
    
    // Generate position based on generator type
    var position: vec2<f32>;
    switch (sim_size.position_generator) {
        case 0u: { // Random
            position = generate_random_position(base_seed, f32(sim_size.width), f32(sim_size.height));
        }
        case 1u: { // Center
            position = generate_center_position(base_seed, f32(sim_size.width), f32(sim_size.height));
        }
        case 2u: { // UniformCircle
            position = generate_uniform_circle_position(base_seed, f32(sim_size.width), f32(sim_size.height));
        }
        case 3u: { // CenteredCircle
            position = generate_centered_circle_position(base_seed, f32(sim_size.width), f32(sim_size.height));
        }
        case 4u: { // Ring
            position = generate_ring_position(base_seed, f32(sim_size.width), f32(sim_size.height));
        }
        case 5u: { // Line
            position = generate_line_position(base_seed, f32(sim_size.width), f32(sim_size.height));
        }
        case 6u: { // Spiral
            position = generate_spiral_position(base_seed, f32(sim_size.width), f32(sim_size.height));
        }
        case 7u: { // Image
            position = generate_image_position(base_seed, f32(sim_size.width), f32(sim_size.height));
        }
        default: {
            position = generate_random_position(base_seed, f32(sim_size.width), f32(sim_size.height));
        }
    }
    
    // Generate random angle
    let angle = random_range(angle_seed, 0.0, TAU);
    
    // Set speed to average of min/max
    let speed = (sim_size.agent_speed_min + sim_size.agent_speed_max) * 0.5;
    
    // Update agent
    agents[agent_index] = vec4<f32>(position.x, position.y, angle, speed);
} 