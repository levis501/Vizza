import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';
import { lutPlugin } from './vite-plugin-luts';

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [svelte(), lutPlugin()],

    clearScreen: false,

    resolve: {
        alias: {
            $lib: resolve(__dirname, 'src/lib'),
        },
    },

    server: {
        // Bound to 0.0.0.0 so the port is reachable from outside the container.
        host: '0.0.0.0',
        port: 9994,
        strictPort: true,
        // Vite's DNS-rebinding guard rejects any Host header it doesn't know,
        // which blocks reaching this container by hostname or IP from the LAN.
        // The guard protects a dev server bound to localhost on a workstation;
        // here the server is deliberately exposed, so it only gets in the way.
        allowedHosts: true,
        fs: {
            // The WGSL corpus is read straight out of the Rust tree rather than
            // copied, so Vite must be allowed to serve from src-tauri.
            allow: ['.', './src-tauri'],
        },
    },

    test: {
        environment: 'node',
        include: ['test/unit/**/*.test.ts', 'test/wgsl/**/*.test.ts'],
    },
});
