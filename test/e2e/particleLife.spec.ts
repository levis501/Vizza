import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * M8 — Particle Life, at the DOM layer.
 *
 * Same shape and same limits as `slimeMold.spec.ts`: Playwright's launcher
 * makes `navigator.gpu` undefined regardless of flags, so nothing here looks at
 * a pixel. What this layer covers is the menu mounting, the loading overlay
 * lifting, each class of control reaching the engine, and the defects this
 * milestone's UI half exists to close:
 *
 *   1. the **± flip-sign button**, the only one of eleven that invoked a
 *      command — `update_particle_life_setting`, which has no `#[tauri::command]`
 *      behind it, took its argument under a key the shim does not rename, and
 *      dispatched an event missing the field its parent destructures;
 *   2. the **diagonal**, which all eleven transforms have always preserved and
 *      which the ported `matrix_operations.rs` does not — the shipped
 *      behaviour must survive the move to the shared module;
 *   3. **"Clear Trails"**, a registry stub resolving `null` that then logged
 *      success, and which must reach `clearTrails()` rather than the
 *      particle-destroying `resetRuntimeState()`;
 *   4. **`get_species_colors`**, called with no arguments against a handler
 *      defaulting to four, so at five or more species the matrix headers went
 *      white;
 *   5. **three disagreeing particle-count ranges** and a **cursor-strength
 *      slider whose top half was inert**;
 *   6. the physics diagram's **"Reset to Defaults"**, which wrote two numbers
 *      `Settings::default()` does not contain;
 *   7. the **four position generators** implemented in `init.wgsl` and offered
 *      by nothing.
 */

/** The one console error a GPU-less browser is expected to produce. */
const EXPECTED_ERROR = /WebGPU|GPU adapter|secure context|No available adapters/i;

/** `PARTICLE_LIFE_CEILING` — the compute ceiling, and the answer on any conformant device. */
const PARTICLE_COUNT_CAP = 50_000;

/** `PARTICLE_LIFE_MIN_PARTICLES`, the Rust's own `clamp(1000, …)` lower bound. */
const PARTICLE_COUNT_FLOOR = 1_000;

interface FakeEngineWindow extends Window {
    __vizza?: { installFakeEngine?: () => unknown };
    __fakeEngine?: { log: Array<{ command: string; args: unknown }> };
}

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

function commandsNamed(page: Page, command: string) {
    return engineLog(page).then((log) => log.filter((entry) => entry.command === command).length);
}

/** Open the mode and wait for it to become *interactive*. */
async function openParticleLife(page: Page): Promise<void> {
    await page.getByRole('heading', { name: 'Particle Life', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeHidden();
    // The overlay swallows every pointer event including "Back to Menu", so a
    // mode that never clears it is bricked rather than merely blank.
    await expect(page.locator('.loading-overlay')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Regenerate Particles' })).toBeVisible();
}

/** The two drag boxes in the Settings fieldset, in markup order. */
function countBox(page: Page, which: 'particle' | 'species') {
    return page
        .locator('.control-group')
        .filter({ hasText: 'Particle Count' })
        .locator('.number-drag-box')
        .nth(which === 'particle' ? 0 : 1);
}

/** One cell of the interaction matrix. */
function matrixCell(page: Page, row: number, column: number) {
    return page.locator('.matrix-grid .matrix-row').nth(row).locator('.value-display').nth(column);
}

/** All the matrix values, read off the DOM, as a matrix of numbers. */
async function matrixValues(page: Page): Promise<number[][]> {
    const rows = await page.locator('.matrix-grid .matrix-row').all();
    return Promise.all(
        rows.map(async (row) =>
            (await row.locator('.value-display').allTextContents()).map((text) =>
                Number(text.trim())
            )
        )
    );
}

function transformButton(page: Page, title: string) {
    return page.locator(`.interaction-matrix button[title="${title}"]`);
}

/** The last `force_matrix` the mode sent, as the engine received it. */
async function lastForceMatrix(page: Page): Promise<number[][]> {
    const values = await settingUpdates(page, 'force_matrix');
    return values.at(-1) as number[][];
}

async function setSpeciesCount(page: Page, count: number): Promise<void> {
    const box = countBox(page, 'species');
    await box.dblclick();
    await box.locator('input').fill(String(count));
    await box.locator('input').press('Enter');
    await expect.poll(() => settingUpdates(page, 'species_count')).toContain(count);
}

test.describe('particle life mode', () => {
    test('mounts its menu with no unexpected console output', async ({ page }) => {
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await installFakeEngine(page);
        await openParticleLife(page);

        // The mount chain — start, presets, colour schemes, the particle-count
        // limit, two syncs and the species colours — needs a moment to settle.
        await page.waitForTimeout(500);

        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });

    test('renders its fieldsets and Settings::default() values', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openParticleLife(page);

        for (const legend of [
            'About this simulation',
            'Presets',
            'Display Settings',
            'Controls',
            'Settings',
            'Physics',
        ]) {
            await expect(page.getByRole('group').filter({ hasText: legend }).first()).toBeVisible();
        }

        // settings.rs:144 — four species, and the literal 4x4 default matrix.
        await expect(countBox(page, 'species')).toHaveText('4');
        expect(await matrixValues(page)).toEqual([
            [-0.1, 0.2, -0.1, 0.1],
            [0.2, -0.1, 0.3, -0.1],
            [-0.1, 0.3, -0.1, 0.2],
            [0.1, -0.1, 0.2, -0.1],
        ]);

        // The constructor's particle count (manager.rs:323), not State::default()'s 1000.
        await expect(countBox(page, 'particle')).toHaveText('15000');
    });

    /**
     * Defect 5a. The drag box advertised `min={1}`, this file clamped to
     * [1000, 50000] and the Rust to [1000, 100000] — three ranges for one
     * control, of which the one the user could see was the wrong one.
     */
    test('the particle count control advertises the range it actually enforces', async ({
        page,
    }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openParticleLife(page);

        const box = countBox(page, 'particle');
        await expect(box).toHaveAttribute('aria-valuemin', String(PARTICLE_COUNT_FLOOR));
        await expect(box).toHaveAttribute('aria-valuemax', String(PARTICLE_COUNT_CAP));

        // And the clamp holds for a value typed straight in.
        await box.dblclick();
        await box.locator('input').fill('900000');
        await box.locator('input').press('Enter');

        await expect(box).toHaveText(String(PARTICLE_COUNT_CAP));
        await expect
            .poll(() => settingUpdates(page, 'particle_count'))
            .toEqual([PARTICLE_COUNT_CAP]);
    });

    /**
     * Defect 5b. `update_setting` clamps `cursor_strength` to 10
     * (simulation.rs:3487) and the slider ran to 20, so everything above the
     * midpoint produced the same force as the midpoint.
     */
    test('the cursor strength slider stops where the backend clamp does', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openParticleLife(page);

        await expect(page.locator('#cursorStrength')).toHaveAttribute('max', '10');

        await page.locator('#cursorStrength').fill('10');
        await expect.poll(() => stateUpdates(page, 'cursor_strength')).toContain(10);
    });

    /**
     * Defect 7. `PositionGenerator` has eleven variants, all eleven are
     * implemented in `init.wgsl` and dispatched by its `switch` at :283, and the
     * control offered seven. The list now comes from the engine, so the two
     * cannot drift again.
     */
    test('offers all eleven position generators, and all eleven type generators', async ({
        page,
    }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openParticleLife(page);

        const selects = page.locator('.button-select select');
        // Matrix, position, type — in markup order. The first option of each is
        // the disabled placeholder.
        await expect(selects.nth(1).locator('option')).toHaveText([
            'Select position generator...',
            'Random',
            'Center',
            'Uniform Circle',
            'Centered Circle',
            'Ring',
            'Rainbow Ring',
            'Color Battle',
            'Color Wheel',
            'Line',
            'Spiral',
            'Rainbow Spiral',
        ]);

        await expect(selects.nth(0).locator('option')).toHaveCount(23);
        await expect(selects.nth(2).locator('option')).toHaveCount(12);

        // And one of the four that used to be unreachable actually goes out.
        await selects.nth(1).selectOption('ColorWheel');
        await page.getByRole('button', { name: 'Regenerate Positions' }).click();
        await expect.poll(() => settingUpdates(page, 'position_generator')).toContain('ColorWheel');
    });

    /**
     * Defects 1 and 2. Every one of the eleven buttons must reach the engine as
     * a plain `update_simulation_setting force_matrix` — the ± button used to
     * be the exception — and every one must leave the diagonal alone.
     */
    test('all eleven matrix transforms reach the engine and hold the diagonal', async ({
        page,
    }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openParticleLife(page);

        const before = await matrixValues(page);
        const diagonal = before.map((row, i) => row[i]);

        const titles = [
            'Scale down matrix values by 20%',
            'Scale up matrix values by 20%',
            'Rotate matrix anticlockwise',
            'Rotate matrix clockwise',
            'Flip matrix horizontally',
            'Flip matrix vertically',
            'Shift matrix left',
            'Shift matrix right',
            'Shift matrix up',
            'Shift matrix down',
            'Set all matrix values to zero',
            'Flip the sign of all matrix values',
        ];

        for (const title of titles) {
            await transformButton(page, title).click();
            await expect
                .poll(async () => (await lastForceMatrix(page)).map((row, i) => row[i]))
                .toEqual(diagonal);
        }

        // Twelve buttons, twelve writes — nothing took a second path and nothing
        // was swallowed. (Two of the twelve are the scale pair.)
        await expect
            .poll(async () => (await settingUpdates(page, 'force_matrix')).length)
            .toBe(titles.length);
    });

    /**
     * The ± button specifically, because it is the one that was broken. Its
     * off-diagonal entries must be negated and its diagonal must not be: a
     * self-attracting species collapses to a point.
     */
    test('the ± button negates the off-diagonal and spares self-repulsion', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openParticleLife(page);

        await transformButton(page, 'Flip the sign of all matrix values').click();

        await expect
            .poll(() => lastForceMatrix(page))
            .toEqual([
                [-0.1, -0.2, 0.1, -0.1],
                [-0.2, -0.1, -0.3, 0.1],
                [0.1, -0.3, -0.1, -0.2],
                [-0.1, 0.1, -0.2, -0.1],
            ]);

        // And the grid the user is looking at agrees with what was sent.
        // `NumberDragBox` trims trailing zeroes, so 2dp shows as "-0.2".
        await expect(matrixCell(page, 0, 1)).toHaveText('-0.2');
        await expect(matrixCell(page, 0, 0)).toHaveText('-0.1');
    });

    /**
     * Defect 3. This was a registry stub resolving `null`, after which the mode
     * logged "Trail texture cleared successfully". It must reach `clearTrails()`
     * — *not* `resetRuntimeState()`, which for Particle Life re-seeds every
     * particle (simulation.rs:3860) and would make the button a duplicate of
     * "Regenerate Particles".
     */
    test('Clear Trails clears trails rather than throwing the particles away', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openParticleLife(page);

        await page.getByLabel('Enable Particle Traces').check();
        await page.getByRole('button', { name: 'Clear Trails' }).click();

        await expect.poll(() => commandsNamed(page, 'clear_trails')).toBe(1);
        expect(await commandsNamed(page, 'reset_runtime_state')).toBe(0);
        expect(await commandsNamed(page, 'reset_simulation')).toBe(0);
    });

    /**
     * Defect 4. `get_species_colors` was called with no arguments against a
     * handler defaulting `count` to **4**, so `Math.min(species_count, colors.length)`
     * yielded four colours at any species count and `InteractionMatrix` painted
     * `#ffffff` for every label past the fourth.
     */
    test('every species header is coloured, at eight species as well as four', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openParticleLife(page);

        await setSpeciesCount(page, 8);
        await expect(page.locator('.matrix-header-row .header-label')).toHaveCount(8);

        const colors = await page
            .locator('.matrix-header-row .header-label')
            .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).style.color));
        expect(colors).toHaveLength(8);

        /*
         * Eight distinct stops off the LUT rather than four followed by four of
         * the component's `#ffffff` fallback. Distinctness is the assertion and
         * not "none of them is white", because a colour scheme is perfectly
         * entitled to a white stop — several end on one — whereas *four*
         * identical trailing labels can only be the fallback.
         */
        expect(new Set(colors).size).toBe(8);
    });

    /**
     * Defect 6. `Settings::default()` is `max_distance: 0.05, force_beta: 0.5`
     * (settings.rs:147); the button wrote 0.01 and 0.3, i.e. an interaction
     * radius a fifth of the real one, and no fresh start ever produces that.
     */
    test('Reset to Defaults writes Settings::default()', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openParticleLife(page);

        // Move two of them first, so the reset has something to undo.
        await page.locator('#friction-slider').fill('0.2');
        await page.locator('#brownian-motion-slider').fill('0.9');

        await page.getByRole('button', { name: 'Reset to Defaults' }).click();

        await expect.poll(async () => (await settingUpdates(page, 'max_force')).at(-1)).toBe(0.5);
        await expect
            .poll(async () => (await settingUpdates(page, 'max_distance')).at(-1))
            .toBe(0.05);
        await expect.poll(async () => (await settingUpdates(page, 'force_beta')).at(-1)).toBe(0.5);
        await expect.poll(async () => (await settingUpdates(page, 'friction')).at(-1)).toBe(0.5);
        await expect
            .poll(async () => (await settingUpdates(page, 'brownian_motion')).at(-1))
            .toBe(0.5);

        await expect(page.locator('.parameter-item').nth(1).locator('.parameter-value')).toHaveText(
            '0.050'
        );
        await expect(page.locator('.parameter-item').nth(2).locator('.parameter-value')).toHaveText(
            '0.50'
        );
    });

    /**
     * The six controls `ParticleLifeModel::update_state` never had an arm for.
     *
     * They stay on `update_simulation_state` — see the note in
     * ParticleLifeMode.svelte for why the write goes where the read is — so what
     * has to be shown is that the *engine* now accepts them. Recording alone
     * would not: the fake logs before the model runs. Reading the value back out
     * of `getState()` does, and `cursor_strength`'s clamp to 10 proves the arm
     * ran rather than a `state[name] = value` fallback.
     */
    test('the state controls reach a model that actually accepts them', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openParticleLife(page);

        await page.locator('#cursorSize').fill('0.8');
        await page.locator('#cursorStrength').fill('10');
        await page.getByLabel('Enable Particle Traces').check();
        await page.locator('#traceFade').fill('0.25');
        await page.locator('select').filter({ hasText: 'Gray18' }).selectOption('Gray18');

        await expect.poll(() => stateUpdates(page, 'cursor_size')).toContain(0.8);
        await expect.poll(() => stateUpdates(page, 'traces_enabled')).toContain(true);
        await expect.poll(() => stateUpdates(page, 'trace_fade')).toContain(0.25);
        await expect.poll(() => stateUpdates(page, 'background_color_mode')).toContain('Gray18');

        // The reset button syncs both documents back out of the engine; the
        // values that survive that round trip are the ones the model kept.
        await page.getByRole('button', { name: 'Regenerate Particles' }).click();
        await expect(page.locator('#traceFade')).toHaveValue('0.25');
        await expect(page.locator('#cursorSize')).toHaveValue('0.8');
    });

    /**
     * The colour-scheme pair, in the shape M4/M5/M7 each found broken in one
     * direction or the other: the name must be written into state *and* the LUT
     * bytes pushed, and reversal must go through the command that re-derives
     * them rather than a bare flag write.
     */
    test('the colour scheme round-trips and reversal pushes a LUT', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openParticleLife(page);

        const before = await commandsNamed(page, 'update_color_scheme');
        await page.locator('.color-scheme-selector select').selectOption({ index: 3 });
        await expect.poll(() => commandsNamed(page, 'update_color_scheme')).toBeGreaterThan(before);
        await expect.poll(async () => (await stateUpdates(page, 'color_scheme')).length).toBe(1);

        const afterApply = await commandsNamed(page, 'update_color_scheme');
        await page.locator('.color-scheme-selector .reverse-btn').click();
        await expect
            .poll(() => commandsNamed(page, 'update_color_scheme'))
            .toBeGreaterThan(afterApply);
    });

    /** The no-engine path: the shell must stay navigable with no WebGPU at all. */
    test('degrades without an engine', async ({ page }) => {
        await page.goto('/');
        // Deliberately no fake engine.
        await page.getByRole('heading', { name: 'Particle Life', exact: true }).click();
        await expect(page.locator('.loading-overlay')).toBeHidden();
        await expect(page.getByRole('button', { name: 'Regenerate Particles' })).toBeVisible();

        // The ceiling still comes from somewhere honest.
        await expect(countBox(page, 'particle')).toHaveAttribute(
            'aria-valuemax',
            String(PARTICLE_COUNT_CAP)
        );

        await page.getByRole('button', { name: '← Back to Menu', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeVisible();
    });
});
