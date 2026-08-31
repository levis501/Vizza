<SimulationLayout
    simulationName="Gradient Editor"
    {running}
    {loading}
    {showUI}
    {currentFps}
    {controlsVisible}
    {menuPosition}
    showCenterControls={false}
    showRightControls={false}
    on:back={goBack}
    on:toggleUI={toggleBackendGui}
    on:pause={stopSimulation}
    on:resume={resumeSimulation}
    on:userInteraction={handleUserInteraction}
    on:mouseEvent={handleMouseEvent}
>
    <!-- Custom GEM Header -->
    <div class="gem-header">
        <div class="header-left">
            <h2>Gradient Editor</h2>
        </div>
        <div class="header-right">
            <button
                class="save-button"
                on:click={saveColorScheme}
                disabled={!colorSchemeName.trim()}
            >
                💾 Save Color Scheme
            </button>
        </div>
    </div>

    <!-- Save outcome — success or the reason the save was refused -->
    {#if saveMessage}
        <div class="save-message" class:failed={saveFailed} role="status">
            {saveMessage}
        </div>
    {/if}

    <!-- Gradient Stops Overlay -->
    <div class="gradient-stops-overlay">
        <div class="stops-container">
            <div
                class="gradient-bar"
                role="button"
                tabindex="0"
                on:dblclick={addStopAtPosition}
                on:keydown={(e) => e.key === 'Enter' && addStopAtPosition(e)}
            >
                {#each gradientStops as stop, index}
                    <div
                        class="color-stop"
                        class:selected={selectedStopIndex === index}
                        style="left: {stop.position * 100}%; background-color: {stop.color}"
                        role="button"
                        tabindex="0"
                        on:click={() => selectStop(index)}
                        on:keydown={(e) => e.key === 'Enter' && selectStop(index)}
                        on:mousedown={(e) => startDragging(e, index)}
                    >
                        <div class="stop-handle"></div>
                    </div>
                {/each}
            </div>
        </div>
    </div>

    <!-- Control Panel -->
    <div class="control-panel">
        <!-- Header Section - Grid layout -->
        <div class="control-header">
            <div class="header-grid">
                <div class="name-section">
                    <label for="color-scheme-name-input">Name:</label>
                    <input
                        id="color-scheme-name-input"
                        type="text"
                        bind:value={colorSchemeName}
                        placeholder="Color Scheme Name"
                        class="color-scheme-name-input"
                    />
                </div>
                <div class="preset-section">
                    <label for="preset-selector">Preset:</label>
                    <!-- 'Heat', not 'Warm': `applyPreset` has always switched on
                    'Heat' (and ColorSchemeSelector.svelte:64 offers that
                    spelling), so the 'Warm' option here matched no arm and
                    selecting it cleared the stop selection without changing a
                    single stop. -->
                    <Selector
                        id="preset-selector"
                        options={[
                            'Custom',
                            'Rainbow',
                            'Heat',
                            'Cool',
                            'Viridis',
                            'Plasma',
                            'Inferno',
                        ]}
                        bind:value={selectedPreset}
                        on:change={applyPreset}
                    />
                </div>
                <div class="space-section">
                    <label for="color-space-selector">Color Space:</label>
                    <Selector
                        id="color-space-selector"
                        options={COLOR_SPACE_OPTIONS}
                        bind:value={colorSpaceLabel}
                        on:change={handleColorSpaceChange}
                    />
                </div>
                <div class="display-section">
                    <label for="display-mode-selector">Display Mode:</label>
                    <Selector
                        id="display-mode-selector"
                        options={['Smooth', 'Dithered']}
                        bind:value={selectedDisplayMode}
                        on:change={handleDisplayModeChange}
                    />
                </div>
                <div class="display-section">
                    <label for="interpolation-mode-selector">Interpolation:</label>
                    <Selector
                        id="interpolation-mode-selector"
                        options={['Smooth', 'Stepped']}
                        bind:value={interpolationMode}
                        on:change={updateGradient}
                    />
                </div>
            </div>
        </div>

        <!-- Selected Stop Controls - Grid layout -->
        {#if selectedStopIndex >= 0 && selectedStopIndex < gradientStops.length}
            <div class="stop-controls">
                <div class="stop-header">
                    <span class="stop-title"
                        >Stop {selectedStopIndex + 1} ({Math.round(
                            gradientStops[selectedStopIndex].position * 100
                        )}%)</span
                    >
                    <div class="stop-actions">
                        <button type="button" on:click={duplicateStop} class="btn-compact"
                            >Copy</button
                        >
                        {#if gradientStops.length > 2}
                            <button
                                type="button"
                                on:click={deleteStop}
                                class="btn-compact btn-danger">Delete</button
                            >
                        {/if}
                    </div>
                </div>
                <div class="stop-controls-grid">
                    <div class="control-item">
                        <label for="color-picker">Color</label>
                        <input
                            id="color-picker"
                            type="color"
                            bind:value={gradientStops[selectedStopIndex].color}
                            on:input={handleColorInput}
                            class="color-picker"
                        />
                    </div>
                    <div class="control-item">
                        <label for="position-slider">Position</label>
                        <input
                            id="position-slider"
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            bind:value={gradientStops[selectedStopIndex].position}
                            on:input={handlePositionInput}
                            class="position-slider"
                        />
                    </div>
                </div>
            </div>
        {/if}

        <!-- Actions Section - Grid layout -->
        <div class="actions-section">
            <div class="actions-grid">
                <div class="action-group">
                    <span class="section-label">Actions</span>
                    <div class="button-group">
                        <button type="button" on:click={reverseGradient} class="btn-action"
                            >Reverse</button
                        >
                        <button type="button" on:click={exportLUT} class="btn-action">Export</button
                        >
                    </div>
                </div>
                <div class="random-group">
                    <span class="section-label">Random Generator</span>
                    <div class="random-controls">
                        <div class="random-row">
                            <Selector
                                options={[
                                    'Basic',
                                    'Warm',
                                    'Cool',
                                    'Pastel',
                                    'Neon',
                                    'Earth',
                                    'Monochrome',
                                    'Complementary',
                                    'Truly Random',
                                ]}
                                bind:value={selectedRandomScheme}
                            />
                            <Selector
                                options={['Random', 'Even']}
                                bind:value={randomStopPlacement}
                            />
                        </div>
                        <div class="random-row">
                            <div class="stops-control">
                                <span>Stops: {randomStopCount}</span>
                                <input
                                    type="range"
                                    min="2"
                                    max="16"
                                    step="1"
                                    bind:value={randomStopCount}
                                    class="stops-range"
                                />
                            </div>
                            <button
                                type="button"
                                on:click={triggerRandomization}
                                class="btn-generate">Generate</button
                            >
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</SimulationLayout>

<!-- Shared camera controls component -->
<CameraControls enabled={true} on:toggleGui={toggleBackendGui} on:togglePause={togglePause} />

<script lang="ts">
    import { createEventDispatcher, onMount, onDestroy } from 'svelte';
    import { invoke } from '$lib/rpc';
    import { listen } from '$lib/rpc';
    import SimulationLayout from './components/shared/SimulationLayout.svelte';
    import CameraControls from './components/shared/CameraControls.svelte';
    import Selector from './components/inputs/Selector.svelte';
    import {
        DEFAULT_GRADIENT_COLOR_SPACE,
        GRADIENT_COLOR_SPACES,
        GRADIENT_COLOR_SPACE_LABELS,
        buildGradientLut,
        parseGradientColorSpace,
        sampleGradient,
        type GradientColorSpace,
    } from '$lib/engine/color/spaces';
    // import { createSyncManager } from './utils/sync';

    const dispatch = createEventDispatcher();

    export let autoHideDelay: number = 3000;

    /**
     * The one list of colour spaces, shared with ColorSchemeSelector.svelte.
     *
     * Both files used to carry their own: this one offered culori's `jab` and
     * `lchuv` (which work but have no counterpart in gradient.wgsl), while
     * ColorSchemeSelector.svelte:75 offered `Jzazbz` and `HSLuv` mapped onto
     * culori mode names culori does not register — so two of its five spaces
     * threw `converters[color.mode].rgb is not a function` in all nine modes.
     * Deriving both pickers from `GRADIENT_COLOR_SPACES` is what stops them
     * drifting apart again.
     */
    const COLOR_SPACE_OPTIONS = GRADIENT_COLOR_SPACES.map(
        (space) => GRADIENT_COLOR_SPACE_LABELS[space]
    );

    // State variables
    let colorSchemeName = '';
    let selectedColorSpace: GradientColorSpace = DEFAULT_GRADIENT_COLOR_SPACE;
    // The <Selector> shows display names; `selectedColorSpace` is the canonical
    // id. Kept as its own binding rather than a `$:` derivation because
    // `bind:value` writes back into whatever it is given.
    let colorSpaceLabel = GRADIENT_COLOR_SPACE_LABELS[selectedColorSpace];
    let selectedPreset = 'Custom';
    let selectedDisplayMode = 'Smooth';
    let interpolationMode: 'Smooth' | 'Stepped' = 'Smooth';
    let selectedRandomScheme: string = 'Basic';
    let randomStopPlacement: 'Even' | 'Random' = 'Random';
    let randomStopCount: number = 3;
    let gradientStops = [
        { position: 0, color: '#0000ff' },
        { position: 1, color: '#ffff00' },
    ];
    let selectedStopIndex = 0;
    let isDragging = false;
    let dragStopIndex = -1;
    let updateTimeout: number | null = null;
    let unlistenSimulationInitialized: (() => void) | null = null;
    let saveMessage = '';
    let saveFailed = false;
    let saveMessageTimeout: number | null = null;
    /**
     * Set by `onDestroy`, checked by everything asynchronous.
     *
     * `updateGradient` is debounced 50 ms, so leaving a fresh edit and hitting
     * "Back to Menu" fired `update_gradient_preview` *after* the mode had torn
     * its simulation down. Clearing the timer covers the common case; the flag
     * covers the one where the timer has already fired and is sitting in an
     * `await`.
     */
    let destroyed = false;

    // Simulation control state
    let running = false;
    // True until `start_simulation` settles, as in every other mode — and
    // cleared in the failure path too, or a browser with no WebGPU is left
    // behind an overlay that swallows the "Back to Menu" click (M2 defect 3).
    let loading = true;
    let showUI = true;
    const currentFps = 0;
    let controlsVisible = true;
    const menuPosition = 'middle';

    // Auto-hide functionality for controls when UI is hidden
    let hideTimeout: number | null = null;

    // Create sync manager for type-safe backend synchronization (not used in this mode)
    // const syncManager = createSyncManager<any, any>();

    /** What `sampleGradient` and `buildGradientLut` need from this editor. */
    function gradientOptions() {
        return { space: selectedColorSpace, mode: interpolationMode };
    }

    // Event handlers
    function handleColorSpaceChange({ detail }: { detail: { value: string } }) {
        // Through the parser rather than a cast: it folds every spelling either
        // editor has ever stored onto the canonical set, so a display name, a
        // legacy `jab`, or a stored `lchuv` all land somewhere real instead of
        // leaving the <Selector> showing nothing.
        selectedColorSpace = parseGradientColorSpace(detail.value);
        colorSpaceLabel = GRADIENT_COLOR_SPACE_LABELS[selectedColorSpace];
        updateGradient();
    }

    async function handleDisplayModeChange() {
        const mode = selectedDisplayMode === 'Dithered' ? 1 : 0;
        try {
            await invoke('set_gradient_display_mode', { mode });
        } catch (error) {
            console.error('Failed to set display mode:', error);
        }
    }

    function selectStop(index: number) {
        selectedStopIndex = index;
    }

    function addStopAtPosition(event: MouseEvent | KeyboardEvent) {
        if (event instanceof MouseEvent) {
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
            const position = (event.clientX - rect.left) / rect.width;
            addStop(position);
        } else {
            addStop(0.5);
        }
    }

    function addStop(position: number) {
        const color = getColorAtPosition(position);
        gradientStops = [...gradientStops, { position, color }];
        gradientStops.sort((a, b) => a.position - b.position);
        selectedStopIndex = gradientStops.findIndex(
            (stop) => Math.abs(stop.position - position) < 0.001
        );
        updateGradient();
    }

    function deleteStop() {
        if (gradientStops.length <= 2) return;
        gradientStops = gradientStops.filter((_, i) => i !== selectedStopIndex);
        if (selectedStopIndex >= gradientStops.length) {
            selectedStopIndex = gradientStops.length - 1;
        }
        updateGradient();
    }

    function duplicateStop() {
        const stop = gradientStops[selectedStopIndex];
        const newStop = { ...stop, position: Math.min(1, stop.position + 0.05) };
        gradientStops = [...gradientStops, newStop];
        gradientStops.sort((a, b) => a.position - b.position);
        selectedStopIndex = gradientStops.findIndex((s) => s === newStop);
        updateGradient();
    }

    function startDragging(event: MouseEvent, index: number) {
        event.preventDefault();
        isDragging = true;
        dragStopIndex = index;
        selectedStopIndex = index;

        const handleMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;
            const gradientBar = document.querySelector('.gradient-bar') as HTMLElement;
            if (!gradientBar) return;

            const rect = gradientBar.getBoundingClientRect();
            const position = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

            // Update position without sorting during drag for better performance
            gradientStops[dragStopIndex].position = position;
            gradientStops = [...gradientStops]; // Trigger reactivity

            // Use immediate visual update during drag
            updateGradientImmediate();
        };

        const handleMouseUp = () => {
            isDragging = false;
            // Sort only when drag ends
            gradientStops = [...gradientStops].sort((a, b) => a.position - b.position);
            dragStopIndex = gradientStops.findIndex(
                (stop) => Math.abs(stop.position - gradientStops[dragStopIndex].position) < 0.001
            );
            selectedStopIndex = dragStopIndex;
            // Final update with full LUT generation
            updateGradient();

            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }

    /**
     * `sampleGradient` (engine/color/spaces.ts:511) is a port of exactly what
     * this function used to do — clamp, hold the terminal colour outside the
     * stop range, binary-search the bracketing pair — plus the guard the
     * hand-rolled version lacked: two stops dragged onto each other divided by
     * zero and handed culori a `t` of NaN, which baked a poisoned LUT.
     */
    function getColorAtPosition(position: number): string {
        return sampleGradient(gradientStops, position, gradientOptions());
    }

    // Immediate visual update during dragging (no backend call)
    function updateGradientImmediate() {
        // Just trigger reactivity for visual feedback
        gradientStops = [...gradientStops];
    }

    // Handle color input
    function handleColorInput() {
        // Force immediate update to ensure color changes are reflected
        gradientStops = [...gradientStops];
        updateGradient();
    }

    // Handle position input with sorting
    function handlePositionInput() {
        gradientStops = [...gradientStops].sort((a, b) => a.position - b.position);
        selectedStopIndex = gradientStops.findIndex(
            (stop) => Math.abs(stop.position - gradientStops[selectedStopIndex].position) < 0.001
        );
        updateGradient();
    }

    /** The 768-byte planar LUT for the current stops. */
    function generateLutData(): Uint8Array {
        return buildGradientLut(gradientStops, gradientOptions());
    }

    async function updateGradient() {
        // Clear any existing timeout
        if (updateTimeout) {
            clearTimeout(updateTimeout);
        }
        if (destroyed) return;

        // Debounce the LUT update to avoid too many rapid calls
        updateTimeout = window.setTimeout(async () => {
            updateTimeout = null;
            // The timer is cleared in onDestroy, but a rebuild already in
            // flight when the user leaves would still push a LUT at a
            // simulation that no longer exists.
            if (destroyed) return;
            try {
                // Convert Uint8Array to regular array for proper serialization
                const lutDataArray = Array.from(generateLutData());

                // Single optimized call to update gradient preview
                await invoke('update_gradient_preview', { colorSchemeData: lutDataArray });
            } catch (e) {
                console.error('Failed to update gradient:', e);
            }
        }, 50); // Reduced debounce for better responsiveness
    }

    function applyPreset() {
        switch (selectedPreset) {
            case 'Rainbow':
                gradientStops = [
                    { position: 0, color: '#ff0000' },
                    { position: 0.17, color: '#ff8000' },
                    { position: 0.33, color: '#ffff00' },
                    { position: 0.5, color: '#00ff00' },
                    { position: 0.67, color: '#0080ff' },
                    { position: 0.83, color: '#8000ff' },
                    { position: 1, color: '#ff0080' },
                ];
                break;
            case 'Heat':
                gradientStops = [
                    { position: 0, color: '#000000' },
                    { position: 0.5, color: '#ff0000' },
                    { position: 1, color: '#ffff00' },
                ];
                break;
            case 'Cool':
                gradientStops = [
                    { position: 0, color: '#0000ff' },
                    { position: 0.5, color: '#00ffff' },
                    { position: 1, color: '#ffffff' },
                ];
                break;
            case 'Viridis':
                gradientStops = [
                    { position: 0, color: '#440154' },
                    { position: 0.25, color: '#31688e' },
                    { position: 0.5, color: '#35b779' },
                    { position: 0.75, color: '#fde725' },
                    { position: 1, color: '#fde725' },
                ];
                break;
            case 'Plasma':
                gradientStops = [
                    { position: 0, color: '#0d0887' },
                    { position: 0.25, color: '#7e03a8' },
                    { position: 0.5, color: '#cc4778' },
                    { position: 0.75, color: '#f89441' },
                    { position: 1, color: '#f0f921' },
                ];
                break;
            case 'Inferno':
                gradientStops = [
                    { position: 0, color: '#000004' },
                    { position: 0.25, color: '#1b0c41' },
                    { position: 0.5, color: '#4a0c6b' },
                    { position: 0.75, color: '#781c6d' },
                    { position: 1, color: '#ed6925' },
                ];
                break;
        }
        selectedStopIndex = 0;
        updateGradient();
    }

    function reverseGradient() {
        gradientStops = gradientStops
            .map((stop) => ({
                ...stop,
                position: 1 - stop.position,
            }))
            .sort((a, b) => a.position - b.position);
        updateGradient();
    }

    function triggerRandomization() {
        randomizeGradient(selectedRandomScheme);
    }

    function generateRandomColors(scheme: string, desiredCount?: number): string[] {
        let colors: string[] = [];

        switch (scheme) {
            case 'Basic':
                colors = [
                    '#ff0000',
                    '#00ff00',
                    '#0000ff',
                    '#ffff00',
                    '#ff00ff',
                    '#00ffff',
                    '#ff8000',
                    '#8000ff',
                ];
                break;
            case 'Warm':
                colors = [
                    '#ff4500',
                    '#ff6347',
                    '#ffa500',
                    '#ff8c00',
                    '#dc143c',
                    '#b22222',
                    '#cd853f',
                    '#d2691e',
                ];
                break;
            case 'Cool':
                colors = [
                    '#4169e1',
                    '#0000cd',
                    '#1e90ff',
                    '#00bfff',
                    '#87ceeb',
                    '#20b2aa',
                    '#008b8b',
                    '#4682b4',
                ];
                break;
            case 'Pastel':
                colors = [
                    '#ffb3ba',
                    '#ffdfba',
                    '#ffffba',
                    '#baffc9',
                    '#bae1ff',
                    '#e6baff',
                    '#ffc9ba',
                    '#c9baff',
                ];
                break;
            case 'Neon':
                colors = [
                    '#ff073a',
                    '#39ff14',
                    '#00ffff',
                    '#ff00ff',
                    '#ffff00',
                    '#ff4500',
                    '#8a2be2',
                    '#00ff7f',
                ];
                break;
            case 'Earth':
                colors = [
                    '#8b4513',
                    '#a0522d',
                    '#cd853f',
                    '#daa520',
                    '#b8860b',
                    '#9acd32',
                    '#6b8e23',
                    '#556b2f',
                ];
                break;
            case 'Monochrome': {
                const baseHue = Math.floor(Math.random() * 360);
                colors = [];
                for (let i = 0; i < 8; i++) {
                    const saturation = 50 + Math.random() * 50; // 50-100%
                    const lightness = 20 + Math.random() * 60; // 20-80%
                    colors.push(hslToHex(baseHue, saturation, lightness));
                }
                break;
            }
            case 'Complementary': {
                const hue1 = Math.floor(Math.random() * 360);
                const hue2 = (hue1 + 180) % 360;
                colors = [
                    hslToHex(hue1, 70, 50),
                    hslToHex(hue1, 80, 30),
                    hslToHex(hue1, 60, 70),
                    hslToHex(hue2, 70, 50),
                    hslToHex(hue2, 80, 30),
                    hslToHex(hue2, 60, 70),
                ];
                break;
            }
            case 'Truly Random': {
                const target = Math.max(2, desiredCount ?? 8);
                const set = new Set<string>();
                while (set.size < target) {
                    const r = Math.floor(Math.random() * 256);
                    const g = Math.floor(Math.random() * 256);
                    const b = Math.floor(Math.random() * 256);
                    const hex = `#${r.toString(16).padStart(2, '0')}${g
                        .toString(16)
                        .padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
                    set.add(hex);
                }
                colors = Array.from(set);
                break;
            }
        }

        return colors;
    }

    function generateStopPositions(count: number, placement: 'Even' | 'Random'): number[] {
        if (placement === 'Even') {
            // Generate evenly spaced positions
            const positions: number[] = [];
            for (let i = 0; i < count; i++) {
                positions.push(i / (count - 1));
            }
            return positions;
        } else {
            // Generate random positions
            const positions: number[] = [0, 1]; // Always include start and end

            // Add intermediate positions
            for (let i = 2; i < count; i++) {
                positions.push(0.1 + Math.random() * 0.8); // Avoid edges
            }

            return positions.sort((a, b) => a - b);
        }
    }

    function randomizeGradient(scheme: string = 'Basic') {
        const stopCount = randomStopCount;
        const colors = generateRandomColors(scheme, stopCount);
        const positions = generateStopPositions(stopCount, randomStopPlacement);
        const palette = [...colors];
        for (let i = palette.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [palette[i], palette[j]] = [palette[j], palette[i]];
        }
        gradientStops = positions.map((position, i) => ({
            position,
            color: palette[i % palette.length],
        }));

        selectedStopIndex = 0;
        updateGradient();
    }

    /** Show `text` for three seconds, replacing whatever is on screen. */
    function showSaveMessage(text: string, failed: boolean) {
        if (saveMessageTimeout) clearTimeout(saveMessageTimeout);
        saveMessage = text;
        saveFailed = failed;
        saveMessageTimeout = window.setTimeout(() => {
            saveMessage = '';
            saveFailed = false;
        }, 3000);
    }

    async function saveColorScheme() {
        if (!colorSchemeName.trim()) return;
        try {
            const lutData = Array.from(generateLutData());
            // `save_custom_color_scheme` answers with the name the scheme was
            // actually stored under — trimmed — and that is the name the picker
            // will list, so select by it rather than by the raw input.
            const savedName = (await invoke('save_custom_color_scheme', {
                name: colorSchemeName,
                colorSchemeData: lutData,
            })) as string;

            // Update the gradient simulation with the new LUT
            await invoke('apply_color_scheme_by_name', { colorSchemeName: savedName });

            showSaveMessage(`LUT "${savedName}" saved successfully!`, false);
        } catch (e) {
            // Reported on screen and *not* to the console: the one failure a
            // user can actually provoke here is `saveCustom` refusing a
            // built-in's name (ColorSchemeManager.ts:264), which is a message
            // to read and act on, not a program error. Logging it would also
            // make the refusal indistinguishable from a real fault in a
            // console-clean E2E run.
            showSaveMessage(e instanceof Error ? e.message : `Failed to save LUT: ${e}`, true);
        }
    }

    /**
     * Download the current gradient as a real `.lut` file.
     *
     * This used to write the 768 values *interleaved* (`r,g,b,r,g,b…`) as
     * newline-separated text, so the file it produced could not be loaded back
     * by either build: every `.lut` in `src-tauri/src/simulations/shared/LUTs/`
     * is exactly 768 raw bytes in planar `[R×256][G×256][B×256]` order, which
     * is what `buildGradientLut` returns and what `ColorScheme.fromBytes`
     * reads.
     */
    function exportLUT() {
        const blob = new Blob([generateLutData()], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${colorSchemeName || 'custom'}.lut`;
        link.click();
        URL.revokeObjectURL(url);
    }

    function goBack() {
        dispatch('back');
    }

    async function toggleBackendGui() {
        try {
            await invoke('toggle_gui');
            const visible = (await invoke('get_gui_state')) as boolean;
            showUI = visible;

            if (!showUI) {
                showControls();
                startAutoHideTimer();
            } else {
                stopAutoHideTimer();
                controlsVisible = true;
            }
        } catch (error) {
            console.error('Failed to toggle GUI:', error);
        }
    }

    async function stopSimulation() {
        try {
            await invoke('pause_simulation');
            running = false;
        } catch (error) {
            console.error('Failed to stop simulation:', error);
        }
    }

    async function resumeSimulation() {
        try {
            await invoke('resume_simulation');
            running = true;
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

    function handleUserInteraction() {
        if (!showUI && !controlsVisible) {
            showControls();
            startAutoHideTimer();
        } else if (!showUI && controlsVisible) {
            startAutoHideTimer();
        }
    }

    function handleMouseEvent() {
        // Handle mouse events if needed
    }

    // Auto-hide functionality
    function startAutoHideTimer() {
        stopAutoHideTimer();
        hideTimeout = window.setTimeout(() => {
            if (!showUI) {
                controlsVisible = false;
            }
        }, autoHideDelay);
    }

    function stopAutoHideTimer() {
        if (hideTimeout) {
            clearTimeout(hideTimeout);
            hideTimeout = null;
        }
    }

    function showControls() {
        controlsVisible = true;
    }

    function hslToHex(h: number, s: number, l: number): string {
        s /= 100;
        l /= 100;
        const c = (1 - Math.abs(2 * l - 1)) * s;
        const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
        const m = l - c / 2;

        let r = 0;
        let g = 0;
        let b = 0;

        if (h < 60) {
            r = c;
            g = x;
            b = 0;
        } else if (h < 120) {
            r = x;
            g = c;
            b = 0;
        } else if (h < 180) {
            r = 0;
            g = c;
            b = x;
        } else if (h < 240) {
            r = 0;
            g = x;
            b = c;
        } else if (h < 300) {
            r = x;
            g = 0;
            b = c;
        } else {
            r = c;
            g = 0;
            b = x;
        }

        r = Math.round((r + m) * 255);
        g = Math.round((g + m) * 255);
        b = Math.round((b + m) * 255);

        const hexR = r.toString(16).padStart(2, '0');
        const hexG = g.toString(16).padStart(2, '0');
        const hexB = b.toString(16).padStart(2, '0');

        return `#${hexR}${hexG}${hexB}`;
    }

    onMount(async () => {
        try {
            // Listen for simulation-initialized event
            unlistenSimulationInitialized = await listen('simulation-initialized', async () => {
                // Now that simulation is initialized, update gradient
                updateGradient();
            });

            // Start gradient simulation
            await invoke('start_simulation', { simulationType: 'gradient' });
            running = true;

            // Add event listeners for auto-hide functionality (excluding keydown to avoid conflicts with CameraControls)
            const events = ['mousedown', 'mousemove', 'wheel', 'touchstart'];
            events.forEach((event) => {
                window.addEventListener(event, handleUserInteraction, { passive: true });
            });
        } catch (e) {
            console.error('Failed to start gradient simulation:', e);
        } finally {
            loading = false;
        }
    });

    onDestroy(async () => {
        // Before the await: everything below runs a microtask later, and the
        // debounced rebuild is 50 ms out.
        destroyed = true;
        if (updateTimeout) {
            clearTimeout(updateTimeout);
            updateTimeout = null;
        }

        try {
            await invoke('destroy_simulation');
        } catch (error) {
            console.error('Failed to destroy simulation on component destroy:', error);
        }

        if (unlistenSimulationInitialized) {
            unlistenSimulationInitialized();
        }

        // Remove event listeners for auto-hide functionality
        const events = ['mousedown', 'mousemove', 'wheel', 'touchstart'];
        events.forEach((event) => {
            window.removeEventListener(event, handleUserInteraction);
        });

        // Clear any remaining timeouts
        if (hideTimeout) {
            clearTimeout(hideTimeout);
        }
        if (saveMessageTimeout) {
            clearTimeout(saveMessageTimeout);
        }
    });
</script>

<style>
    /* Gradient editor specific styles */

    /* Custom GEM Header */
    .gem-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 1rem 1.5rem;
        background: rgba(26, 26, 26, 0.95);
        border-bottom: 1px solid #444;
        margin-bottom: 1rem;
    }

    .header-left h2 {
        margin: 0;
        font-size: 1.5rem;
        color: #646cff;
    }

    .header-right {
        display: flex;
        gap: 0.5rem;
    }

    .save-button {
        background: #646cff;
        color: white;
        border: 1px solid #646cff;
        padding: 0.5rem 1rem;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 500;
        transition: all 0.2s ease;
    }

    .save-button:hover:not(:disabled) {
        background: #535bf2;
        border-color: #535bf2;
        transform: translateY(-1px);
        box-shadow: 0 4px 8px rgba(100, 108, 255, 0.3);
    }

    .save-button:disabled {
        background: #adb5bd;
        border-color: #adb5bd;
        cursor: not-allowed;
        transform: none;
        box-shadow: none;
    }

    .gradient-stops-overlay {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 2rem;
    }

    .stops-container {
        width: 100%;
        max-width: 800px;
    }

    .gradient-bar {
        height: 80px;
        border-radius: 12px;
        position: relative;
        cursor: crosshair;
        border: 3px solid rgba(255, 255, 255, 0.3);
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
    }

    .color-stop {
        position: absolute;
        top: 50%;
        transform: translate(-50%, -50%);
        width: 24px;
        height: 48px;
        border: 3px solid white;
        border-radius: 6px;
        cursor: grab;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        transition: all 0.2s ease;
    }

    .color-stop:hover {
        transform: translate(-50%, -50%) scale(1.15);
        box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6);
    }

    .color-stop.selected {
        border-color: #646cff;
        box-shadow: 0 6px 24px rgba(100, 108, 255, 0.6);
    }

    .stop-handle {
        width: 100%;
        height: 100%;
        background: inherit;
        border-radius: 3px;
    }

    .control-panel {
        background: rgba(26, 26, 26, 0.95);
        border-top: 1px solid #444;
        padding: 0.75rem 1rem;
        overflow-y: auto;
        max-height: 400px;
    }

    .control-header {
        margin-bottom: 0.75rem;
        padding-bottom: 0.5rem;
        border-bottom: 1px solid #444;
    }

    .header-grid {
        display: grid;
        grid-template-columns: auto auto;
        gap: 1rem;
        align-items: center;
        justify-content: start;
    }

    .name-section {
        display: flex;
        align-items: center;
        gap: 0.4rem;
    }

    .name-section label {
        font-weight: 500;
        color: #ccc;
        font-size: 0.8rem;
        white-space: nowrap;
    }

    .color-scheme-name-input {
        background: #333;
        border: 1px solid #555;
        color: white;
        padding: 0.25rem 0.4rem;
        border-radius: 3px;
        width: 120px;
        font-size: 0.8rem;
    }

    .preset-section {
        display: flex;
        align-items: center;
        gap: 0.4rem;
    }

    .preset-section label {
        font-weight: 500;
        color: #ccc;
        font-size: 0.8rem;
        white-space: nowrap;
    }

    .space-section,
    .display-section {
        display: flex;
        align-items: center;
        gap: 0.4rem;
    }

    .space-section label,
    .display-section label {
        font-weight: 500;
        color: #ccc;
        font-size: 0.8rem;
        white-space: nowrap;
    }

    .stop-controls {
        margin-bottom: 0.75rem;
        padding-bottom: 0.5rem;
        border-bottom: 1px solid #444;
    }

    .stop-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.5rem;
    }

    .stop-title {
        font-weight: 500;
        color: #646cff;
        font-size: 0.9rem;
    }

    .stop-actions {
        display: flex;
        gap: 0.3rem;
    }

    .stop-controls-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.75rem;
    }

    .control-item {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .control-item label {
        font-weight: 500;
        color: #ccc;
        font-size: 0.75rem;
        white-space: nowrap;
    }

    .color-picker {
        width: 100%;
        height: 24px;
        border: none;
        border-radius: 3px;
        cursor: pointer;
    }

    .position-slider {
        width: 100%;
        height: 20px;
    }

    .actions-section {
        margin-top: 0.75rem;
        padding-top: 0.5rem;
        border-top: 1px solid #444;
    }

    .actions-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0.75rem;
        align-items: center;
    }

    .action-group {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .button-group {
        display: flex;
        gap: 0.3rem;
    }

    .random-group {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .random-controls {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
    }

    .random-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        flex-wrap: wrap;
    }

    .stops-control {
        display: flex;
        align-items: center;
        gap: 0.4rem;
    }

    .stops-control span {
        font-weight: 500;
        color: #646cff;
        font-size: 0.8rem;
        white-space: nowrap;
    }

    .stops-range {
        width: 50px;
        height: 18px;
    }

    .btn-action {
        padding: 0.25rem 0.5rem;
        font-size: 0.75rem;
        border-radius: 3px;
        border: 1px solid #555;
        background: #333;
        color: white;
        cursor: pointer;
        transition: background-color 0.2s;
        white-space: nowrap;
    }

    .btn-action:hover {
        background: #444;
    }

    .btn-compact {
        padding: 0.25rem 0.5rem;
        font-size: 0.75rem;
        border-radius: 3px;
        border: 1px solid #555;
        background: #333;
        color: white;
        cursor: pointer;
        transition: background-color 0.2s;
        white-space: nowrap;
    }

    .btn-compact:hover {
        background: #444;
    }

    .btn-compact.btn-danger {
        background: #dc3545;
        border-color: #dc3545;
    }

    .btn-compact.btn-danger:hover {
        background: #c82333;
    }

    .btn-generate {
        padding: 0.25rem 0.5rem;
        font-size: 0.75rem;
        border-radius: 3px;
        border: 1px solid #555;
        background: #333;
        color: white;
        cursor: pointer;
        transition: background-color 0.2s;
        white-space: nowrap;
    }

    .btn-generate:hover {
        background: #444;
    }

    .save-message {
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background-color: #4caf50; /* Green background */
        color: white;
        padding: 10px 20px;
        border-radius: 5px;
        z-index: 1001; /* Above other content */
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        animation: fadeInOut 3s ease-in-out;
        max-width: min(640px, 90vw);
        text-align: center;
    }

    /* A refused save — most often a name that collides with a built-in. */
    .save-message.failed {
        background-color: #dc3545;
    }

    @keyframes fadeInOut {
        0% {
            opacity: 0;
        }
        20% {
            opacity: 1;
        }
        80% {
            opacity: 1;
        }
        100% {
            opacity: 0;
        }
    }
</style>
