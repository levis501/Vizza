/**
 * Slime Mold's own commands.
 *
 * Four of the five map onto a `#[tauri::command]` in
 * src-tauri/src/commands/slime_mold.rs; `get_agent_count_limit` is new to the
 * browser and registry.ts says why.
 *
 * The agent pool is the reason this file exists at all. Everything else in the
 * app is under 3% of the 128 MiB `maxStorageBufferBindingSize`; Slime Mold at
 * the desktop UI's maximum of 100 million agents wants 1.6 GB (WEB_PORT.md,
 * "Buffer budget"). The Rust clamps nothing — `update_agent_count`
 * (commands/slime_mold.rs:55) assigns `count as usize` straight through — and
 * an over-large storage buffer does not reject in a browser, it loses the
 * device and takes every other simulation down with it. So the ceiling is
 * enforced here, at the seam, as well as in the control.
 */

import { register } from '../registry';
import { getEngineContext, hasEngineContext } from '../context';
import { SPEC_MINIMUM_SLIME_MOLD_AGENTS } from '$lib/engine/gpu/limits';
import { clampSlimeMoldAgentCount } from '$lib/engine/sims/slimeMold/settings';

/**
 * The ceiling, from the device if one booted.
 *
 * With no engine there is no adapter to ask, and the honest answer is the
 * ceiling every conformant implementation must be able to honour. Overstating
 * it would put a number in front of the user that their machine may not accept.
 */
function agentCap(): number {
    if (!hasEngineContext()) return SPEC_MINIMUM_SLIME_MOLD_AGENTS;
    return getEngineContext().caps().slimeMoldAgents;
}

export function registerSlimeMoldHandlers(): void {
    register('get_agent_count_limit', async () => agentCap());

    /**
     * The clamp is here as well as in `AgentCountInput` on purpose: the control
     * clamps so the *user* is told what happened, this clamps because nothing
     * else stands between a restored `localStorage` value, or a desktop
     * settings file asking for 10 M, and a storage buffer the device cannot
     * bind. Validate at the boundary, enforce at the sink.
     */
    register('update_agent_count', async (args) => {
        if (!hasEngineContext()) return null;
        const engine = getEngineContext();
        if (engine.currentSimulation() === null) return null;
        engine.setAgentCount(clampSlimeMoldAgentCount(args.count, agentCap()));
        return null;
    });

    /**
     * `Option<u32>` in the Rust (commands/slime_mold.rs:81): null when the
     * running simulation is not Slime Mold, rather than an error. The mode
     * treats null as "leave the box alone", so returning it is not a failure.
     */
    register('get_current_agent_count', async () => {
        if (!hasEngineContext()) return null;
        const state = await getEngineContext().getState();
        const count = state.agent_count;
        return typeof count === 'number' ? count : null;
    });

    /**
     * The two fit modes go to different documents because that is where the
     * two fields live: `position_image_fit_mode` is `Settings` field 11
     * (slime_mold/settings.rs:55), `mask_image_fit_mode` is `State` field 6
     * (state.rs:161).
     *
     * The Rust reaches *both* through `update_setting`, which is how
     * `mask_image_fit_mode` ended up settable by a name `update_state` does not
     * accept even though `get_state` reports it. Routing each to the document
     * it belongs to is a deliberate divergence, and the only one that lets the
     * value survive a state sync.
     */
    register('set_slime_mold_position_image_fit_mode', async (args) => {
        if (!hasEngineContext()) return null;
        await getEngineContext().updateSetting('position_image_fit_mode', args.fit_mode);
        return null;
    });

    register('set_slime_mold_mask_image_fit_mode', async (args) => {
        if (!hasEngineContext()) return null;
        await getEngineContext().updateState('mask_image_fit_mode', args.fit_mode);
        return null;
    });
}
