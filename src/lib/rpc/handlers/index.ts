/**
 * Installs the real command handlers over the stub baseline in registry.ts.
 *
 * Order matters only in that this must run after registry.ts has populated its
 * stubs — importing this module is what upgrades a stubbed command to a live
 * one. Commands belonging to unported simulations keep their stubs, so the UI
 * stays interactive throughout the port rather than throwing.
 */

import { registerLifecycleHandlers } from './lifecycle';
import { registerCameraHandlers, setPointerCanvas } from './camera';
import { registerSettingsHandlers } from './settings';
import { registerColorSchemeHandlers } from './colorSchemes';
import { registerPresetHandlers } from './presets';
import { registerImageHandlers } from './images';
import { registerGradientHandlers } from './gradient';
import { registerSlimeMoldHandlers } from './slimeMold';

let installed = false;

export function installHandlers(): void {
    if (installed) return;
    installed = true;

    registerLifecycleHandlers();
    registerCameraHandlers();
    registerSettingsHandlers();
    registerColorSchemeHandlers();
    registerPresetHandlers();
    registerImageHandlers();
    registerGradientHandlers();
    registerSlimeMoldHandlers();
}

export { setPointerCanvas };
