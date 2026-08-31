import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * M3 — Moiré, at the DOM layer.
 *
 * Playwright's launcher makes `navigator.gpu` undefined regardless of flags, so
 * nothing here can look at a rendered pixel; that is test/gpu's job. What this
 * layer *can* prove is that the menu mounts, that its controls reach the engine
 * through `update_simulation_setting`, that a preset comes back out of the
 * store, and that a browser with no WebGPU at all still gets a usable page.
 *
 * The engine under the controls is `$lib/engine/testing/fakeEngine` — same
 * `EngineContext` interface, same handlers, same `PresetStore`, in-memory
 * settings instead of a device (WEB_PORT.md, "Test strategy").
 */

/** The one console error a GPU-less browser is expected to produce. */
const EXPECTED_ERROR = /WebGPU|GPU adapter|secure context|No available adapters/i;

interface FakeEngineWindow extends Window {
    __vizza?: { installFakeEngine?: () => unknown };
    __fakeEngine?: { log: Array<{ command: string; args: unknown }> };
}

/** Console errors and warnings that are not the known no-WebGPU message. */
function collectUnexpected(page: Page): string[] {
    const unexpected: string[] = [];
    const consider = (message: ConsoleMessage) => {
        if (message.type() !== 'error' && message.type() !== 'warning') return;
        const text = message.text();
        if (EXPECTED_ERROR.test(text)) return;
        unexpected.push(`${message.type()}: ${text}`);
    };
    page.on('console', consider);
    page.on('pageerror', (error) => unexpected.push(`pageerror: ${error.message}`));
    return unexpected;
}

async function installFakeEngine(page: Page): Promise<void> {
    await page.waitForFunction(() =>
        Boolean((window as FakeEngineWindow).__vizza?.installFakeEngine)
    );
    await page.evaluate(() => {
        const w = window as FakeEngineWindow;
        w.__fakeEngine = w.__vizza!.installFakeEngine!() as FakeEngineWindow['__fakeEngine'];
    });
}

function engineLog(page: Page) {
    return page.evaluate(() => (window as FakeEngineWindow).__fakeEngine?.log ?? []);
}

async function openMoire(page: Page): Promise<void> {
    await page.getByRole('heading', { name: 'Moiré', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeHidden();
}

/** The `.value-display` of the NumberDragBox sitting next to a given label. */
function dragBoxValue(page: Page, label: string) {
    return settingRow(page, label).locator('.value-display');
}

/**
 * The row wrapping one control.
 *
 * Matched on the label's *exact* text: "Speed:" is a substring of "Flow
 * Speed:", so a `hasText` filter silently reads the wrong drag box.
 */
function settingRow(page: Page, label: string) {
    return page
        .locator('.setting-item, .control-group')
        .filter({ has: page.getByText(label, { exact: true }) })
        .last();
}

function dragBoxButton(page: Page, label: string, direction: 'increment' | 'decrement') {
    return settingRow(page, label).locator(`.step-button.${direction}`);
}

test.describe('moiré mode', () => {
    test('mounts its menu with no unexpected console output', async ({ page }) => {
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await installFakeEngine(page);
        await openMoire(page);

        await expect(page.getByRole('group').filter({ hasText: 'Moiré Patterns' })).toBeVisible();
        // Give the mount's async chain — start, settings, state, presets,
        // colour schemes, webcam probe — time to settle before judging.
        await page.waitForTimeout(500);

        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });

    test('renders every fieldset the settings drive', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openMoire(page);

        for (const legend of [
            'Presets',
            'Display Settings',
            'Actions',
            'Animation',
            'Moiré Patterns',
            'Advection Flow',
        ]) {
            await expect(page.getByRole('group').filter({ hasText: legend }).first()).toBeVisible();
        }

        // Settings::default() values, straight from the fake engine.
        await expect(dragBoxValue(page, 'Speed:')).toHaveText('0.1');
        await expect(dragBoxValue(page, 'Base Frequency:')).toHaveText('20');
        await expect(dragBoxValue(page, 'Decay:')).toHaveText('0.98');
    });

    test('drag-box controls round-trip through update_simulation_setting', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openMoire(page);
        await expect(dragBoxValue(page, 'Speed:')).toHaveText('0.1');

        // Every one of these used to assign a local variable and stop there.
        await dragBoxButton(page, 'Speed:', 'increment').click();
        await dragBoxButton(page, 'Base Frequency:', 'decrement').click();
        await dragBoxButton(page, 'Curl:', 'decrement').click();

        await expect(dragBoxValue(page, 'Speed:')).toHaveText('0.11');
        await expect(dragBoxValue(page, 'Base Frequency:')).toHaveText('19.9');

        await expect
            .poll(async () =>
                (await engineLog(page))
                    .filter((entry) => entry.command === 'update_simulation_setting')
                    .map((entry) => (entry.args as { name: string }).name)
            )
            .toEqual(['speed', 'base_freq', 'curl']);

        const log = await engineLog(page);
        const speed = log.find(
            (entry) =>
                entry.command === 'update_simulation_setting' &&
                (entry.args as { name: string }).name === 'speed'
        );
        expect((speed!.args as { value: number }).value).toBeCloseTo(0.11, 5);
    });

    test('the generator-type select offers the values the backend parses', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openMoire(page);

        const select = page.locator('#moire-generator-type');
        // MoireGeneratorType serializes capitalised, so lowercase option values
        // left this select showing nothing at all.
        await expect(select).toHaveValue('Linear');
        await expect(select.locator('option')).toHaveText(['Linear', 'Radial']);

        await select.selectOption('Radial');
        // Selecting Radial must actually reach the engine *and* reveal the
        // radial-only fieldset, which the lowercase guard never did.
        await expect
            .poll(async () =>
                (await engineLog(page)).some(
                    (entry) =>
                        entry.command === 'update_simulation_setting' &&
                        (entry.args as { name: string; value: unknown }).name ===
                            'generator_type' &&
                        (entry.args as { value: unknown }).value === 'Radial'
                )
            )
            .toBe(true);
        await expect(
            page.getByRole('group').filter({ hasText: 'Radial Pattern Settings' })
        ).toBeVisible();
    });

    test('applies a built-in preset and reloads the settings from it', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openMoire(page);

        const presets = page
            .locator('fieldset')
            .filter({ has: page.getByRole('button', { name: 'Save Current Settings' }) });
        const select = presets.locator('select');

        // The four built-ins transcribed from moire/mod.rs:14.
        await expect(select.locator('option:not([disabled])')).toHaveText([
            'Default',
            'Classic Moiré',
            'Psychedelic',
            'Subtle',
        ]);

        await expect(dragBoxValue(page, 'Base Frequency:')).toHaveText('20');
        await select.selectOption('Classic Moiré');

        // Settings { base_freq: 30.0, moire_amount: 0.8, ..Settings::default() }
        await expect(dragBoxValue(page, 'Base Frequency:')).toHaveText('30');
        await expect(dragBoxValue(page, 'Moiré Amount:')).toHaveText('0.8');
        // A field the preset does not name comes from the defaults, not from
        // whatever the previous preset left behind.
        await expect(dragBoxValue(page, 'Decay:')).toHaveText('0.98');

        await select.selectOption('Subtle');
        await expect(dragBoxValue(page, 'Base Frequency:')).toHaveText('40');
        await expect(dragBoxValue(page, 'Moiré Amount:')).toHaveText('0.3');
    });

    test('image mode reveals its controls and the six real interference modes', async ({
        page,
    }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openMoire(page);

        await expect(page.locator('#moire-interference-mode')).toHaveCount(0);
        await page.getByText('Enable Image Mode').click();

        const modes = page.locator('#moire-interference-mode');
        await expect(modes).toBeVisible();
        // The list used to be Modulate + "Blind spot": a "Blend" that no
        // ImageInterferenceMode variant matches, so choosing it always failed.
        await expect(modes.locator('option')).toHaveText([
            'Replace',
            'Add',
            'Multiply',
            'Overlay',
            'Mask',
            'Modulate',
        ]);
        await expect(modes).toHaveValue('Modulate');

        await expect(page.getByRole('button', { name: 'Choose File…' })).toBeVisible();
        await expect(page.getByText('Mirror horizontal')).toBeVisible();
    });

    test('randomize reaches the engine and refreshes the panel', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openMoire(page);

        await page.getByRole('button', { name: 'Randomize Moiré Settings' }).click();
        await expect
            .poll(async () =>
                (await engineLog(page)).some((entry) => entry.command === 'randomize_settings')
            )
            .toBe(true);
    });

    test('degrades to a navigable page when there is no engine at all', async ({ page }) => {
        // No fake engine: exactly what a browser without WebGPU sees.
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await openMoire(page);

        // The loading overlay swallows pointer events, so if it never clears,
        // "Back to Menu" is unreachable and the app is bricked, not degraded.
        await expect(page.locator('button.ui-button', { hasText: 'Back to Menu' })).toBeVisible();
        await page.locator('button.ui-button', { hasText: 'Back to Menu' }).click();
        await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeVisible();

        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });
});

test.describe('moiré — navigation affordances', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openMoire(page);
    });

    /**
     * Regression: upstream, Moiré alone forwarded this event as
     * `dispatch('navigate', { detail: e.detail })` — double-wrapped, where every
     * other mode passes `e.detail`. App.handleNavigation then set currentMode to
     * an object, no {#if} branch matched, and the page rendered nothing at all
     * with no route back. A dead end reachable in two clicks.
     */
    test('Camera Controls reaches How To Play and can come back', async ({ page }) => {
        await page.getByRole('button', { name: /Camera Controls/i }).click();

        // Something must actually render — the bug produced a blank page.
        await expect(page.getByRole('button', { name: '← Back' })).toBeVisible();

        await page.getByRole('button', { name: '← Back' }).click();
        await expect(page.getByRole('button', { name: /Camera Controls/i })).toBeVisible();
    });

    /**
     * Upstream `handleMouseEvent` was a no-op while the panel advertised
     * "Mouse wheel: Zoom | Drag: Pan camera". Moiré has no brush, but the
     * camera is real and shared with every other mode.
     */
    test('the wheel drives the camera', async ({ page }) => {
        const canvasArea = page.locator('.simulation-container');
        await canvasArea.hover({ position: { x: 400, y: 300 } });
        await page.mouse.wheel(0, -240);

        await expect
            .poll(async () =>
                (await engineLog(page)).some((e) => e.command === 'zoom_camera_to_cursor')
            )
            .toBe(true);
    });
});
