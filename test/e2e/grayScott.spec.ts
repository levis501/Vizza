import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * M4 — Gray-Scott, at the DOM layer.
 *
 * Same shape as moire.spec.ts and for the same reason: Playwright's launcher
 * makes `navigator.gpu` undefined regardless of flags, so nothing here can look
 * at a rendered pixel. What this layer covers is that the menu mounts, that the
 * loading overlay lifts, that each class of control reaches the engine, and —
 * the two bugs this milestone exists to pin — that the mask-pattern selector
 * and the colour-scheme selector still show the chosen value *after* a state
 * sync rather than falling back to their placeholder.
 *
 * The engine under the controls is `$lib/engine/testing/fakeEngine`, which now
 * carries Gray-Scott's real settings *and state* models, so `getState()`
 * canonicalises the mask enums exactly as the ported simulation does.
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

/**
 * Open the mode and wait for it to become *interactive*.
 *
 * The waits are the point. `loading={loading || !settings}` renders a
 * full-bleed overlay that swallows every pointer event including "Back to
 * Menu", and `settings` is assigned in exactly one place — the
 * `simulation-initialized` listener. So the mode is usable if and only if that
 * event fires and `get_current_settings` resolves truthy. Before the
 * simulation was ported, `start_gray_scott_simulation` rejected with
 * `Simulation "gray_scott" is not ported yet`, the event never fired, and this
 * screen was permanently dead on exactly the WebGPU-capable browsers the port
 * targets. Anything that reintroduces that fails here first.
 */
async function openGrayScott(page: Page): Promise<void> {
    await page.getByRole('heading', { name: 'Gray-Scott', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeHidden();
    await expect(page.locator('.loading-overlay')).toBeHidden();
    await expect(page.getByRole('group').filter({ hasText: 'Reaction-Diffusion' })).toBeVisible();
}

/** The `.parameter-item` in GrayScottDiagram wrapping one NumberDragBox. */
function parameterRow(page: Page, label: string) {
    return page.locator('.parameter-item').filter({ has: page.getByText(label, { exact: true }) });
}

function parameterValue(page: Page, label: string) {
    return parameterRow(page, label).locator('.value-display');
}

function parameterButton(page: Page, label: string, direction: 'increment' | 'decrement') {
    return parameterRow(page, label).locator(`.step-button.${direction}`);
}

/** The `<select>` of the `Selector` carrying a given label. */
function labelledSelector(page: Page, label: string) {
    return page
        .locator('.selector')
        .filter({ has: page.getByText(label, { exact: true }) })
        .locator('select');
}

/** The preset fieldset's select — it has no label of its own. */
function presetSelect(page: Page) {
    return page
        .locator('fieldset')
        .filter({ has: page.getByRole('button', { name: 'Save Current Settings' }) })
        .locator('select');
}

/** The colour-scheme select, likewise unlabelled but next to "Reverse". */
function colorSchemeSelect(page: Page) {
    return page.locator('.color-scheme-selector select');
}

function stateUpdates(page: Page, name: string) {
    return engineLog(page).then((log) =>
        log
            .filter(
                (entry) =>
                    entry.command === 'update_simulation_state' &&
                    (entry.args as { name: string }).name === name
            )
            .map((entry) => (entry.args as { value: unknown }).value)
    );
}

test.describe('gray-scott mode', () => {
    test('mounts its menu with no unexpected console output', async ({ page }) => {
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await installFakeEngine(page);
        await openGrayScott(page);

        // Give the mount's async chain — start, presets, colour schemes, the
        // initial preset apply, the state sync, the noise seed — time to settle.
        await page.waitForTimeout(500);

        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });

    test('renders its fieldsets and the initial preset it applies on mount', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openGrayScott(page);

        for (const legend of [
            'About this simulation',
            'Presets',
            'Display Settings',
            'Controls',
            'Settings',
            'Reaction-Diffusion',
        ]) {
            await expect(page.getByRole('group').filter({ hasText: legend }).first()).toBeVisible();
        }

        // getPresets() applies "Undulating" on first load; those are its
        // feed/kill rates from gray_scott/mod.rs, and `timestep: 1.0` is the
        // preset's own value rather than Settings::default()'s 2.5.
        await expect(parameterValue(page, 'Feed Rate (F):')).toHaveText('0.026');
        await expect(parameterValue(page, 'Kill Rate (K):')).toHaveText('0.051');
        await expect(parameterValue(page, 'Diffusion U (Du):')).toHaveText('0.16');
        await expect(parameterValue(page, 'Timestep (Δt):')).toHaveText('1');
    });

    test('drag boxes round-trip through update_simulation_setting', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openGrayScott(page);
        await expect(parameterValue(page, 'Feed Rate (F):')).toHaveText('0.026');

        await parameterButton(page, 'Feed Rate (F):', 'increment').click();
        await parameterButton(page, 'Kill Rate (K):', 'decrement').click();

        await expect(parameterValue(page, 'Feed Rate (F):')).toHaveText('0.027');
        await expect(parameterValue(page, 'Kill Rate (K):')).toHaveText('0.05');

        await expect
            .poll(async () =>
                (await engineLog(page))
                    .filter((entry) => entry.command === 'update_simulation_setting')
                    .map((entry) => (entry.args as { name: string }).name)
            )
            .toEqual(['feed_rate', 'kill_rate']);

        const log = await engineLog(page);
        const feed = log.find(
            (entry) =>
                entry.command === 'update_simulation_setting' &&
                (entry.args as { name: string }).name === 'feed_rate'
        );
        expect((feed!.args as { value: number }).value).toBeCloseTo(0.027, 5);
    });

    test('action buttons reach the engine', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openGrayScott(page);

        await page.getByRole('button', { name: /Randomize Settings/ }).click();
        await expect
            .poll(async () =>
                (await engineLog(page)).some((entry) => entry.command === 'randomize_settings')
            )
            .toBe(true);

        // Reset must reach `reset_simulation`, NOT `reset_runtime_state`. The
        // two are different operations and Gray-Scott is where that first
        // matters: its runtime-state reset is a documented no-op, so a Reset
        // button wired to it blanks nothing. Counting rather than merely
        // looking for the name, because apply_preset fires a runtime-state
        // reset of its own on mount.
        const before = (await engineLog(page)).filter(
            (entry) => entry.command === 'reset_simulation'
        ).length;
        await page.getByRole('button', { name: /Reset Simulation/ }).click();
        await expect
            .poll(
                async () =>
                    (await engineLog(page)).filter(
                        (entry) => entry.command === 'reset_simulation'
                    ).length
            )
            .toBe(before + 1);

        await page.getByRole('button', { name: /Seed Noise/ }).click();
        await expect
            .poll(async () =>
                (await engineLog(page)).some((entry) => entry.command === 'seed_random_noise')
            )
            .toBe(true);
    });

    test('applies a built-in preset and reloads the settings from it', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openGrayScott(page);

        // The nine transcribed from gray_scott/mod.rs:14. Note there is no
        // "Default" entry, unlike every other simulation.
        await expect(presetSelect(page).locator('option:not([disabled])')).toHaveText([
            'Brain Coral',
            'Fingerprint',
            'Mitosis',
            'Ripples',
            'Soliton Collapse',
            'U-Skate World',
            'Undulating',
            'Worms',
            'Custom',
        ]);

        await presetSelect(page).selectOption('Worms');
        await expect(parameterValue(page, 'Feed Rate (F):')).toHaveText('0.078');
        await expect(parameterValue(page, 'Kill Rate (K):')).toHaveText('0.061');

        await presetSelect(page).selectOption('Mitosis');
        await expect(parameterValue(page, 'Feed Rate (F):')).toHaveText('0.037');
        await expect(parameterValue(page, 'Kill Rate (K):')).toHaveText('0.065');
        // A field no preset names comes from the defaults, not from the last one.
        await expect(parameterValue(page, 'Diffusion V (Dv):')).toHaveText('0.08');
    });

    /**
     * Regression for the mask-enum round trip.
     *
     * `MaskPattern` had three spellings in the Rust: serde's `"DiagonalGradient"`
     * (what `get_state` returned), the display name `"Diagonal Gradient"` (what
     * this Selector lists and sends), and lowercase/underscore forms. After any
     * state sync the Selector's `options.includes(value)` failed, so it rendered
     * its *placeholder* instead of the selection and its ◀/▶ buttons cycled from
     * `indexOf() === -1` — ◀ jumping to the last option and ▶ to the first. Six
     * of nine patterns and all five targets were affected, and the optimistic
     * local write kept the display honest right up until the next sync, which is
     * why casual testing never caught it.
     *
     * Applying a preset is the cheapest way to force a full `syncAll`.
     */
    test('the mask-pattern selector survives a state sync', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openGrayScott(page);

        const pattern = labelledSelector(page, 'Mask Pattern');
        await expect(pattern.locator('option')).toHaveText([
            'Disabled',
            'Checkerboard',
            'Diagonal Gradient',
            'Radial Gradient',
            'Vertical Stripes',
            'Horizontal Stripes',
            'Wave Function',
            'Cosine Grid',
            'Image',
        ]);
        await expect(pattern).toHaveValue('Disabled');

        await pattern.selectOption('Diagonal Gradient');
        const target = labelledSelector(page, 'Mask Target');
        await expect(target).toBeVisible();

        // Force a full syncAll: state now comes back from the engine, not from
        // the optimistic local write.
        await presetSelect(page).selectOption('Ripples');
        await expect(parameterValue(page, 'Feed Rate (F):')).toHaveText('0.018');

        await expect(pattern).toHaveValue('Diagonal Gradient');
        // The placeholder <option> is rendered only when the value matches no
        // option, so its absence is the assertion that matters here.
        await expect(pattern.locator('option')).toHaveCount(9);
        await expect(pattern.locator('option[disabled]')).toHaveCount(0);

        // The dependent controls must still be on screen — the placeholder bug
        // also made `state.mask_pattern !== 'Disabled'` unreliable.
        await expect(target).toHaveValue('UV Concentration');
        await expect(target.locator('option')).toHaveCount(5);

        // And the engine received the display spelling, which is what the
        // ported settings module made canonical.
        await expect.poll(() => stateUpdates(page, 'mask_pattern')).toEqual(['Diagonal Gradient']);
    });

    test('the mask sub-controls round-trip through update_simulation_state', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openGrayScott(page);

        await labelledSelector(page, 'Mask Pattern').selectOption('Checkerboard');
        await labelledSelector(page, 'Mask Target').selectOption('Kill Rate');
        await page.getByText('Mirror horizontal').click();
        await page.getByText('Invert tone').click();

        await expect.poll(() => stateUpdates(page, 'mask_target')).toEqual(['Kill Rate']);
        await expect.poll(() => stateUpdates(page, 'mask_mirror_horizontal')).toEqual([true]);
        await expect.poll(() => stateUpdates(page, 'mask_invert_tone')).toEqual([true]);

        // Cursor settings go through the same command via the shared panel.
        await page.locator('#cursorSize').fill('0.5');
        await expect.poll(() => stateUpdates(page, 'cursor_size')).toEqual([0.5]);
    });

    /**
     * Regression for the XY plot's unscaled pointer coordinates.
     *
     * Everything XYPlot draws with is in canvas backing-store pixels, but
     * `handleResize` floors the backing store at 320px while these two plots
     * share a row inside a menu about 600px wide — so the element renders
     * around 240px and the two spaces are never equal. The handler used
     * `clientX - rect.left` raw, which put the value roughly 15% left of the
     * cursor.
     *
     * The centre of the canvas *element* is the centre of the backing store is
     * the centre of the plot area (plotX + plotSize/2 = 160 = 320/2, and
     * likewise 150 = 300/2), so a drag that ends there must produce exactly the
     * midpoint of each axis range whatever the element's rendered size. Under
     * the old arithmetic it produced about 0.047 instead of 0.055.
     */
    test('the XY plot maps the pointer to the value under it', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openGrayScott(page);

        const canvas = page.locator('.plot-section').first().locator('canvas');
        // page.mouse works in viewport coordinates, and the plots sit well down
        // a scrolling menu.
        await canvas.scrollIntoViewIfNeeded();
        const box = (await canvas.boundingBox())!;
        // The element really is rendered smaller than its backing store; if that
        // ever stops being true this test would pass for the wrong reason.
        expect(box.width).toBeLessThan(320);

        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;

        await page.mouse.move(cx, cy);
        await page.mouse.down();
        // handlePointerMove throttles at 50ms and ignores a move to the same
        // point, so step away and come back.
        await page.mouse.move(cx + 25, cy + 25);
        await page.waitForTimeout(80);
        await page.mouse.move(cx, cy);
        await page.waitForTimeout(80);
        await page.mouse.up();

        const settingUpdates = (name: string) =>
            engineLog(page).then((log) =>
                log
                    .filter(
                        (entry) =>
                            entry.command === 'update_simulation_setting' &&
                            (entry.args as { name: string }).name === name
                    )
                    .map((entry) => (entry.args as { value: number }).value)
            );

        // Midpoint of the F plot range [0.01, 0.1] and the K range [0.03, 0.07].
        await expect
            .poll(async () => (await settingUpdates('feed_rate')).at(-1))
            .toBeCloseTo(0.055, 3);
        await expect
            .poll(async () => (await settingUpdates('kill_rate')).at(-1))
            .toBeCloseTo(0.05, 3);
    });

    /**
     * Regression for `current_color_scheme` being read but never written.
     *
     * `updateLut` only called `apply_color_scheme_by_name`, and
     * handlers/colorSchemes.ts pushes the LUT bytes at the simulation without
     * writing the *name* into its state — the `updateColorScheme` seam carries
     * only the buffer and the reversed flag. Since the Selector binds to
     * `state.current_color_scheme`, and `updateLut` finishes with a `syncAll`,
     * the selection was overwritten by the stale state one tick later.
     */
    test('the colour scheme round-trips into simulation state', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openGrayScott(page);

        const schemes = colorSchemeSelect(page);
        // State::default()'s scheme, which is what the sync hands back.
        await expect(schemes).toHaveValue('MATPLOTLIB_prism');

        await schemes.selectOption('ZELDA_Glass');
        // updateLut ends in syncAll, so this assertion is only reachable if the
        // name actually landed in simulation state.
        await expect(schemes).toHaveValue('ZELDA_Glass');
        await expect
            .poll(() => stateUpdates(page, 'current_color_scheme'))
            .toEqual(['ZELDA_Glass']);

        // Reversing is a second full sync, from a different command.
        await page.getByRole('button', { name: 'Reverse' }).click();
        await expect
            .poll(async () =>
                (await engineLog(page)).some((entry) => entry.command === 'update_color_scheme')
            )
            .toBe(true);
        await expect(schemes).toHaveValue('ZELDA_Glass');
    });

    /**
     * `load_gray_scott_nutrient_image` used to fall through to the registry
     * stub, which resolves `null`: the user picked a file and nothing happened,
     * with no error anywhere.
     */
    test('the image mask pattern loads a file into the engine', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openGrayScott(page);

        await labelledSelector(page, 'Mask Pattern').selectOption('Image');

        // Webcam is an omitted feature of the port, so its permanently-greyed
        // Start button was removed rather than left to advertise nothing.
        await expect(page.getByText('Webcam:')).toHaveCount(0);

        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Choose File…' }).click();
        await (
            await chooser
        ).setFiles({
            name: 'nutrient.png',
            mimeType: 'image/png',
            buffer: Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
                'base64'
            ),
        });

        await expect
            .poll(async () =>
                (await engineLog(page)).find((entry) => entry.command === 'load_image')
            )
            .toMatchObject({ args: { name: 'nutrient.png', slot: 'nutrient' } });
    });

    test('degrades to a navigable page when there is no engine at all', async ({ page }) => {
        // No fake engine: exactly what a browser without WebGPU sees. This path
        // works *because* hasEngineContext() is false, which is a different code
        // path from the ported simulation — both have to stay alive.
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await page.getByRole('heading', { name: 'Gray-Scott', exact: true }).click();

        // The loading overlay swallows pointer events, so if it never clears,
        // "Back to Menu" is unreachable and the app is bricked, not degraded.
        await expect(page.locator('button.ui-button', { hasText: 'Back to Menu' })).toBeVisible();
        await page.locator('button.ui-button', { hasText: 'Back to Menu' }).click();
        await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeVisible();

        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });
});

test.describe('gray-scott — navigation affordances', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openGrayScott(page);
    });

    test('Camera Controls reaches How To Play and can come back', async ({ page }) => {
        await page.getByRole('button', { name: /Camera Controls/i }).click();
        await expect(page.getByRole('button', { name: '← Back' })).toBeVisible();

        await page.getByRole('button', { name: '← Back' }).click();
        await expect(page.getByRole('button', { name: /Camera Controls/i })).toBeVisible();
    });

    /**
     * `SimulationLayout.handleMouseEvent` only forwards events whose target is
     * the container *itself*, so every position here has to miss the menu — it
     * is centred, so the left margin is the reliable place to aim.
     */
    const FIELD = { x: 30, y: 400 };

    test('the wheel drives the camera', async ({ page }) => {
        const canvasArea = page.locator('.simulation-container');
        await canvasArea.hover({ position: FIELD });
        await page.mouse.wheel(0, -240);

        await expect
            .poll(async () =>
                (await engineLog(page)).some((e) => e.command === 'zoom_camera_to_cursor')
            )
            .toBe(true);
    });

    /**
     * "Left click: Seed reaction" is the one thing the control panel promises
     * about the mouse, and it is the only mode-specific interaction Gray-Scott
     * has. A press *and* a release, because the mode tracks `isMousePressed`
     * itself and a missed mouseup leaves the brush painting forever.
     */
    test('clicking the field seeds a reaction and releases', async ({ page }) => {
        const canvasArea = page.locator('.simulation-container');
        await canvasArea.click({ position: FIELD });

        await expect
            .poll(async () =>
                (await engineLog(page)).map((e) => e.command).filter((c) => c.startsWith('handle_'))
            )
            .toEqual(['handle_mouse_interaction', 'handle_mouse_release']);
    });
});
