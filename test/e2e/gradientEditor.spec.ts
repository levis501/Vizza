import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';
import {
    GRADIENT_COLOR_SPACES,
    GRADIENT_COLOR_SPACE_LABELS,
} from '../../src/lib/engine/color/spaces';

/**
 * M6 — Gradient Editor, at the DOM layer.
 *
 * Playwright's launcher makes `navigator.gpu` undefined regardless of flags
 * (WEB_PORT.md, "Verified environment facts"), so nothing here looks at a
 * rendered pixel — the gradient the editor is *for* is invisible to this layer.
 * What is visible is every byte on the way to it: the editor bakes a 768-byte
 * LUT on the CPU and pushes it through `update_gradient_preview`, which the fake
 * engine records with a checksum. So "this control changed the gradient" is an
 * assertable, exact statement here even though "the gradient looks right" is
 * not.
 *
 * The colour-space list is imported from the engine rather than transcribed, so
 * a space added to `GRADIENT_COLOR_SPACES` is covered by this suite the moment
 * it exists.
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

/** Every LUT the editor has pushed at the engine, as checksums, in order. */
async function lutChecksums(page: Page): Promise<number[]> {
    return (await engineLog(page))
        .filter((entry) => entry.command === 'update_color_scheme')
        .map((entry) => (entry.args as { checksum: number }).checksum);
}

async function openEditor(page: Page): Promise<void> {
    await page.getByRole('heading', { name: 'Gradient Editor', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeHidden();
}

async function backToMenu(page: Page): Promise<void> {
    await page.locator('button.ui-button', { hasText: 'Back to Menu' }).click();
}

const stops = (page: Page) => page.locator('.gradient-bar .color-stop');
const colorSpaceSelect = (page: Page) => page.locator('#color-space-selector');
const displayModeSelect = (page: Page) => page.locator('#display-mode-selector');
const interpolationSelect = (page: Page) => page.locator('#interpolation-mode-selector');
const nameInput = (page: Page) => page.locator('#color-scheme-name-input');
// By class, not by accessible name: `SimulationLayout`'s container is itself
// `role="button"`, so a name-based match picks up the whole page as well.
const saveButton = (page: Page) => page.locator('button.save-button');

test.describe('gradient editor', () => {
    test('mounts, lifts the loading gate, and says nothing to the console', async ({ page }) => {
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await installFakeEngine(page);
        await openEditor(page);

        // `loading` used to be a `const false`, so there was no gate to lift and
        // no way to tell a started simulation from a failed one. It is now the
        // same `true`-until-`start_simulation`-settles flag every other mode
        // uses — and it must actually clear, because the overlay swallows
        // pointer events.
        await expect(page.locator('.loading-overlay')).toBeHidden();
        await expect(page.locator('.gradient-bar')).toBeVisible();
        await expect(stops(page)).toHaveCount(2);

        // The mount's async chain — start, the initialized event, the first
        // debounced LUT push — needs to settle before the console is judged.
        await page.waitForTimeout(500);
        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });

    test('the first frame is seeded with a LUT built from the default stops', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openEditor(page);

        // `simulation-initialized` triggers the first `updateGradient`, so the
        // preview is never left showing the identity ramp the simulation seeds
        // itself with.
        await expect.poll(async () => (await lutChecksums(page)).length).toBeGreaterThan(0);
        const log = await engineLog(page);
        const push = log.find((entry) => entry.command === 'update_color_scheme');
        expect((push!.args as { length: number }).length).toBe(768);
    });

    /**
     * The regression for the defect that motivated `engine/color/spaces.ts`.
     *
     * `ColorSchemeSelector.svelte:75` offered `Jzazbz` and `HSLuv` and mapped
     * them to culori mode names culori does not register — it ships `jab` and
     * `lchuv` — so two of its five spaces threw
     * `TypeError: converters[color.mode].rgb is not a function`, which the
     * catch turned into a `console.error`. The gradient simply stopped updating.
     * Parameterised over `GRADIENT_COLOR_SPACES` so the same cannot happen to a
     * space added later.
     */
    for (const space of GRADIENT_COLOR_SPACES) {
        const label = GRADIENT_COLOR_SPACE_LABELS[space];

        test(`interpolating in ${label} reaches the engine without throwing`, async ({ page }) => {
            const unexpected = collectUnexpected(page);

            await page.goto('/');
            await installFakeEngine(page);
            await openEditor(page);
            await expect.poll(async () => (await lutChecksums(page)).length).toBeGreaterThan(0);

            const before = (await lutChecksums(page)).length;
            await colorSpaceSelect(page).selectOption(label);
            await expect(colorSpaceSelect(page)).toHaveValue(label);

            await expect
                .poll(async () => (await lutChecksums(page)).length)
                .toBeGreaterThan(before);
            await page.waitForTimeout(200);
            expect(unexpected, unexpected.join('\n')).toEqual([]);
        });
    }

    test('the picker offers exactly the engine-canonical spaces, and they differ', async ({
        page,
    }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openEditor(page);

        const labels = GRADIENT_COLOR_SPACES.map((space) => GRADIENT_COLOR_SPACE_LABELS[space]);
        await expect(colorSpaceSelect(page).locator('option')).toHaveText(labels);
        await expect(colorSpaceSelect(page)).toHaveValue('OkLab');

        // Each space must bake *different* bytes from the same stops — the
        // point of offering them at all. Blue→yellow separates all four.
        const checksums = new Map<string, number>();
        for (const label of labels) {
            await colorSpaceSelect(page).selectOption(label);
            await expect
                .poll(async () => (await lutChecksums(page)).length)
                .toBeGreaterThan(checksums.size);
            const seen = await lutChecksums(page);
            checksums.set(label, seen[seen.length - 1]);
        }
        expect(new Set(checksums.values()).size).toBe(labels.length);
    });

    test('adding, copying and deleting stops each rebuild the LUT', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openEditor(page);
        await expect.poll(async () => (await lutChecksums(page)).length).toBeGreaterThan(0);

        // Double-clicking the bar adds a stop at the cursor, coloured by what
        // the gradient already shows there.
        const bar = page.locator('.gradient-bar');
        const box = (await bar.boundingBox())!;
        await bar.dblclick({ position: { x: box.width / 2, y: box.height / 2 } });
        await expect(stops(page)).toHaveCount(3);

        // The rebuild is debounced 50 ms, so poll rather than read once.
        await expect.poll(async () => (await lutChecksums(page)).length).toBeGreaterThan(1);
        const afterAdd = await lutChecksums(page);

        await page.getByRole('button', { name: 'Copy', exact: true }).click();
        await expect(stops(page)).toHaveCount(4);

        // Delete only appears above two stops, which is the guard that keeps a
        // gradient interpolable at all.
        await page.getByRole('button', { name: 'Delete', exact: true }).click();
        await expect(stops(page)).toHaveCount(3);

        await expect
            .poll(async () => (await lutChecksums(page)).length)
            .toBeGreaterThan(afterAdd.length);
    });

    test('dragging a stop moves it and pushes a new LUT', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openEditor(page);
        await expect.poll(async () => (await lutChecksums(page)).length).toBeGreaterThan(0);

        const bar = page.locator('.gradient-bar');
        const box = (await bar.boundingBox())!;
        const before = (await lutChecksums(page)).length;

        // Drag the left stop a quarter of the way in. A gradient whose stops no
        // longer reach 0 is exactly the case the two `getColorAtPosition`
        // copies disagreed on: this one clamps and holds the terminal colour,
        // the other extrapolated with t outside [0,1].
        const handle = stops(page).first();
        const start = (await handle.boundingBox())!;
        await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.25, start.y + start.height / 2, { steps: 8 });
        await page.mouse.up();

        await expect(page.locator('.stop-title')).toContainText('25%');
        await expect.poll(async () => (await lutChecksums(page)).length).toBeGreaterThan(before);
    });

    /**
     * Two stops dragged onto each other used to divide by zero, producing a
     * `t` of NaN and a LUT of whatever culori made of it. `sampleGradient`
     * takes the right-hand stop's colour instead.
     */
    test('coincident stops do not poison the LUT', async ({ page }) => {
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await installFakeEngine(page);
        await openEditor(page);
        await expect.poll(async () => (await lutChecksums(page)).length).toBeGreaterThan(0);

        const bar = page.locator('.gradient-bar');
        const box = (await bar.boundingBox())!;
        const handle = stops(page).first();
        const start = (await handle.boundingBox())!;

        // Drag the first stop all the way onto the last.
        await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width, start.y + start.height / 2, { steps: 10 });
        await page.mouse.up();

        await expect(page.locator('.stop-title')).toContainText('100%');
        await page.waitForTimeout(200);
        // A NaN anywhere in the LUT would surface as a throw out of
        // `ColorScheme.fromBytes` or as a console error from the catch.
        expect(unexpected, unexpected.join('\n')).toEqual([]);
        expect((await lutChecksums(page)).length).toBeGreaterThan(0);
    });

    test('the display-mode toggle reaches set_gradient_display_mode', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openEditor(page);

        await expect(displayModeSelect(page)).toHaveValue('Smooth');
        await displayModeSelect(page).selectOption('Dithered');

        // Through `handlers/gradient.ts`, which writes it as a state update —
        // the same seam the Rust's `update_state("displayMode", …)` arm is.
        await expect
            .poll(async () =>
                (await engineLog(page))
                    .filter((entry) => entry.command === 'update_simulation_state')
                    .map((entry) => entry.args)
            )
            .toEqual([{ name: 'display_mode', value: 1 }]);

        await displayModeSelect(page).selectOption('Smooth');
        await expect
            .poll(async () =>
                (await engineLog(page))
                    .filter((entry) => entry.command === 'update_simulation_state')
                    .map((entry) => (entry.args as { value: number }).value)
            )
            .toEqual([1, 0]);
    });

    test('stepped interpolation bakes a different LUT from smooth', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openEditor(page);
        await expect.poll(async () => (await lutChecksums(page)).length).toBeGreaterThan(0);

        const smooth = (await lutChecksums(page)).at(-1)!;
        await interpolationSelect(page).selectOption('Stepped');
        await expect.poll(async () => (await lutChecksums(page)).at(-1)).not.toBe(smooth);
    });

    test('applying a preset replaces the stops and rebuilds', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openEditor(page);

        const presets = page.locator('#preset-selector');
        // 'Heat', not 'Warm': the option used to name a preset `applyPreset`
        // has no arm for, so selecting it changed nothing at all.
        await expect(presets.locator('option')).toHaveText([
            'Custom',
            'Rainbow',
            'Heat',
            'Cool',
            'Viridis',
            'Plasma',
            'Inferno',
        ]);

        await presets.selectOption('Rainbow');
        await expect(stops(page)).toHaveCount(7);

        await presets.selectOption('Heat');
        await expect(stops(page)).toHaveCount(3);
    });
});

test.describe('gradient editor — saving a custom colour scheme', () => {
    const NAME = 'M6 E2E Gradient';

    test('saves, lists it in another mode’s picker, and survives a reload', async ({ page }) => {
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await installFakeEngine(page);
        await openEditor(page);

        await expect(saveButton(page)).toBeDisabled();
        await nameInput(page).fill(NAME);
        await expect(saveButton(page)).toBeEnabled();
        await saveButton(page).click();

        await expect(page.locator('.save-message')).toContainText(`"${NAME}" saved successfully`);
        await expect(page.locator('.save-message.failed')).toHaveCount(0);

        // The picker lives in ColorSchemeSelector, which the editor does not
        // mount — so the round trip has to be checked from one of the nine modes
        // that do.
        await backToMenu(page);
        await page.getByRole('heading', { name: 'Moiré', exact: true }).click();
        const picker = page.locator('.color-scheme-selector select');
        await expect(picker.locator(`option[value="${NAME}"]`)).toHaveCount(1);

        // localStorage, not memory: the whole point of M6's persistence item.
        await page.reload();
        await installFakeEngine(page);
        await page.getByRole('heading', { name: 'Moiré', exact: true }).click();
        await expect(page.locator('.color-scheme-selector select')).toBeVisible();
        await expect(
            page.locator('.color-scheme-selector select').locator(`option[value="${NAME}"]`)
        ).toHaveCount(1);

        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });

    /**
     * `ColorSchemeManager.saveCustom` refuses a built-in's name rather than
     * shadowing it: `get` always answers from the embedded set, so a custom
     * scheme saved under a built-in's name would be listed and then be
     * unreachable, with the user's gradient lost. The refusal has to be
     * *visible* — and it is not a console error, because it is a message to act
     * on, not a fault.
     */
    test('refuses a built-in’s name and says why', async ({ page }) => {
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await installFakeEngine(page);
        await openEditor(page);

        await nameInput(page).fill('MATPLOTLIB_bone');
        await saveButton(page).click();

        const message = page.locator('.save-message.failed');
        await expect(message).toBeVisible();
        await expect(message).toContainText('built-in colour scheme');

        // Nothing was stored, so the picker still holds exactly one entry for
        // that name — a saved custom scheme under a built-in's name is the
        // duplicate `allColorSchemes` was taught to dedup.
        await backToMenu(page);
        await page.getByRole('heading', { name: 'Moiré', exact: true }).click();
        await expect(
            page.locator('.color-scheme-selector select').locator('option[value="MATPLOTLIB_bone"]')
        ).toHaveCount(1);

        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });
});

/**
 * The 🎨 dialog inside `ColorSchemeSelector`, which is a second gradient editor
 * living in **all nine** simulation modes.
 *
 * This is where defect 1 actually bit users: two of its five colour spaces
 * named culori modes culori does not register, so choosing them threw and the
 * preview silently froze — in Moiré, Gray-Scott, Vectors and six more. Driven
 * through Moiré here because one mode is enough to exercise the shared
 * component, and Moiré is the cheapest to mount.
 */
test.describe('the shared colour-scheme editor dialog', () => {
    const dialogSpace = (page: Page) => page.locator('#colorSpaceTop');
    const dialogName = (page: Page) => page.locator('#customColorSchemeName');
    const dialogSave = (page: Page) =>
        page.locator('.gradient-editor-content button.primary-button', {
            hasText: 'Save Color Scheme',
        });

    async function openDialog(page: Page): Promise<void> {
        await page.goto('/');
        await installFakeEngine(page);
        await page.getByRole('heading', { name: 'Moiré', exact: true }).click();
        await page.locator('.color-scheme-selector .gradient-btn').click();
        await expect(page.locator('.gradient-editor-content')).toBeVisible();
        // Opening pushes the initial preview; wait for the mode's own
        // colour-scheme traffic to settle so the counts below mean something.
        await page.waitForTimeout(300);
    }

    test('offers exactly the engine-canonical spaces', async ({ page }) => {
        await openDialog(page);

        const labels = GRADIENT_COLOR_SPACES.map((space) => GRADIENT_COLOR_SPACE_LABELS[space]);
        // Was ['RGB', 'Lab', 'OkLab', 'Jzazbz', 'HSLuv'] — the last two of which
        // could not work.
        await expect(dialogSpace(page).locator('option')).toHaveText(labels);
        await expect(dialogSpace(page)).toHaveValue('OkLab');
    });

    for (const space of GRADIENT_COLOR_SPACES) {
        const label = GRADIENT_COLOR_SPACE_LABELS[space];

        test(`interpolating in ${label} previews without throwing`, async ({ page }) => {
            const unexpected = collectUnexpected(page);
            await openDialog(page);

            const before = (await lutChecksums(page)).length;
            await dialogSpace(page).selectOption(label);
            await expect(dialogSpace(page)).toHaveValue(label);

            await expect
                .poll(async () => (await lutChecksums(page)).length)
                .toBeGreaterThan(before);
            await page.waitForTimeout(200);
            expect(unexpected, unexpected.join('\n')).toEqual([]);
        });
    }

    test('saving adds the scheme to the picker and selects it', async ({ page }) => {
        const unexpected = collectUnexpected(page);
        await openDialog(page);

        await expect(dialogSave(page)).toBeDisabled();
        // Deliberately padded: `save_custom_color_scheme` answers with the
        // trimmed name, and that is the name the picker lists — selecting by
        // the raw input would leave the <Selector> showing nothing.
        await dialogName(page).fill('  Dialog Scheme  ');
        await dialogSave(page).click();

        await expect(page.locator('.gradient-editor-content')).toHaveCount(0);
        const picker = page.locator('.color-scheme-selector select');
        await expect(picker.locator('option[value="Dialog Scheme"]')).toHaveCount(1);
        await expect(picker).toHaveValue('Dialog Scheme');

        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });

    test('refuses a built-in’s name, keeps the dialog open, and says why', async ({ page }) => {
        const unexpected = collectUnexpected(page);
        await openDialog(page);

        await dialogName(page).fill('MATPLOTLIB_bone');
        await dialogSave(page).click();

        const error = page.locator('.gradient-editor-content .save-error');
        await expect(error).toBeVisible();
        await expect(error).toContainText('built-in colour scheme');
        // Still open, with the name still in the box: the user renames and
        // keeps the gradient they authored.
        await expect(page.locator('.gradient-editor-content')).toBeVisible();
        await expect(dialogName(page)).toHaveValue('MATPLOTLIB_bone');

        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });

    test('cancelling restores the colour scheme that was selected', async ({ page }) => {
        await openDialog(page);

        await page.locator('.gradient-editor-content button.secondary-button').click();
        await expect(page.locator('.gradient-editor-content')).toHaveCount(0);
        await expect
            .poll(async () =>
                (await engineLog(page)).some((entry) => entry.command === 'update_color_scheme')
            )
            .toBe(true);
    });
});

test.describe('gradient editor — teardown', () => {
    /**
     * Regression for the two teardown hazards.
     *
     * `updateGradient` is debounced 50 ms, so leaving straight after an edit
     * fired `update_gradient_preview` *after* `destroy_simulation` — and
     * `handlers/colorSchemes.ts`'s `applyToSimulation` only checked that an
     * engine existed, not that a simulation was running, so
     * `SimulationHost.requireSimulation()` threw "No simulation is running"
     * into the editor's `console.error`. Both had to go before this could pass.
     */
    test('navigating away immediately after an edit stays console-clean', async ({ page }) => {
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await installFakeEngine(page);
        await openEditor(page);
        await expect.poll(async () => (await lutChecksums(page)).length).toBeGreaterThan(0);

        // Edit, then leave inside the debounce window.
        await interpolationSelect(page).selectOption('Stepped');
        await backToMenu(page);
        await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeVisible();

        // Well past the 50 ms debounce, and past the destroy that races it.
        await page.waitForTimeout(600);
        expect(unexpected, unexpected.join('\n')).toEqual([]);

        // The debounced push must have been *dropped*, not merely swallowed:
        // the last thing the engine saw is the teardown.
        const log = await engineLog(page);
        const destroyAt = log.map((entry) => entry.command).lastIndexOf('destroy');
        expect(destroyAt).toBeGreaterThanOrEqual(0);
        expect(log.slice(destroyAt).some((entry) => entry.command === 'update_color_scheme')).toBe(
            false
        );
    });

    test('degrades to a navigable page when there is no engine at all', async ({ page }) => {
        // No fake engine: exactly what a browser without WebGPU sees. The
        // loading overlay swallows pointer events, so if it never clears the
        // app is bricked rather than degraded.
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await openEditor(page);

        await expect(page.locator('.loading-overlay')).toBeHidden();
        await backToMenu(page);
        await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeVisible();

        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });
});
