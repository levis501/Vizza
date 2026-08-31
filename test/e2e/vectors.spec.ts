import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * M5 — Vectors, at the DOM layer.
 *
 * Same shape as grayScott.spec.ts and for the same reason: Playwright's launcher
 * makes `navigator.gpu` undefined regardless of flags, so nothing here can look
 * at a rendered pixel. What this layer covers is that the menu mounts, that the
 * loading overlay lifts, that each class of control reaches the engine, and that
 * the two enum selectors still show the chosen value *after* a settings sync
 * rather than falling back to their placeholder.
 *
 * The engine under the controls is `$lib/engine/testing/fakeEngine`, which now
 * carries Vectors' real settings *and* state models — so `getSettings()`
 * canonicalises `noise_type` and `vector_field_type` exactly as the ported
 * simulation will, and `getState()` projects the state document the same way.
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
 * The waits are the point. `loading={loading || !settings}` renders a full-bleed
 * overlay that swallows every pointer event including "Back to Menu", and
 * `settings` is assigned in exactly one place — `loadSettings()`, from the mount
 * chain. So the mode is usable if and only if `start_simulation` resolves *and*
 * `get_current_settings` comes back truthy. Anything that breaks either leaves
 * this screen permanently dead on exactly the WebGPU-capable browsers the port
 * targets, and it fails here first.
 */
async function openVectors(page: Page): Promise<void> {
    await page.getByRole('heading', { name: 'Vectors', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeHidden();
    await expect(page.locator('.loading-overlay')).toBeHidden();
    await expect(page.getByRole('group').filter({ hasText: 'Vector Field' }).first()).toBeVisible();
}

/**
 * The row wrapping one control, matched on the label's *exact* text — "Noise
 * Scale:" would otherwise also match nothing while "Density:" matches one row,
 * and a loose filter silently reads the wrong drag box.
 */
function settingRow(page: Page, label: string) {
    return page
        .locator('.setting-item, .control-group')
        .filter({ has: page.getByText(label, { exact: true }) })
        .last();
}

function dragBoxValue(page: Page, label: string) {
    return settingRow(page, label).locator('.value-display');
}

function dragBoxButton(page: Page, label: string, direction: 'increment' | 'decrement') {
    return settingRow(page, label).locator(`.step-button.${direction}`);
}

/**
 * The `<select>` of one `Selector`, by the `id` prop the mode gives it.
 *
 * Not by label: `VectorsMode` puts its `<label>` *beside* the component rather
 * than passing Selector's `label` prop, so the label is outside `.selector` and
 * a `filter({ has: getByText(...) })` on that container matches nothing. The id
 * lands on the `<select>` itself (`Selector.svelte:80`).
 */
function selector(page: Page, id: string) {
    return page.locator(`select#${id}`);
}

/** ImageSelector's Fit Mode select, which is given no id of its own. */
function fitModeSelect(page: Page) {
    return page.locator('.image-selector select');
}

function colorSchemeSelect(page: Page) {
    return page.locator('.color-scheme-selector select');
}

function presetSelect(page: Page) {
    return page
        .locator('fieldset')
        .filter({ has: page.getByRole('button', { name: 'Save Current Settings' }) })
        .locator('select');
}

function settingUpdates(page: Page, name: string) {
    return engineLog(page).then((log) =>
        log
            .filter(
                (entry) =>
                    entry.command === 'update_simulation_setting' &&
                    (entry.args as { name: string }).name === name
            )
            .map((entry) => (entry.args as { value: unknown }).value)
    );
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

test.describe('vectors mode', () => {
    test('mounts its menu with no unexpected console output', async ({ page }) => {
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await installFakeEngine(page);
        await openVectors(page);

        // Give the mount's async chain — start, settings, state, presets,
        // colour schemes — time to settle before judging.
        await page.waitForTimeout(500);

        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });

    test('renders its fieldsets and Settings::default() values', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openVectors(page);

        for (const legend of ['About this simulation', 'Presets', 'Color', 'Vector Field']) {
            await expect(page.getByRole('group').filter({ hasText: legend }).first()).toBeVisible();
        }

        // settings.rs:31, straight from the fake engine.
        await expect(dragBoxValue(page, 'Noise Seed:')).toHaveText('0');
        await expect(dragBoxValue(page, 'Noise Scale:')).toHaveText('5');
        await expect(dragBoxValue(page, 'Noise DT Multiplier:')).toHaveText('1');
        await expect(dragBoxValue(page, 'Density:')).toHaveText('0.02');
        await expect(dragBoxValue(page, 'Line Length:')).toHaveText('0.03');
        // Regression: NumberDragBox defaults `precision` to 2, so this rendered
        // as "0" — and stayed "0" for every value below 0.005 — until M5 passed
        // an explicit precision to each of these boxes.
        await expect(dragBoxValue(page, 'Line Width:')).toHaveText('0.001');
    });

    test('drag boxes round-trip through update_simulation_setting', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openVectors(page);

        await dragBoxButton(page, 'Density:', 'increment').click();
        await dragBoxButton(page, 'Line Width:', 'increment').click();
        await dragBoxButton(page, 'Noise Seed:', 'increment').click();

        await expect(dragBoxValue(page, 'Density:')).toHaveText('0.021');
        await expect(dragBoxValue(page, 'Line Width:')).toHaveText('0.002');
        await expect(dragBoxValue(page, 'Noise Seed:')).toHaveText('1');

        // The value survives a full settings sync, which `updateSetting` does
        // after every change — so these assertions are only reachable if the
        // engine actually took the value.
        await expect
            .poll(async () => (await settingUpdates(page, 'density')).at(-1))
            .toBeCloseTo(0.021, 6);
        await expect
            .poll(async () => (await settingUpdates(page, 'line_width')).at(-1))
            .toBeCloseTo(0.002, 6);
        await expect.poll(() => settingUpdates(page, 'noise_seed')).toEqual([1]);
    });

    test('the background selector round-trips', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openVectors(page);

        const background = selector(page, 'backgroundColorMode');
        await expect(background.locator('option')).toHaveText([
            'Black',
            'White',
            'Gray18',
            'Color Scheme',
        ]);
        await expect(background).toHaveValue('Black');

        // The `#[serde(rename = "Color Scheme")]` variant — the one spelling
        // that could have gone wrong, since it has a space in it.
        await background.selectOption('Color Scheme');
        await expect(background).toHaveValue('Color Scheme');
        await expect
            .poll(() => settingUpdates(page, 'background_color_mode'))
            .toEqual(['Color Scheme']);
        await expect(background.locator('option[disabled]')).toHaveCount(0);
    });

    /**
     * Regression for the enum round trip.
     *
     * `NoiseType` carries two spellings in the Rust — serde's (`"Fbm"`,
     * `"FBMBillow"`) and `Display`'s (`"FBM"`, `"FBM Billow"`) — and they
     * disagree for five of the eleven variants. Gray-Scott's mask enums had
     * exactly this shape and it was a live bug: after any sync the `<Selector>`
     * matched no option, rendered its *placeholder*, and its ◀/▶ buttons cycled
     * from `indexOf() === -1`.
     *
     * Vectors happens to land on the working side — its option list, the serde
     * output and `update_setting`'s arms all use the serde spelling — so this
     * test exists to keep it there. `updateSetting` re-reads the whole settings
     * object from the engine after every change, so simply picking a value and
     * then changing an unrelated control is a full round trip through
     * `get_current_settings`.
     */
    test('the noise-type selector survives a settings sync', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openVectors(page);

        const noise = selector(page, 'noise-type');
        await expect(noise.locator('option')).toHaveText([
            'OpenSimplex',
            'Worley',
            'Value',
            'Fbm',
            'FBMBillow',
            'FBMClouds',
            'FBMRidged',
            'Billow',
            'RidgedMulti',
            'Cylinders',
            'Checkerboard',
        ]);
        await expect(noise).toHaveValue('OpenSimplex');

        // The two variants whose serde and Display spellings differ most.
        await noise.selectOption('FBMBillow');
        await expect(noise).toHaveValue('FBMBillow');

        // Force another full settings sync from an unrelated control.
        await dragBoxButton(page, 'Density:', 'increment').click();
        await expect(dragBoxValue(page, 'Density:')).toHaveText('0.021');

        await expect(noise).toHaveValue('FBMBillow');
        // The placeholder <option> is rendered only when the value matches no
        // option, so its absence is the assertion that matters.
        await expect(noise.locator('option')).toHaveCount(11);
        await expect(noise.locator('option[disabled]')).toHaveCount(0);

        await noise.selectOption('RidgedMulti');
        await expect(noise).toHaveValue('RidgedMulti');
        await expect
            .poll(() => settingUpdates(page, 'noise_type'))
            .toEqual(['FBMBillow', 'RidgedMulti']);
    });

    /**
     * The field-type selector gates a whole fieldset behind
     * `settings?.vector_field_type === 'Image'`, so a spelling that fails to
     * round-trip does not merely show a placeholder — it makes the entire image
     * group unreachable. That is what happened to Moiré's radial parameters in
     * M3.
     */
    test('the field-type selector survives a sync and gates the image group', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openVectors(page);

        const fieldType = selector(page, 'vector-field-type');
        await expect(fieldType.locator('option')).toHaveText(['Noise', 'Image']);
        await expect(fieldType).toHaveValue('Noise');

        // Noise mode: the noise group is present, the image group is not.
        await expect(selector(page, 'noise-type')).toBeVisible();
        await expect(page.getByText('Mirror Horizontal')).toHaveCount(0);

        await fieldType.selectOption('Image');
        await expect(fieldType).toHaveValue('Image');
        await expect(page.getByText('Mirror Horizontal')).toBeVisible();
        await expect(selector(page, 'noise-type')).toHaveCount(0);

        // Density and the line controls are common to both, and must not have
        // gone away with the noise group.
        await expect(dragBoxValue(page, 'Density:')).toHaveText('0.02');

        await fieldType.selectOption('Noise');
        await expect(selector(page, 'noise-type')).toBeVisible();
        await expect
            .poll(() => settingUpdates(page, 'vector_field_type'))
            .toEqual(['Image', 'Noise']);
    });

    test('the image controls round-trip and load a file into the engine', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openVectors(page);

        await selector(page, 'vector-field-type').selectOption('Image');

        // Webcam is an omitted feature of the port, so its permanently-greyed
        // Start button was removed rather than left to advertise nothing — and
        // its three `vectors_*` registry stubs went with it.
        await expect(page.getByText('Webcam:')).toHaveCount(0);

        const fitMode = fitModeSelect(page);
        await expect(fitMode.locator('option')).toHaveText(['Stretch', 'Center', 'Fit H', 'Fit V']);
        await expect(fitMode).toHaveValue('Stretch');
        await fitMode.selectOption('Fit V');
        await expect(fitMode).toHaveValue('Fit V');

        await page.locator('#image-mirror-h').check();
        await page.locator('#image-invert').check();

        await expect.poll(() => settingUpdates(page, 'image_fit_mode')).toEqual(['Fit V']);
        await expect.poll(() => settingUpdates(page, 'image_mirror_horizontal')).toEqual([true]);
        await expect.poll(() => settingUpdates(page, 'image_invert_tone')).toEqual([true]);

        /*
         * `load_vectors_vector_field_image` fell through to the registry stub
         * before M5, which resolves `null`: the user picked a file, nothing
         * happened, and nothing said so. Image path #2 for the port.
         */
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Choose File…' }).click();
        await (
            await chooser
        ).setFiles({
            name: 'field.png',
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
            .toMatchObject({ args: { name: 'field.png', slot: 'vector_field' } });
    });

    test('the Randomize button reaches the engine', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openVectors(page);

        await page.getByRole('button', { name: 'Randomize' }).click();
        await expect
            .poll(async () =>
                (await engineLog(page)).some((entry) => entry.command === 'randomize_settings')
            )
            .toBe(true);
    });

    test('lists and applies the single built-in preset', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openVectors(page);

        // vectors/mod.rs registers exactly one: Preset::new("Default",
        // Settings::default()).
        await expect(presetSelect(page).locator('option:not([disabled])')).toHaveText(['Default']);

        await dragBoxButton(page, 'Density:', 'increment').click();
        await expect(dragBoxValue(page, 'Density:')).toHaveText('0.021');

        await presetSelect(page).selectOption('Default');
        // The preset pins nothing, so applying it restores every default.
        await expect(dragBoxValue(page, 'Density:')).toHaveText('0.02');
        await expect(dragBoxValue(page, 'Line Width:')).toHaveText('0.001');
    });

    /**
     * Regression for `current_color_scheme` being read but never written.
     *
     * `apply_color_scheme_by_name` pushes the LUT bytes at the simulation
     * (handlers/colorSchemes.ts) but never writes the *name* into its state —
     * the `updateColorScheme` seam carries only the buffer and the reversed
     * flag. Since this Selector binds `state.current_color_scheme` and
     * `updateLutName` ends in a state sync, the selection was overwritten by the
     * stale state one tick later. The same defect M4 fixed in Gray-Scott.
     */
    test('the colour scheme round-trips into simulation state', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openVectors(page);

        const schemes = colorSchemeSelect(page);
        // State::default()'s scheme (state.rs:18), which the sync hands back.
        await expect(schemes).toHaveValue('MATPLOTLIB_viridis');

        await schemes.selectOption('ZELDA_Glass');
        await expect(schemes).toHaveValue('ZELDA_Glass');
        await expect
            .poll(() => stateUpdates(page, 'current_color_scheme'))
            .toEqual(['ZELDA_Glass']);

        await page.getByRole('button', { name: 'Reverse' }).click();
        await expect
            .poll(async () =>
                (await engineLog(page)).some((entry) => entry.command === 'update_color_scheme')
            )
            .toBe(true);
        await expect(schemes).toHaveValue('ZELDA_Glass');
    });

    test('degrades to a navigable page when there is no engine at all', async ({ page }) => {
        // No fake engine: exactly what a browser without WebGPU sees. This path
        // works *because* hasEngineContext() is false — `get_current_settings`
        // returns `{}`, which is truthy, so the overlay lifts and "Back to Menu"
        // stays reachable instead of the app being bricked behind it.
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await page.getByRole('heading', { name: 'Vectors', exact: true }).click();

        await expect(page.locator('button.ui-button', { hasText: 'Back to Menu' })).toBeVisible();
        await page.locator('button.ui-button', { hasText: 'Back to Menu' }).click();
        await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeVisible();

        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });
});

test.describe('vectors — camera', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openVectors(page);
    });

    /**
     * `SimulationLayout.handleMouseEvent` only forwards events whose target is
     * the container *itself*, so every position here has to miss the menu — it
     * is centred, so the left margin is the reliable place to aim.
     */
    const FIELD = { x: 30, y: 400 };

    test('the wheel drives zoom-to-cursor', async ({ page }) => {
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
     * Panning is the whole interaction model here — the field is infinite and
     * the camera is how you move through it, which is what the About text
     * promises. Vectors has no brush, so `handle_mouse_interaction` must *not*
     * fire.
     */
    test('dragging pans the camera and paints nothing', async ({ page }) => {
        const canvasArea = page.locator('.simulation-container');
        const box = (await canvasArea.boundingBox())!;
        const x = box.x + FIELD.x;
        const y = box.y + FIELD.y;

        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 60, y + 20);
        await page.mouse.move(x + 120, y + 40);
        await page.mouse.up();

        await expect
            .poll(
                async () => (await engineLog(page)).filter((e) => e.command === 'pan_camera').length
            )
            .toBeGreaterThan(0);
        expect((await engineLog(page)).some((e) => e.command === 'handle_mouse_interaction')).toBe(
            false
        );
    });
});
