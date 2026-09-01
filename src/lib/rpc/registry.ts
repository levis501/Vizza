/**
 * The command table.
 *
 * Every name here corresponds to a `#[tauri::command]` in
 * src-tauri/src/commands/*.rs. Handlers are added milestone by milestone; until
 * a simulation is ported, its commands resolve through `stub()` so the UI stays
 * interactive rather than throwing.
 *
 * The completeness test in test/unit/registry.test.ts greps the expected names
 * out of the .svelte sources, so this table cannot silently drift from what the
 * components actually call.
 */

import { emit } from './events';
import { PARTICLE_LIFE_CEILING, SPEC_MINIMUM_SLIME_MOLD_AGENTS } from '$lib/engine/gpu/limits';

export type Handler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

export const registry = new Map<string, Handler>();

/** Commands not yet implemented resolve to a default rather than throwing. */
function stub(name: string, value: unknown = null): void {
    registry.set(name, async () => {
        if (import.meta.env?.DEV) {
            console.debug(`[rpc] stub: ${name}`);
        }
        return value;
    });
}

export function register(name: string, handler: Handler): void {
    registry.set(name, handler);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
/**
 * Modes gate their loading overlay on `simulation-initialized`, and several
 * also wait for `simulation-resumed`. Until a simulation is actually ported,
 * the start stubs still have to signal readiness or the UI stays covered.
 */
for (const name of [
    'start_simulation',
    'start_slime_mold_simulation',
    'start_gray_scott_simulation',
    'start_particle_life_simulation',
    'start_pellets_simulation',
    'start_moire_simulation',
    'start_primordial_particles_simulation',
]) {
    registry.set(name, async () => {
        if (import.meta.env?.DEV) console.debug(`[rpc] stub: ${name}`);
        // Deferred a tick so callers that subscribe after invoking still hear it.
        queueMicrotask(() => {
            emit('simulation-initialized', null);
            emit('simulation-resumed', null);
        });
        return null;
    });
}

for (const name of [
    'destroy_simulation',
    'pause_simulation',
    'resume_simulation',
    'step_simulation',
    'reset_simulation',
    'reset_runtime_state',
    'reset_graphics_resources',
    'reset_trails',
    'reset_agents',
    'clear_trail_texture',
    'randomize_settings',
    'render_frame',
    'seed_random_noise',
    'kill_all_particles',
])
    stub(name);

// ---------------------------------------------------------------------------
// Settings and state
// ---------------------------------------------------------------------------
stub('get_current_settings', {});
stub('get_current_state', {});
/*
 * `update_particle_life_setting` used to be stubbed here, and had a handler.
 *
 * It never worked and could not have: no `#[tauri::command]` of that name is
 * registered in `main.rs`, so on the desktop the one caller — the ± flip-sign
 * button in InteractionMatrix.svelte — always rejected. It also passed the
 * setting name under `setting` rather than `settingName`, which the shim does
 * not rename, so `args.setting_name` was `undefined` even here. Its ten sibling
 * buttons never called it: they dispatch to the mode, which sends one
 * `update_simulation_setting force_matrix`. The ± button does that now too, and
 * the command is gone rather than fixed — the "no unreachable handlers" check
 * in test/unit/registry.test.ts is what keeps it gone.
 */
for (const name of [
    'update_simulation_setting',
    'update_simulation_state',
    'update_pellets_trails_state',
    'update_agent_count',
])
    stub(name);
stub('get_current_agent_count', null);
/*
 * `get_agent_count_limit` has no `#[tauri::command]` behind it — it is the one
 * command in this table the desktop app never had.
 *
 * It exists because the desktop had no ceiling at all: `update_agent_count`
 * (commands/slime_mold.rs:55) assigns whatever it is given with no clamp, and
 * `SlimeMoldMode.svelte` offered up to 100 million, which at 16 B/agent is
 * 1.6 GB against a 128 MiB `maxStorageBufferBindingSize`. In a browser that
 * does not fail politely, it loses the device. The real ceiling is a property
 * of the granted limits (`gpu/limits.ts`), so the control has to ask for it.
 *
 * The stub value is the ceiling on a device granting exactly the WebGPU spec
 * minimum — the honest answer when no device exists to ask.
 */
stub('get_agent_count_limit', SPEC_MINIMUM_SLIME_MOLD_AGENTS);

/*
 * `get_particle_count_limit` is the second command with no desktop original,
 * and it exists for the same reason as the first: the ceiling is a property of
 * the device, so the control has to ask rather than hardcode.
 *
 * Unlike Slime Mold's, this one is a *compute* ceiling — 50,000 particles is
 * 1.2 MB, but `particle_life/compute.wgsl` is O(n²) — so on every device that
 * clears the WebGPU spec minimums the answer is `PARTICLE_LIFE_CEILING` exactly
 * and the two device-derived bounds in `particleLifeCap` never bind. The stub
 * is therefore the same number the engine would return, which is honest rather
 * than lucky: see gpu/limits.ts.
 */
stub('get_particle_count_limit', PARTICLE_LIFE_CEILING);

// ---------------------------------------------------------------------------
// Camera and interaction
// ---------------------------------------------------------------------------
for (const name of [
    'pan_camera',
    'zoom_camera',
    'zoom_camera_to_cursor',
    'reset_camera',
    'set_camera_sensitivity',
    'handle_mouse_interaction_screen',
    'handle_mouse_release',
    'update_cursor_size',
    'update_cursor_strength',
])
    stub(name);
/*
 * `update_cursor_position_screen` and `get_camera_state` used to be stubbed
 * here. GrayScottMode was the only caller of either, and M4 removed both calls:
 * the first fired an awaited round-trip on every mousemove for a command whose
 * Rust original ignores its arguments, and the second fetched a camera state
 * that nothing consumed. The "no unreachable handlers" check in
 * test/unit/registry.test.ts is what pairs a command with its call sites, so
 * they are dropped rather than left dangling — `SimulationHost.getCameraState()`
 * is untouched, and re-registering either is a six-line handler when a caller
 * comes back.
 */

// ---------------------------------------------------------------------------
// GUI and window
// ---------------------------------------------------------------------------
stub('toggle_gui', true);
stub('get_gui_state', true);
stub('get_app_version', '0.11.2');
for (const name of [
    'handle_window_resize',
    'apply_window_settings',
    'apply_window_settings_on_startup',
    'set_webview_zoom',
    'toggle_fullscreen',
    'save_app_settings',
    'reset_app_settings',
])
    stub(name);
stub('get_app_settings', {});
stub('get_current_window_size', {
    width: typeof window !== 'undefined' ? window.innerWidth : 1600,
    height: typeof window !== 'undefined' ? window.innerHeight : 900,
});

// ---------------------------------------------------------------------------
// Colour schemes
// ---------------------------------------------------------------------------
stub('get_available_color_schemes', []);
stub('get_species_colors', []);
for (const name of [
    'apply_color_scheme_by_name',
    'toggle_color_scheme_reversed',
    'save_custom_color_scheme',
    'update_gradient_preview',
    'set_gradient_display_mode',
])
    stub(name);

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------
stub('get_available_presets', []);
stub('get_presets_for_simulation_type', []);
for (const name of ['apply_preset', 'save_preset']) stub(name);

// ---------------------------------------------------------------------------
// Post-processing — PostProcessingMenu.svelte builds these names dynamically
// from `simulationType`, so the whole closed set must exist.
// ---------------------------------------------------------------------------
const POST_PROCESSING_SIMS = [
    '', // flow uses the unprefixed pair
    'particle_life_',
    'gray_scott_',
    'slime_mold_',
    'pellets_',
    'voronoi_ca_',
    'primordial_particles_',
];
for (const sim of POST_PROCESSING_SIMS) {
    stub(`get_${sim}post_processing_state`, {
        blur_filter: { enabled: false, radius: 4, sigma: 2 },
    });
    stub(`update_${sim}post_processing_state`);
}

// ---------------------------------------------------------------------------
// Image loading — native paths become File uploads (see resources/imageUpload).
// ImageSelector.svelte passes these names through its `loadCommand` prop, so
// they are dynamic call sites; the set is closed and enumerated here.
// ---------------------------------------------------------------------------
for (const name of [
    'load_slime_mold_position_image',
    'load_slime_mold_mask_image',
    'load_gray_scott_nutrient_image',
    'load_flow_vector_field_image',
    'load_vectors_vector_field_image',
    'load_moire_image',
])
    stub(name);

for (const name of [
    'set_slime_mold_position_image_fit_mode',
    'set_slime_mold_mask_image_fit_mode',
    'set_flow_vector_field_type',
    'set_flow_image_fit_mode',
    'set_flow_image_mirror_horizontal',
    'set_flow_image_mirror_vertical',
    'set_flow_image_invert_tone',
])
    stub(name);

// ---------------------------------------------------------------------------
// Webcam — omitted from the browser port. Device enumeration returns empty so
// WebcamControls reports "no devices" rather than erroring.
// ---------------------------------------------------------------------------
// Gray-Scott's three are absent: M4 deleted its WebcamControls outright rather
// than ship a Start button that is permanently greyed out, so nothing calls them.
// M5 did the same to Vectors', and M7 to Slime Mold's. Only Flow and Moiré still
// have panels, so only their names survive.
//
// Slime Mold's device-enumeration command is the *unprefixed*
// `get_available_webcam_devices` (commands/slime_mold.rs:210) — the name looks
// shared but is not: Flow and Moiré each have their own prefixed one, and
// nothing else in `src/` called it. Removing Slime Mold's panel therefore
// orphans the `''` entry, which the "no unreachable handlers" check in
// test/unit/registry.test.ts turns into a failure rather than dead weight.
for (const sim of ['flow_', 'moire_']) {
    stub(`get_available_${sim}webcam_devices`, []);
}
for (const sim of ['flow', 'moire']) {
    stub(`start_${sim}_webcam_capture`);
    stub(`stop_${sim}_webcam_capture`);
}
