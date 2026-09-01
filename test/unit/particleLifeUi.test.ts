import { describe, it, expect } from 'vitest';
import {
    flipHorizontal,
    flipSign,
    flipVertical,
    rotateClockwise,
    rotateCounterclockwise,
    scaleForceMatrix,
    shiftDown,
    shiftLeft,
    shiftRight,
    shiftUp,
    withPreservedDiagonal,
    zeroMatrix,
    type ReadonlyMatrix,
} from '../../src/lib/engine/sims/particleLife/matrixOperations';
import { registry } from '../../src/lib/rpc/registry';
import { installHandlers } from '../../src/lib/rpc/handlers';
import { invoke } from '../../src/lib/rpc/invoke';
import { setEngineContext } from '../../src/lib/rpc/context';
import { FakeEngine } from '../../src/lib/engine/testing/fakeEngine';
import { PARTICLE_LIFE_CEILING } from '../../src/lib/engine/gpu/limits';

/**
 * M8's UI half: the eleven matrix buttons, and the two commands the seam gained
 * or lost.
 *
 * `particleLife.test.ts` pins `matrixOperations.ts` against the sixteen Rust
 * tests in `matrix_operations.rs`. This file pins the *other* semantics — the
 * ones `InteractionMatrix.svelte` has always had and the Rust never did — so
 * that repointing the component at the shared module cannot silently change
 * what a button does.
 */

/** A matrix whose diagonal is unmistakable and whose off-diagonal cells are all distinct. */
function labelled(n: number): number[][] {
    return Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i === j ? -0.9 : (i * n + j + 1) / 100))
    );
}

/** The diagonal, as a flat list. */
function diagonal(m: ReadonlyMatrix): number[] {
    return m.map((row, i) => row[i]);
}

/**
 * Exactly what `InteractionMatrix.svelte` wrote out eleven times before M8:
 * a fresh n×n matrix whose diagonal is copied and whose every other cell comes
 * from `sourceOf`. Reproduced here as the ground truth for "the shipped
 * behaviour", so the module-plus-wrapper form has something independent to
 * agree with.
 */
function shippedForm(
    original: ReadonlyMatrix,
    sourceOf: (i: number, j: number, n: number) => number
): number[][] {
    const n = original.length;
    return Array.from({ length: n }, (_, i) =>
        Array.from({ length: n }, (_, j) => (i === j ? original[i][i] : sourceOf(i, j, n)))
    );
}

/** The transform each button now runs, paired with the inline form it replaced. */
const BUTTONS: Array<{
    name: string;
    transform: (m: ReadonlyMatrix) => number[][];
    /** The old inline `else` branch, verbatim, for the seven that were right. */
    inline?: (m: ReadonlyMatrix, i: number, j: number, n: number) => number;
}> = [
    {
        name: 'scale down (⬇↓)',
        transform: (m) => scaleForceMatrix(m, 0.8),
        inline: (m, i, j) => Math.max(-1, Math.min(1, m[i][j] * 0.8)),
    },
    {
        name: 'scale up (↑⬆)',
        transform: (m) => scaleForceMatrix(m, 1.2),
        inline: (m, i, j) => Math.max(-1, Math.min(1, m[i][j] * 1.2)),
    },
    {
        name: 'flip horizontal (↔)',
        transform: flipHorizontal,
        inline: (m, i, j, n) => m[i][n - 1 - j],
    },
    {
        name: 'flip vertical (↕)',
        transform: flipVertical,
        inline: (m, i, j, n) => m[n - 1 - i][j],
    },
    {
        name: 'rotate clockwise (↻)',
        transform: rotateClockwise,
        inline: (m, i, j, n) => m[n - 1 - j][i],
    },
    {
        name: 'rotate anticlockwise (↺)',
        transform: rotateCounterclockwise,
        inline: (m, i, j, n) => m[j][n - 1 - i],
    },
    // The four shifts have no `inline` entry on purpose: the old code moved the
    // matrix the opposite way to its own arrow *and* its own dispatched name.
    // See 'the four shift buttons now move the way their arrows point' below.
    { name: 'shift left (←)', transform: shiftLeft },
    { name: 'shift right (→)', transform: shiftRight },
    { name: 'shift up (↑)', transform: shiftUp },
    { name: 'shift down (↓)', transform: shiftDown },
    { name: 'zero (0)', transform: zeroMatrix, inline: () => 0 },
    { name: 'flip sign (±)', transform: flipSign, inline: (m, i, j) => -m[i][j] },
];

describe('the interaction matrix buttons preserve the diagonal', () => {
    for (const { name, transform } of BUTTONS) {
        it(`${name} leaves force_matrix[i][i] alone`, () => {
            for (const n of [2, 3, 4, 5, 8]) {
                const original = labelled(n);
                const result = withPreservedDiagonal(original, transform(original));
                expect(diagonal(result), `n = ${n}`).toEqual(diagonal(original));
            }
        });
    }

    for (const { name, transform, inline } of BUTTONS) {
        if (!inline) continue;
        it(`${name} matches the inline implementation it replaced, cell for cell`, () => {
            for (const n of [2, 3, 4, 5, 8]) {
                const original = labelled(n);
                expect(withPreservedDiagonal(original, transform(original)), `n = ${n}`).toEqual(
                    shippedForm(original, (i, j) => inline(original, i, j, n))
                );
            }
        });
    }

    /**
     * The point of the whole exercise, stated as one assertion.
     *
     * `force_matrix[i][i]` is how species *i* feels about itself, and it is
     * negative in every entry of `Settings::default()` — self-repulsion is what
     * stops a species collapsing to a point. `flip_sign` in the Rust negates it
     * along with everything else, which turns every species into a self-attractor
     * and the field into eight dots. Nobody has ever seen that happen, because
     * the button has never done it.
     */
    it('± does not turn self-repulsion into self-attraction', () => {
        const original = [
            [-0.1, 0.2, -0.1, 0.1],
            [0.2, -0.1, 0.3, -0.1],
            [-0.1, 0.3, -0.1, 0.2],
            [0.1, -0.1, 0.2, -0.1],
        ];

        // The module on its own — the Rust's semantics — flips all sixteen.
        expect(diagonal(flipSign(original))).toEqual([0.1, 0.1, 0.1, 0.1]);

        // As the button runs it, the four self-terms stay repulsive.
        const asShipped = withPreservedDiagonal(original, flipSign(original));
        expect(diagonal(asShipped)).toEqual([-0.1, -0.1, -0.1, -0.1]);
        expect(asShipped[0][1]).toBe(-0.2);
        expect(asShipped[1][2]).toBe(-0.3);
    });

    it('scaling cannot scale the diagonal away', () => {
        const original = labelled(4);
        for (const factor of [0.8, 1.2, 0, 5]) {
            const scaled = withPreservedDiagonal(original, scaleForceMatrix(original, factor));
            expect(diagonal(scaled), `factor ${factor}`).toEqual(diagonal(original));
        }
    });

    /**
     * The four shifts were inverted: "Shift matrix left" (←) computed
     * `new[i][j] = old[i][j - 1]`, sliding every column one place *right*, while
     * dispatching `type: 'shiftLeft'` — the component disagreed with itself.
     * The pairs are exact inverses, so nothing became unreachable; the arrow now
     * points the way the matrix moves.
     */
    it('the four shift buttons now move the way their arrows point', () => {
        const original = labelled(4);

        // ← takes column j+1 into column j.
        const left = withPreservedDiagonal(original, shiftLeft(original));
        expect(left[0][1]).toBe(original[0][2]);
        expect(left[0][2]).toBe(original[0][3]);

        // → is the mirror image: column j-1 into column j.
        const right = withPreservedDiagonal(original, shiftRight(original));
        expect(right[0][2]).toBe(original[0][1]);
        expect(right[0][3]).toBe(original[0][2]);

        // ↑ takes row i+1 into row i, ↓ the reverse.
        const up = withPreservedDiagonal(original, shiftUp(original));
        expect(up[0][1]).toBe(original[1][1]);
        expect(up[1][0]).toBe(original[2][0]);

        const down = withPreservedDiagonal(original, shiftDown(original));
        expect(down[1][0]).toBe(original[0][0]);
        expect(down[2][0]).toBe(original[1][0]);
    });

    /**
     * Holding the diagonal makes every one of the eleven **lossy**, and the
     * shift pairs are where a user meets it: pressing ← then → does not give
     * back the matrix you started with, because the diagonal cell that was
     * carried into a neighbouring column on the way out is not carried back.
     *
     * That is not a defect introduced here — it is a direct consequence of the
     * behaviour the panel advertises, and the inline code had it too. It is
     * pinned so that the next reader who assumes these buttons undo each other
     * finds a test saying otherwise rather than an editor's worth of tuning
     * quietly gone.
     */
    it('the pairs are not exact inverses, because the diagonal is held', () => {
        const original = labelled(4);
        const left = withPreservedDiagonal(original, shiftLeft(original));
        const back = withPreservedDiagonal(left, shiftRight(left));

        expect(back).not.toEqual(original);
        // The diagonal survives; the cell it displaced does not.
        expect(diagonal(back)).toEqual(diagonal(original));
        expect(back[0][1]).toBe(original[0][0]);

        // Raw, without the wrapper, the module's own pair *is* an involution —
        // that is what `particleLife.test.ts` asserts against the Rust.
        expect(shiftRight(shiftLeft(original))).toEqual(original);
    });

    /**
     * The species count runs 2..8, but the matrix is briefly empty during a
     * sync and `withPreservedDiagonal` must not reach past either array.
     */
    it('survives the degenerate shapes', () => {
        expect(withPreservedDiagonal([], [])).toEqual([]);
        expect(withPreservedDiagonal([[0.4]], flipSign([[0.4]]))).toEqual([[0.4]]);
        // A transform that changes the shape (a rotation of a rectangle)
        // restores only the cells that exist on both diagonals.
        const wide: number[][] = [
            [1, 2, 3],
            [4, 5, 6],
        ];
        // rotateClockwise gives [[4,1],[5,2],[6,3]]; cells [0][0] and [1][1]
        // are on both diagonals and come back from the original, [2][2] does
        // not exist in a 2-row input and is left as the rotation produced it.
        expect(withPreservedDiagonal(wide, rotateClockwise(wide))).toEqual([
            [1, 1],
            [5, 5],
            [6, 3],
        ]);
    });

    /** Pure in, pure out: the component reassigns `force_matrix` to get reactivity. */
    it('does not mutate its arguments', () => {
        const original = labelled(3);
        const copy = original.map((row) => [...row]);
        const transformed = flipSign(original);
        withPreservedDiagonal(original, transformed);
        expect(original).toEqual(copy);
    });
});

/**
 * The command surface, with the **real handlers installed** over the stubs.
 *
 * `registry.test.ts` deliberately does not install them — it is checking that
 * the stub baseline covers every call site — so a `register()` that should not
 * exist is invisible there. These assertions need the installed table.
 */
describe('the Particle Life command surface', () => {
    installHandlers();

    /**
     * `update_particle_life_setting` was the ± button's own command and was
     * broken three ways at once: no `#[tauri::command]` of that name is in
     * `main.rs`'s `generate_handler!` list, the argument went under `setting`
     * rather than `settingName` so the handler read `undefined`, and the event
     * it dispatched carried no `matrix` for the parent to destructure. Its ten
     * siblings never needed it.
     */
    it('has no update_particle_life_setting, as a stub or as a handler', () => {
        expect(registry.has('update_particle_life_setting')).toBe(false);
    });

    /**
     * "Clear Trails" was a stub resolving `null`, and the mode then logged
     * success. It must reach `clearTrails()` — and specifically *not*
     * `resetRuntimeState()`, which for Particle Life draws a fresh seed and
     * re-runs `init.wgsl` over the whole pool, i.e. does what the neighbouring
     * "Regenerate Particles" button is for.
     */
    it('routes clear_trail_texture to clearTrails, not to a particle respawn', async () => {
        const engine = new FakeEngine();
        setEngineContext(engine);
        try {
            await engine.start('particle_life');
            await invoke('clear_trail_texture');

            const commands = engine.log.map((entry) => entry.command);
            expect(commands).toContain('clear_trails');
            expect(commands).not.toContain('reset_runtime_state');
            expect(commands).not.toContain('reset_simulation');
        } finally {
            setEngineContext(null);
        }
    });

    /**
     * With no engine there is no adapter to ask, and the honest answer is the
     * constant — which on every device meeting the WebGPU spec minimums is also
     * what the engine would say, since the two device-derived bounds inside
     * `particleLifeCap` only bind far below them.
     */
    it('answers get_particle_count_limit with the compute ceiling when no engine booted', async () => {
        await expect(invoke('get_particle_count_limit')).resolves.toBe(PARTICLE_LIFE_CEILING);
    });

    it('answers get_particle_count_limit from the device when one booted', async () => {
        const engine = new FakeEngine();
        setEngineContext(engine);
        try {
            await expect(invoke('get_particle_count_limit')).resolves.toBe(
                engine.caps().particleLife
            );
        } finally {
            setEngineContext(null);
        }
    });
});
