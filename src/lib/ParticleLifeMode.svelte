<SimulationLayout
    simulationName="Particle Life"
    running={isSimulationRunning}
    loading={isLoading || !settings || !state || !isInitialized}
    {showUI}
    currentFps={fps_display}
    {controlsVisible}
    {menuPosition}
    on:back={() => dispatch('back')}
    on:toggleUI={toggleBackendGui}
    on:pause={pauseSimulation}
    on:resume={resumeSimulation}
    on:userInteraction={() => autoHideManager?.handleUserInteraction()}
    on:mouseEvent={handleMouseEvent}
>
    {#if settings && state}
        <form on:submit|preventDefault>
            <!-- About this simulation -->
            <CollapsibleFieldset title="About this simulation" bind:open={show_about_section}>
                <p>
                    Particle Life is a simulation where particles of different species interact with
                    each other based on a force matrix. Each species can attract, repel, or remain
                    neutral towards other species, creating complex emergent behaviors and beautiful
                    patterns.
                </p>
                <p>
                    The simulation features up to 8 different species, each with their own color.
                    The interaction matrix below determines how strongly each species attracts or
                    repels others. Positive values create attraction, negative values create
                    repulsion, and values near zero result in neutral behavior.
                </p>
                <p>
                    Experiment with different matrix generators, adjust physics parameters, and
                    watch as simple rules give rise to complex, lifelike behaviors including
                    flocking, clustering, orbital patterns, and dynamic ecosystems.
                </p>
            </CollapsibleFieldset>

            <!-- Presets -->
            <PresetFieldset
                availablePresets={available_presets}
                bind:currentPreset={current_preset}
                placeholder="Select Preset..."
                on:presetChange={({ detail }) => updatePreset(detail.value)}
                on:presetSave={({ detail }) => savePreset(detail.name)}
            />

            <!-- Display Settings -->
            <fieldset>
                <legend>Display Settings</legend>
                <div class="display-controls-grid">
                    <div class="control-group">
                        <label for="colorSchemeSelector">Color Scheme</label>
                        <ColorSchemeSelector
                            bind:available_color_schemes
                            bind:current_color_scheme={state.current_color_scheme}
                            bind:reversed={state.color_scheme_reversed}
                            on:select={(e) => updateColorScheme(e.detail.name)}
                            on:reverse={(e) => updateColorSchemeReversed(e.detail.reversed)}
                        />
                    </div>
                    <div class="control-group">
                        <Selector
                            options={background_color_mode_options}
                            bind:value={state.background_color_mode}
                            label="Background Color Mode"
                            on:change={({ detail }) => updateColorMode(detail.value)}
                        />
                    </div>
                    <div class="control-group">
                        <label>
                            <input
                                type="checkbox"
                                checked={state.traces_enabled}
                                on:change={(e) =>
                                    updateTracesEnabled((e.target as HTMLInputElement).checked)}
                            />
                            Enable Particle Traces
                        </label>
                    </div>
                    {#if state.traces_enabled}
                        <div class="control-group">
                            <label for="traceFade">Trace Fade</label>
                            <input
                                type="range"
                                id="traceFade"
                                value={state.trace_fade}
                                min="0"
                                max="1"
                                step="0.01"
                                on:input={(e) =>
                                    updateTraceFade(
                                        parseFloat((e.target as HTMLInputElement).value)
                                    )}
                            />
                            <span class="range-value">{state.trace_fade.toFixed(2)}</span>
                        </div>
                        <div class="control-group">
                            <Button
                                variant="warning"
                                on:click={clearTrails}
                                title="Clear all particle trails"
                            >
                                Clear Trails
                            </Button>
                        </div>
                    {/if}
                </div>
            </fieldset>

            <!-- Post Processing -->
            <PostProcessingMenu simulationType="particle_life" />

            <!-- Controls -->
            <ControlsPanel
                mouseInteractionText="🖱️ Left click: Attract | Right click: Repel"
                cursorSize={state.cursor_size}
                cursorStrength={state.cursor_strength}
                sizeMin={0.05}
                sizeMax={1.0}
                sizeStep={0.05}
                strengthMin={0}
                strengthMax={PARTICLE_LIFE_MAX_CURSOR_STRENGTH}
                strengthStep={0.5}
                sizePrecision={2}
                strengthPrecision={1}
                on:cursorSizeChange={(e) => updateCursorSize(e.detail)}
                on:cursorStrengthChange={(e) => updateCursorStrength(e.detail)}
                on:navigate={(e) => dispatch('navigate', e.detail)}
            />

            <!-- Settings -->
            <fieldset>
                <legend>Settings</legend>
                <div class="control-group">
                    <Button variant="primary" on:click={resetSimulation}
                        >Regenerate Particles</Button
                    >
                    <ButtonSelect
                        value={state.matrix_generator}
                        buttonText="Regenerate Matrix"
                        placeholder="Select matrix generator..."
                        options={matrix_generator_options}
                        on:change={({ detail }) => updateMatrixGenerator(detail.value)}
                        on:buttonclick={async () => {
                            await randomizeMatrix();
                        }}
                    />
                    <ButtonSelect
                        value={state.position_generator}
                        buttonText="Regenerate Positions"
                        placeholder="Select position generator..."
                        options={position_generator_options}
                        on:change={({ detail }) => updatePositionGenerator(detail.value)}
                        on:buttonclick={async () => {
                            await regeneratePositions();
                        }}
                    />
                    <ButtonSelect
                        value={state.type_generator}
                        buttonText="Regenerate Types"
                        placeholder="Select type generator..."
                        options={type_generator_options}
                        on:change={({ detail }) => updateTypeGenerator(detail.value)}
                        on:buttonclick={async () => {
                            await regenerateTypes();
                        }}
                    />
                </div>

                <div class="control-group">
                    <label for="particleCount">Particle Count</label>
                    <NumberDragBox
                        value={state.particle_count}
                        min={PARTICLE_LIFE_MIN_PARTICLES}
                        max={particle_count_cap}
                        step={1000}
                        precision={0}
                        on:change={(e) => updateParticleCount(e.detail)}
                    />

                    <label for="speciesCount">Species Count</label>
                    <NumberDragBox
                        value={settings.species_count}
                        min={2}
                        max={8}
                        step={1}
                        precision={0}
                        on:change={(e) => updateSpeciesCount(e.detail)}
                    />

                    <!--
                        Speed. **The desktop build has no such control** — its
                        `update_setting` has a `"dt"` arm (simulation.rs:3475)
                        that nothing on either build ever reached, so `dt` has
                        been fixed at 0.016 for every user of every version.

                        Here rather than in the Physics fieldset, for two
                        reasons. `InteractivePhysicsDiagram` owns exactly the
                        five `Settings` fields of the force law, and its "Reset
                        to Defaults" writes `Settings::default()` — a `State`
                        field inside it would either have to be swept into that
                        reset, which would stop it being a faithful port, or sit
                        there being ignored by it. And this control-group is
                        already where the two "how much simulation" numbers
                        live, one of them (`particle_count`) also `State`.

                        The range is 0.1x-4x and the ceiling is measured, not
                        chosen: see PARTICLE_LIFE_MIN_SPEED in settings.ts for
                        why nothing here can destabilise and why 4x is
                        nonetheless where the useful range ends.
                    -->
                    <label for="simulationSpeed">Speed</label>
                    <NumberDragBox
                        id="simulationSpeed"
                        value={particleLifeDtToSpeed(state.dt)}
                        min={PARTICLE_LIFE_MIN_SPEED}
                        max={PARTICLE_LIFE_MAX_SPEED}
                        step={0.1}
                        precision={1}
                        unit="x"
                        on:change={(e) => updateSpeed(e.detail)}
                    />
                </div>

                <!-- Interaction Matrix -->
                <div class="control-group">
                    <div class="matrix-info">
                        <p>Click and drag to edit values.</p>
                    </div>
                </div>

                <div class="matrix-and-setup-container">
                    <div class="matrix-section">
                        <InteractionMatrix
                            {settings}
                            {speciesColors}
                            on:matrixUpdate={handleMatrixUpdate}
                            on:matrixTransform={handleMatrixTransform}
                        />
                    </div>
                </div>
            </fieldset>

            <!-- Physics Equation Visualization -->
            <fieldset>
                <legend>Physics</legend>
                <div class="diagram-content">
                    <InteractivePhysicsDiagram
                        maxForce={settings.max_force}
                        maxDistance={settings.max_distance}
                        forceBeta={settings.force_beta}
                        friction={settings.friction}
                        brownianMotion={settings.brownian_motion}
                        on:update={(e) => updateSetting(e.detail.setting, e.detail.value)}
                    />
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
    import Button from './components/shared/Button.svelte';
    import NumberDragBox from './components/inputs/NumberDragBox.svelte';
    import ColorSchemeSelector from './components/shared/ColorSchemeSelector.svelte';
    import InteractivePhysicsDiagram from './components/particle-life/InteractivePhysicsDiagram.svelte';
    import InteractionMatrix from './components/particle-life/InteractionMatrix.svelte';
    import SimulationLayout from './components/shared/SimulationLayout.svelte';
    import Selector from './components/inputs/Selector.svelte';
    import ButtonSelect from './components/inputs/ButtonSelect.svelte';
    import CameraControls from './components/shared/CameraControls.svelte';
    import CollapsibleFieldset from './components/shared/CollapsibleFieldset.svelte';
    import PresetFieldset from './components/shared/PresetFieldset.svelte';
    import PostProcessingMenu from './components/shared/PostProcessingMenu.svelte';
    import ControlsPanel from './components/shared/ControlsPanel.svelte';
    import { AutoHideManager, createAutoHideEventListeners } from './utils/autoHide';
    import { createSyncManager } from './utils/sync';
    import {
        BACKGROUND_COLOR_MODES,
        PARTICLE_LIFE_MAX_SPEED,
        PARTICLE_LIFE_MIN_PARTICLES,
        PARTICLE_LIFE_MIN_SPEED,
        PARTICLE_LIFE_PARTICLE_CEILING,
        POSITION_GENERATORS,
        TYPE_GENERATORS,
        clampParticleCount,
        particleLifeDtToSpeed,
        particleLifeSpeedToDt,
    } from '$lib/engine/sims/particleLife/settings';
    import { MATRIX_GENERATORS } from '$lib/engine/sims/particleLife/matrix';
    import './shared-theme.css';

    const dispatch = createEventDispatcher();

    /**
     * Every option list comes from the engine, none is spelled out here.
     *
     * The four enums each existed twice — once in this file's `<ButtonSelect>`
     * markup and once in the Rust's `update_setting` match — and the copies had
     * already drifted: the position list offered **seven** of eleven variants,
     * leaving `RainbowRing`, `ColorBattle`, `ColorWheel` and `RainbowSpiral`
     * unreachable despite all four being fully implemented in `init.wgsl` and
     * dispatched by its `switch` at :283. That is the M4 mask-enum defect
     * again, and the fix is the one M4 settled on: one list, in the engine,
     * imported here.
     *
     * `PascalCase` is what goes on the wire — `update_setting` matches on it and
     * `get_state` emits it — so the label is only cosmetic. It is the value with
     * spaces inserted before interior capitals, which turns `StripesH` into
     * "Stripes H" and `RockPaperScissors` into "Rock Paper Scissors" without a
     * second table to keep in step.
     */
    function optionsFor(values: readonly string[]) {
        return values.map((value) => ({
            value,
            label: value.replace(/([a-z0-9])([A-Z])/g, '$1 $2'),
        }));
    }

    const position_generator_options = optionsFor(POSITION_GENERATORS);
    const type_generator_options = optionsFor(TYPE_GENERATORS);
    const matrix_generator_options = optionsFor(MATRIX_GENERATORS);
    const background_color_mode_options = [...BACKGROUND_COLOR_MODES];

    /**
     * `state.cursor_strength` is clamped to 10 by the backend
     * (simulation.rs:3487) and the slider advertised **20**, so the top half of
     * it was inert — the handle moved, the number changed, and every value past
     * 10 produced the same force. The Rust's clamp is the honest ceiling.
     */
    const PARTICLE_LIFE_MAX_CURSOR_STRENGTH = 10;

    export let menuPosition: string = 'middle';
    export let autoHideDelay: number = 3000;

    interface Settings {
        species_count: number;
        force_matrix: number[][];
        max_force: number;
        max_distance: number;
        friction: number;
        wrap_edges: boolean;
        force_beta: number;
        brownian_motion: number;
    }

    interface State {
        particle_count: number;
        random_seed: number;
        dt: number;
        cursor_size: number;
        cursor_strength: number;
        traces_enabled: boolean;
        trace_fade: number;
        edge_fade_strength: number;
        position_generator: string;
        type_generator: string;
        matrix_generator: string;
        current_color_scheme: string;
        color_scheme_reversed: boolean;
        background_color_mode: string;
    }

    // Simulation state
    let settings: Settings | undefined = undefined;

    // Runtime state
    let state: State | undefined = undefined;

    // Create sync manager for type-safe backend synchronization
    const syncManager = createSyncManager<Settings, State>();

    // UI state
    let current_preset = '';
    let available_presets: string[] = [];
    let available_color_schemes: string[] = [];

    let show_about_section = false; // Toggle for expandable about section
    let fps_display = 0;
    let isSimulationRunning = false;
    let isLoading = true;
    let isInitialized = false; // Track if initial state sync is complete

    // Enhanced UI state
    let showUI = true;

    // Auto-hide functionality for controls when UI is hidden
    let controlsVisible = true;

    // Auto-hide manager
    let autoHideManager: AutoHideManager;
    let eventListeners: { add: () => void; remove: () => void };

    // Species colors for UI visualization - will be populated from backend
    let speciesColors: string[] = [];

    /**
     * The particle-count ceiling, asked of the device on mount.
     *
     * Initialised to the constant so the control has a truthful maximum before
     * the answer arrives, and so a failure to ask degrades to the conservative
     * value rather than to `Infinity`. Three ranges disagreed before this: the
     * drag box advertised a minimum of **1**, this file clamped to
     * [1000, 50000], and the Rust clamps to [1000, 100000] — so the box let the
     * user type a number that could not be reached and the two clamps below it
     * disagreed about the top.
     */
    let particle_count_cap = PARTICLE_LIFE_PARTICLE_CEILING;

    // Function to update species colors from backend
    async function updateSpeciesColors() {
        if (!state || !settings) return;

        try {
            /*
             * The count is passed even though the desktop command takes none.
             * It only reaches the fallback path — with a simulation running,
             * `get_species_colors` answers from `state.species_colors` — but
             * that fallback defaulted to **4**, so at five or more species the
             * matrix headers past the fourth fell back to white.
             */
            const colors = await invoke<[number, number, number, number][]>('get_species_colors', {
                count: settings.species_count,
            });

            if (colors && colors.length > 0) {
                // Convert from linear RGB to sRGB for proper display in UI
                const linearToSrgb = (linear: number): number => {
                    if (linear <= 0.0031308) {
                        return linear * 12.92;
                    } else {
                        return 1.055 * Math.pow(linear, 1.0 / 2.4) - 0.055;
                    }
                };

                // Colors are species-first in all modes; in color scheme mode, background is appended at the end.
                // Always take the first N species colors for UI.
                const endIndex = Math.min(settings.species_count, colors.length);
                const colorsToProcess = colors.slice(0, endIndex);

                speciesColors = colorsToProcess.map(([r, g, b, a]) => {
                    const r_srgb = Math.round(linearToSrgb(r) * 255);
                    const g_srgb = Math.round(linearToSrgb(g) * 255);
                    const b_srgb = Math.round(linearToSrgb(b) * 255);
                    return `rgba(${r_srgb}, ${g_srgb}, ${b_srgb}, ${a})`;
                });
            } else {
                console.warn('Received empty species colors, using fallback colors');
                useFallbackColors();
            }
        } catch (e) {
            console.error('Failed to get species colors, using fallback colors:', e);
            useFallbackColors();
        }
    }

    // Function to use fallback colors when species colors can't be retrieved
    function useFallbackColors() {
        speciesColors = [
            'rgb(255,51,51)', // Red
            'rgb(51,255,51)', // Green
            'rgb(51,51,255)', // Blue
            'rgb(255,255,51)', // Yellow
            'rgb(255,51,255)', // Magenta
            'rgb(51,255,255)', // Cyan
            'rgb(255,153,51)', // Orange
            'rgb(153,51,255)', // Purple
        ];
    }

    // Event listeners
    let unsubscribeFps: (() => void) | null = null;
    let unsubscribeSimulationInitialized: (() => void) | null = null;
    let unsubscribeSimulationResumed: (() => void) | null = null;

    // Reactive statement to ensure force matrix is always properly initialized
    $: {
        if (
            settings &&
            settings.species_count &&
            (!settings.force_matrix ||
                !Array.isArray(settings.force_matrix) ||
                settings.force_matrix.length !== settings.species_count)
        ) {
            // Initialize or resize force matrix to match species count
            const currentMatrix = settings.force_matrix || [];
            const newMatrix: number[][] = [];

            for (let i = 0; i < settings.species_count; i++) {
                newMatrix[i] = [];
                for (let j = 0; j < settings.species_count; j++) {
                    if (
                        i < currentMatrix.length &&
                        currentMatrix[i] &&
                        j < currentMatrix[i].length &&
                        currentMatrix[i][j] !== undefined
                    ) {
                        newMatrix[i][j] = currentMatrix[i][j];
                    } else {
                        // Random values for new entries
                        newMatrix[i][j] = (Math.random() - 0.5) * 0.6;
                    }
                }
            }

            settings.force_matrix = newMatrix;
        }
    }

    /**
     * Changing the species count keeps the matrix the user tuned.
     *
     * `Settings::set_species_count` (settings.rs:169) resizes with zeroes and
     * then, for **any** count above two, overwrites the whole matrix with a
     * fresh `MatrixGenerator::Random` draw — ignoring `state.matrix_generator`
     * and throwing away a hand-authored matrix on every bump from 4 to 5. That
     * has never been visible, because every caller sends its own preserved
     * matrix immediately afterwards and overwrites the random draw before a
     * frame is drawn: this function does it below, and `apply_settings` does it
     * at simulation.rs:3832. The port makes the intent explicit rather than
     * relying on the overwrite — `resizeForceMatrix` in the engine preserves the
     * overlap, and so does the loop below.
     *
     * New cells get a small random value rather than the engine's zero, and
     * that difference is deliberate: this write lands last, and a zero row and
     * column means the new species neither attracts nor repels anything, which
     * on screen is a species that does nothing at all — a worse first
     * impression than one with an opinion.
     */
    // Two-way binding handlers
    async function updateSpeciesCount(value: number) {
        if (settings == undefined) return;
        if (state == undefined) return;

        const newCount = Math.max(2, Math.min(8, Math.round(value)));
        if (newCount === settings.species_count) return;

        // Ensure force matrix exists
        if (!settings.force_matrix || !Array.isArray(settings.force_matrix)) {
            settings.force_matrix = Array(settings.species_count || 4)
                .fill(null)
                .map(() => Array(settings?.species_count || 4).fill(0.0));
        }

        // Resize force matrix to match new species count
        const oldMatrix = settings.force_matrix;
        const newMatrix: number[][] = [];

        for (let i = 0; i < newCount; i++) {
            newMatrix[i] = [];
            for (let j = 0; j < newCount; j++) {
                if (
                    i < oldMatrix.length &&
                    oldMatrix[i] &&
                    j < oldMatrix[i].length &&
                    oldMatrix[i][j] !== undefined
                ) {
                    newMatrix[i][j] = oldMatrix[i][j];
                } else {
                    // Random values for new entries
                    newMatrix[i][j] = (Math.random() - 0.5) * 0.6;
                }
            }
        }

        // Update both settings atomically to prevent race conditions
        settings.species_count = newCount;
        settings.force_matrix = newMatrix;

        // Force a reactive update by triggering a change
        settings = { ...settings };

        try {
            // First update the species count
            await invoke('update_simulation_setting', {
                settingName: 'species_count',
                value: newCount,
            });

            // Then update the force matrix with the new size
            await invoke('update_simulation_setting', {
                settingName: 'force_matrix',
                value: newMatrix,
            });

            // Update species colors after species count change
            await updateSpeciesColors();

            // Reset simulation to respawn particles with new species count
            await invoke('reset_simulation');

            // Sync state from backend
            await syncSettingsFromBackend();

            console.log(`Species count updated to ${newCount}, particles respawned`);
        } catch (e) {
            console.error('Failed to update species count:', e);
        }
    }

    async function updateSetting(settingName: string, value: number | boolean) {
        if (!settings) return;

        try {
            // Update local state first for immediate UI feedback
            switch (settingName) {
                case 'max_force':
                    settings.max_force = value as number;
                    break;
                case 'max_distance':
                    settings.max_distance = value as number;
                    break;
                case 'force_beta':
                    settings.force_beta = value as number;
                    break;
                case 'friction':
                    settings.friction = value as number;
                    break;
                case 'brownian_motion':
                    settings.brownian_motion = value as number;
                    break;
                case 'wrap_edges':
                    settings.wrap_edges = value as boolean;
                    break;
            }

            // Then update backend
            await syncManager.updateSetting(settingName, value);
        } catch (e) {
            console.error(`Failed to update ${settingName}:`, e);
            // On error, sync from backend to restore correct state
            await syncSettingsFromBackend();
        }
    }

    /**
     * The second of the three clamps M7 established for Slime Mold's agents.
     *
     * The `NumberDragBox` clamps first so the user is told; this one clamps
     * because a value restored from a preset, or synced from a session started
     * on another machine, never passes through the control at all; and the
     * simulation clamps last, immediately before the `createBuffer` that would
     * otherwise stall the GPU. See `handlers/particleLife.ts`.
     */
    async function updateParticleCount(value: number) {
        if (!state) return;

        const newCount = clampParticleCount(Math.round(value), particle_count_cap);
        if (newCount === state.particle_count) return;

        console.log(`updateParticleCount called: ${state.particle_count} -> ${newCount}`);

        state.particle_count = newCount;

        try {
            console.log(`Sending particle count update to backend: ${newCount}`);
            // Use the new dynamic particle count update
            await invoke('update_simulation_setting', {
                settingName: 'particle_count',
                value: newCount,
            });

            console.log(`Backend update complete, waiting for GPU operations...`);
            // Add a small delay to ensure GPU operations are complete
            await new Promise((resolve) => setTimeout(resolve, 100));

            console.log(`Syncing state from backend...`);
            // Sync state from backend to ensure frontend reflects actual backend state
            await syncSettingsFromBackend();

            console.log(`Particle count update complete: ${newCount}`);
        } catch (e) {
            console.error('Failed to update particle count:', e);
            // Revert state on error
            await syncSettingsFromBackend();
        }
    }

    /*
     * The five writes below stay on `update_simulation_state`, deliberately.
     *
     * On the desktop all five are dead: `ParticleLifeModel::update_state` has
     * exactly one arm, `"color_scheme"`, and everything else falls through to a
     * `tracing::warn!` that still returns `Ok(())` — so the command succeeds,
     * `sync.ts` never rolls its optimistic update back, and the widget shows a
     * change the backend never saw. `cursor_size`, `cursor_strength`,
     * `traces_enabled`, `trace_fade` and `background_color_mode` are all in that
     * set (`color_scheme_reversed` was the sixth; it is handled above).
     *
     * The obvious fix is to send them to `update_simulation_setting`, which does
     * have an arm for each. M7 met the identical defect in Slime Mold's
     * `position_generator` and settled it the other way, on a principle worth
     * keeping: **the write goes where the read is**. `get_state` returns all
     * five and `get_settings` returns none of them, so a mode that reads them
     * out of the state document and writes them into the settings document
     * would be describing the same field with two names. The port puts the arm
     * on the state model instead — `updateParticleLifeState` in
     * `sims/particleLife/settings.ts` — which is also what keeps
     * `updateStateOptimistic`'s rollback in play, since a bad value there still
     * rejects.
     */

    // Mouse interaction controls
    async function updateCursorSize(value: number) {
        const result = await syncManager.updateStateOptimistic(state, 'cursor_size', value);
        if (result) state = result;
    }

    async function updateCursorStrength(value: number) {
        const result = await syncManager.updateStateOptimistic(state, 'cursor_strength', value);
        if (result) state = result;
    }

    // Rendering controls
    async function updateTracesEnabled(value: boolean) {
        const result = await syncManager.updateStateOptimistic(state, 'traces_enabled', value);
        if (result) state = result;
    }

    async function updateTraceFade(value: number) {
        const result = await syncManager.updateStateOptimistic(state, 'trace_fade', value);
        if (result) state = result;
    }

    /**
     * Speed — a control the desktop build does not have.
     *
     * `dt` is `State`, so this takes the same `update_simulation_state` route as
     * the five above rather than `update_simulation_setting`; the engine's arm
     * clamps it, which is why the value is converted here and re-read from
     * `state.dt` for display rather than held in a second variable.
     */
    async function updateSpeed(value: number) {
        const result = await syncManager.updateStateOptimistic(
            state,
            'dt',
            particleLifeSpeedToDt(value)
        );
        if (result) state = result;
    }

    async function updateMatrixGenerator(value: string) {
        try {
            await invoke('update_simulation_setting', { settingName: 'matrix_generator', value });
            state!.matrix_generator = value;
            console.log(`Updated matrix generator: ${value}`);
        } catch (e) {
            console.error('Failed to update matrix generator:', e);
        }
    }

    // Preset management
    async function updatePreset(value: string) {
        current_preset = value;
        try {
            await invoke('apply_preset', { presetName: value });
            // Always sync both settings and state after preset change
            await syncSettingsFromBackend();
            console.log(`Applied preset: ${value}`);
        } catch (e) {
            console.error('Failed to apply preset:', e);
        }
    }

    async function savePreset(presetName: string) {
        if (presetName.trim() === '') return;

        try {
            await invoke('save_preset', {
                presetName: presetName.trim(),
            });

            // Refresh presets list
            await loadPresets();

            // Set the current preset to the newly saved one
            current_preset = presetName.trim();

            console.log(`Saved preset: ${presetName}`);
        } catch (e) {
            console.error('Failed to save preset:', e);
        }
    }

    // Data loading functions
    async function loadPresets() {
        try {
            available_presets = await invoke('get_presets_for_simulation_type', {
                simulationType: 'particle_life',
            });

            // Set the default preset if available
            if (available_presets.includes('Default')) {
                current_preset = 'Default';
            }
        } catch (e) {
            console.error('Failed to load presets:', e);
            available_presets = [];
        }
    }

    /**
     * The device ceiling, asked for once. A failure leaves the conservative
     * constant in place, exactly as `loadAgentCountCap` does in SlimeMoldMode.
     */
    async function loadParticleCountCap() {
        try {
            const cap = await invoke('get_particle_count_limit');
            if (typeof cap === 'number' && cap > 0) particle_count_cap = cap;
        } catch (e) {
            console.error('Failed to read the particle-count limit:', e);
        }
    }

    async function loadColorSchemes() {
        try {
            available_color_schemes = await invoke('get_available_color_schemes');
        } catch (e) {
            console.error('Failed to load color schemes:', e);
            available_color_schemes = [];
        }
    }

    async function syncSettingsFromBackend() {
        const synced = await syncManager.syncAll();
        if (synced.settings !== null && synced.settings !== undefined) {
            settings = synced.settings;
        }
        if (synced.state !== null && synced.state !== undefined) {
            state = synced.state;
            // Debug: Log the generator values to see what we're getting
            console.log('Backend state received:', {
                matrix_generator: state.matrix_generator,
                position_generator: state.position_generator,
                type_generator: state.type_generator,
                background_color_mode: state.background_color_mode,
                current_color_scheme: state.current_color_scheme,
            });
        }
    }

    // Simulation control
    async function startSimulation() {
        try {
            await invoke('start_particle_life_simulation');
            // Don't set isSimulationRunning = true here - wait for simulation-initialized event
            console.log('Particle Life simulation started');
        } catch (e) {
            console.error('Failed to start simulation:', e);
        }
    }

    async function stopSimulation() {
        try {
            await invoke('destroy_simulation');
            isSimulationRunning = false;
            console.log('Simulation stopped');
        } catch (e) {
            console.error('Failed to stop simulation:', e);
        }
    }

    async function pauseSimulation() {
        try {
            await invoke('pause_simulation');
            isSimulationRunning = false;

            // Update auto-hide manager state and handle pause
            if (autoHideManager) {
                autoHideManager.updateState({ running: isSimulationRunning });
                autoHideManager.handlePause();
            }
            console.log('Simulation paused');
        } catch (e) {
            console.error('Failed to pause simulation:', e);
        }
    }

    async function resumeSimulation() {
        try {
            await invoke('resume_simulation');
            isSimulationRunning = true;

            // Update auto-hide manager state and handle resume
            if (autoHideManager) {
                autoHideManager.updateState({ running: isSimulationRunning });
                autoHideManager.handleResume();
            }
            console.log('Simulation resumed');
        } catch (e) {
            console.error('Failed to resume simulation:', e);
        }
    }

    async function togglePause() {
        if (isSimulationRunning) {
            await pauseSimulation();
        } else {
            await resumeSimulation();
        }
    }

    async function resetSimulation() {
        try {
            console.log('Resetting simulation...');

            // Apply current generator settings before reset
            await invoke('update_simulation_setting', {
                settingName: 'position_generator',
                value: state!.position_generator,
            });
            await invoke('update_simulation_setting', {
                settingName: 'type_generator',
                value: state!.type_generator,
            });

            await invoke('update_simulation_setting', {
                settingName: 'matrix_generator',
                value: state!.matrix_generator,
            });

            await invoke('reset_simulation');

            // Wait a bit for the backend to process the changes
            await new Promise((resolve) => setTimeout(resolve, 100));

            console.log('Syncing state from backend...');
            // Sync state from backend to ensure frontend reflects actual backend state
            await syncSettingsFromBackend();

            console.log('Simulation reset complete');
        } catch (e) {
            console.error('Failed to reset simulation:', e);
            // Sync state on error to ensure consistency
            await syncSettingsFromBackend();
        }
    }

    async function randomizeMatrix() {
        try {
            // First update the matrix generator setting
            await invoke('update_simulation_setting', {
                settingName: 'matrix_generator',
                value: state!.matrix_generator,
            });

            // Then randomize the matrix using the current generator
            await invoke('randomize_settings');
            await syncSettingsFromBackend();

            // Update species colors after matrix randomization
            await updateSpeciesColors();

            console.log(`Matrix randomized using ${state!.matrix_generator} generator`);
        } catch (e) {
            console.error('Failed to randomize matrix:', e);
        }
    }

    async function regeneratePositions() {
        try {
            // Update the position generator setting and regenerate particles
            await invoke('update_simulation_setting', {
                settingName: 'position_generator',
                value: state!.position_generator,
            });

            // Reset simulation to regenerate particles with new position generator
            await invoke('reset_simulation');

            // Sync state from backend
            await syncSettingsFromBackend();

            console.log(
                `Particles regenerated with ${state!.position_generator} position generator`
            );
        } catch (e) {
            console.error('Failed to regenerate particles:', e);
        }
    }

    async function regenerateTypes() {
        try {
            // Update the type generator setting and regenerate particles
            await invoke('update_simulation_setting', {
                settingName: 'type_generator',
                value: state!.type_generator,
            });

            // Reset simulation to regenerate particles with new type generator
            await invoke('reset_simulation');

            // Wait a bit for the backend to process the changes
            await new Promise((resolve) => setTimeout(resolve, 200));

            // Sync state from backend
            await syncSettingsFromBackend();

            console.log(`Types regenerated with ${state!.type_generator} type generator`);
        } catch (e) {
            console.error('Failed to regenerate types:', e);
        }
    }

    let isMousePressed = false;
    let currentMouseButton = 0;

    async function handleMouseEvent(e: CustomEvent) {
        const event = e.detail as MouseEvent | WheelEvent;
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

            // Determine if it's left click (attract) or right click (repel)
            const isAttract = mouseEvent.button === 0; // Left click = attract, right click = repel

            console.log(
                `Mouse ${isAttract ? 'attract' : 'repel'} at screen coords: (${physicalCursorX}, ${physicalCursorY}), raw: (${mouseEvent.clientX}, ${mouseEvent.clientY})`
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
            const mouseEvent = event as MouseEvent;
            mouseEvent.preventDefault();

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
            // Handle context menu as right-click for repel functionality
            const mouseEvent = event as MouseEvent;

            // Convert screen coordinates to world coordinates
            const devicePixelRatio = window.devicePixelRatio || 1;
            const physicalCursorX = mouseEvent.clientX * devicePixelRatio;
            const physicalCursorY = mouseEvent.clientY * devicePixelRatio;

            console.log(
                `Particle Life context menu (repel) at screen coords: (${physicalCursorX}, ${physicalCursorY}), raw: (${mouseEvent.clientX}, ${mouseEvent.clientY})`
            );

            // Track as active right-button press to ensure release is generated later
            isMousePressed = true;
            currentMouseButton = 2;

            try {
                await invoke('handle_mouse_interaction_screen', {
                    screenX: physicalCursorX,
                    screenY: physicalCursorY,
                    mouseButton: 2, // Right mouse button for repel
                });
            } catch (e) {
                console.error('Failed to handle Particle Life context menu interaction:', e);
            }
        }

        // Handle auto-hide functionality
        if (autoHideManager) {
            autoHideManager.handleUserInteraction();
        }
    }

    // Add type for event parameter (Svelte custom event)
    async function handleMatrixUpdate(e: CustomEvent<{ i: number; j: number; value: number }>) {
        // Only reference e.detail to avoid unused variable warning
        void e.detail;
        try {
            await invoke('update_simulation_setting', {
                settingName: 'force_matrix',
                value: settings!.force_matrix,
            });
        } catch (error) {
            console.error('Failed to update force matrix:', error);
        }
    }

    async function handleMatrixTransform(e: CustomEvent<{ type: string; matrix: number[][] }>) {
        // Only use matrix from e.detail
        const { matrix } = e.detail;
        try {
            await invoke('update_simulation_setting', {
                settingName: 'force_matrix',
                value: matrix,
            });
        } catch (error) {
            console.error('Failed to update force matrix:', error);
        }
    }

    // Generator update functions (local state only)
    function updatePositionGenerator(value: string) {
        state!.position_generator = value;
        console.log(`Position generator set to: ${value} (will apply on next reset)`);
    }

    function updateTypeGenerator(value: string) {
        state!.type_generator = value;
        console.log(`Type generator set to: ${value} (will apply on next reset)`);
    }

    async function toggleBackendGui() {
        try {
            await invoke('toggle_gui');
            // Toggle local state directly instead of relying on backend state
            showUI = !showUI;

            // Update auto-hide manager state and handle UI toggle
            if (autoHideManager) {
                autoHideManager.updateState({ showUI, running: isSimulationRunning });
                autoHideManager.handleUIToggle(showUI);
            }
        } catch (err) {
            console.error('Failed to toggle backend GUI:', err);
        }
    }

    // Lifecycle
    onMount(async () => {
        try {
            // Initialize auto-hide manager
            autoHideManager = new AutoHideManager(
                {
                    controlsVisible,
                    cursorHidden: false,
                    showUI,
                    running: isSimulationRunning,
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

            // Set up event listeners BEFORE starting simulation to avoid race conditions

            // Set up FPS monitoring
            try {
                unsubscribeFps = await listen('fps-update', (event) => {
                    fps_display = event.payload as number;
                });
            } catch (e) {
                console.error('Failed to set up FPS listener:', e);
            }

            // Listen for simulation initialization event
            try {
                console.log('Registering simulation-initialized event listener...');
                unsubscribeSimulationInitialized = await listen(
                    'simulation-initialized',
                    async () => {
                        console.log('Simulation initialized, syncing settings...');
                        await syncSettingsFromBackend();
                        await updateSpeciesColors();
                        isSimulationRunning = true;
                        isInitialized = true; // Mark initialization as complete
                    }
                );
                console.log('Registered simulation-initialized event listener.');
            } catch (e) {
                console.error('Failed to set up simulation-initialized listener:', e);
            }

            // Listen for simulation resumed event
            try {
                unsubscribeSimulationResumed = await listen('simulation-resumed', async () => {
                    console.log('Simulation resumed');
                    isSimulationRunning = true;
                });
            } catch (e) {
                console.error('Failed to set up simulation-resumed listener:', e);
            }

            // Now start simulation after event listeners are set up
            await startSimulation();

            // Load initial data
            await Promise.all([loadPresets(), loadColorSchemes(), loadParticleCountCap()]);

            // Set the default preset if available and not already set
            if (available_presets.includes('Default') && !current_preset) {
                current_preset = 'Default';
            }

            // Sync settings after color schemes are loaded
            await syncSettingsFromBackend();

            // Only update species colors after simulation is running
            if (isSimulationRunning) {
                await updateSpeciesColors();
            }
        } catch (e) {
            console.error('Failed to initialize simulation:', e);
        } finally {
            isLoading = false;
        }
    });

    onDestroy(async () => {
        // Stop simulation
        await stopSimulation();

        // Clean up listeners
        if (unsubscribeFps) {
            unsubscribeFps();
        }
        if (unsubscribeSimulationInitialized) {
            unsubscribeSimulationInitialized();
        }
        if (unsubscribeSimulationResumed) {
            unsubscribeSimulationResumed();
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
     * Push the LUT bytes *and* write the name into state.
     *
     * `apply_color_scheme_by_name` hands the buffer to the simulation but never
     * records which scheme it was — the engine seam carries bytes and a
     * reversed flag, nothing else. The `<ColorSchemeSelector>` binds
     * `state.current_color_scheme`, and every reset, preset and species-count
     * change ends in `syncSettingsFromBackend()`, so without the second call the
     * highlight snapped back to whatever the engine still held. M4 fixed this in
     * Gray-Scott and M5 in Vectors; `update_state`'s **one** working arm on the
     * desktop is `"color_scheme"` (simulation.rs:3657), so this line is the one
     * state write in the whole mode that already worked there.
     */
    async function updateColorScheme(colorSchemeName: string) {
        try {
            if (!state) return;
            state.current_color_scheme = colorSchemeName;
            await invoke('apply_color_scheme_by_name', { colorSchemeName });
            await invoke('update_simulation_state', {
                stateName: 'color_scheme',
                value: colorSchemeName,
            });

            // Immediately update species colors after color scheme change
            await updateSpeciesColors();
        } catch (e) {
            console.error('Failed to update color scheme:', e);
        }
    }

    /**
     * Reversal goes through the colour-scheme command, not a bare state write.
     *
     * This used to be `updateStateOptimistic('color_scheme_reversed')`, which on
     * the desktop hit `update_state`'s `_ =>` warning arm and did nothing at
     * all, and in the browser would set the flag without re-deriving the LUT the
     * species colours are sampled from. `toggle_color_scheme_reversed` is the
     * command that re-derives and pushes the bytes, and it mirrors the flag into
     * state on its way through — the same fix M7 made in SlimeMoldMode and M5 in
     * VectorsMode.
     */
    async function updateColorSchemeReversed(reversed: boolean) {
        try {
            await invoke('toggle_color_scheme_reversed');
            if (state) state = { ...state, color_scheme_reversed: reversed };

            // Immediately update species colors after color scheme change
            await updateSpeciesColors();
        } catch (e) {
            console.error('Failed to update color scheme reversed:', e);
        }
    }

    async function updateColorMode(value: string) {
        try {
            console.log(`Updating background color mode to: ${value}`);
            const result = await syncManager.updateStateOptimistic(
                state,
                'background_color_mode',
                value
            );
            if (result) state = result;

            // Immediately update species colors after color mode change
            await updateSpeciesColors();
        } catch (e) {
            console.error('Failed to update color mode:', e);
        }
    }

    async function clearTrails() {
        try {
            await invoke('clear_trail_texture');
            console.log('Trail texture cleared successfully');
        } catch (e) {
            console.error('Failed to clear trail texture:', e);
        }
    }
</script>

<style>
    /* Particle Life specific styles */
    .matrix-info {
        padding: 0.3rem;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 4px;
    }

    .matrix-info p {
        margin: 0;
        color: rgba(255, 255, 255, 0.7);
        font-size: 0.8rem;
    }

    .matrix-and-setup-container {
        display: flex;
        gap: 1rem;
        align-items: flex-start;
    }

    .matrix-section {
        flex: 1;
    }
</style>
