<div class="image-selector">
    {#if showFitMode}
        <div class="setting-item">
            <span class="setting-label">Fit Mode:</span>
            <Selector
                options={['Stretch', 'Center', 'Fit H', 'Fit V']}
                value={fitMode}
                on:change={(e) =>
                    onFitModeChange?.(e.detail.value as 'Center' | 'Stretch' | 'FitH' | 'FitV')}
            />
        </div>
    {/if}

    {#if showLoadButton}
        <div class="setting-item">
            <span class="setting-label">Load Image:</span>
            <Button variant="default" on:click={handleLoadImage}>Choose File…</Button>
        </div>
    {/if}
</div>

<script lang="ts">
    import { createEventDispatcher } from 'svelte';
    import { invoke } from '$lib/rpc';
    import Selector from '../inputs/Selector.svelte';
    import Button from './Button.svelte';

    const dispatch = createEventDispatcher();

    const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tiff'];

    /**
     * Browser replacement for the native file dialog.
     *
     * The desktop app opened a Tauri dialog and handed Rust a filesystem path.
     * There is no path in a browser, so we collect a File and pass it to the
     * engine, which decodes it with createImageBitmap.
     */
    function pickImageFile(): Promise<File | null> {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = IMAGE_EXTENSIONS.map((e) => `.${e}`).join(',');
            input.addEventListener('change', () => resolve(input.files?.[0] ?? null), {
                once: true,
            });
            // A cancelled picker fires no 'change' event in most browsers.
            input.addEventListener('cancel', () => resolve(null), { once: true });
            input.click();
        });
    }

    // Props
    export let fitMode: string = 'Stretch';
    export let loadCommand: string = '';
    export let showFitMode: boolean = true;
    export let showLoadButton: boolean = true;

    // Event handlers
    export let onFitModeChange:
        | ((value: 'Center' | 'Stretch' | 'FitH' | 'FitV') => void)
        | undefined = undefined;

    async function handleLoadImage() {
        try {
            const file = await pickImageFile();

            if (file && loadCommand) {
                await invoke(loadCommand, { imageFile: file, imagePath: file.name });
                dispatch('imageLoaded', { imagePath: file.name, imageFile: file });
            }
        } catch (err) {
            console.error('Failed to load image:', err);
            dispatch('error', { error: err });
        }
    }
</script>

<style>
    .image-selector {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .setting-item {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .setting-label {
        font-weight: 500;
        min-width: 120px;
        color: var(--text-color);
    }
</style>
