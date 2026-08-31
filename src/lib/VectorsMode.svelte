<SimulationLayout
    simulationName="Vectors"
    {running}
    loading={loading || !settings}
    {showUI}
    {currentFps}
    {controlsVisible}
    {menuPosition}
    on:back={returnToMenu}
    on:toggleUI={toggleBackendGui}
    on:pause={stopSimulation}
    on:resume={resumeSimulation}
    on:userInteraction={autoHideManager?.handleUserInteraction}
    on:mouseEvent={handleMouseEvent}
>
    {#if settings}
        <form on:submit|preventDefault>
            <CollapsibleFieldset title="About this simulation" bind:open={show_about_section}>
                <p>
                    Vectors renders a grid of lines where direction and length are derived from a
                    noise field. Pan and zoom move the camera through the field (WASD, Q/E, or
                    mouse).
                </p>
            </CollapsibleFieldset>

            <PresetFieldset
                availablePresets={available_presets}
                bind:currentPreset={current_preset}
                placeholder="Select preset..."
                on:presetChange={({ detail }) => updatePreset(detail.value)}
                on:presetSave={({ detail }) => savePreset(detail.name)}
            />

            <fieldset>
                <legend>Color</legend>
                <div class="control-group">
                    <label for="backgroundColorMode">Background</label>
                    <Selector
                        id="backgroundColorMode"
                        options={backgroundColorModeOptions}
                        value={settings?.background_color_mode}
                        on:change={({ detail }) =>
                            updateSetting('background_color_mode', detail.value)}
                    />
                </div>
                <div class="control-group">
                    <label for="colorSchemeSelector">Color Scheme</label>
                    <ColorSchemeSelector
                        bind:available_color_schemes={available_luts}
                        current_color_scheme={state?.current_color_scheme ?? ''}
                        reversed={state?.color_scheme_reversed ?? false}
                        on:select={({ detail }) => updateLutName(detail.name)}
                        on:reverse={() => updateLutReversed()}
                    />
                </div>
            </fieldset>

            <fieldset>
                <legend>Vector Field</legend>
                <div class="control-group">
                    <label class="setting-label" for="vector-field-type">Vector Field Type</label>
                    <Selector
                        id="vector-field-type"
                        options={vectorFieldTypeOptions}
                        value={settings?.vector_field_type ?? 'Noise'}
                        on:change={({ detail }) => updateSetting('vector_field_type', detail.value)}
                    />
                </div>
                {#if settings?.vector_field_type === 'Image'}
                    <ImageSelector
                        fitMode={settings?.image_fit_mode ?? 'Stretch'}
                        loadCommand="load_vectors_vector_field_image"
                        onFitModeChange={(value) => updateImageFitMode(value)}
                    />
                    <!--
                        WebcamControls used to sit here. Webcam capture is an
                        omitted feature of this port (WEB_PORT.md, "Omitted
                        features"), and its three `vectors_*` commands could only
                        ever have resolved to empty stubs — so the panel is
                        removed outright rather than shipped as a permanently
                        greyed-out Start button next to an empty device list.
                        M4 did the same to Gray-Scott's.
                    -->
                    <div class="control-group">
                        <label class="setting-label" for="image-mirror-h">Mirror Horizontal</label>
                        <input
                            id="image-mirror-h"
                            type="checkbox"
                            checked={settings?.image_mirror_horizontal ?? false}
                            on:change={(e) =>
                                updateSetting(
                                    'image_mirror_horizontal',
                                    (e.target as HTMLInputElement).checked
                                )}
                        />
                    </div>
                    <div class="control-group">
                        <label class="setting-label" for="image-mirror-v">Mirror Vertical</label>
                        <input
                            id="image-mirror-v"
                            type="checkbox"
                            checked={settings?.image_mirror_vertical ?? false}
                            on:change={(e) =>
                                updateSetting(
                                    'image_mirror_vertical',
                                    (e.target as HTMLInputElement).checked
                                )}
                        />
                    </div>
                    <div class="control-group">
                        <label class="setting-label" for="image-invert">Invert Tone</label>
                        <input
                            id="image-invert"
                            type="checkbox"
                            checked={settings?.image_invert_tone ?? false}
                            on:change={(e) =>
                                updateSetting(
                                    'image_invert_tone',
                                    (e.target as HTMLInputElement).checked
                                )}
                        />
                    </div>
                {/if}
                {#if settings?.vector_field_type === 'Noise'}
                    <div class="control-group">
                        <label class="setting-label" for="noise-type">Noise Type</label>
                        <Selector
                            id="noise-type"
                            options={noiseTypeOptions}
                            value={settings?.noise_type ?? 'OpenSimplex'}
                            on:change={({ detail }) => updateSetting('noise_type', detail.value)}
                        />
                    </div>
                    <!--
                        Every drag box below carries an explicit `precision`.
                        NumberDragBox defaults it to 2 and formats with
                        `parseFloat(value.toFixed(precision))`, so with the
                        0.001 steps these controls use, Line Width's default of
                        0.001 rendered as "0" and stayed "0" across its entire
                        lower range — a control that changed nothing on screen
                        when dragged. Density and Line Length had the same
                        problem one digit further out. Every other mode with
                        sub-0.01 steps (Flow, Pellets, Voronoi CA) already
                        passes this prop.
                    -->
                    <div class="control-group">
                        <label class="setting-label" for="noise-seed">Noise Seed:</label>
                        <NumberDragBox
                            id="noise-seed"
                            value={settings.noise_seed as number}
                            on:change={({ detail }) => updateSetting('noise_seed', detail)}
                            min={0}
                            max={4294967295}
                            step={1}
                            precision={0}
                        />
                    </div>
                    <div class="control-group">
                        <label class="setting-label" for="noise-scale">Noise Scale:</label>
                        <NumberDragBox
                            id="noise-scale"
                            value={settings.noise_scale as number}
                            on:change={({ detail }) => updateSetting('noise_scale', detail)}
                            min={0.001}
                            max={100.0}
                            step={0.001}
                            precision={3}
                        />
                    </div>
                    <div class="control-group">
                        <label class="setting-label" for="noise-dt">Noise DT Multiplier:</label>
                        <NumberDragBox
                            id="noise-dt"
                            value={settings.noise_dt_multiplier as number}
                            on:change={({ detail }) => updateSetting('noise_dt_multiplier', detail)}
                            min={0.0}
                            max={10.0}
                            step={0.1}
                            precision={1}
                        />
                    </div>
                {/if}
                <div class="control-group">
                    <label class="setting-label" for="density">Density:</label>
                    <NumberDragBox
                        id="density"
                        value={settings.density as number}
                        on:change={({ detail }) => updateSetting('density', detail)}
                        min={0.001}
                        max={0.1}
                        step={0.001}
                        precision={3}
                    />
                </div>
                <div class="control-group">
                    <label class="setting-label" for="line-length">Line Length:</label>
                    <NumberDragBox
                        id="line-length"
                        value={settings.line_length as number}
                        on:change={({ detail }) => updateSetting('line_length', detail)}
                        min={0.005}
                        max={1.0}
                        step={0.001}
                        precision={3}
                    />
                </div>
                <div class="control-group">
                    <label class="setting-label" for="line-width">Line Width:</label>
                    <NumberDragBox
                        id="line-width"
                        value={settings.line_width as number}
                        on:change={({ detail }) => updateSetting('line_width', detail)}
                        min={0.001}
                        max={1.0}
                        step={0.001}
                        precision={3}
                    />
                </div>
                <div class="control-group">
                    <Button on:click={randomizeSettings}>Randomize</Button>
                </div>
            </fieldset>
        </form>
    {/if}
</SimulationLayout>

<CameraControls enabled={true} on:toggleGui={toggleBackendGui} on:togglePause={togglePause} />

<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { invoke, listen } from '$lib/rpc';
    import SimulationLayout from './components/shared/SimulationLayout.svelte';
    import CollapsibleFieldset from './components/shared/CollapsibleFieldset.svelte';
    import PresetFieldset from './components/shared/PresetFieldset.svelte';
    import ColorSchemeSelector from './components/shared/ColorSchemeSelector.svelte';
    import Selector from './components/inputs/Selector.svelte';
    import NumberDragBox from './components/inputs/NumberDragBox.svelte';
    import Button from './components/shared/Button.svelte';
    import ImageSelector from './components/shared/ImageSelector.svelte';
    import CameraControls from './components/shared/CameraControls.svelte';
    import { AutoHideManager, createAutoHideEventListeners } from './utils/autoHide';
    import { createSyncManager } from './utils/sync';
    import type { AppMode } from '../types/app';
    import {
        BACKGROUND_COLOR_MODES,
        NOISE_TYPES,
        VECTOR_FIELD_TYPES,
        type BackgroundColorMode,
        type NoiseType,
        type VectorFieldType,
    } from '$lib/engine/sims/vectors/settings';
    import type { ImageFitMode } from '$lib/engine/resources/imageUpload';

    /*
     * The option lists come from the engine rather than being spelled out here,
     * so the two copies cannot drift into the round-trip failure M3 and M4 each
     * hit: a `<Selector>` whose options miss the spelling `get_settings`
     * returns renders its *placeholder* instead of the selection, and its ◀/▶
     * buttons then cycle from `indexOf() === -1`.
     *
     * These are the **serde** spellings, which is what `get_settings` emits and
     * what `update_setting` parses — so `Fbm` and `FBMBillow` appear in the
     * dropdown exactly as inconsistently as `settings.rs` declares them. The
     * prettier `Display` names ("FBM", "FBM Billow") exist as
     * `NOISE_TYPE_LABELS`, but showing them would mean translating on the way in
     * *and* out, which is precisely the construct that broke Gray-Scott. Left as
     * a presentation decision for M14, where every mode's labels get one pass.
     */
    const backgroundColorModeOptions: string[] = [...BACKGROUND_COLOR_MODES];
    const noiseTypeOptions: string[] = [...NOISE_TYPES];
    const vectorFieldTypeOptions: string[] = [...VECTOR_FIELD_TYPES];

    export let menuPosition: 'left' | 'right' | 'middle' = 'right';
    export let autoHideDelay: number = 1000;

    import { createEventDispatcher } from 'svelte';
    const dispatch = createEventDispatcher<{
        back: void;
        navigate: { detail: AppMode };
    }>();

    let running = false;
    let loading = true;
    let showUI = true;
    let currentFps = 0;
    let controlsVisible = true;
    let show_about_section = false;

    let autoHideManager: AutoHideManager;
    let eventListeners: { add: () => void; remove: () => void };
    let fpsUnlisten: (() => void) | null = null;

    /**
     * Mirrors `VectorsSettings` (engine/sims/vectors/settings.ts), which mirrors
     * `settings.rs`. Every field is optional because `get_current_settings`
     * degrades to `{}` when there is no engine at all, and the markup binds
     * through `settings?.x` for the same reason.
     *
     * `noise_seed` was **missing** from this interface before M5 while
     * `settings.noise_seed as number` read it anyway through the index
     * signature — so the one field the type could have caught was the one it
     * silently let through.
     */
    interface Settings {
        vector_field_type?: VectorFieldType;
        noise_type?: NoiseType;
        noise_seed?: number;
        noise_scale?: number;
        noise_dt_multiplier?: number;
        density?: number;
        line_length?: number;
        line_width?: number;
        background_color_mode?: BackgroundColorMode;
        image_fit_mode?: ImageFitMode;
        image_mirror_horizontal?: boolean;
        image_mirror_vertical?: boolean;
        image_invert_tone?: boolean;
        [key: string]: unknown;
    }

    interface State {
        current_color_scheme: string;
        color_scheme_reversed: boolean;
    }

    const syncManager = createSyncManager<Settings, State>();
    let settings: Settings | null = null;
    let state: State | null = null;
    let available_presets: string[] = [];
    let available_luts: string[] = [];
    let current_preset = '';

    onMount(async () => {
        try {
            autoHideManager = new AutoHideManager(
                { controlsVisible, cursorHidden: false, showUI, running },
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
                { autoHideDelay, cursorHideDelay: 2000 }
            );

            eventListeners = createAutoHideEventListeners(() => {
                autoHideManager.handleUserInteraction();
            });
            eventListeners.add();

            fpsUnlisten = await listen('fps-update', (event) => {
                currentFps = event.payload as number;
            });

            await invoke('start_simulation', { simulationType: 'vectors' });
            await Promise.all([loadSettings(), loadState(), loadPresets(), loadColorSchemes()]);
            startRenderLoop();

            running = true;
            loading = false;
        } catch (error) {
            console.error('Failed to start Vectors simulation:', error);
            loading = false;
        }
    });

    onDestroy(() => {
        // The rAF chain was cancelled only by `returnToMenu`, so any other route
        // out of this component — a navigation that swaps `currentMode`, an HMR
        // update — left it running against a destroyed simulation forever.
        stopRenderLoop();
        if (running) {
            invoke('destroy_simulation').catch(console.error);
        }
        if (fpsUnlisten) fpsUnlisten();
        if (eventListeners) eventListeners.remove();
        if (autoHideManager) autoHideManager.cleanup();
    });

    async function loadSettings() {
        const synced = await syncManager.syncSettings();
        if (synced) settings = synced;
    }

    async function loadState() {
        const synced = await syncManager.syncState();
        if (synced) state = synced;
    }

    async function loadColorSchemes() {
        try {
            available_luts = (await invoke('get_available_color_schemes')) as string[];
        } catch (e) {
            console.error('Failed to load color schemes:', e);
        }
    }

    async function updateLutName(name: string) {
        try {
            await invoke('apply_color_scheme_by_name', { colorSchemeName: name });
            /*
             * `apply_color_scheme_by_name` pushes the LUT bytes at the
             * simulation (handlers/colorSchemes.ts -> updateColorScheme) but
             * never writes the *name* into simulation state — the engine seam
             * carries only the buffer and the reversed flag. The <Selector>
             * above binds to `state.current_color_scheme`, and this function
             * ends in a state sync, so without this second call the highlight
             * snapped straight back to whatever the engine still held. Exactly
             * the defect M4 fixed in GrayScottMode.svelte:832.
             *
             * `color_scheme_reversed` needs no equivalent: it *is* part of the
             * updateColorScheme seam, so the engine mirrors it on its own.
             */
            await invoke('update_simulation_state', {
                stateName: 'current_color_scheme',
                value: name,
            });
            await loadState();
        } catch (e) {
            console.error('Failed to update LUT:', e);
        }
    }

    async function updateLutReversed() {
        try {
            await invoke('toggle_color_scheme_reversed');
            await loadState();
        } catch (e) {
            console.error('Failed to toggle LUT reversed:', e);
        }
    }

    /*
     * `loadWebcamDevices`, `startWebcam` and `stopWebcam` lived here and called
     * `get_available_vectors_webcam_devices`, `start_vectors_webcam_capture`
     * and `stop_vectors_webcam_capture`. All three are gone with the panel, and
     * their registry stubs with them — the completeness test in
     * test/unit/registry.test.ts asserts both directions, so an orphaned handler
     * fails just as loudly as a missing one.
     */

    async function updateImageFitMode(value: string) {
        try {
            await invoke('update_simulation_setting', {
                settingName: 'image_fit_mode',
                value,
            });
            await loadSettings();
        } catch (e) {
            console.error('Failed to update image fit mode:', e);
        }
    }

    async function loadPresets() {
        try {
            available_presets = await invoke('get_available_presets');
        } catch (error) {
            console.error('Failed to load presets:', error);
        }
    }

    async function updateSetting(settingName: string, value: string | number | boolean) {
        try {
            await invoke('update_simulation_setting', { settingName, value });
            await loadSettings();
        } catch (error) {
            console.error(`Failed to update setting ${settingName}:`, error);
        }
    }

    async function updatePreset(presetName: string) {
        try {
            await invoke('apply_preset', { presetName });
            await loadSettings();
            current_preset = presetName;
        } catch (error) {
            console.error('Failed to apply preset:', error);
        }
    }

    async function savePreset(presetName: string) {
        try {
            await invoke('save_preset', { presetName });
            await loadPresets();
            current_preset = presetName;
        } catch (error) {
            console.error('Failed to save preset:', error);
        }
    }

    async function randomizeSettings() {
        try {
            await invoke('randomize_settings');
            await loadSettings();
        } catch (error) {
            console.error('Failed to randomize settings:', error);
        }
    }

    async function stopSimulation() {
        try {
            await invoke('pause_simulation');
            running = false;
            if (autoHideManager) {
                autoHideManager.updateState({ running });
                autoHideManager.handlePause();
            }
        } catch (error) {
            console.error('Failed to pause simulation:', error);
        }
    }

    async function resumeSimulation() {
        try {
            await invoke('resume_simulation');
            running = true;
            if (autoHideManager) {
                autoHideManager.updateState({ running });
                autoHideManager.handleResume();
            }
        } catch (error) {
            console.error('Failed to resume simulation:', error);
        }
    }

    async function togglePause() {
        if (running) await stopSimulation();
        else await resumeSimulation();
    }

    let renderLoopId: number | null = null;

    function startRenderLoop() {
        async function renderLoop() {
            if (renderLoopId === null) return;
            try {
                // A redraw request, not the frame pump — `RenderLoop` owns the
                // real rAF chain (handlers/lifecycle.ts:112). `currentFps` used
                // to be assigned a hardcoded 60 here, which is a number the HUD
                // displayed as if it were measured; the real figure arrives on
                // the `fps-update` event this mode now listens for.
                await invoke('render_frame');
            } catch (e) {
                console.error('Render failed:', e);
            }
            if (renderLoopId !== null) {
                renderLoopId = requestAnimationFrame(renderLoop);
            }
        }
        renderLoopId = requestAnimationFrame(renderLoop);
    }

    function stopRenderLoop() {
        if (renderLoopId !== null) {
            cancelAnimationFrame(renderLoopId);
            renderLoopId = null;
        }
    }

    async function toggleBackendGui() {
        try {
            await invoke('toggle_gui');
            showUI = !showUI;
            if (autoHideManager) {
                autoHideManager.updateState({ showUI, running });
                autoHideManager.handleUIToggle(showUI);
            }
        } catch (err) {
            console.error('Failed to toggle backend GUI:', err);
        }
    }

    function returnToMenu() {
        stopRenderLoop();
        dispatch('back');
    }

    let isMousePressed = false;
    let lastPanX = 0;
    let lastPanY = 0;

    async function handleMouseEvent(e: CustomEvent) {
        const event = e.detail as MouseEvent | WheelEvent;
        if (autoHideManager) autoHideManager.handleUserInteraction();

        if (event.type === 'wheel') {
            const wheelEvent = event as WheelEvent;
            wheelEvent.preventDefault();
            const zoomDelta = -wheelEvent.deltaY * 0.001;
            const devicePixelRatio = window.devicePixelRatio || 1;
            const physicalCursorX = wheelEvent.clientX * devicePixelRatio;
            const physicalCursorY = wheelEvent.clientY * devicePixelRatio;
            try {
                await invoke('zoom_camera_to_cursor', {
                    delta: zoomDelta,
                    cursorX: physicalCursorX,
                    cursorY: physicalCursorY,
                });
            } catch (err) {
                console.error('Failed to zoom:', err);
            }
        } else if (event.type === 'mousedown') {
            const mouseEvent = event as MouseEvent;
            mouseEvent.preventDefault();
            if (mouseEvent.button === 0 || mouseEvent.button === 1) {
                isMousePressed = true;
                lastPanX = mouseEvent.clientX;
                lastPanY = mouseEvent.clientY;
            }
        } else if (event.type === 'mousemove' && isMousePressed) {
            const mouseEvent = event as MouseEvent;
            mouseEvent.preventDefault();
            const dx = (mouseEvent.clientX - lastPanX) * 0.002;
            const dy = (lastPanY - mouseEvent.clientY) * 0.002; // Y flipped for natural feel
            lastPanX = mouseEvent.clientX;
            lastPanY = mouseEvent.clientY;
            try {
                await invoke('pan_camera', { deltaX: dx, deltaY: dy });
            } catch (err) {
                console.error('Failed to pan:', err);
            }
        } else if (event.type === 'mouseup') {
            if (isMousePressed) {
                isMousePressed = false;
            }
        } else if (event.type === 'contextmenu') {
            (event as MouseEvent).preventDefault();
        }
    }
</script>
