<div class="diagram-container">
    <div class="instructions">
        <span>Drag the colorful handles to adjust reaction-diffusion parameters</span>
    </div>

    <div class="plots-container">
        <!-- Feed Rate vs Kill Rate Plot -->
        <div class="plot-section">
            <XYPlot
                xValue={feedRate}
                yValue={killRate}
                xRange={feedRatePlotRange}
                yRange={killRatePlotRange}
                xLabel="Feed Rate (F)"
                yLabel="Kill Rate (K)"
                title="Feed Rate (F) vs Kill Rate (K)"
                handleColor="#ef4444"
                handleStrokeColor="#dc2626"
                valueLabelX="F"
                valueLabelY="K"
                width={400}
                height={300}
                margin={40}
                on:update={handleFeedKillUpdate}
            />
        </div>

        <!-- Diffusion U vs Diffusion V Plot -->
        <div class="plot-section">
            <XYPlot
                xValue={diffusionRateU}
                yValue={diffusionRateV}
                xRange={diffusionUPlotRange}
                yRange={diffusionVPlotRange}
                xLabel="Diffusion Rate U (Du)"
                yLabel="Diffusion Rate V (Dv)"
                title="Diffusion Rate U (Du) vs Diffusion Rate V (Dv)"
                handleColor="#22c55e"
                handleStrokeColor="#16a34a"
                valueLabelX="Du"
                valueLabelY="Dv"
                width={400}
                height={300}
                margin={40}
                on:update={handleDiffusionUpdate}
            />
        </div>
    </div>

    <div class="parameter-display">
        <div class="parameter-grid">
            <div class="parameter-item">
                <span class="parameter-label">Feed Rate (F):</span>
                <NumberDragBox
                    bind:value={feedRate}
                    min={feedRateRange.min}
                    max={feedRateRange.max}
                    step={0.001}
                    precision={3}
                    on:change={handleFeedRateChange}
                />
            </div>
            <div class="parameter-item">
                <span class="parameter-label">Kill Rate (K):</span>
                <NumberDragBox
                    bind:value={killRate}
                    min={killRateRange.min}
                    max={killRateRange.max}
                    step={0.001}
                    precision={3}
                    on:change={handleKillRateChange}
                />
            </div>
            <div class="parameter-item">
                <span class="parameter-label">Diffusion U (Du):</span>
                <NumberDragBox
                    bind:value={diffusionRateU}
                    min={diffusionRange.min}
                    max={diffusionRange.max}
                    step={0.001}
                    precision={3}
                    on:change={handleDiffusionRateUChange}
                />
            </div>
            <div class="parameter-item">
                <span class="parameter-label">Diffusion V (Dv):</span>
                <NumberDragBox
                    bind:value={diffusionRateV}
                    min={diffusionRange.min}
                    max={diffusionRange.max}
                    step={0.001}
                    precision={3}
                    on:change={handleDiffusionRateVChange}
                />
            </div>
            <div class="parameter-item">
                <span class="parameter-label">Timestep (Δt):</span>
                <NumberDragBox
                    bind:value={internalTimestep}
                    min={timestepRange.min}
                    max={timestepRange.max}
                    step={0.1}
                    precision={1}
                    on:change={handleTimestepChange}
                />
            </div>
        </div>
    </div>
</div>

<script lang="ts">
    import { createEventDispatcher } from 'svelte';
    import XYPlot from './XYPlot.svelte';
    import NumberDragBox from '../inputs/NumberDragBox.svelte';

    // `Settings::default()`, as ported in engine/sims/grayScott/settings.ts.
    // These are placeholders — GrayScottMode always passes real values — but
    // three of them had drifted from the model (0.1 / 0.05 / 1.0), which is
    // exactly the kind of second copy that gets mistaken for the source.
    export let feedRate: number = 0.055;
    export let killRate: number = 0.062;
    export let diffusionRateU: number = 0.16;
    export let diffusionRateV: number = 0.08;
    export let timestep: number = 2.5;

    const dispatch = createEventDispatcher();

    /*
     * Two sets of ranges, on purpose.
     *
     * The `*Range` constants are what the desktop app used, and they stay on
     * the NumberDragBoxes below so no value the engine accepts becomes
     * unreachable from the UI.
     *
     * The `*PlotRange` constants are **narrower, and this is a deliberate
     * divergence from the desktop app.** Gray-Scott's interesting domain is
     * roughly F ∈ [0.01, 0.09] and K ∈ [0.03, 0.07]; all nine built-in presets
     * live there, and `Settings::randomize` samples F ∈ [0.02, 0.08],
     * K ∈ [0.04, 0.08], Du ∈ [0.1, 0.3], Dv ∈ [0.05, 0.15]. Plotted against
     * the full 0.01–1.0 axis, every preset landed inside the first ~17px of a
     * 220px axis and one pixel of drag moved F by ~0.0045 — 4.5x coarser than
     * the `step={0.001}` of the drag box sitting right next to it, which made
     * the plot strictly worse than the control it was meant to replace.
     * Same story for diffusion: 0.16/0.08 against a 2.0 ceiling.
     *
     * Du and Dv get separate plot ranges rather than one shared one because
     * their useful bands differ by about 2x; sharing squashed Dv into the
     * bottom fifth of the Y axis.
     */
    const feedRateRange = { min: 0.01, max: 1.0 };
    const killRateRange = { min: 0.01, max: 1.0 };
    const diffusionRange = { min: 0.01, max: 2.0 };
    const timestepRange = { min: 0.1, max: 10.0 };

    const feedRatePlotRange = { min: 0.01, max: 0.1 };
    const killRatePlotRange = { min: 0.03, max: 0.07 };
    const diffusionUPlotRange = { min: 0.05, max: 0.3 };
    const diffusionVPlotRange = { min: 0.02, max: 0.15 };

    // Internal state for timestep
    let internalTimestep = timestep;

    // Handle timestep change from NumberDragBox
    function handleTimestepChange(event: CustomEvent<number>) {
        const newTimestep = event.detail;
        internalTimestep = newTimestep;
        dispatch('update', { setting: 'timestep', value: newTimestep });
    }

    // Handle individual parameter changes from NumberDragBox
    function handleFeedRateChange(event: CustomEvent<number>) {
        const newValue = event.detail;
        feedRate = newValue;
        dispatch('update', { setting: 'feed_rate', value: newValue });
    }

    function handleKillRateChange(event: CustomEvent<number>) {
        const newValue = event.detail;
        killRate = newValue;
        dispatch('update', { setting: 'kill_rate', value: newValue });
    }

    function handleDiffusionRateUChange(event: CustomEvent<number>) {
        const newValue = event.detail;
        diffusionRateU = newValue;
        dispatch('update', { setting: 'diffusion_rate_u', value: newValue });
    }

    function handleDiffusionRateVChange(event: CustomEvent<number>) {
        const newValue = event.detail;
        diffusionRateV = newValue;
        dispatch('update', { setting: 'diffusion_rate_v', value: newValue });
    }

    // Handle XY plot updates
    function handleFeedKillUpdate(event: CustomEvent) {
        const { x, y } = event.detail;
        dispatch('update', { setting: 'feed_rate', value: x });
        dispatch('update', { setting: 'kill_rate', value: y });
    }

    function handleDiffusionUpdate(event: CustomEvent) {
        const { x, y } = event.detail;
        dispatch('update', { setting: 'diffusion_rate_u', value: x });
        dispatch('update', { setting: 'diffusion_rate_v', value: y });
    }

    // Sync with external props when they change
    $: if (timestep !== internalTimestep && Math.abs(timestep - internalTimestep) > 0.01) {
        internalTimestep = timestep;
    }
</script>

<style>
    .diagram-container {
        width: 100%;
        max-width: 100%;
        margin: 0;
        padding: 0;
    }

    .instructions {
        margin: 0 0 15px 0;
        color: rgba(255, 255, 255, 0.7);
        font-size: 0.9em;
        font-style: italic;
    }

    .plots-container {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 1rem;
        margin-bottom: 1rem;
    }

    .plot-section {
        display: flex;
        flex-direction: column;
    }

    .parameter-display {
        margin: 1rem 0;
        padding: 1rem;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 4px;
        border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .parameter-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 0.75rem;
    }

    .parameter-item {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.75rem;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 4px;
        border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .parameter-label {
        color: rgba(255, 255, 255, 0.8);
        font-size: 0.875rem;
        margin-bottom: 0.25rem;
    }

    /* Mobile responsive styles */
    @media (max-width: 768px) {
        .instructions {
            font-size: 0.8em;
            text-align: center;
        }

        .plots-container {
            grid-template-columns: 1fr;
            gap: 1rem;
        }

        .parameter-grid {
            grid-template-columns: 1fr;
            gap: 0.5rem;
        }

        .parameter-item {
            padding: 0.75rem;
        }
    }
</style>
