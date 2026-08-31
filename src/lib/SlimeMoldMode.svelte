<SimulationLayout
    simulationName="Slime Mold"
    {running}
    {loading}
    {showUI}
    {currentFps}
    {controlsVisible}
    {menuPosition}
    on:back={returnToMenu}
    on:toggleUI={toggleBackendGui}
    on:pause={stopSimulation}
    on:resume={resumeSimulation}
    on:userInteraction={() => autoHideManager?.handleUserInteraction()}
    on:mouseEvent={handleMouseEvent}
>
    {#if settings && state}
        <form on:submit|preventDefault>
            <!-- About this simulation -->
            <CollapsibleFieldset title="About this simulation" bind:open={show_about_section}>
                <p>
                    Slime Mold simulates the fascinating behavior of Physarum polycephalum, a
                    single-celled organism that exhibits collective intelligence. Thousands of
                    agents move through space, depositing pheromone trails that attract other
                    agents, creating efficient networks.
                </p>
                <p>
                    The simulation models how slime molds solve complex problems like finding
                    optimal paths through mazes and connecting food sources. Agents sense pheromone
                    gradients and adjust their movement accordingly, while the pheromone trails
                    decay and diffuse over time.
                </p>
                <p>
                    Watch as simple rules for movement and pheromone interaction lead to the
                    emergence of sophisticated transportation networks, branching patterns, and
                    adaptive pathfinding - all without central coordination or planning.
                </p>
            </CollapsibleFieldset>

            <!-- Preset Controls -->
            <PresetFieldset
                availablePresets={available_presets}
                bind:currentPreset={current_preset}
                placeholder="Select preset..."
                on:presetChange={({ detail }) => updatePreset(detail.value)}
                on:presetSave={({ detail }) => savePreset(detail.name)}
            />

            <!-- Display Settings -->
            <fieldset>
                <legend>Display Settings</legend>
                <div class="control-group">
                    <label for="colorSchemeSelector">Color Scheme</label>
                    <ColorSchemeSelector
                        bind:available_color_schemes={available_luts}
                        current_color_scheme={state?.current_color_scheme}
                        reversed={state?.color_scheme_reversed}
                        on:select={({ detail }) => updateLutName(detail.name)}
                        on:reverse={() => updateLutReversed()}
                    />
                </div>
            </fieldset>

            <!-- Post Processing -->
            <PostProcessingMenu simulationType="slime_mold" />

            <!-- Controls -->
            <ControlsPanel
                mouseInteractionText="🖱️ Left click: Attract agents | Right click: Repel agents"
                cursorSize={state.cursor_size}
                cursorStrength={state.cursor_strength}
                sizeMin={10}
                sizeMax={500}
                sizeStep={5}
                strengthMin={0}
                strengthMax={50}
                strengthStep={0.5}
                sizePrecision={0}
                strengthPrecision={1}
                on:cursorSizeChange={(e) => updateCursorSize(e.detail)}
                on:cursorStrengthChange={(e) => updateCursorStrength(e.detail)}
                on:navigate={(e) => dispatch('navigate', e.detail)}
            />

            <!-- Combined Settings -->
            <fieldset>
                <legend>Settings</legend>

                <!-- General Settings -->
                <div class="settings-section">
                    <div class="control-group">
                        <Button
                            variant="warning"
                            type="button"
                            on:click={async () => {
                                try {
                                    await invoke('randomize_settings');
                                    await syncSettingsFromBackend();
                                    console.log('Settings randomized successfully');
                                } catch (e) {
                                    console.error('Failed to randomize settings:', e);
                                }
                            }}>🎲 Randomize Settings</Button
                        >
                        <Button
                            variant="warning"
                            type="button"
                            on:click={async () => {
                                try {
                                    await invoke('reset_trails');
                                    console.log('Trails reset successfully');
                                } catch (e) {
                                    console.error('Failed to reset trails:', e);
                                }
                            }}>🧹 Clear Trails</Button
                        >
                    </div>
                    <div class="control-group">
                        <label for="positionGenerator" class="visually-hidden"
                            >Agent Position Generator</label
                        >
                        <ButtonSelect
                            value={state.position_generator}
                            options={position_generator_options}
                            buttonText="Reset Agents"
                            placeholder="Select position generator..."
                            on:change={({ detail }) => updatePositionGenerator(detail.value)}
                            on:buttonclick={resetAgents}
                        />
                    </div>

                    <!-- Image Position Generator Controls -->
                    {#if state.position_generator === 'Image'}
                        <div class="control-group">
                            <ImageSelector
                                fitMode={settings.position_image_fit_mode}
                                loadCommand="load_slime_mold_position_image"
                                showFitMode={true}
                                showLoadButton={true}
                                onFitModeChange={(value) => updatePositionImageFitMode(value)}
                            />
                        </div>
                    {/if}
                </div>

                <!-- Pheromone Settings -->
                <div class="settings-section">
                    <h3 class="section-header">Pheromone</h3>
                    <div class="settings-grid">
                        <div class="setting-item">
                            <label class="setting-label" for="sm-decay-rate">Decay Rate:</label>
                            <NumberDragBox
                                id="sm-decay-rate"
                                bind:value={settings.pheromone_decay_rate}
                                min={0}
                                max={10000}
                                step={1}
                                precision={2}
                                unit="%"
                                on:change={async (e) => {
                                    try {
                                        await invoke('update_simulation_setting', {
                                            settingName: 'pheromone_decay_rate',
                                            value: e.detail,
                                        });
                                    } catch (err) {
                                        console.error(
                                            'Failed to update pheromone decay rate:',
                                            err
                                        );
                                    }
                                }}
                            />
                        </div>
                        <div class="setting-item">
                            <label class="setting-label" for="sm-deposition-rate"
                                >Deposition Rate:</label
                            >
                            <NumberDragBox
                                id="sm-deposition-rate"
                                bind:value={settings.pheromone_deposition_rate}
                                min={0}
                                max={100}
                                step={1}
                                precision={2}
                                unit="%"
                                on:change={async (e) => {
                                    try {
                                        await invoke('update_simulation_setting', {
                                            settingName: 'pheromone_deposition_rate',
                                            value: e.detail,
                                        });
                                    } catch (err) {
                                        console.error(
                                            'Failed to update pheromone deposition rate:',
                                            err
                                        );
                                    }
                                }}
                            />
                        </div>
                        <div class="setting-item">
                            <label class="setting-label" for="sm-diffusion-rate"
                                >Diffusion Rate:</label
                            >
                            <NumberDragBox
                                id="sm-diffusion-rate"
                                bind:value={settings.pheromone_diffusion_rate}
                                min={0}
                                max={100}
                                step={1}
                                precision={2}
                                unit="%"
                                on:change={async (e) => {
                                    try {
                                        await invoke('update_simulation_setting', {
                                            settingName: 'pheromone_diffusion_rate',
                                            value: e.detail,
                                        });
                                    } catch (err) {
                                        console.error(
                                            'Failed to update pheromone diffusion rate:',
                                            err
                                        );
                                    }
                                }}
                            />
                        </div>
                    </div>
                </div>

                <!-- Agent Settings -->
                <div class="settings-section">
                    <h3 class="section-header">Agent</h3>
                    <div class="settings-grid">
                        <div class="setting-item">
                            <label class="setting-label" for="sm-agent-count"
                                >Agent Count (millions):</label
                            >
                            <AgentCountInput
                                id="sm-agent-count"
                                value={agent_count_millions}
                                maxAgents={agent_count_cap}
                                on:update={({ detail }) => updateAgentCount(detail)}
                            />
                        </div>
                        <div class="setting-item">
                            <label class="setting-label" for="sm-min-speed">Min Speed:</label>
                            <NumberDragBox
                                id="sm-min-speed"
                                bind:value={settings.agent_speed_min}
                                min={0}
                                max={500}
                                step={10}
                                precision={1}
                                on:change={async (e) => {
                                    try {
                                        await invoke('update_simulation_setting', {
                                            settingName: 'agent_speed_min',
                                            value: e.detail,
                                        });
                                        await syncSettingsFromBackend();
                                    } catch (err) {
                                        console.error('Failed to update min speed:', err);
                                    }
                                }}
                            />
                        </div>
                        <div class="setting-item">
                            <label class="setting-label" for="sm-max-speed">Max Speed:</label>
                            <NumberDragBox
                                id="sm-max-speed"
                                bind:value={settings.agent_speed_max}
                                min={0}
                                max={500}
                                step={10}
                                precision={1}
                                on:change={async (e) => {
                                    try {
                                        await invoke('update_simulation_setting', {
                                            settingName: 'agent_speed_max',
                                            value: e.detail,
                                        });
                                        await syncSettingsFromBackend();
                                    } catch (err) {
                                        console.error('Failed to update max speed:', err);
                                    }
                                }}
                            />
                        </div>
                        <div class="setting-item">
                            <label class="setting-label" for="sm-turn-rate">Turn Rate:</label>
                            <NumberDragBox
                                id="sm-turn-rate"
                                value={(settings.agent_turn_rate * 180) / Math.PI}
                                min={0}
                                max={360}
                                step={1}
                                precision={0}
                                unit="°"
                                on:change={({ detail }) =>
                                    setRadians('agent_turn_rate', detail, 'turn rate')}
                            />
                        </div>
                        <div class="setting-item">
                            <label class="setting-label" for="sm-jitter">Jitter:</label>
                            <NumberDragBox
                                id="sm-jitter"
                                bind:value={settings.agent_jitter}
                                min={0.0}
                                max={10.0}
                                step={0.01}
                                precision={2}
                                on:change={async (e) => {
                                    try {
                                        await invoke('update_simulation_setting', {
                                            settingName: 'agent_jitter',
                                            value: e.detail,
                                        });
                                        await syncSettingsFromBackend();
                                    } catch (err) {
                                        console.error('Failed to update agent jitter:', err);
                                    }
                                }}
                            />
                        </div>
                        <div class="setting-item">
                            <label class="setting-label" for="sm-sensor-angle">Sensor Angle:</label>
                            <NumberDragBox
                                id="sm-sensor-angle"
                                value={(settings.agent_sensor_angle * 180) / Math.PI}
                                min={0}
                                max={180}
                                step={1}
                                precision={0}
                                unit="°"
                                on:change={({ detail }) =>
                                    setRadians('agent_sensor_angle', detail, 'sensor angle')}
                            />
                        </div>
                        <div class="setting-item">
                            <label class="setting-label" for="sm-sensor-distance"
                                >Sensor Distance:</label
                            >
                            <NumberDragBox
                                id="sm-sensor-distance"
                                bind:value={settings.agent_sensor_distance}
                                min={0}
                                max={500}
                                step={1}
                                precision={0}
                                on:change={async (e) => {
                                    try {
                                        await invoke('update_simulation_setting', {
                                            settingName: 'agent_sensor_distance',
                                            value: e.detail,
                                        });
                                        await syncSettingsFromBackend();
                                    } catch (err) {
                                        console.error('Failed to update sensor distance:', err);
                                    }
                                }}
                            />
                        </div>
                    </div>
                </div>

                <!-- Mask Settings -->
                <div class="settings-section">
                    <h3 class="section-header">Mask</h3>
                    <div class="settings-grid">
                        <div class="setting-item">
                            <label class="setting-label" for="sm-mask-pattern">Mask Pattern:</label>
                            <Selector
                                id="sm-mask-pattern"
                                options={mask_pattern_options}
                                value={state.mask_pattern}
                                on:change={handleMaskPattern}
                            />
                        </div>
                        {#if state.mask_pattern && state.mask_pattern !== 'Disabled'}
                            <div class="setting-item">
                                <label class="setting-label" for="sm-mask-target"
                                    >Mask Target:</label
                                >
                                <Selector
                                    id="sm-mask-target"
                                    options={mask_target_options}
                                    value={state.mask_target}
                                    on:change={handleMaskTarget}
                                />
                            </div>
                            <div class="setting-item">
                                <label class="setting-label" for="sm-mask-strength">Strength:</label
                                >
                                <NumberDragBox
                                    id="sm-mask-strength"
                                    value={state.mask_strength}
                                    min={0.0}
                                    max={1.0}
                                    step={0.01}
                                    on:change={async (e) => {
                                        if (state) {
                                            state.mask_strength = e.detail;
                                            try {
                                                await invoke('update_simulation_state', {
                                                    stateName: 'mask_strength',
                                                    value: e.detail,
                                                });
                                            } catch (err) {
                                                console.error(
                                                    'Failed to update mask strength:',
                                                    err
                                                );
                                            }
                                        }
                                    }}
                                />
                            </div>
                            <div class="setting-item">
                                <label class="setting-label" for="sm-mask-curve">Mask Curve:</label>
                                <NumberDragBox
                                    id="sm-mask-curve"
                                    value={state.mask_curve}
                                    min={0.2}
                                    max={5.0}
                                    step={0.05}
                                    on:change={async (e) => {
                                        if (state) {
                                            state.mask_curve = e.detail;
                                            try {
                                                await invoke('update_simulation_state', {
                                                    stateName: 'mask_curve',
                                                    value: e.detail,
                                                });
                                            } catch (err) {
                                                console.error('Failed to update mask curve:', err);
                                            }
                                        }
                                    }}
                                />
                            </div>
                            <div class="setting-item">
                                <label class="checkbox">
                                    <input
                                        type="checkbox"
                                        checked={state.mask_mirror_horizontal}
                                        on:change={(e) =>
                                            handleMaskMirrorHorizontal(
                                                (e.target as HTMLInputElement).checked
                                            )}
                                    />
                                    Mirror horizontal
                                </label>
                            </div>
                            <div class="setting-item">
                                <label class="checkbox">
                                    <input
                                        type="checkbox"
                                        checked={state.mask_mirror_vertical || false}
                                        on:change={(e) =>
                                            handleMaskMirrorVertical(
                                                (e.target as HTMLInputElement).checked
                                            )}
                                    />
                                    Mirror vertical
                                </label>
                            </div>
                            <div class="setting-item">
                                <label class="checkbox">
                                    <input
                                        type="checkbox"
                                        checked={state.mask_invert_tone || false}
                                        on:change={(e) =>
                                            handleMaskInvertTone(
                                                (e.target as HTMLInputElement).checked
                                            )}
                                    />
                                    Invert tone
                                </label>
                            </div>
                            {#if state.mask_pattern === 'Image'}
                                <ImageSelector
                                    fitMode={state.mask_image_fit_mode}
                                    loadCommand="load_slime_mold_mask_image"
                                    onFitModeChange={(value) => updateMaskImageFitMode(value)}
                                />
                                <!--
                                    No WebcamControls here. Webcam is an
                                    explicitly omitted feature of the browser
                                    port (WEB_PORT.md, "Omitted features"), so
                                    `get_available_webcam_devices` returns []
                                    forever and the Start button rendered
                                    permanently greyed out — a control
                                    advertising a capability the app does not
                                    have. Removed rather than disabled, as M4
                                    did for Gray-Scott and M5 for Vectors.

                                    Note this mode's enumeration command is the
                                    *unprefixed* `get_available_webcam_devices`
                                    (commands/slime_mold.rs:210). The name looks
                                    shared; it is not — Flow and Moiré have
                                    their own prefixed ones — so its stub is
                                    gone from registry.ts with the panel.
                                -->
                            {/if}
                        {/if}
                    </div>
                </div>
            </fieldset>
        </form>
    {/if}
</SimulationLayout>

<!-- Shared camera controls component -->
<CameraControls enabled={true} on:toggleGui={toggleBackendGui} on:togglePause={togglePause} />

<script lang="ts">
    import { createEventDispatcher, onMount, onDestroy } from 'svelte';
    import { invoke } from '$lib/rpc';
    import { listen } from '$lib/rpc';
    import SimulationLayout from './components/shared/SimulationLayout.svelte';
    import CameraControls from './components/shared/CameraControls.svelte';
    import CollapsibleFieldset from './components/shared/CollapsibleFieldset.svelte';
    import PresetFieldset from './components/shared/PresetFieldset.svelte';
    import PostProcessingMenu from './components/shared/PostProcessingMenu.svelte';
    import ControlsPanel from './components/shared/ControlsPanel.svelte';
    import ButtonSelect from './components/inputs/ButtonSelect.svelte';
    import Button from './components/shared/Button.svelte';
    import AgentCountInput from './components/slime-mold/AgentCountInput.svelte';
    import NumberDragBox from './components/inputs/NumberDragBox.svelte';
    import Selector from './components/inputs/Selector.svelte';
    import ImageSelector from './components/shared/ImageSelector.svelte';
    import {
        clampSlimeMoldAgentCount,
        MASK_PATTERNS,
        MASK_TARGETS,
        POSITION_GENERATORS,
        SLIME_MOLD_DEFAULT_AGENTS,
        type MaskPattern,
        type MaskTarget,
        type PositionGenerator,
    } from '$lib/engine/sims/slimeMold/settings';
    import { SPEC_MINIMUM_SLIME_MOLD_AGENTS } from '$lib/engine/gpu/limits';
    import { AutoHideManager, createAutoHideEventListeners } from './utils/autoHide';
    import { createSyncManager } from './utils/sync';
    import './shared-theme.css';
    import ColorSchemeSelector from './components/shared/ColorSchemeSelector.svelte';

    const dispatch = createEventDispatcher();

    export let menuPosition: string = 'middle';
    export let autoHideDelay: number = 3000;

    // Settings type (matches src-tauri/src/simulations/slime_mold/settings.rs)
    type Settings = {
        // Agent parameters
        agent_jitter: number;
        agent_possible_starting_headings: [number, number];
        agent_sensor_angle: number; // radians
        agent_sensor_distance: number;
        agent_speed_max: number;
        agent_speed_min: number;
        agent_turn_rate: number; // radians per second

        // Pheromone parameters
        pheromone_decay_rate: number;
        pheromone_deposition_rate: number;
        pheromone_diffusion_rate: number;

        // Position image fit mode
        position_image_fit_mode: string;

        // Update frequencies and randomness
        diffusion_frequency: number;
        decay_frequency: number;
        random_seed: number;

        /**
         * `"Black"` / `"White"`, not the lowercase this used to claim.
         *
         * Three spellings exist (settings.rs:75): serde's capitalised pair,
         * which is what `get_settings` emits and what a preset carries;
         * `as_str()`'s lowercase pair; and
         * `update_slime_mold_background_mode`'s lowercase match arm. Nothing in
         * this menu renders the field, so the lie was invisible — but the
         * engine's `BACKGROUND_MODES` is the serde spelling, so this is now the
         * same string on both sides.
         */
        background_mode: 'Black' | 'White';
    };

    // State type (matches src-tauri/src/simulations/slime_mold/state.rs, plus
    // the three model-level fields get_state folds in — see SlimeMoldState).
    type State = {
        // Mask system state
        mask_pattern: MaskPattern;
        mask_target: MaskTarget;
        mask_strength: number;
        mask_curve: number;
        mask_reversed: boolean;
        mask_image_fit_mode: string;
        mask_mirror_horizontal: boolean;
        mask_mirror_vertical: boolean;
        mask_invert_tone: boolean;

        // Current color scheme state (runtime)
        current_color_scheme: string;
        color_scheme_reversed: boolean;

        // Cursor interaction parameters
        cursor_size: number;
        cursor_strength: number;

        // Position generator
        position_generator: PositionGenerator;

        // Agent pool size. Not a Settings field on either side: the Rust holds
        // it on the model (simulation.rs:133) and get_state folds it in.
        agent_count: number;

        // UI visibility state
        gui_visible: boolean;

        // Camera state (position and zoom)
        camera_position: [number, number];
        camera_zoom: number;

        // Simulation runtime state
        simulation_time: number;
        is_running: boolean;
    };

    // Simulation state
    let settings: Settings | undefined = undefined;
    let state: State | undefined = undefined;

    // Create sync manager for type-safe backend synchronization
    const syncManager = createSyncManager<Settings, State>();

    /**
     * The three option lists, taken from the engine rather than retyped.
     *
     * They have to be *character-identical* to what `get_current_state` returns
     * — `Selector.svelte` compares with `options.includes(value)` and
     * `ButtonSelect` renders `<option value=…>` — and two of the three were
     * not. `MaskPattern`/`MaskTarget` happened to agree here (`get_state` emits
     * `as_str()`, which is the display spelling, so unlike Gray-Scott this pair
     * was already correct), but the position generator listed *serde's*
     * spelling: `'UniformCircle'` against the `'Uniform Circle'` the backend
     * both emits and accepts. After any state sync that select fell back to its
     * placeholder, and the value it sent parsed as nothing — which on the
     * desktop means `from_str` returns None and the generator silently resets
     * to Random (position_generators.rs:155, simulation.rs:1450).
     *
     * Importing is what stops the two copies drifting again, exactly as
     * `GrayScottMode` does since M4.
     */
    const mask_pattern_options: string[] = [...MASK_PATTERNS];
    const mask_target_options: string[] = [...MASK_TARGETS];
    const position_generator_options = POSITION_GENERATORS.map((name) => ({
        value: name,
        label: name,
        buttonAction: 'randomize',
    }));

    // Agent count tracked separately (not part of preset settings)
    let currentAgentCount = SLIME_MOLD_DEFAULT_AGENTS;

    /**
     * The device ceiling, in agents.
     *
     * Fetched rather than constant: it is derived from the granted
     * `maxStorageBufferBindingSize` (gpu/limits.ts), so only the engine knows
     * it. The initial value is the ceiling every conformant implementation must
     * honour, which is the honest answer for the tick before the reply lands
     * and the permanent answer on a browser with no WebGPU at all.
     */
    let agent_count_cap = SPEC_MINIMUM_SLIME_MOLD_AGENTS;

    // Preset and color scheme state
    let current_preset = '';
    let available_presets: string[] = [];
    let available_luts: string[] = [];

    // UI state
    let show_about_section = false;

    // Simulation control state
    let running = false;
    let loading = false;
    let showUI = true;
    let currentFps = 0;
    let controlsVisible = true;

    // Auto-hide manager
    let autoHideManager: AutoHideManager;
    let eventListeners: { add: () => void; remove: () => void };

    // Event listeners
    let unlistenFps: (() => void) | null = null;

    // Camera controls

    let isMousePressed = false;
    let currentMouseButton = 0;

    /**
     * Set by `onDestroy`, checked by everything that resumes after an `await`.
     *
     * `onMount` here is one long await chain — start, presets, colour schemes,
     * three syncs — and `listen('fps-update')` is at the end of it. Navigating
     * away before that resolves used to register the listener *after* teardown
     * had run, so it was never unsubscribed and went on writing `currentFps`
     * into a destroyed component for the life of the page. M6 found the same
     * class of bug in the gradient editor's debounced preview.
     */
    let destroyed = false;

    async function returnToMenu() {
        try {
            await invoke('destroy_simulation');
            dispatch('back');
        } catch (error) {
            console.error('Failed to return to menu:', error);
        }
    }

    async function toggleBackendGui() {
        try {
            await invoke('toggle_gui');
            // Toggle local state directly instead of relying on backend state
            showUI = !showUI;

            // Update auto-hide manager state and handle UI toggle
            if (autoHideManager) {
                autoHideManager.updateState({ showUI, running });
                autoHideManager.handleUIToggle(showUI);
            }
        } catch (error) {
            console.error('Failed to toggle GUI:', error);
        }
    }

    async function stopSimulation() {
        try {
            await invoke('pause_simulation');
            running = false;

            // Update auto-hide manager state and handle pause
            if (autoHideManager) {
                autoHideManager.updateState({ running });
                autoHideManager.handlePause();
            }
        } catch (error) {
            console.error('Failed to stop simulation:', error);
        }
    }

    async function resumeSimulation() {
        try {
            await invoke('resume_simulation');
            running = true;

            // Update auto-hide manager state and handle resume
            if (autoHideManager) {
                autoHideManager.updateState({ running });
                autoHideManager.handleResume();
            }
        } catch (error) {
            console.error('Failed to resume simulation:', error);
        }
    }

    async function togglePause() {
        if (running) {
            await stopSimulation();
        } else {
            await resumeSimulation();
        }
    }

    // Helper function to convert agent count to millions.
    // `fromMillions` rounds: 3.774873 * 1e6 is 3774872.9999999995 in binary
    // floating point, and the clamp floors, so a bare multiply loses one agent
    // on every trip through the box.
    const toMillions = (count: number) => count / 1_000_000;
    const fromMillions = (millions: number) => Math.round(millions * 1_000_000);

    // Computed values
    $: agent_count_millions = toMillions(currentAgentCount);

    /**
     * The clamp happens three times and each one earns its place.
     *
     * `AgentCountInput` clamps so the user is *told* what happened, this clamps
     * so nothing that bypasses the control (a restored value, a future preset)
     * reaches the command, and `handlers/slimeMold.ts` clamps because it is the
     * last thing before a `createBuffer` that would otherwise lose the device.
     */
    async function updateAgentCount(millions: number) {
        const requested = clampSlimeMoldAgentCount(fromMillions(millions), agent_count_cap);
        try {
            await invoke('update_agent_count', { count: requested });
            await syncAgentCountFromBackend();
        } catch (e) {
            console.error('Failed to update agent count:', e);
        }
    }

    /**
     * Reverse the colour scheme through the colour-scheme command, not through
     * a bare state write.
     *
     * `update_simulation_state('color_scheme_reversed')` puts the flag in the
     * state document but pushes no LUT: the bytes live in `ColorSchemeManager`
     * and only `toggle_color_scheme_reversed` re-derives and hands them to the
     * simulation (handlers/colorSchemes.ts). So the checkbox moved and the
     * picture did not. Same shape as the `updateLutName` defect below.
     */
    async function updateLutReversed() {
        try {
            await invoke('toggle_color_scheme_reversed');
            await syncAllFromBackend();
        } catch (e) {
            console.error('Failed to toggle color scheme reversed:', e);
        }
    }

    // Cursor configuration handlers
    async function updateCursorSize(size: number) {
        const result = await syncManager.updateStateOptimistic(
            state,
            'cursor_size',
            size,
            true // sync from backend after update
        );
        if (result) state = result;
    }

    async function updateCursorStrength(strength: number) {
        const result = await syncManager.updateStateOptimistic(
            state,
            'cursor_strength',
            strength,
            true // sync from backend after update
        );
        if (result) state = result;
    }

    async function handleMaskPattern(e: CustomEvent) {
        const value = e.detail.value;
        if (state) {
            state.mask_pattern = value;
            try {
                await invoke('update_simulation_state', {
                    stateName: 'mask_pattern',
                    value: state.mask_pattern,
                });
            } catch (err) {
                console.error('Failed to update mask pattern:', err);
            }
        }
    }

    async function handleMaskTarget(e: CustomEvent) {
        const value = e.detail.value;
        if (state) {
            state.mask_target = value;
            try {
                await invoke('update_simulation_state', {
                    stateName: 'mask_target',
                    value: state.mask_target,
                });
            } catch (err) {
                console.error('Failed to update mask target:', err);
            }
        }
    }

    async function handleMaskMirrorHorizontal(checked: boolean) {
        if (state) {
            state.mask_mirror_horizontal = checked;
            try {
                await invoke('update_simulation_state', {
                    stateName: 'mask_mirror_horizontal',
                    value: state.mask_mirror_horizontal,
                });
            } catch (err) {
                console.error('Failed to update mask mirror horizontal:', err);
            }
        }
    }

    async function handleMaskMirrorVertical(checked: boolean) {
        if (state) {
            state.mask_mirror_vertical = checked;
            try {
                await invoke('update_simulation_state', {
                    stateName: 'mask_mirror_vertical',
                    value: state.mask_mirror_vertical,
                });
            } catch (err) {
                console.error('Failed to update mask mirror vertical:', err);
            }
        }
    }

    async function handleMaskInvertTone(checked: boolean) {
        if (state) {
            state.mask_invert_tone = checked;
            try {
                await invoke('update_simulation_state', {
                    stateName: 'mask_invert_tone',
                    value: state.mask_invert_tone,
                });
            } catch (err) {
                console.error('Failed to update mask invert tone:', err);
            }
        }
    }

    /**
     * The two angle boxes show degrees and the backend stores radians.
     *
     * They used to carry *two* `on:change` directives — one converting into
     * `settings!` and one invoking — which Svelte runs both of, so it worked,
     * but the conversion was written twice with only the comment to say the
     * two constants had to agree. One handler, one conversion.
     */
    async function setRadians(
        name: 'agent_turn_rate' | 'agent_sensor_angle',
        degrees: number,
        label: string
    ) {
        if (!settings) return;
        const radians = (degrees * Math.PI) / 180;
        settings = { ...settings, [name]: radians };
        try {
            await invoke('update_simulation_setting', { settingName: name, value: radians });
            await syncSettingsFromBackend();
        } catch (err) {
            console.error(`Failed to update ${label}:`, err);
        }
    }

    /**
     * `update_simulation_state`, deliberately, though the Rust has no such arm.
     *
     * On the desktop this select reaches `update_state`'s `_ =>` fallback,
     * which warns and returns `Ok(())` (simulation.rs:2630) — so the whole
     * "Agent Position Generator" control does nothing, every reset re-seeds
     * with `Random`, and the Image generator (with its own file picker and fit
     * mode) is unreachable. The generator *is* in `update_setting`, but it is
     * not a `Settings` field: `get_settings` never returns it and `get_state`
     * does. The port puts the write where the read is, and
     * `updateSlimeMoldState` has the matching arm.
     */
    async function updatePositionGenerator(value: string) {
        if (!state) return;
        state = { ...state, position_generator: value as PositionGenerator };
        try {
            await invoke('update_simulation_state', {
                stateName: 'position_generator',
                value,
            });
        } catch (err) {
            console.error('Failed to update position generator:', err);
        }
    }

    /** "Reset Agents" re-seeds the pool *and* blanks the trails it left. */
    async function resetAgents() {
        try {
            await invoke('reset_agents');
            await invoke('reset_trails');
        } catch (err) {
            console.error('Failed to reset agents:', err);
        }
    }

    /**
     * The two fit modes go to different documents because that is where the two
     * fields live — see `handlers/slimeMold.ts`. Both keep their dedicated
     * command rather than being folded into `update_simulation_setting`,
     * because each has to re-fit an *already decoded* image, which the plain
     * setter has no reason to do.
     */
    async function updatePositionImageFitMode(value: string) {
        if (!settings) return;
        settings = { ...settings, position_image_fit_mode: value };
        try {
            await invoke('set_slime_mold_position_image_fit_mode', { fitMode: value });
        } catch (err) {
            console.error('Failed to update position image fit mode:', err);
        }
    }

    async function updateMaskImageFitMode(value: string) {
        if (!state) return;
        state = { ...state, mask_image_fit_mode: value };
        try {
            await invoke('set_slime_mold_mask_image_fit_mode', { fitMode: value });
        } catch (err) {
            console.error('Failed to update mask image fit mode:', err);
        }
    }

    async function updatePreset(value: string) {
        current_preset = value;
        try {
            await invoke('apply_preset', { presetName: value });
            await invoke('reset_trails'); // Clear all existing trails
            await syncSettingsFromBackend(); // Sync UI with new settings
            // Reset agents asynchronously to avoid blocking the UI
            invoke('reset_agents').catch((e) => console.error('Failed to reset agents:', e));
            console.log(`Applied preset: ${value}`);
        } catch (e) {
            console.error('Failed to apply preset:', e);
        }
    }

    async function savePreset(presetName: string) {
        try {
            await invoke('save_preset', { presetName: presetName.trim() });
            // Refresh the available presets list
            await loadAvailablePresets();
            // Set the current preset to the newly saved one
            current_preset = presetName.trim();
            console.log(`Saved preset: ${presetName}`);
        } catch (e) {
            console.error('Failed to save preset:', e);
        }
    }

    // Load available presets from backend
    async function loadAvailablePresets() {
        try {
            available_presets = await invoke('get_presets_for_simulation_type', {
                simulationType: 'slime_mold',
            });
            console.log('Available presets loaded:', available_presets);
            if (available_presets.length > 0 && !current_preset) {
                current_preset = available_presets[0];
                console.log('Set initial preset to:', current_preset);
            }
        } catch (e) {
            console.error('Failed to load available presets:', e);
        }
    }

    // Load available color schemes from backend
    async function loadAvailableLuts() {
        try {
            available_luts = await invoke('get_available_color_schemes');
            console.log('Available color schemes loaded:', available_luts.length);
        } catch (e) {
            console.error('Failed to load available color schemes:', e);
        }
    }

    // Sync settings from backend to frontend
    async function syncSettingsFromBackend() {
        const synced = await syncManager.syncSettings();
        if (synced && !destroyed) settings = synced;
    }

    // Sync state from backend to frontend
    async function syncStateFromBackend() {
        const synced = await syncManager.syncState();
        if (synced && !destroyed) state = synced;
    }

    async function syncAllFromBackend() {
        const synced = await syncManager.syncAll();
        if (destroyed) return;
        if (synced.settings) settings = synced.settings;
        if (synced.state) state = synced.state;
    }

    /**
     * The device ceiling. Asked for once, on mount.
     *
     * A failure here is not fatal — `agent_count_cap` keeps the spec-minimum
     * value it was initialised with, which is a legal ceiling on any conformant
     * device, so the control degrades to conservative rather than to unbounded.
     */
    async function loadAgentCountCap() {
        try {
            const cap = await invoke('get_agent_count_limit');
            if (typeof cap === 'number' && cap > 0 && !destroyed) agent_count_cap = cap;
        } catch (e) {
            console.error('Failed to read the agent-count limit:', e);
        }
    }

    /**
     * Clamped on the way *in* as well as on the way out.
     *
     * A count that arrives above this device's ceiling — from a session started
     * on a machine with a larger `maxStorageBufferBindingSize`, or from the
     * desktop's 10 M default — would otherwise be displayed as achievable.
     */
    async function syncAgentCountFromBackend() {
        try {
            const agentCount = await invoke('get_current_agent_count');
            if (typeof agentCount === 'number' && !destroyed) {
                currentAgentCount = clampSlimeMoldAgentCount(agentCount, agent_count_cap);
            }
        } catch (e) {
            console.error('Failed to sync agent count from backend:', e);
        }
    }

    /*
     * `loadWebcamDevices`, `startWebcamCapture` and `stopWebcamCapture` used to
     * live here, invoking `get_available_webcam_devices`,
     * `start_slime_mold_webcam_capture` and `stop_slime_mold_webcam_capture`.
     * All three are gone with the panel — see the note beside the mask
     * ImageSelector — and so are their registry stubs, because
     * test/unit/registry.test.ts fails on a handler nothing calls.
     */

    async function startSimulation() {
        if (running || loading) return;

        loading = true;

        try {
            await invoke('start_slime_mold_simulation');
            loading = false;
            running = true;

            // Backend now handles the render loop, we just track state
            currentFps = 0;
        } catch (e) {
            console.error('Failed to start simulation:', e);
            loading = false;
            running = false;
        }
    }

    onMount(async () => {
        // Initialize auto-hide manager
        autoHideManager = new AutoHideManager(
            {
                controlsVisible,
                cursorHidden: false,
                showUI,
                running,
            },
            {
                onControlsShow: () => {
                    controlsVisible = true;
                },
                onControlsHide: () => {
                    controlsVisible = false;
                },
                onCursorShow: () => {
                    document.body.style.cursor = '';
                },
                onCursorHide: () => {
                    document.body.style.cursor = 'none';
                },
            },
            {
                autoHideDelay,
                cursorHideDelay: 2000,
            }
        );

        // Create event listeners
        eventListeners = createAutoHideEventListeners(() => {
            autoHideManager.handleUserInteraction();
        });
        eventListeners.add();

        /*
         * Subscribed first, and synchronously enough that teardown can always
         * find it. Everything below is awaited, so a user who clicks Back
         * during the start would otherwise register this listener *after*
         * onDestroy had already run and looked for it.
         */
        listen('fps-update', (event: { payload: number }) => {
            if (!destroyed) currentFps = event.payload as number;
        }).then((unlisten) => {
            if (destroyed) unlisten();
            else unlistenFps = unlisten;
        });

        // Start the simulation first
        await startSimulation();

        // Load available presets and color schemes
        await loadAvailablePresets();
        await loadAvailableLuts();

        // Sync settings and state from backend
        await loadAgentCountCap();
        await syncSettingsFromBackend();
        await syncStateFromBackend();
        await syncAgentCountFromBackend();
    });

    onDestroy(async () => {
        // Set before the first await: every resumable path below and in the
        // sync helpers checks it.
        destroyed = true;

        if (unlistenFps) {
            unlistenFps();
            unlistenFps = null;
        }

        // Clean up the simulation
        try {
            await invoke('destroy_simulation');
        } catch (error) {
            console.error('Failed to destroy simulation on component destroy:', error);
        }

        // Clean up auto-hide functionality
        if (eventListeners) {
            eventListeners.remove();
        }
        if (autoHideManager) {
            autoHideManager.cleanup();
        }
    });

    /**
     * The colour-scheme round trip, which was broken here in the *opposite*
     * direction from Gray-Scott's and Vectors'.
     *
     * Those two called only `apply_color_scheme_by_name`, which pushes LUT
     * bytes but writes no name, so the `<Selector>` — which binds
     * `state.current_color_scheme` — reverted on the next sync. Slime Mold
     * called only `update_simulation_state`, which writes the name and pushes
     * no bytes: the selection stuck and *the picture never changed*. Same
     * missing half of the same pair, and the harder one to notice, because the
     * control looks right.
     *
     * Both calls, in that order, then one sync. `color_scheme_reversed` is
     * carried by the `updateColorScheme` seam itself, so it needs no
     * equivalent — see `updateLutReversed`.
     */
    async function updateLutName(value: string) {
        if (!state) return;
        state = { ...state, current_color_scheme: value };
        try {
            await invoke('apply_color_scheme_by_name', { colorSchemeName: value });
            await invoke('update_simulation_state', {
                stateName: 'current_color_scheme',
                value,
            });
            await syncAllFromBackend();
        } catch (e) {
            console.error('Failed to update color scheme:', e);
        }
    }

    async function handleMouseEvent(e: CustomEvent) {
        const event = e.detail as MouseEvent | WheelEvent;

        // Attracting agents counts as using the app; without this the
        // auto-hide timer was only reset by interaction with the *menu*, so
        // the controls faded out mid-stroke. GrayScottMode does the same.
        autoHideManager?.handleUserInteraction();

        if (event.type === 'wheel') {
            const wheelEvent = event as WheelEvent;
            wheelEvent.preventDefault();

            const zoomDelta = -wheelEvent.deltaY * 0.001;

            // Convert screen coordinates to physical coordinates
            const devicePixelRatio = window.devicePixelRatio || 1;
            const physicalCursorX = wheelEvent.clientX * devicePixelRatio;
            const physicalCursorY = wheelEvent.clientY * devicePixelRatio;

            try {
                await invoke('zoom_camera_to_cursor', {
                    delta: zoomDelta,
                    cursorX: physicalCursorX,
                    cursorY: physicalCursorY,
                });
            } catch (e) {
                console.error('Failed to zoom camera to cursor:', e);
            }
        } else if (event.type === 'mousedown') {
            const mouseEvent = event as MouseEvent;
            mouseEvent.preventDefault();

            isMousePressed = true;
            currentMouseButton = mouseEvent.button;

            // Convert screen coordinates to world coordinates
            const devicePixelRatio = window.devicePixelRatio || 1;
            const physicalCursorX = mouseEvent.clientX * devicePixelRatio;
            const physicalCursorY = mouseEvent.clientY * devicePixelRatio;

            console.log(
                `Mouse interaction at screen coords: (${physicalCursorX}, ${physicalCursorY}), raw: (${mouseEvent.clientX}, ${mouseEvent.clientY})`
            );

            try {
                await invoke('handle_mouse_interaction_screen', {
                    screenX: physicalCursorX,
                    screenY: physicalCursorY,
                    mouseButton: mouseEvent.button,
                });
            } catch (e) {
                console.error('Failed to handle mouse interaction:', e);
            }
        } else if (event.type === 'mousemove') {
            if (isMousePressed) {
                const mouseEvent = event as MouseEvent;
                mouseEvent.preventDefault();

                // Convert screen coordinates to world coordinates
                const devicePixelRatio = window.devicePixelRatio || 1;
                const physicalCursorX = mouseEvent.clientX * devicePixelRatio;
                const physicalCursorY = mouseEvent.clientY * devicePixelRatio;

                // Use the same button state as when mouse was first pressed
                try {
                    await invoke('handle_mouse_interaction_screen', {
                        screenX: physicalCursorX,
                        screenY: physicalCursorY,
                        mouseButton: currentMouseButton,
                    });
                } catch (e) {
                    console.error('Failed to handle mouse interaction:', e);
                }
            }
        } else if (event.type === 'mouseup') {
            // Only handle mouseup if we were actually tracking a mouse press
            if (isMousePressed) {
                isMousePressed = false;

                // Stop cursor interaction when mouse is released
                try {
                    await invoke('handle_mouse_release', { mouseButton: currentMouseButton });
                } catch (e) {
                    console.error('Failed to stop mouse interaction:', e);
                }
            }
        } else if (event.type === 'contextmenu') {
            // Handle context menu as right-click for simulation interaction
            const mouseEvent = event as MouseEvent;

            // Convert screen coordinates to world coordinates
            const devicePixelRatio = window.devicePixelRatio || 1;
            const physicalCursorX = mouseEvent.clientX * devicePixelRatio;
            const physicalCursorY = mouseEvent.clientY * devicePixelRatio;

            console.log(
                `Slime Mold context menu interaction at screen coords: (${physicalCursorX}, ${physicalCursorY}), button: 2`
            );

            // Track as active right-button press to ensure release is generated later
            isMousePressed = true;
            currentMouseButton = 2;

            try {
                await invoke('handle_mouse_interaction_screen', {
                    screenX: physicalCursorX,
                    screenY: physicalCursorY,
                    mouseButton: 2, // Right mouse button
                });
            } catch (e) {
                console.error('Failed to handle Slime Mold context menu interaction:', e);
            }
        }
    }
</script>

<style>
    /* SlimeMold specific styles */

    fieldset {
        border: 1px solid #ccc;
        border-radius: 4px;
        padding: 0.5rem;
        margin-bottom: 0.5rem;
    }

    legend {
        font-weight: bold;
        padding: 0 0.3rem;
    }

    .control-group {
        margin-bottom: 0.5rem;
    }

    label {
        display: block;
        margin-bottom: 0.25rem;
    }

    /* Key/Value pair settings layout */
    .settings-grid {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 0.15rem 0.3rem;
        width: 100%;
    }

    .setting-item {
        display: contents;
    }

    .setting-label {
        font-weight: 500;
        color: rgba(255, 255, 255, 0.9);
        padding: 0.5rem 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }

    .setting-item:last-child .setting-label {
        border-bottom: none;
    }

    .visually-hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        margin: -1px;
        border: 0;
        padding: 0;
        white-space: nowrap;
        clip-path: inset(100%);
        clip: rect(0 0 0 0);
    }

    /* Settings section styling */
    .settings-section {
        margin-bottom: 1.5rem;
    }

    .settings-section:last-child {
        margin-bottom: 0;
    }

    .section-header {
        font-size: 1rem;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.9);
        margin: 0 0 0.75rem 0;
        padding: 0.25rem 0;
        border-bottom: 1px solid rgba(255, 255, 255, 0.2);
    }
</style>
