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
                    noise field. Pan and zoom move the camera through the field (WASD, Q/E, or mouse).
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
                        options={['Black', 'White', 'Gray18', 'Color Scheme']}
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
                        options={['Noise', 'Image']}
                        value={settings?.vector_field_type ?? 'Noise'}
                        on:change={({ detail }) => {
                            if (detail.value === 'Noise' && webcamActive) stopWebcam();
                            updateSetting('vector_field_type', detail.value);
                        }}
                    />
                </div>
                {#if settings?.vector_field_type === 'Image'}
                    <ImageSelector
                        fitMode={settings?.image_fit_mode ?? 'Stretch'}
                        loadCommand="load_vectors_vector_field_image"
                        onFitModeChange={(value) => updateImageFitMode(value)}
                    />
                    <WebcamControls
                        {webcamDevices}
                        {webcamActive}
                        onStartWebcam={startWebcam}
                        onStopWebcam={stopWebcam}
                    />
                    <div class="control-group">
                        <label class="setting-label" for="image-mirror-h">Mirror Horizontal</label>
                        <input
                            id="image-mirror-h"
                            type="checkbox"
                            checked={settings?.image_mirror_horizontal ?? false}
                            on:change={(e) =>
                                updateSetting('image_mirror_horizontal', (e.target as HTMLInputElement).checked)}
                        />
                    </div>
                    <div class="control-group">
                        <label class="setting-label" for="image-mirror-v">Mirror Vertical</label>
                        <input
                            id="image-mirror-v"
                            type="checkbox"
                            checked={settings?.image_mirror_vertical ?? false}
                            on:change={(e) =>
                                updateSetting('image_mirror_vertical', (e.target as HTMLInputElement).checked)}
                        />
                    </div>
                    <div class="control-group">
                        <label class="setting-label" for="image-invert">Invert Tone</label>
                        <input
                            id="image-invert"
                            type="checkbox"
                            checked={settings?.image_invert_tone ?? false}
                            on:change={(e) =>
                                updateSetting('image_invert_tone', (e.target as HTMLInputElement).checked)}
                        />
                    </div>
                {/if}
                {#if settings?.vector_field_type === 'Noise'}
                <div class="control-group">
                    <label class="setting-label" for="noise-type">Noise Type</label>
                    <Selector
                        id="noise-type"
                        options={['OpenSimplex', 'Worley', 'Value', 'Fbm', 'FBMBillow', 'FBMClouds', 'FBMRidged', 'Billow', 'RidgedMulti', 'Cylinders', 'Checkerboard']}
                        value={settings?.noise_type ?? 'OpenSimplex'}
                        on:change={({ detail }) => updateSetting('noise_type', detail.value)}
                    />
                </div>
                <div class="control-group">
                    <label class="setting-label" for="noise-seed">Noise Seed:</label>
                    <NumberDragBox
                        id="noise-seed"
                        value={settings.noise_seed as number}
                        on:change={({ detail }) => updateSetting('noise_seed', detail)}
                        min={0}
                        max={4294967295}
                        step={1}
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
    import { invoke } from '@tauri-apps/api/core';
    import SimulationLayout from './components/shared/SimulationLayout.svelte';
    import CollapsibleFieldset from './components/shared/CollapsibleFieldset.svelte';
    import PresetFieldset from './components/shared/PresetFieldset.svelte';
    import ColorSchemeSelector from './components/shared/ColorSchemeSelector.svelte';
    import Selector from './components/inputs/Selector.svelte';
    import NumberDragBox from './components/inputs/NumberDragBox.svelte';
    import Button from './components/shared/Button.svelte';
    import ImageSelector from './components/shared/ImageSelector.svelte';
    import WebcamControls from './components/shared/WebcamControls.svelte';
    import CameraControls from './components/shared/CameraControls.svelte';
    import { AutoHideManager, createAutoHideEventListeners } from './utils/autoHide';
    import { createSyncManager } from './utils/sync';
    import type { AppMode } from '../types/app';

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

    let webcamDevices: number[] = [];
    let webcamActive = false;

    interface Settings {
        vector_field_type?: string;
        noise_type: string;
        noise_scale: number;
        noise_dt_multiplier: number;
        density: number;
        line_length: number;
        line_width: number;
        background_color_mode: string;
        image_fit_mode?: string;
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
                    onControlsShow: () => { controlsVisible = true; },
                    onControlsHide: () => { controlsVisible = false; },
                    onCursorShow: () => { document.body.style.cursor = ''; },
                    onCursorHide: () => { document.body.style.cursor = 'none'; },
                },
                { autoHideDelay, cursorHideDelay: 2000 }
            );

            eventListeners = createAutoHideEventListeners(() => {
                autoHideManager.handleUserInteraction();
            });
            eventListeners.add();

            await invoke('start_simulation', { simulationType: 'vectors' });
            await Promise.all([
                loadSettings(),
                loadState(),
                loadPresets(),
                loadColorSchemes(),
                loadWebcamDevices(),
            ]);
            startRenderLoop();

            running = true;
            loading = false;
        } catch (error) {
            console.error('Failed to start Vectors simulation:', error);
            loading = false;
        }
    });

    onDestroy(() => {
        if (webcamActive) {
            invoke('stop_vectors_webcam_capture').catch(console.error);
        }
        if (running) {
            invoke('destroy_simulation').catch(console.error);
        }
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

    async function loadWebcamDevices() {
        try {
            webcamDevices = (await invoke('get_available_vectors_webcam_devices')) as number[];
        } catch (e) {
            console.error('Failed to load vectors webcam devices:', e);
        }
    }

    async function startWebcam() {
        try {
            await invoke('start_vectors_webcam_capture');
            webcamActive = true;
        } catch (e) {
            console.error('Failed to start vectors webcam:', e);
        }
    }

    async function stopWebcam() {
        try {
            await invoke('stop_vectors_webcam_capture');
            webcamActive = false;
        } catch (e) {
            console.error('Failed to stop vectors webcam:', e);
        }
    }

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
                await invoke('render_frame');
                currentFps = 60;
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
