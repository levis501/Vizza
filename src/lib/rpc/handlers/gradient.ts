/**
 * Gradient-editor commands.
 *
 * Only one lives here. Its sibling, `update_gradient_preview`, is registered in
 * `colorSchemes.ts` because it is a colour-scheme push that happens to be
 * unsaved — the Rust groups it the same way (commands/colors_schemes.rs:114 vs
 * commands/gradient.rs:7), and it deliberately applies to *whatever* simulation
 * is running, not only to the gradient preview.
 *
 * No `EngineContext` method is added for this: `set_gradient_display_mode` is a
 * state write under another name, exactly as the Rust's own
 * `update_state("displayMode", …)` arm is (gradient/simulation.rs:245), so it
 * goes through the `updateState` seam that already exists.
 */

import { register } from '../registry';
import { getEngineContext, hasEngineContext } from '../context';

export function registerGradientHandlers(): void {
    register('set_gradient_display_mode', async (args) => {
        // The Rust returns Err("only available for Gradient simulation") when
        // something else is running (commands/gradient.rs:28). Dropped silently
        // instead, matching how `settings.ts` treats a mutation with nothing to
        // mutate: the only caller is GradientEditorMode, which logs whatever it
        // catches, so rejecting would put an error in the console on a race
        // between the mode's first render and `start_simulation` resolving.
        if (!hasEngineContext()) return null;
        const engine = getEngineContext();
        if (engine.currentSimulation() !== 'gradient') return null;

        await engine.updateState('display_mode', Number(args.mode));
        return null;
    });
}
