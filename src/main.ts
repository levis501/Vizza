// styles.css holds the design tokens (--ui-*, --accent-*, --spacing-*) that
// Button.svelte and Input.svelte reference. It was never imported in the Tauri
// app, so those components rendered with undefined custom properties.
import './styles.css';
import './app.css';
import App from './App.svelte';
import { mount } from 'svelte';
import { startEngine, getFailureMessage } from '$lib/engine/bootstrap';

const target = document.getElementById('app');
if (!target) {
    throw new Error('Could not find app element');
}

const app = mount(App, {
    target,
});

/*
 * Boot the engine after mounting, not before.
 *
 * initGpu is async, and blocking the mount on it would leave the page empty
 * for the duration — including on the failure paths, where the UI is exactly
 * what has to render the explanation.
 */
void startEngine().then((engine) => {
    const failure = getFailureMessage();
    if (failure) {
        console.error('[vizza]', failure);
        return;
    }
    // The animated menu background is a simulation like any other; the shell
    // swaps it out when a card is clicked. Failures must be logged, not
    // swallowed — a rejected start otherwise reads as a blank canvas.
    engine?.host.start('main_menu').catch((err) => {
        console.error('[vizza] main menu failed to start:', err);
    });
});

export default app;
