/**
 * Stand-in for $lib/engine/shaders inside the GPU harness bundle.
 *
 * The real module is built on `import.meta.glob`, which only Vite can resolve —
 * the harness is bundled with esbuild and served from a plain node server, so
 * the corpus arrives over HTTP as /shaders.json instead. Everything else in the
 * engine is the genuine module, which is the point: these tests must exercise
 * the shipping code, not a parallel copy of it.
 */

declare global {
    // eslint-disable-next-line no-var
    var __VIZZA_SHADERS__: Record<string, string> | undefined;
}

function corpus(): Record<string, string> {
    const loaded = globalThis.__VIZZA_SHADERS__;
    if (!loaded) {
        throw new Error('shader corpus not loaded: fetch /shaders.json before running tests');
    }
    return loaded;
}

export const shaders = new Proxy({} as Record<string, string>, {
    get: (_target, key: string) => corpus()[key],
    has: (_target, key: string) => key in corpus(),
    ownKeys: () => Object.keys(corpus()),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});

export function shaderPathsNow(): string[] {
    return Object.keys(corpus()).sort();
}

export const shaderPaths: readonly string[] = [];

export function getShader(path: string): string {
    const source = corpus()[path];
    if (source === undefined) {
        throw new Error(`No WGSL shader at '${path}'`);
    }
    return source;
}
