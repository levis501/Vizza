import { test, expect } from '@playwright/test';

/**
 * M1 — the title page.
 *
 * Asserts the shell renders and routes without a GPU, which is all this layer
 * can see (Playwright's launcher disables WebGPU). Simulation output is covered
 * by test/gpu.
 */

/** Cards on the menu, in DOM order, with the AppMode each routes to. */
const SIMULATIONS = [
    ['Slime Mold', 'slime-mold'],
    ['Gray-Scott', 'gray-scott'],
    ['Particle Life', 'particle-life'],
    ['Flow Field', 'flow'],
    ['Pellets', 'pellets'],
    ['Gradient Editor', 'gradient-editor'],
    ['Voronoi Cellular Automata', 'voronoi-ca'],
    ['Moiré', 'moire'],
    ['Primordial Particles', 'primordial-particles'],
    ['Vectors', 'vectors'],
] as const;

test.describe('title page', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
    });

    test('renders the title and logo', async ({ page }) => {
        await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeVisible();
        await expect(page.locator('img[alt*="Vizza" i]')).toBeVisible();
    });

    test('renders a card for every simulation', async ({ page }) => {
        for (const [label] of SIMULATIONS) {
            await expect(
                page.getByRole('heading', { name: label, exact: true })
            ).toBeVisible();
        }
        // 10 simulations + the How To Play card.
        await expect(page.locator('.simulation-card')).toHaveCount(
            SIMULATIONS.length + 1
        );
    });

    test('has no quit button (desktop-only, removed in the port)', async ({ page }) => {
        await expect(page.locator('.quit-button')).toHaveCount(0);
    });

    test('paints an opaque backdrop', async ({ page }) => {
        // The Tauri build relied on a transparent native window; the browser
        // needs html to paint or the page flashes white before the first frame.
        const bg = await page.evaluate(
            () => getComputedStyle(document.documentElement).backgroundColor
        );
        expect(bg).not.toBe('rgba(0, 0, 0, 0)');
        expect(bg).not.toBe('transparent');
    });

    test('wires up the design tokens', async ({ page }) => {
        // styles.css was orphaned in the Tauri app, leaving Button/Input
        // referencing undefined custom properties.
        const token = await page.evaluate(() =>
            getComputedStyle(document.documentElement)
                .getPropertyValue('--accent-primary')
                .trim()
        );
        expect(token).toBe('#646cff');
    });

    for (const [label, mode] of SIMULATIONS) {
        test(`navigates to ${mode} and back`, async ({ page }) => {
            await page.getByRole('heading', { name: label, exact: true }).click();

            // Leaving the menu is the observable signal — the mode components
            // render their own layout, and none of them show the menu heading.
            await expect(
                page.getByRole('heading', { name: 'Vizza', level: 1 })
            ).toBeHidden();

            // SimulationLayout's container also carries role="button", so scope
            // to the control-bar button itself.
            await page.locator('button.ui-button', { hasText: 'Back to Menu' }).click();
            await expect(
                page.getByRole('heading', { name: 'Vizza', level: 1 })
            ).toBeVisible();
        });
    }
});
