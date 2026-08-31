/**
 * L3 GPU test runner.
 *
 * Playwright's launcher makes `navigator.gpu` undefined regardless of flags,
 * headless or headful, and also over connectOverCDP — so there is no way to
 * drive WebGPU through it. This runner therefore bundles the harness with
 * esbuild, serves it from a bare node server, launches raw Chrome against
 * SwiftShader, and waits for the page to POST its results back.
 *
 *   node test/gpu/run.mjs            # or: npm run test:gpu
 *   node test/gpu/run.mjs --headful  # keeps the browser open for debugging
 */

import { createServer } from 'node:http';
import { readFileSync, readdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import * as esbuild from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SHADER_ROOT = join(ROOT, 'src-tauri/src/simulations');

// 9991 and 9992 are held by other containers on this host; 9994 is the dev
// server. 9995 is free — see PLODE_COMMON.md on the 9991-9999 range.
const PORT = Number(process.env.VIZZA_GPU_PORT ?? 9995);
const TIMEOUT_MS = Number(process.env.VIZZA_GPU_TIMEOUT ?? 300_000);
const HEADFUL = process.argv.includes('--headful');

// ---------------------------------------------------------------------------
// The WGSL corpus, read the same way vite-plugin-luts reads the LUTs: straight
// out of the Rust tree, so the test compiles the shipping shaders.
// ---------------------------------------------------------------------------

function collectShaders(dir, into = {}) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            collectShaders(full, into);
        } else if (entry.endsWith('.wgsl')) {
            into[relative(SHADER_ROOT, full)] = readFileSync(full, 'utf8');
        }
    }
    return into;
}

// ---------------------------------------------------------------------------
// Bundle
// ---------------------------------------------------------------------------

/**
 * Resolves `$lib/*` to src/lib, and swaps the shader module for the harness
 * shim — the real one is built on import.meta.glob, which only Vite handles.
 */
const aliasPlugin = {
    name: 'vizza-alias',
    setup(build) {
        build.onResolve({ filter: /^\$lib\// }, (args) => {
            const tail = args.path.slice('$lib/'.length);
            if (tail === 'engine/shaders' || tail === 'engine/shaders/index') {
                return { path: join(HERE, 'shaderShim.ts') };
            }
            return { path: resolveWithExtension(join(ROOT, 'src/lib', tail)) };
        });
    },
};

function resolveWithExtension(base) {
    for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
        try {
            if (statSync(candidate).isFile()) return candidate;
        } catch {
            /* keep looking */
        }
    }
    throw new Error(`cannot resolve ${base}`);
}

async function bundle() {
    const result = await esbuild.build({
        entryPoints: [join(HERE, 'harness.ts')],
        bundle: true,
        format: 'esm',
        target: 'chrome120',
        sourcemap: 'inline',
        write: false,
        plugins: [aliasPlugin],
        logLevel: 'silent',
    });
    return result.outputFiles[0].text;
}

// ---------------------------------------------------------------------------
// Server + browser
// ---------------------------------------------------------------------------

function findChrome() {
    // The Playwright build number changes on every image rebuild, so the path
    // is resolved rather than hardcoded (see PLODE_COMMON.md, "Headless Chrome").
    const cache = join(process.env.HOME ?? '', '.cache/ms-playwright');
    let builds = [];
    try {
        builds = readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name));
    } catch {
        /* reported below */
    }

    for (const build of builds.sort().reverse()) {
        const candidate = join(cache, build, 'chrome-linux64/chrome');
        try {
            if (statSync(candidate).isFile()) return candidate;
        } catch {
            /* keep looking */
        }
    }

    throw new Error(`No Chromium found under ${cache}. Run: npx playwright install chromium`);
}

async function main() {
    const shaders = collectShaders(SHADER_ROOT);
    const shaderCount = Object.keys(shaders).length;
    console.log(`[gpu] ${shaderCount} WGSL shaders in the corpus`);

    const harnessJs = await bundle();
    const page = readFileSync(join(HERE, 'index.html'), 'utf8');

    let resolveResults;
    const received = new Promise((r) => {
        resolveResults = r;
    });

    const server = createServer((req, res) => {
        const url = (req.url ?? '/').split('?')[0];

        if (req.method === 'POST' && url === '/results') {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                res.writeHead(204).end();
                try {
                    resolveResults(JSON.parse(body));
                } catch (err) {
                    resolveResults({
                        results: [{ name: 'runner', ok: false, error: String(err) }],
                    });
                }
            });
            return;
        }

        if (url === '/' || url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
        } else if (url === '/harness.js') {
            res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(harnessJs);
        } else if (url === '/shaders.json') {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(shaders));
        } else {
            res.writeHead(404).end();
        }
    });

    await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

    const chrome = findChrome();
    const profile = mkdtempSync(join(tmpdir(), 'vizza-gpu-'));
    const args = [
        ...(HEADFUL ? [] : ['--headless']),
        '--no-sandbox',
        '--disable-dev-shm-usage',
        // SwiftShader's Vulkan ICD is what makes WebGPU work with no real GPU.
        '--enable-unsafe-webgpu',
        '--enable-features=Vulkan',
        `--user-data-dir=${profile}`,
        `http://127.0.0.1:${PORT}/`,
    ];

    const child = spawn(chrome, args, {
        env: { ...process.env, VK_ICD_FILENAMES: join(dirname(chrome), 'vk_swiftshader_icd.json') },
        stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));

    const timeout = new Promise((_, reject) =>
        setTimeout(
            () => reject(new Error(`no results after ${TIMEOUT_MS} ms\n${stderr.slice(-2000)}`)),
            TIMEOUT_MS
        )
    );

    let payload;
    try {
        payload = await Promise.race([received, timeout]);
    } finally {
        if (!HEADFUL) child.kill('SIGKILL');
        server.close();
        rmSync(profile, { recursive: true, force: true });
    }

    return report(payload, shaderCount);
}

function report(payload, shaderCount) {
    const results = payload.results ?? [];
    let failed = 0;

    for (const result of results) {
        const ms = result.ms === undefined ? '' : ` (${result.ms.toFixed(0)} ms)`;
        if (result.ok) {
            console.log(`  ✓ ${result.name}${ms}`);
        } else {
            failed++;
            console.log(`  ✗ ${result.name}${ms}\n      ${result.error}`);
        }
    }

    if (payload.shaderCount !== undefined && payload.shaderCount !== shaderCount) {
        failed++;
        console.log(
            `  ✗ the page saw ${payload.shaderCount} shaders, the corpus holds ${shaderCount}`
        );
    }

    console.log(`\n[gpu] ${results.length - failed}/${results.length} passed`);
    return failed === 0 ? 0 : 1;
}

main().then(
    (code) => process.exit(code),
    (err) => {
        console.error(`[gpu] ${err.message}`);
        process.exit(1);
    }
);
