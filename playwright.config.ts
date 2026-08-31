import { defineConfig, devices } from '@playwright/test';

/**
 * DOM/E2E layer.
 *
 * Playwright's launcher makes `navigator.gpu` undefined regardless of flags, so
 * nothing here can assert on rendered simulation output. These tests cover
 * navigation, controls, and persistence; GPU correctness lives in test/gpu,
 * which drives raw Chrome instead.
 */
export default defineConfig({
    testDir: './test/e2e',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    reporter: process.env.CI ? 'list' : [['list']],

    use: {
        baseURL: 'http://localhost:9994',
        trace: 'on-first-retry',
    },

    projects: [
        {
            name: 'chromium',
            use: {
                ...devices['Desktop Chrome'],
                launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
            },
        },
    ],

    webServer: {
        command: 'npx vite',
        url: 'http://localhost:9994',
        reuseExistingServer: true,
        timeout: 60_000,
    },
});
