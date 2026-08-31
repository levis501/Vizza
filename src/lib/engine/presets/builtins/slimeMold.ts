/**
 * Slime Mold's thirteen built-in presets, transcribed from
 * src-tauri/src/simulations/slime_mold/mod.rs:17.
 *
 * Unlike Gray-Scott's, every entry here really is written as
 * `Settings { .., ..Settings::default() }`, so "only the fields that differ
 * from the defaults" is a straight transcription rather than a trap — checked
 * field by field before relying on it, because M4 found the opposite in
 * gray_scott/mod.rs, where all nine presets spelled out three values that
 * disagreed with `Settings::default()` and omitting them would have run every
 * preset 2.5x too fast.
 *
 * Three things the check did turn up, all faithfully reproduced:
 *
 *  - **Several presets name a value that equals the default.** "Firecracker
 *    Trees" and "Threads" both set `agent_sensor_angle: 0.3`, and "Venom" sets
 *    `agent_sensor_angle: 0.3` and `agent_sensor_distance: 20.0` — all three
 *    are already `Settings::default()`. They are kept below rather than pruned:
 *    the house rule exists so a preset is not silently pinned to a stale
 *    default, and dropping a redundant key would make the diff against mod.rs
 *    unreadable for no gain. A test asserts each entry is a subset of the Rust
 *    literal, not that it is minimal.
 *  - **"Default" carries no overrides at all** (mod.rs:21 —
 *    `Preset::new("Default", Settings::default())`), so it is `{}`.
 *  - **Six presets pin `pheromone_decay_rate: 100.0`** against a default of
 *    10.0. That is a 10x difference in how fast trails fade and it is the single
 *    most visible parameter in the simulation, so it is not optional garnish —
 *    the eight presets that omit it (Default, Firecracker Trees, Snake, Venom,
 *    plus Cells and Net which set their own) really do run at a different decay.
 *
 * The six "Bars" … "Cascades" entries carry long decimal tails because they
 * were captured from the Randomize button and pasted in; `276.855_5` and
 * `0.733_131_2` in mod.rs are Rust digit separators, not extra precision.
 *
 * Exported as data rather than self-registering: see the note in ./index.ts.
 */

import type { BuiltinPreset } from './index';

export const SLIME_MOLD_BUILTIN_PRESETS: readonly BuiltinPreset[] = [
    // mod.rs:21 — `Settings::default()`, so no overrides.
    { name: 'Default', settings: {} },
    {
        // mod.rs:22
        name: 'Gloop Loops',
        settings: {
            agent_jitter: 0.1,
            agent_turn_rate: 0.43, // equals the default; kept, see the header
            agent_speed_max: 300.0,
            agent_sensor_angle: 0.7,
            agent_sensor_distance: 5.0,
            pheromone_decay_rate: 100.0,
        },
    },
    {
        // mod.rs:34
        name: 'Firecracker Trees',
        settings: {
            agent_jitter: 0.1,
            agent_turn_rate: 0.93,
            agent_speed_min: 200.0,
            agent_speed_max: 300.0,
            agent_sensor_angle: 0.3, // equals the default
        },
    },
    {
        // mod.rs:45
        name: 'Threads',
        settings: {
            agent_jitter: 0.0,
            agent_turn_rate: 0.02,
            agent_sensor_angle: 0.3, // equals the default
            agent_speed_min: 50.0,
            agent_speed_max: 150.0,
            pheromone_decay_rate: 100.0,
        },
    },
    {
        // mod.rs:57
        name: 'Snake',
        settings: {
            agent_turn_rate: 0.37,
            agent_sensor_angle: 1.34,
            agent_sensor_distance: 225.0,
        },
    },
    {
        // mod.rs:66
        name: 'Cells',
        settings: {
            agent_jitter: 0.2,
            agent_turn_rate: 3.27,
            agent_speed_min: 200.0,
            agent_speed_max: 300.0,
            agent_sensor_angle: 1.95,
            agent_sensor_distance: 60.0,
            pheromone_decay_rate: 30.0,
        },
    },
    {
        // mod.rs:79
        name: 'Net',
        settings: {
            agent_jitter: 3.0,
            agent_turn_rate: 6.0,
            agent_speed_min: 99.0,
            agent_speed_max: 100.0,
            agent_sensor_angle: 1.57,
            agent_sensor_distance: 225.0,
            pheromone_decay_rate: 400.0,
        },
    },
    {
        // mod.rs:92
        name: 'Bars',
        settings: {
            agent_jitter: 3.9499364,
            agent_sensor_angle: 2.1932874,
            agent_sensor_distance: 443.47357,
            agent_speed_max: 482.0867,
            agent_speed_min: 426.72086,
            agent_turn_rate: 4.9691095,
            pheromone_decay_rate: 100.0,
            pheromone_deposition_rate: 43.590575,
            pheromone_diffusion_rate: 47.48144,
        },
    },
    {
        // mod.rs:107
        name: 'Healthy Fungus',
        settings: {
            agent_jitter: 3.1646671,
            agent_sensor_angle: 1.2506089,
            agent_sensor_distance: 8.729994,
            agent_speed_max: 479.0331,
            agent_speed_min: 294.0581,
            agent_turn_rate: 0.88734615,
            pheromone_decay_rate: 100.0,
            pheromone_deposition_rate: 52.57219,
            pheromone_diffusion_rate: 24.33,
        },
    },
    {
        // mod.rs:122
        name: 'Sand On A Speaker',
        settings: {
            agent_jitter: 2.991177,
            agent_sensor_angle: 0.6429619,
            agent_sensor_distance: 144.3722,
            agent_speed_max: 447.08768,
            agent_speed_min: 416.39087,
            agent_turn_rate: 2.1364458,
            pheromone_decay_rate: 100.0,
            pheromone_deposition_rate: 63.37401,
            pheromone_diffusion_rate: 7.905072,
        },
    },
    {
        // mod.rs:137
        name: 'Spots',
        settings: {
            agent_jitter: 0.25468826,
            agent_sensor_angle: 1.5476805,
            agent_sensor_distance: 31.14605,
            agent_speed_max: 350.69513,
            agent_speed_min: 300.85114,
            agent_turn_rate: 4.5000796,
            pheromone_decay_rate: 100.0,
            pheromone_deposition_rate: 22.841704,
            pheromone_diffusion_rate: 6.278837,
        },
    },
    {
        // mod.rs:152
        name: 'Cascades',
        settings: {
            agent_jitter: 4.6256456,
            agent_sensor_angle: 0.8972509,
            agent_sensor_distance: 239.66182,
            agent_speed_max: 381.27463,
            agent_speed_min: 276.8555,
            agent_turn_rate: 0.7331312,
            pheromone_decay_rate: 100.0,
            pheromone_deposition_rate: 27.726316,
            pheromone_diffusion_rate: 66.05927,
        },
    },
    {
        // mod.rs:167. `agent_speed_min: 0.0` is the only preset that stops
        // agents entirely at the low end of the speed range.
        name: 'Venom',
        settings: {
            agent_jitter: 2.0,
            agent_sensor_angle: 0.3, // equals the default
            agent_sensor_distance: 20.0, // equals the default
            agent_speed_max: 500.0,
            agent_speed_min: 0.0,
            agent_turn_rate: 0.20943952,
        },
    },
];
