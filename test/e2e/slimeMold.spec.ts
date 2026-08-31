import { test, expect, type ConsoleMessage, type Page } from '@playwright/test';

/**
 * M7 — Slime Mold, at the DOM layer.
 *
 * Same shape as grayScott.spec.ts and for the same reason: Playwright's
 * launcher makes `navigator.gpu` undefined regardless of flags, so nothing here
 * can look at a rendered pixel. What this layer covers is that the menu mounts,
 * that the loading overlay lifts, that each class of control reaches the engine,
 * and the four defects this milestone exists to pin:
 *
 *   1. the **agent-count ceiling** — the headline risk. 10 M agents at a
 *      16-byte stride is 160 MB against a 128 MiB `maxStorageBufferBindingSize`
 *      and the desktop UI offered a hundred million. A browser does not reject
 *      that, it loses the device;
 *   2. the **position-generator spelling**, which listed serde's
 *      `'UniformCircle'` against the `'Uniform Circle'` the backend emits and
 *      accepts — the M4 mask-enum bug, in a different control;
 *   3. the **colour-scheme round trip**, broken here in the opposite direction
 *      from M4's and M5's: the name was written to state and the LUT never
 *      pushed;
 *   4. **teardown**, where an fps listener subscribed at the end of a long
 *      `onMount` chain outlived the component.
 *
 * The engine under the controls is `$lib/engine/testing/fakeEngine`, which
 * carries Slime Mold's real settings *and state* models, so `getState()`
 * canonicalises the three enums exactly as the ported simulation does.
 */

/** The one console error a GPU-less browser is expected to produce. */
const EXPECTED_ERROR = /WebGPU|GPU adapter|secure context|No available adapters/i;

/**
 * `slimeMoldAgentCap(64 MiB)` — the fake engine deliberately reports a smaller
 * device than the reference one so that this number differs from the
 * spec-minimum fallback below. A control reading its ceiling from the engine
 * shows this; one that hardcoded a constant would show the other.
 */
const FAKE_DEVICE_CAP = 3_774_873;

/** `slimeMoldAgentCap(128 MiB)` — what the registry stub answers with no engine. */
const SPEC_MINIMUM_CAP = 7_549_747;

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

/** Open the mode and wait for it to become *interactive*. */
async function openSlimeMold(page: Page): Promise<void> {
    await page.getByRole('heading', { name: 'Slime Mold', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeHidden();
    // The overlay swallows every pointer event including "Back to Menu", so a
    // mode that never clears it is bricked rather than merely blank.
    await expect(page.locator('.loading-overlay')).toBeHidden();
    await expect(page.getByRole('button', { name: /Clear Trails/ })).toBeVisible();
}

/** The `.setting-item` wrapping one labelled NumberDragBox. */
function settingRow(page: Page, label: string) {
    return page.locator('.setting-item').filter({ has: page.getByText(label, { exact: true }) });
}

function settingValue(page: Page, label: string) {
    return settingRow(page, label).locator('.value-display');
}

function settingButton(page: Page, label: string, direction: 'increment' | 'decrement') {
    return settingRow(page, label).locator(`.step-button.${direction}`);
}

/** The preset fieldset's select — it has no label of its own. */
function presetSelect(page: Page) {
    return page
        .locator('fieldset')
        .filter({ has: page.getByRole('button', { name: 'Save Current Settings' }) })
        .locator('select');
}

function colorSchemeSelect(page: Page) {
    return page.locator('.color-scheme-selector select');
}

function positionGeneratorSelect(page: Page) {
    return page.locator('.button-select select');
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

/**
 * Force a full state re-read from the engine.
 *
 * The cursor slider is the cheapest handle on `syncState()` that does not also
 * change what is being asserted: `updateCursorSize` finishes with
 * `updateStateOptimistic(..., shouldSync = true)`. Slime Mold applies no preset
 * on mount, so unlike Gray-Scott a preset is not the natural lever here.
 */
async function forceStateSync(page: Page): Promise<void> {
    await page.locator('#cursorSize').fill('250');
    await expect.poll(() => stateUpdates(page, 'cursor_size')).toContain(250);
}

test.describe('slime mold mode', () => {
    test('mounts its menu with no unexpected console output', async ({ page }) => {
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await installFakeEngine(page);
        await openSlimeMold(page);

        // Give the mount's async chain — start, presets, colour schemes, the
        // agent-count limit, and the three syncs — time to settle.
        await page.waitForTimeout(500);

        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });

    test('renders its fieldsets and Settings::default() values', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openSlimeMold(page);

        for (const legend of [
            'About this simulation',
            'Presets',
            'Display Settings',
            'Controls',
            'Settings',
        ]) {
            await expect(page.getByRole('group').filter({ hasText: legend }).first()).toBeVisible();
        }

        // slime_mold/settings.rs:166. Note the three pheromone rates: the doc
        // comments in the Rust claim 1.0/1.0/1.0 and the code says 10/100/100.
        await expect(settingValue(page, 'Decay Rate:')).toHaveText('10%');
        await expect(settingValue(page, 'Deposition Rate:')).toHaveText('100%');
        await expect(settingValue(page, 'Diffusion Rate:')).toHaveText('100%');
        await expect(settingValue(page, 'Min Speed:')).toHaveText('30');
        await expect(settingValue(page, 'Max Speed:')).toHaveText('60');
        await expect(settingValue(page, 'Jitter:')).toHaveText('0.04');
        await expect(settingValue(page, 'Sensor Distance:')).toHaveText('20');
        // Stored in radians, shown in degrees: 0.43 rad and 0.3 rad.
        await expect(settingValue(page, 'Turn Rate:')).toHaveText('25°');
        await expect(settingValue(page, 'Sensor Angle:')).toHaveText('17°');
    });

    test('drag boxes round-trip through update_simulation_setting', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openSlimeMold(page);
        await expect(settingValue(page, 'Decay Rate:')).toHaveText('10%');

        await settingButton(page, 'Decay Rate:', 'increment').click();
        await settingButton(page, 'Sensor Distance:', 'decrement').click();

        await expect(settingValue(page, 'Decay Rate:')).toHaveText('11%');
        await expect(settingValue(page, 'Sensor Distance:')).toHaveText('19');

        await expect.poll(() => settingUpdates(page, 'pheromone_decay_rate')).toEqual([11]);
        await expect.poll(() => settingUpdates(page, 'agent_sensor_distance')).toEqual([19]);
    });

    /**
     * Regression for the two angle boxes, which each carried *two* `on:change`
     * directives: one writing `settings!.agent_turn_rate` and one invoking, with
     * the degrees-to-radians conversion spelled out separately in both. Svelte
     * runs both handlers, so it worked — but only as long as nobody edited one
     * of the two copies.
     */
    test('the angle boxes convert degrees to radians exactly once', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openSlimeMold(page);

        await settingButton(page, 'Turn Rate:', 'increment').click();
        await settingButton(page, 'Sensor Angle:', 'decrement').click();

        // The box steps by one *degree*, so the value that reaches the engine
        // is the old radian value plus (or minus) exactly pi/180 — not the
        // rounded 25 or 17 the display shows.
        await expect
            .poll(async () => (await settingUpdates(page, 'agent_turn_rate')).at(-1))
            .toBeCloseTo(0.43 + Math.PI / 180, 9);
        await expect
            .poll(async () => (await settingUpdates(page, 'agent_sensor_angle')).at(-1))
            .toBeCloseTo(0.3 - Math.PI / 180, 9);

        await expect(settingValue(page, 'Turn Rate:')).toHaveText('26°');
        await expect(settingValue(page, 'Sensor Angle:')).toHaveText('16°');
    });

    test('the action buttons reach the engine', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openSlimeMold(page);

        await page.getByRole('button', { name: /Randomize Settings/ }).click();
        await expect
            .poll(async () =>
                (await engineLog(page)).some((entry) => entry.command === 'randomize_settings')
            )
            .toBe(true);

        // "Clear Trails" is Slime Mold's runtime-state reset: the Rust routes
        // reset_runtime_state straight to reset_trails (simulation.rs:2766), so
        // the two are one operation rather than two that happen to agree.
        await page.getByRole('button', { name: /Clear Trails/ }).click();
        await expect
            .poll(async () =>
                (await engineLog(page)).some((entry) => entry.command === 'reset_runtime_state')
            )
            .toBe(true);

        // "Reset Agents" re-seeds the pool *and* blanks what it left behind, so
        // both commands have to arrive.
        await page.getByRole('button', { name: 'Reset Agents' }).click();
        await expect
            .poll(
                async () =>
                    (await engineLog(page)).filter((entry) => entry.command === 'reset_agents')
                        .length
            )
            .toBe(1);
    });

    /**
     * Regression for the position generator's spelling.
     *
     * `SlimeMoldMode.svelte:127` listed serde's `'UniformCircle'` and
     * `'CenteredCircle'`, while `get_state` emits `as_str()` — i.e.
     * `'Uniform Circle'` — and `from_str` accepts nothing else. So after any
     * state sync the select showed its disabled placeholder, and the value it
     * sent parsed as `None`, which `update_setting`'s fallback
     * (simulation.rs:1450) turns into a silent reset to Random. It also sent it
     * on the wrong command: `update_state` has no `position_generator` arm at
     * all, so on the desktop the control does nothing whatsoever and the Image
     * generator — with its own file picker — is unreachable.
     */
    test('the position generator uses the engine spelling and survives a sync', async ({
        page,
    }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openSlimeMold(page);

        const generator = positionGeneratorSelect(page);
        await expect(generator.locator('option:not([disabled])')).toHaveText([
            'Random',
            'Center',
            'Uniform Circle',
            'Centered Circle',
            'Ring',
            'Line',
            'Spiral',
            'Image',
        ]);
        await expect(generator).toHaveValue('Random');

        await generator.selectOption('Uniform Circle');
        await expect
            .poll(() => stateUpdates(page, 'position_generator'))
            .toEqual(['Uniform Circle']);

        // The value now comes back from the engine rather than from the
        // optimistic local write, which is where the desktop build fell over.
        await forceStateSync(page);
        await expect(generator).toHaveValue('Uniform Circle');
    });

    /**
     * The mask enums, unlike Gray-Scott's, were *already* right — `get_state`
     * emits `as_str()`, which is the display spelling these options use. Pinned
     * anyway, because the option lists now come from the engine rather than
     * being retyped here, and this is what proves the two agree.
     */
    test('the mask selectors survive a state sync', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openSlimeMold(page);

        const pattern = page.locator('#sm-mask-pattern');
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
        const target = page.locator('#sm-mask-target');
        await expect(target).toBeVisible();
        // Seven, not Gray-Scott's five.
        await expect(target.locator('option')).toHaveCount(7);
        await expect(target).toHaveValue('Pheromone Deposition');

        await target.selectOption('Trail Map');
        await forceStateSync(page);

        await expect(pattern).toHaveValue('Diagonal Gradient');
        await expect(target).toHaveValue('Trail Map');
        // The placeholder <option> is rendered only when the value matches no
        // option, so its absence is the assertion that matters here.
        await expect(pattern.locator('option[disabled]')).toHaveCount(0);
        await expect(target.locator('option[disabled]')).toHaveCount(0);

        await expect.poll(() => stateUpdates(page, 'mask_pattern')).toEqual(['Diagonal Gradient']);
        await expect.poll(() => stateUpdates(page, 'mask_target')).toEqual(['Trail Map']);
    });

    test('the mask sub-controls round-trip through update_simulation_state', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openSlimeMold(page);

        await page.locator('#sm-mask-pattern').selectOption('Checkerboard');
        await settingButton(page, 'Strength:', 'increment').click();
        await settingButton(page, 'Mask Curve:', 'decrement').click();
        await page.getByText('Mirror horizontal').click();
        await page.getByText('Invert tone').click();

        await expect.poll(() => stateUpdates(page, 'mask_strength')).toEqual([0.51]);
        await expect.poll(() => stateUpdates(page, 'mask_curve')).toEqual([0.95]);
        await expect.poll(() => stateUpdates(page, 'mask_mirror_horizontal')).toEqual([true]);
        await expect.poll(() => stateUpdates(page, 'mask_invert_tone')).toEqual([true]);

        // Cursor strength goes through the same command via the shared panel.
        await page.locator('#cursorStrength').fill('12');
        await expect.poll(() => stateUpdates(page, 'cursor_strength')).toEqual([12]);
    });

    /**
     * The milestone's headline risk.
     *
     * The desktop control was `min={0} max={100}` **in millions** — a hundred
     * million agents, 1.6 GB in one storage buffer against a 128 MiB
     * `maxStorageBufferBindingSize` (WEB_PORT.md, "Buffer budget"). Requesting
     * that in a browser does not fail politely; it loses the GPU device, taking
     * every simulation on the page with it. Nothing in the Rust clamps either:
     * `update_agent_count` assigns `count as usize` straight through.
     *
     * Three things are asserted, and the third is as important as the other
     * two. The ceiling is visible *before* anything goes wrong; an over-large
     * request is reduced rather than refused; and the user is told, in exact
     * agents, what they got instead — a user who types 10 and silently receives
     * 3.7 files a bug.
     */
    test('the agent-count box shows the device ceiling and clamps to it', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openSlimeMold(page);

        const box = page.locator('#sm-agent-count');
        await box.scrollIntoViewIfNeeded();

        // 1 M, not the desktop's 10 M (SLIME_MOLD_DEFAULT_AGENTS).
        await expect(box).toHaveValue('1');

        // The ceiling is on screen unprompted, and it is the *device's* — the
        // fake reports a 64 MiB binding size precisely so this number differs
        // from the no-engine fallback a hardcoded control would show.
        await expect(
            page.getByText(`Device limit: ${FAKE_DEVICE_CAP.toLocaleString('en-US')}`)
        ).toBeVisible();
        expect(FAKE_DEVICE_CAP).not.toBe(SPEC_MINIMUM_CAP);

        // The maximum the number input itself advertises, in millions, rounded
        // down so the 0.1 step can never land above the cap.
        await expect(box).toHaveAttribute('max', '3.7');

        await box.fill('10');
        await page.getByRole('button', { name: 'Update', exact: true }).click();

        // Reduced, not rejected: no error, and a message naming the exact count.
        await expect(
            page.getByText(`using ${FAKE_DEVICE_CAP.toLocaleString('en-US')} agents`)
        ).toBeVisible();
        await expect(box).toHaveValue(String(FAKE_DEVICE_CAP / 1_000_000));

        // And the clamped value is what actually reached the engine.
        await expect
            .poll(async () =>
                (await engineLog(page))
                    .filter((entry) => entry.command === 'set_agent_count')
                    .map((entry) => (entry.args as { count: number }).count)
            )
            .toEqual([FAKE_DEVICE_CAP]);

        // A value inside the cap passes through untouched, and the notice goes
        // away rather than lingering as a warning about a request since revised.
        await box.fill('2');
        await page.getByRole('button', { name: 'Update', exact: true }).click();
        await expect(page.getByText('is more than this device can bind')).toHaveCount(0);
        await expect
            .poll(async () =>
                (await engineLog(page))
                    .filter((entry) => entry.command === 'set_agent_count')
                    .map((entry) => (entry.args as { count: number }).count)
            )
            .toEqual([FAKE_DEVICE_CAP, 2_000_000]);
    });

    test('lists the thirteen built-in presets and applies one', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openSlimeMold(page);

        // Transcribed from slime_mold/mod.rs:17 — thirteen, in registration
        // order, starting with a plain `Settings::default()` named "Default".
        // (Gray-Scott's ninth entry is *called* "Custom"; nothing appends one.)
        await expect(presetSelect(page).locator('option:not([disabled])')).toHaveText([
            'Default',
            'Gloop Loops',
            'Firecracker Trees',
            'Threads',
            'Snake',
            'Cells',
            'Net',
            'Bars',
            'Healthy Fungus',
            'Sand On A Speaker',
            'Spots',
            'Cascades',
            'Venom',
        ]);

        await presetSelect(page).selectOption('Gloop Loops');
        await expect(settingValue(page, 'Decay Rate:')).toHaveText('100%');
        await expect(settingValue(page, 'Max Speed:')).toHaveText('300');
        await expect(settingValue(page, 'Sensor Distance:')).toHaveText('5');
        // A field the preset does not name comes from the defaults, not from
        // whatever the previous preset left behind.
        await expect(settingValue(page, 'Min Speed:')).toHaveText('30');
    });

    /**
     * Regression for `current_color_scheme` being *written* but never applied.
     *
     * Gray-Scott and Vectors had the mirror image of this bug: they called only
     * `apply_color_scheme_by_name`, which pushes LUT bytes without writing the
     * name, so the selection reverted on the next sync. Slime Mold called only
     * `update_simulation_state`, which writes the name and pushes nothing — the
     * control looked correct and the picture never changed, which is the harder
     * half of the pair to notice. Both calls are needed, and the sync at the end
     * is what makes the assertion meaningful.
     */
    test('the colour scheme round-trips into simulation state', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openSlimeMold(page);

        const schemes = colorSchemeSelect(page);
        await expect(schemes).toHaveValue('MATPLOTLIB_prism');

        await schemes.selectOption('ZELDA_Glass');
        await expect(schemes).toHaveValue('ZELDA_Glass');
        await expect
            .poll(() => stateUpdates(page, 'current_color_scheme'))
            .toEqual(['ZELDA_Glass']);
        // The LUT bytes, not just the name.
        await expect
            .poll(async () =>
                (await engineLog(page)).some((entry) => entry.command === 'update_color_scheme')
            )
            .toBe(true);

        // Reversing is the same pair the other way round: it must reach the
        // colour-scheme command, because a bare state write pushes no bytes.
        const before = (await engineLog(page)).filter(
            (entry) => entry.command === 'update_color_scheme'
        ).length;
        await page.getByRole('button', { name: 'Reverse' }).click();
        await expect
            .poll(
                async () =>
                    (await engineLog(page)).filter(
                        (entry) => entry.command === 'update_color_scheme'
                    ).length
            )
            .toBe(before + 1);
        await expect(schemes).toHaveValue('ZELDA_Glass');
    });

    /**
     * Slime Mold is the only simulation with two image inputs, which is why
     * `EngineContext.loadImage` carries a slot at all. Both used to fall
     * through to the registry stub, which resolves `null`: the user picked a
     * file and nothing happened, with no error anywhere.
     */
    test('the position image loads into the position slot', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openSlimeMold(page);

        await positionGeneratorSelect(page).selectOption('Image');

        // settings.rs:179 — FitV, which is *not* ImageFitMode::default().
        const fitMode = page.locator('.image-selector select');
        await expect(fitMode).toHaveValue('Fit V');
        await fitMode.selectOption('Center');
        await expect
            .poll(() => settingUpdates(page, 'position_image_fit_mode'))
            .toEqual(['Center']);

        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Choose File…' }).click();
        await (await chooser).setFiles(onePixelPng('spores.png'));

        await expect
            .poll(async () =>
                (await engineLog(page)).find((entry) => entry.command === 'load_image')
            )
            .toMatchObject({ args: { name: 'spores.png', slot: 'position' } });
    });

    test('the mask image loads into the mask slot', async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openSlimeMold(page);

        await page.locator('#sm-mask-pattern').selectOption('Image');

        // Webcam is an omitted feature of the port, so its permanently-greyed
        // Start button was removed rather than left to advertise nothing.
        await expect(page.getByText('Webcam:')).toHaveCount(0);

        const fitMode = page.locator('.image-selector select');
        await expect(fitMode).toHaveValue('Stretch');
        await fitMode.selectOption('Fit H');
        await expect.poll(() => stateUpdates(page, 'mask_image_fit_mode')).toEqual(['Fit H']);

        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Choose File…' }).click();
        await (await chooser).setFiles(onePixelPng('mask.png'));

        await expect
            .poll(async () =>
                (await engineLog(page)).find((entry) => entry.command === 'load_image')
            )
            .toMatchObject({ args: { name: 'mask.png', slot: 'mask' } });
    });

    test('degrades to a navigable page when there is no engine at all', async ({ page }) => {
        // No fake engine: exactly what a browser without WebGPU sees. This path
        // works *because* hasEngineContext() is false, which is a different
        // code path from the ported simulation — both have to stay alive.
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await page.getByRole('heading', { name: 'Slime Mold', exact: true }).click();

        // The loading overlay swallows pointer events, so if it never clears,
        // "Back to Menu" is unreachable and the app is bricked, not degraded.
        await expect(page.locator('button.ui-button', { hasText: 'Back to Menu' })).toBeVisible();

        // With no adapter to ask, the ceiling falls back to what every
        // conformant WebGPU implementation must grant — conservative, never
        // optimistic, and never the desktop's unbounded 100 M.
        await expect(
            page.getByText(`Device limit: ${SPEC_MINIMUM_CAP.toLocaleString('en-US')}`)
        ).toBeVisible();

        await page.locator('button.ui-button', { hasText: 'Back to Menu' }).click();
        await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeVisible();

        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });

    /**
     * Teardown, which M6 showed is where the quiet failures live.
     *
     * `onMount` is one long await chain and `listen('fps-update')` used to sit
     * at the end of it, so leaving the mode before it resolved registered a
     * listener that `onDestroy` had already finished looking for. It then wrote
     * `currentFps` into a destroyed component for the life of the page. Going
     * in and straight back out, repeatedly, is what surfaces that — and any
     * command that reaches the engine after the simulation is gone, since
     * `requireSimulation()` throws rather than no-oping.
     */
    test('navigating away mid-mount leaves nothing behind', async ({ page }) => {
        const unexpected = collectUnexpected(page);

        await page.goto('/');
        await installFakeEngine(page);

        for (let i = 0; i < 3; i++) {
            await page.getByRole('heading', { name: 'Slime Mold', exact: true }).click();
            await page.locator('button.ui-button', { hasText: 'Back to Menu' }).click();
            await expect(page.getByRole('heading', { name: 'Vizza', level: 1 })).toBeVisible();
        }

        await page.waitForTimeout(500);
        expect(unexpected, unexpected.join('\n')).toEqual([]);
    });
});

test.describe('slime mold — navigation affordances', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        await installFakeEngine(page);
        await openSlimeMold(page);
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
        await page.locator('.simulation-container').hover({ position: FIELD });
        await page.mouse.wheel(0, -240);

        await expect
            .poll(async () =>
                (await engineLog(page)).some((e) => e.command === 'zoom_camera_to_cursor')
            )
            .toBe(true);
    });

    /**
     * "Left click: Attract agents" is what the control panel promises about the
     * mouse. A press *and* a release, because the mode tracks `isMousePressed`
     * itself and a missed mouseup leaves the cursor attracting forever.
     */
    test('clicking the field attracts agents and releases', async ({ page }) => {
        await page.locator('.simulation-container').click({ position: FIELD });

        await expect
            .poll(async () =>
                (await engineLog(page)).map((e) => e.command).filter((c) => c.startsWith('handle_'))
            )
            .toEqual(['handle_mouse_interaction', 'handle_mouse_release']);
    });
});

/** A 1x1 PNG, so the picker has something real to hand over. */
function onePixelPng(name: string) {
    return {
        name,
        mimeType: 'image/png',
        buffer: Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
            'base64'
        ),
    };
}
