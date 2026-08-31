import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Packs the 167 colour-scheme LUTs into a single binary blob plus a name index.
 *
 * The Rust build embeds `src-tauri/src/simulations/shared/LUTs/*.lut` with
 * `include_dir!` (see shared/color_scheme.rs). Rather than fork the assets, we
 * read the same directory and concatenate it, so there is one source of truth.
 *
 * Every LUT is exactly 768 bytes, planar: [R×256][G×256][B×256] u8. Names are
 * sorted so a LUT's offset is `index * 768`.
 *
 * Serves two virtual URLs in dev and emits the same two files at build:
 *   /luts.bin   167 * 768 = 128,256 bytes
 *   /luts.json  { stride: 768, names: [...] }
 */

const LUT_DIR = 'src-tauri/src/simulations/shared/LUTs';
export const LUT_STRIDE = 768;

export interface LutPack {
    names: string[];
    blob: Buffer;
}

export function packLuts(root: string): LutPack {
    const dir = resolve(root, LUT_DIR);
    const names = readdirSync(dir)
        .filter((f) => f.endsWith('.lut'))
        .map((f) => basename(f, '.lut'))
        .sort();

    const blob = Buffer.alloc(names.length * LUT_STRIDE);
    names.forEach((name, i) => {
        const bytes = readFileSync(join(dir, `${name}.lut`));
        if (bytes.length !== LUT_STRIDE) {
            throw new Error(
                `LUT ${name}.lut is ${bytes.length} bytes, expected ${LUT_STRIDE}`
            );
        }
        bytes.copy(blob, i * LUT_STRIDE);
    });

    return { names, blob };
}

export function lutPlugin(): Plugin {
    let root = process.cwd();

    return {
        name: 'vizza-luts',

        configResolved(config) {
            root = config.root;
        },

        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const url = req.url?.split('?')[0];
                if (url !== '/luts.bin' && url !== '/luts.json') return next();

                const { names, blob } = packLuts(root);
                if (url === '/luts.bin') {
                    res.setHeader('Content-Type', 'application/octet-stream');
                    res.end(blob);
                } else {
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ stride: LUT_STRIDE, names }));
                }
            });
        },

        generateBundle() {
            const { names, blob } = packLuts(root);
            this.emitFile({
                type: 'asset',
                fileName: 'luts.bin',
                source: blob,
            });
            this.emitFile({
                type: 'asset',
                fileName: 'luts.json',
                source: JSON.stringify({ stride: LUT_STRIDE, names }),
            });
        },
    };
}
