<div class="agent-count-input">
    <div class="input-container">
        <Input
            {id}
            type="number"
            value={inputValue}
            min={minMillions}
            max={maxMillions}
            step={0.1}
            placeholder="Agent count, in millions"
            error={errorMessage}
            on:input={handleInput}
            on:keydown={handleKeyDown}
            on:focus={handleFocus}
        />
        <!--
            No `class` prop: Button spreads `$$restProps` *after* its static
            `class="ui-button"`, so passing one silently replaces it — and
            `button.ui-button` is how the E2E layer finds buttons.
        -->
        <Button disabled={inputValue.trim() === ''} on:click={handleUpdate}>Update</Button>
    </div>

    <!--
        The ceiling is shown before anything goes wrong, not only after.
        A user who types 10 and silently gets 3.7 files a bug; a user who can
        see "this device tops out at 3,774,873" does not.
    -->
    <p class="ceiling" class:clamped={clampedNotice !== ''}>
        {#if clampedNotice}
            {clampedNotice}
        {:else}
            Device limit: {formatAgents(maxAgents)} agents ({maxMillions} M)
        {/if}
    </p>
</div>

<script lang="ts">
    import { createEventDispatcher } from 'svelte';
    import Button from '../shared/Button.svelte';
    import Input from '../inputs/Input.svelte';
    import {
        clampSlimeMoldAgentCount,
        SLIME_MOLD_MIN_AGENTS,
        slimeMoldAgentMaxMillions,
    } from '$lib/engine/sims/slimeMold/settings';

    /**
     * Agent count, in millions — the unit the desktop control used and the one
     * `example-slime-mold.png` was captured with.
     *
     * What changed in M7 is the ceiling. The desktop offered `max={100}`, i.e.
     * 100 million agents at a 16-byte stride: **1.6 GB** in a single storage
     * buffer against a 128 MiB `maxStorageBufferBindingSize`. Native wgpu
     * refuses that with an error; a browser loses the device, which kills every
     * simulation on the page and not just this one. So the maximum is now
     * whatever the adapter can actually bind, and out-of-range input is
     * **reduced rather than refused** — a preset or a restored value asking for
     * ten million has to keep working (`clampSlimeMoldAgentCount`).
     */
    export let value: number = 1;

    /** The device ceiling in *agents*, from `caps.slimeMoldAgents`. */
    export let maxAgents: number;

    /** For the `<label for=…>` the mode renders beside this control. */
    export let id: string = '';

    const dispatch = createEventDispatcher<{ update: number }>();

    /**
     * Rounded down to a tenth of a million so the widget's own 0.1 step can
     * never land above the cap, then re-clamped in exact agents on submit.
     */
    $: maxMillions = slimeMoldAgentMaxMillions(maxAgents);
    const minMillions = SLIME_MOLD_MIN_AGENTS / 1_000_000;

    let inputValue: string = formatMillions(value);
    let errorMessage: string = '';
    let clampedNotice: string = '';
    let userIsEditing = false;

    /** Explicit locale: the message is asserted verbatim by the E2E spec. */
    function formatAgents(count: number): string {
        return count.toLocaleString('en-US');
    }

    /** 1 -> "1", 3.7 -> "3.7"; never "3.7000000000000002". */
    function formatMillions(millions: number): string {
        return String(Math.round(millions * 1_000_000) / 1_000_000);
    }

    function handleInput(event: Event) {
        inputValue = (event.target as HTMLInputElement).value;
        userIsEditing = true;
        // Stale after a keystroke: the user is telling us the old outcome is
        // no longer what they asked for.
        clampedNotice = '';
        errorMessage = '';
    }

    function handleFocus() {
        userIsEditing = true;
    }

    /**
     * The only rejection left is "that is not a number".
     *
     * The previous version also refused anything failing
     * `n % 0.1 !== 0 && n % 1 !== 0` under the banner "must be a whole number
     * or single decimal place" — which rejected *every* one-decimal value,
     * since `0.3 % 0.1` is 0.09999999999999998 in binary floating point. The
     * affordance the message advertised had never worked. Out-of-range is now
     * clamped instead of refused, so range is not a rejection either.
     */
    function handleUpdate() {
        const raw = inputValue.trim();
        const requested = raw === '' ? NaN : Number(raw);

        if (!Number.isFinite(requested)) {
            errorMessage = 'Enter a number of millions of agents, e.g. 1.5';
            clampedNotice = '';
            return;
        }

        const agents = clampSlimeMoldAgentCount(Math.round(requested * 1_000_000), maxAgents);
        const millions = agents / 1_000_000;

        errorMessage = '';
        clampedNotice =
            Math.round(requested * 1_000_000) === agents
                ? ''
                : `${formatMillions(requested)} M is more than this device can bind — ` +
                  `using ${formatAgents(agents)} agents.`;

        userIsEditing = false;
        inputValue = formatMillions(millions);
        value = millions;
        dispatch('update', millions);
    }

    function handleKeyDown(event: KeyboardEvent) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        handleUpdate();
    }

    /*
     * Follow the backend, unless the user is mid-edit.
     *
     * The engine is the source of truth for the pool size — it is what actually
     * allocated the buffer — so a sync that comes back lower than what was
     * asked for (a value restored from `localStorage` above this device's cap,
     * say) has to show up here, not be overwritten by the local guess.
     */
    $: if (!userIsEditing && formatMillions(value) !== inputValue) {
        inputValue = formatMillions(value);
    }
</script>

<style>
    .agent-count-input {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        width: max-content;
    }
    .input-container {
        display: flex;
        gap: 0.5rem;
        align-items: center;
    }
    .ceiling {
        margin: 0;
        font-size: 0.75rem;
        color: rgba(255, 255, 255, 0.55);
    }
    .ceiling.clamped {
        color: var(--accent-warning, #e0a33e);
    }
</style>
