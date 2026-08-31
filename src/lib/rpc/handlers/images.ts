/**
 * Image-upload commands.
 *
 * The desktop versions took an `image_path` and let the `image` crate open it.
 * There is no filesystem here, so `ImageSelector.svelte` sends the `File` from
 * its `<input type="file">` under `imageFile` (normalised to `image_file`) and
 * keeps `imagePath` as the file's *name*, purely for the label it shows.
 *
 * Commands are registered one per ported simulation rather than in a loop over
 * the whole set: registering `load_slime_mold_mask_image` before Slime Mold
 * exists would replace a harmless stub with a handler that always rejects.
 *
 * Uploaded images are session-only and are never persisted — see the note at
 * the top of `$lib/engine/resources/imageUpload`.
 */

import { register } from '../registry';
import { getEngineContext, hasEngineContext } from '../context';

/** The `slot` each command names, for simulations with more than one input. */
const IMAGE_COMMANDS: Record<string, string> = {
    load_moire_image: 'image',
};

/**
 * `File` is a DOM type, so the check has to survive a non-DOM environment as
 * well as a caller that still passes a path string.
 */
function asFile(value: unknown, command: string): File {
    if (typeof File !== 'undefined' && value instanceof File) return value;
    throw new Error(
        `${command} needs the picked file under "imageFile" — a filesystem path ` +
            `cannot be read from a browser`
    );
}

export function registerImageHandlers(): void {
    for (const [command, slot] of Object.entries(IMAGE_COMMANDS)) {
        register(command, async (args) => {
            // No engine means no simulation to give it to; the picker having
            // done nothing is better than an error dialog on a GPU-less browser.
            if (!hasEngineContext()) return null;
            await getEngineContext().loadImage(asFile(args.image_file, command), slot);
            return null;
        });
    }
}
