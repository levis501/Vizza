import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    MATRIX_GENERATORS,
    createRng,
    generateForceMatrix,
    parseMatrixGenerator,
    type MatrixGenerator,
} from '../../src/lib/engine/sims/particleLife/matrix';
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
    zeroMatrix,
} from '../../src/lib/engine/sims/particleLife/matrixOperations';

const ROOT = resolve(__dirname, '../..');
const PARTICLE_LIFE = join(ROOT, 'src-tauri/src/simulations/particle_life');

/** Species counts the desktop app can reach (`clamp(2, 8)`) plus both degenerate ends. */
const SIZES = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** The `#[cfg(test)] create_test_matrix` helper, matrix_operations.rs:134. */
function createTestMatrix(size: number): number[][] {
    return Array.from({ length: size }, (_, i) =>
        Array.from({ length: size }, (_, j) => (i === j ? -0.1 : (i * size + j) * 0.01))
    );
}

/** The Rust's `matrices_equal`, as an assertion. */
function expectMatricesEqual(a: number[][], b: number[][], tolerance = 0.001) {
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
        expect(a[i].length).toBe(b[i].length);
        for (let j = 0; j < a[i].length; j++) {
            expect(Math.abs(a[i][j] - b[i][j])).toBeLessThanOrEqual(tolerance);
        }
    }
}

/** Every entry, flattened — most structural assertions are over one of these. */
function entries(m: number[][]): number[] {
    return m.flat();
}

/** Run `fn` against a spread of seeds, so a bound is checked over the whole draw space. */
function overSeeds<T>(count: number, fn: (rng: () => number, seed: number) => T): T[] {
    return Array.from({ length: count }, (_, k) => fn(createRng(k * 7919 + 1), k));
}

// ---------------------------------------------------------------------------
// The enum
// ---------------------------------------------------------------------------

describe('MatrixGenerator', () => {
    /**
     * Pinned against the Rust rather than transcribed, because the order is
     * load-bearing twice over: it is the order the UI's picker cycles through,
     * and a preset stores the *name*, so a renamed variant silently falls back
     * to `Random`.
     */
    it('lists all 22 variants in settings.rs declaration order', () => {
        const source = readFileSync(join(PARTICLE_LIFE, 'settings.rs'), 'utf8');
        const body = /pub enum MatrixGenerator \{([^}]*)\}/.exec(source);
        if (body === null) throw new Error('MatrixGenerator enum not found in settings.rs');
        const variants = body[1]
            .split('\n')
            .map((line) => line.replace(/\/\/.*$/, '').trim())
            .filter((line) => line.endsWith(','))
            .map((line) => line.slice(0, -1));

        expect(variants).toHaveLength(22);
        expect([...MATRIX_GENERATORS]).toEqual(variants);
    });

    it('parses known names and falls back to Random, as simulation.rs:3577 does', () => {
        for (const name of MATRIX_GENERATORS) expect(parseMatrixGenerator(name)).toBe(name);
        expect(parseMatrixGenerator('NotAGenerator')).toBe('Random');
        expect(parseMatrixGenerator('random')).toBe('Random');
        expect(parseMatrixGenerator(undefined)).toBe('Random');
        expect(parseMatrixGenerator(7)).toBe('Random');
    });
});

describe('createRng', () => {
    it('is deterministic and stays inside [0, 1)', () => {
        const a = Array.from({ length: 500 }, createRng(12345));
        // A fresh generator on the same seed must replay the same stream.
        const first = createRng(12345);
        const second = createRng(12345);
        expect(Array.from({ length: 20 }, () => first())).toEqual(
            Array.from({ length: 20 }, () => second())
        );
        expect(a.length).toBe(500);

        const draws = Array.from({ length: 5000 }, createRng(99));
        for (const v of draws) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
        // Loose uniformity check — enough to catch a stuck or biased stream.
        const mean = draws.reduce((s, v) => s + v, 0) / draws.length;
        expect(mean).toBeGreaterThan(0.45);
        expect(mean).toBeLessThan(0.55);
    });

    it('does not collapse on hostile seeds', () => {
        for (const seed of [0, -1, 1.5, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
            const rng = createRng(seed);
            const draws = Array.from({ length: 10 }, rng);
            for (const v of draws) expect(Number.isFinite(v)).toBe(true);
            expect(new Set(draws).size).toBeGreaterThan(1);
        }
    });
});

// ---------------------------------------------------------------------------
// The contract every generator owes
// ---------------------------------------------------------------------------

describe('generateForceMatrix contract', () => {
    it('returns a finite speciesCount × speciesCount matrix in [-1, 1], for all 22 × all sizes', () => {
        for (const generator of MATRIX_GENERATORS) {
            for (const n of SIZES) {
                for (let seed = 0; seed < 12; seed++) {
                    const m = generateForceMatrix(generator, n, createRng(seed));
                    expect(m).toHaveLength(n);
                    for (const row of m) {
                        expect(row).toHaveLength(n);
                        for (const value of row) {
                            expect(Number.isFinite(value)).toBe(true);
                            expect(value).toBeGreaterThanOrEqual(-1);
                            expect(value).toBeLessThanOrEqual(1);
                        }
                    }
                }
            }
        }
    });

    it('is deterministic: the same seed gives the same matrix', () => {
        for (const generator of MATRIX_GENERATORS) {
            const a = generateForceMatrix(generator, 8, createRng(4242));
            const b = generateForceMatrix(generator, 8, createRng(4242));
            expect(a).toEqual(b);
        }
    });

    it('actually consumes the rng — every stochastic generator varies with the seed', () => {
        // PredatorPrey and RockPaperScissors are pure functions of the index
        // pair in the Rust and draw nothing, so they are excluded by name
        // rather than by a loose "most of them differ" threshold.
        const deterministic: MatrixGenerator[] = ['PredatorPrey', 'RockPaperScissors'];
        for (const generator of MATRIX_GENERATORS) {
            const a = generateForceMatrix(generator, 6, createRng(1));
            const b = generateForceMatrix(generator, 6, createRng(2));
            if (deterministic.includes(generator)) expect(a).toEqual(b);
            else expect(a).not.toEqual(b);
        }
    });

    it('defaults to Math.random when no rng is supplied', () => {
        const a = generateForceMatrix('Random', 8);
        const b = generateForceMatrix('Random', 8);
        expect(a).toHaveLength(8);
        expect(a).not.toEqual(b);
    });

    it('yields an empty matrix for a count that is not a usable species count', () => {
        for (const bad of [0, -3, NaN, Infinity, -Infinity]) {
            for (const generator of MATRIX_GENERATORS) {
                expect(generateForceMatrix(generator, bad, createRng(0))).toEqual([]);
            }
        }
        // Fractional counts floor rather than producing a ragged matrix.
        expect(generateForceMatrix('Random', 3.9, createRng(0))).toHaveLength(3);
    });

    it('never leaves a NaN behind at speciesCount 1, where several formulas divide by n-1', () => {
        for (const generator of MATRIX_GENERATORS) {
            const m = generateForceMatrix(generator, 1, createRng(0));
            expect(m).toHaveLength(1);
            expect(Number.isFinite(m[0][0])).toBe(true);
        }
    });
});

// ---------------------------------------------------------------------------
// What each generator is *for*
// ---------------------------------------------------------------------------

describe('generator structure', () => {
    it('Random spreads over the whole range and is not symmetric', () => {
        const m = generateForceMatrix('Random', 8, createRng(3));
        const flat = entries(m);
        expect(Math.min(...flat)).toBeLessThan(-0.5);
        expect(Math.max(...flat)).toBeGreaterThan(0.5);
        expect(m[0][1]).not.toBeCloseTo(m[1][0], 6);
    });

    /** The seven generators whose Rust comment claims "Maintain symmetry". */
    const SYMMETRIC: MatrixGenerator[] = [
        'Symmetry',
        'Symbiosis',
        'Magnetic',
        'Crystal',
        'Wave',
        'Cooperation',
        'Competition',
    ];

    it('the symmetric generators are symmetric exactly, not to a tolerance', () => {
        for (const generator of SYMMETRIC) {
            for (let seed = 0; seed < 25; seed++) {
                const m = generateForceMatrix(generator, 8, createRng(seed));
                for (let i = 0; i < 8; i++) {
                    for (let j = 0; j < 8; j++) {
                        expect(m[i][j]).toBe(m[j][i]);
                    }
                }
            }
        }
    });

    it('every generator repels a species from itself', () => {
        // Without self-repulsion a species collapses to a point. Territorial
        // pushes hardest; Zero is the deliberate exception, being noise.
        for (const generator of MATRIX_GENERATORS) {
            if (generator === 'Random' || generator === 'Zero') continue;
            for (let seed = 0; seed < 20; seed++) {
                const m = generateForceMatrix(generator, 6, createRng(seed));
                for (let i = 0; i < 6; i++) expect(m[i][i]).toBeLessThan(0);
            }
        }
    });

    it('Chains puts a strictly stronger band on |i-j| = 1 than anywhere else', () => {
        overSeeds(40, (rng) => {
            const m = generateForceMatrix('Chains', 7, rng);
            for (let i = 0; i < 7; i++) {
                for (let j = 0; j < 7; j++) {
                    if (i === j) continue;
                    // chain ∈ (0.2, 0.8), background ∈ (-0.25, 0.15): disjoint at 0.15.
                    if (Math.abs(i - j) === 1) expect(m[i][j]).toBeGreaterThan(0.15);
                    else expect(m[i][j]).toBeLessThan(0.15);
                }
            }
        });
    });

    it('Chains2 separates the nearest band, the next-nearest band and the rest', () => {
        overSeeds(40, (rng) => {
            const m = generateForceMatrix('Chains2', 8, rng);
            for (let i = 0; i < 8; i++) {
                for (let j = 0; j < 8; j++) {
                    const d = Math.abs(i - j);
                    if (d === 0) {
                        expect(m[i][j]).toBeGreaterThan(-0.4);
                        expect(m[i][j]).toBeLessThan(-0.1);
                    } else if (d === 1) {
                        expect(m[i][j]).toBeGreaterThan(0.05);
                    } else if (d === 2) {
                        expect(m[i][j]).toBeGreaterThan(-0.4);
                        expect(m[i][j]).toBeLessThan(0.2);
                    } else {
                        expect(m[i][j]).toBeGreaterThan(-0.1);
                        expect(m[i][j]).toBeLessThan(0.05);
                    }
                }
            }
        });
    });

    it('Chains3 decays with species distance instead of using a hard band', () => {
        // base·decay^d falls by at least 0.6^1 → 0.6^6 ≈ 0.047× between d = 1
        // and d = 7, which swamps the ±0.1 per-cell variation on average.
        const near: number[] = [];
        const far: number[] = [];
        overSeeds(60, (rng) => {
            const m = generateForceMatrix('Chains3', 8, rng);
            near.push(m[0][1]);
            far.push(m[0][7]);
        });
        const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
        expect(mean(near)).toBeGreaterThan(mean(far) + 0.1);
    });

    it('Snakes links the ends in one direction only — the Rust asymmetry, kept', () => {
        // The Rust sets only M[0][n-1] (settings.rs:292); M[n-1][0] falls
        // through to the background branch. Reproduced deliberately: closing the
        // loop both ways would change every Snakes matrix the app has ever
        // produced, which is an M14 visual-parity call, not a correctness one.
        overSeeds(40, (rng) => {
            const n = 6;
            const m = generateForceMatrix('Snakes', n, rng);
            expect(m[0][n - 1]).toBeGreaterThan(0.0);
            expect(m[n - 1][0]).toBeLessThan(0.1);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (i === j || (i === 0 && j === n - 1)) continue;
                    if (Math.abs(i - j) === 1) expect(m[i][j]).toBeGreaterThan(0.1);
                    else expect(m[i][j]).toBeLessThan(0.1);
                }
            }
        });
    });

    it('Zero is near-zero noise, not the zero matrix', () => {
        // settings.rs:305 says "Zero matrix with tiny random noise" and draws
        // ±0.01. Left as noise: the exactly-zero matrix is what the `zeroMatrix`
        // *operation* produces, and the two controls would otherwise be
        // identical.
        overSeeds(20, (rng) => {
            const m = generateForceMatrix('Zero', 8, rng);
            for (const value of entries(m)) expect(Math.abs(value)).toBeLessThan(0.01);
        });
        const m = generateForceMatrix('Zero', 8, createRng(5));
        expect(entries(m).some((v) => v !== 0)).toBe(true);
    });

    it('PredatorPrey is a complete cycle: i chases i+1 and flees i-1', () => {
        // The defect this pins: the Rust writes the -0.3 "prey repels predator"
        // entry as a side effect of the (i, j) visit, and the later (j, i) visit
        // overwrites it with 0.0 from the `else` branch. Only the single
        // wraparound entry survives, so on the desktop build the cycle is
        // one-way attraction with one stray repulsion.
        for (const n of [3, 4, 5, 8]) {
            const m = generateForceMatrix('PredatorPrey', n, createRng(0));
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (i === j) expect(m[i][j]).toBe(-0.1);
                    else if (j === (i + 1) % n) expect(m[i][j]).toBe(0.4);
                    else if (i === (j + 1) % n) expect(m[i][j]).toBe(-0.3);
                    else expect(m[i][j]).toBe(0);
                }
            }
            // Stated the other way round, since this is the whole point: every
            // predator link has a matching prey link.
            for (let i = 0; i < n; i++) {
                expect(m[i][(i + 1) % n]).toBe(0.4);
                expect(m[(i + 1) % n][i]).toBe(-0.3);
            }
        }
    });

    it('Symbiosis pairs even species with the next odd one', () => {
        overSeeds(30, (rng) => {
            const m = generateForceMatrix('Symbiosis', 8, rng);
            for (let i = 0; i < 8; i++) {
                for (let j = 0; j < 8; j++) {
                    if (i === j) continue;
                    const paired = (i % 2 === 0 && j === i + 1) || (j % 2 === 0 && i === j + 1);
                    // symbiotic ∈ (0.3, 0.9), background ∈ (-0.15, 0.15).
                    if (paired) expect(m[i][j]).toBeGreaterThan(0.3);
                    else expect(m[i][j]).toBeLessThan(0.15);
                }
            }
        });
    });

    it('Territorial repels hardest along the diagonal', () => {
        const diagonals: number[] = [];
        const offDiagonals: number[] = [];
        overSeeds(60, (rng) => {
            const m = generateForceMatrix('Territorial', 6, rng);
            for (let i = 0; i < 6; i++) {
                for (let j = 0; j < 6; j++) {
                    if (i === j) {
                        expect(m[i][j]).toBeGreaterThanOrEqual(-0.9);
                        expect(m[i][j]).toBeLessThan(-0.5);
                        diagonals.push(m[i][j]);
                    } else {
                        expect(m[i][j]).toBeGreaterThan(-0.7);
                        expect(m[i][j]).toBeLessThan(0.1);
                        offDiagonals.push(m[i][j]);
                    }
                }
            }
        });
        // Compared in aggregate, not per cell: self ∈ [-0.9, -0.5) and other
        // ∈ (-0.7, 0.1) overlap, so a single off-diagonal can out-repel the
        // diagonal it sits beside. The distributions do not overlap in the mean.
        const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / xs.length;
        expect(mean(diagonals)).toBeLessThan(mean(offDiagonals) - 0.2);
    });

    it('Magnetic attracts like index parity and repels unlike', () => {
        overSeeds(40, (rng) => {
            const m = generateForceMatrix('Magnetic', 8, rng);
            for (let i = 0; i < 8; i++) {
                for (let j = 0; j < 8; j++) {
                    if (i === j) continue;
                    if (i % 2 === j % 2) expect(m[i][j]).toBeGreaterThan(0.1);
                    else expect(m[i][j]).toBeLessThan(-0.1);
                }
            }
        });
    });

    it('Crystal binds a closed ring of neighbours, both directions', () => {
        overSeeds(40, (rng) => {
            const n = 7;
            const m = generateForceMatrix('Crystal', n, rng);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (i === j) continue;
                    const ring =
                        Math.abs(i - j) === 1 ||
                        (i === 0 && j === n - 1) ||
                        (j === 0 && i === n - 1);
                    // lattice ∈ (0.2, 1.0), background ∈ (-0.3, 0.15).
                    if (ring) expect(m[i][j]).toBeGreaterThan(0.2);
                    else expect(m[i][j]).toBeLessThan(0.15);
                }
            }
        });
    });

    it('Wave is a function of |i - j| up to its per-cell variation, and changes sign', () => {
        const signs = new Set<number>();
        overSeeds(40, (rng) => {
            const n = 8;
            const m = generateForceMatrix('Wave', n, rng);
            // Two cells at the same species distance differ by at most the two
            // independent ±0.1 draws.
            for (let d = 1; d < n; d++) {
                const atDistance: number[] = [];
                for (let i = 0; i + d < n; i++) atDistance.push(m[i][i + d]);
                const spread = Math.max(...atDistance) - Math.min(...atDistance);
                expect(spread).toBeLessThanOrEqual(0.2 + 1e-9);
            }
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (i !== j) signs.add(Math.sign(m[i][j]));
                }
            }
        });
        expect(signs.has(1)).toBe(true);
        expect(signs.has(-1)).toBe(true);
    });

    it('Hierarchy attracts upward only — strictly asymmetric', () => {
        overSeeds(40, (rng) => {
            const m = generateForceMatrix('Hierarchy', 7, rng);
            for (let i = 0; i < 7; i++) {
                for (let j = 0; j < 7; j++) {
                    if (i === j) continue;
                    // hierarchy ∈ (0.1, 0.6), background ∈ (-0.1, 0.1).
                    if (i < j) expect(m[i][j]).toBeGreaterThan(0.1);
                    else expect(Math.abs(m[i][j])).toBeLessThan(0.1);
                }
            }
        });
    });

    it('Clique and AntiClique partition species into contiguous blocks', () => {
        for (const generator of ['Clique', 'AntiClique'] as const) {
            const anti = generator === 'AntiClique';
            overSeeds(40, (rng) => {
                const n = 8;
                const m = generateForceMatrix(generator, n, rng);
                // Recover the block size from row 0, then require the whole
                // matrix to agree with it. Clique: within > 0.2, between < 0.
                // AntiClique: within < -0.2, between > 0.
                const inBlock = (v: number) => (anti ? v < -0.2 : v > 0.2);
                const outOfBlock = (v: number) => (anti ? v > 0 : v < 0);
                let groupSize = 1;
                while (groupSize < n && inBlock(m[0][groupSize])) groupSize++;
                expect(groupSize).toBeGreaterThanOrEqual(2);
                expect(groupSize).toBeLessThanOrEqual(Math.max(Math.floor(n / 2), 2));

                for (let i = 0; i < n; i++) {
                    for (let j = 0; j < n; j++) {
                        if (i === j) continue;
                        const same = Math.floor(i / groupSize) === Math.floor(j / groupSize);
                        expect(same ? inBlock(m[i][j]) : outOfBlock(m[i][j])).toBe(true);
                    }
                }
            });
        }
    });

    it('Fibonacci scales force with the Fibonacci number at the species distance', () => {
        // fib = [1, 1, 2, 3, 5, 8, 13, 21] for 8 species, normalized by 21, so
        // the far corner is ~21× the nearest band and the ordering survives the
        // ±0.1 variation without averaging.
        overSeeds(40, (rng) => {
            const m = generateForceMatrix('Fibonacci', 8, rng);
            expect(m[0][7]).toBeGreaterThan(m[0][1]);
            expect(m[0][6]).toBeGreaterThan(m[0][2]);
            for (const value of entries(m)) {
                expect(value).toBeGreaterThanOrEqual(-0.8);
                expect(value).toBeLessThanOrEqual(0.8);
            }
        });
    });

    it('Prime gives prime-indexed species an in-group', () => {
        // Indices, not species numbers: 2, 3, 5 and 7 are prime; 0, 1, 4 and 6
        // are not. `is_prime(0)` and `is_prime(1)` are false, so species 0 and 1
        // are outsiders.
        const prime = (k: number) => [2, 3, 5, 7].includes(k);
        overSeeds(40, (rng) => {
            const m = generateForceMatrix('Prime', 8, rng);
            for (let i = 0; i < 8; i++) {
                for (let j = 0; j < 8; j++) {
                    if (i === j) continue;
                    if (prime(i) && prime(j)) expect(m[i][j]).toBeGreaterThan(0.3);
                    else if (prime(i) || prime(j)) expect(m[i][j]).toBeGreaterThan(0);
                    else expect(m[i][j]).toBeLessThan(0);
                }
            }
        });
    });

    it('Fractal depends only on |i - j|, up to its per-cell variation', () => {
        overSeeds(40, (rng) => {
            const n = 8;
            const m = generateForceMatrix('Fractal', n, rng);
            for (let d = 1; d < n; d++) {
                const atDistance: number[] = [];
                for (let i = 0; i + d < n; i++) {
                    atDistance.push(m[i][i + d], m[i + d][i]);
                }
                const spread = Math.max(...atDistance) - Math.min(...atDistance);
                expect(spread).toBeLessThanOrEqual(0.2 + 1e-9);
            }
            for (const value of entries(m)) {
                expect(value).toBeGreaterThanOrEqual(-0.8);
                expect(value).toBeLessThanOrEqual(0.8);
            }
        });
    });

    it('RockPaperScissors is a cyclic dominance ring with opposed signs', () => {
        for (const n of [3, 4, 5, 8]) {
            const m = generateForceMatrix('RockPaperScissors', n, createRng(0));
            for (let i = 0; i < n; i++) {
                expect(m[i][i]).toBe(-0.1);
                // i attracts the species it beats; that species repels i.
                expect(m[i][(i + 1) % n]).toBe(0.4);
                expect(m[(i + 1) % n][i]).toBe(-0.2);
            }
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    const adjacent = j === (i + 1) % n || i === (j + 1) % n;
                    if (i !== j && !adjacent) expect(m[i][j]).toBe(0);
                    // Every off-diagonal pair that interacts at all is opposed
                    // in sign — the "antisymmetric" the pattern is named for.
                    if (i !== j && adjacent) expect(Math.sign(m[i][j] * m[j][i])).toBe(-1);
                }
            }
        }
    });

    it('the two cyclic generators degenerate to mutual attraction at 2 species', () => {
        // With n = 2 each species is simultaneously the other's predator and its
        // prey, so the cycle has no consistent orientation. The "beats" branch
        // wins for both cells, giving a symmetric matrix. The Rust instead
        // returns whichever value its row-major write order happened to land
        // last — an artifact, not a decision.
        for (const generator of ['PredatorPrey', 'RockPaperScissors'] as const) {
            const m = generateForceMatrix(generator, 2, createRng(0));
            expect(m).toEqual([
                [-0.1, 0.4],
                [0.4, -0.1],
            ]);
        }
    });

    it('Cooperation attracts everyone and Competition repels everyone', () => {
        overSeeds(40, (rng) => {
            const coop = generateForceMatrix('Cooperation', 6, rng);
            for (let i = 0; i < 6; i++) {
                for (let j = 0; j < 6; j++) {
                    if (i === j) expect(coop[i][j]).toBeLessThan(0);
                    else expect(coop[i][j]).toBeGreaterThan(0);
                }
            }
        });
        overSeeds(40, (rng) => {
            const comp = generateForceMatrix('Competition', 6, rng);
            for (const value of entries(comp)) expect(value).toBeLessThan(0);
        });
    });
});

// ---------------------------------------------------------------------------
// matrix_operations.rs — its 16 tests, ported
// ---------------------------------------------------------------------------

describe('matrix operations (ports of the 16 Rust tests)', () => {
    it('test_scale_force_matrix', () => {
        const original = createTestMatrix(3);

        const doubled = scaleForceMatrix(original, 2.0);
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                expect(Math.abs(doubled[i][j] - original[i][j] * 2.0)).toBeLessThan(0.001);
            }
        }

        const halved = scaleForceMatrix(doubled, 0.5);
        expectMatricesEqual(halved, original);

        // Clamping: 0.8 × 2 saturates at 1, and -0.8 × 2 at -1.
        const high = halved.map((row) => row.slice());
        high[0][1] = 0.8;
        expect(scaleForceMatrix(high, 2.0)[0][1]).toBeLessThanOrEqual(1.0);

        const low = halved.map((row) => row.slice());
        low[0][1] = -0.8;
        expect(scaleForceMatrix(low, 2.0)[0][1]).toBeGreaterThanOrEqual(-1.0);
    });

    it('test_flip_horizontal', () => {
        const original = createTestMatrix(3);
        expectMatricesEqual(flipHorizontal(flipHorizontal(original)), original);

        // The Rust test never checks what a single flip produces — it only
        // round-trips, which passes for the identity function too.
        expect(flipHorizontal(original)[0]).toEqual([0.02, 0.01, -0.1]);
    });

    it('test_flip_vertical', () => {
        const original = createTestMatrix(3);
        expectMatricesEqual(flipVertical(flipVertical(original)), original);

        // Same gap as flip_horizontal: assert the actual result too.
        expect(flipVertical(original)[0]).toEqual(original[2]);
        expect(flipVertical(original)[2]).toEqual(original[0]);
    });

    it('test_rotate_clockwise', () => {
        const original = createTestMatrix(3);
        const rotated = rotateClockwise(original);

        // The exact expectation from matrix_operations.rs:246.
        expect(Math.abs(rotated[0][0] - 0.06)).toBeLessThan(0.001);
        expect(Math.abs(rotated[0][1] - 0.03)).toBeLessThan(0.001);
        expect(Math.abs(rotated[0][2] - -0.1)).toBeLessThan(0.001);
        expect(Math.abs(rotated[1][0] - 0.07)).toBeLessThan(0.001);
        expect(Math.abs(rotated[1][1] - -0.1)).toBeLessThan(0.001);
        expect(Math.abs(rotated[1][2] - 0.01)).toBeLessThan(0.001);
        expect(Math.abs(rotated[2][0] - -0.1)).toBeLessThan(0.001);
        expect(Math.abs(rotated[2][1] - 0.05)).toBeLessThan(0.001);
        expect(Math.abs(rotated[2][2] - 0.02)).toBeLessThan(0.001);

        const fourTimes = rotateClockwise(rotateClockwise(rotateClockwise(rotated)));
        expectMatricesEqual(fourTimes, original);
    });

    it('test_rotate_counterclockwise', () => {
        const original = createTestMatrix(3);
        let m = original;
        for (let k = 0; k < 4; k++) m = rotateCounterclockwise(m);
        expectMatricesEqual(m, original);
    });

    it('test_rotate_clockwise_and_counterclockwise', () => {
        const original = createTestMatrix(4);
        expectMatricesEqual(rotateCounterclockwise(rotateClockwise(original)), original);
        expectMatricesEqual(rotateClockwise(rotateCounterclockwise(original)), original);
    });

    it('test_shift_left_and_right', () => {
        const original = createTestMatrix(3);

        const left = shiftLeft(original);
        expect(Math.abs(left[0][0] - 0.01)).toBeLessThan(0.001);
        expect(Math.abs(left[0][1] - 0.02)).toBeLessThan(0.001);
        expect(Math.abs(left[0][2] - -0.1)).toBeLessThan(0.001);

        expectMatricesEqual(shiftRight(left), original);
        expectMatricesEqual(shiftLeft(shiftRight(original)), original);
    });

    it('test_shift_up_and_down', () => {
        const original = createTestMatrix(3);

        const up = shiftUp(original);
        expect(up[0]).toEqual(original[1]);
        expect(up[1]).toEqual(original[2]);
        expect(up[2]).toEqual(original[0]);
        // The literal values the Rust spells out at matrix_operations.rs:339.
        expect(Math.abs(up[0][0] - 0.03)).toBeLessThan(0.001);
        expect(Math.abs(up[1][1] - 0.07)).toBeLessThan(0.001);
        expect(Math.abs(up[2][2] - 0.02)).toBeLessThan(0.001);

        expectMatricesEqual(shiftDown(up), original);
        expectMatricesEqual(shiftUp(shiftDown(original)), original);
    });

    it('test_complex_operation_sequences', () => {
        const original = createTestMatrix(4);
        expectMatricesEqual(scaleForceMatrix(scaleForceMatrix(original, 2.0), 0.5), original);
        expectMatricesEqual(rotateCounterclockwise(rotateClockwise(original)), original);
        expectMatricesEqual(flipHorizontal(flipHorizontal(original)), original);
    });

    it('test_operation_edge_cases', () => {
        const original = createTestMatrix(2);
        expectMatricesEqual(rotateCounterclockwise(rotateClockwise(original)), original);
        expectMatricesEqual(flipHorizontal(flipHorizontal(original)), original);
        expectMatricesEqual(flipVertical(flipVertical(original)), original);
        expectMatricesEqual(shiftRight(shiftLeft(original)), original);
        expectMatricesEqual(shiftDown(shiftUp(original)), original);
    });

    it('test_scale_edge_cases', () => {
        const zeroed = scaleForceMatrix(createTestMatrix(3), 0.0);
        for (const value of entries(zeroed)) expect(Math.abs(value)).toBeLessThan(0.001);

        const negated = scaleForceMatrix(createTestMatrix(3), -1.0);
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                const expected = i === j ? 0.1 : -((i * 3 + j) * 0.01);
                expect(Math.abs(negated[i][j] - expected)).toBeLessThan(0.001);
            }
        }
    });

    it('test_matrix_operations_with_different_sizes', () => {
        for (let size = 2; size <= 6; size++) {
            const original = createTestMatrix(size);

            let m = original;
            for (let k = 0; k < 4; k++) m = rotateClockwise(m);
            expectMatricesEqual(m, original);

            m = original;
            for (let k = 0; k < size; k++) m = shiftLeft(m);
            expectMatricesEqual(m, original);

            m = original;
            for (let k = 0; k < size; k++) m = shiftUp(m);
            expectMatricesEqual(m, original);
        }
    });

    it('test_operation_invariants', () => {
        const original = createTestMatrix(4);
        for (const op of [rotateClockwise, flipHorizontal, shiftLeft]) {
            const result = op(original);
            expect(result).toHaveLength(4);
            expect(result[0]).toHaveLength(4);
            for (const value of entries(result)) {
                expect(value).toBeGreaterThanOrEqual(-1.0);
                expect(value).toBeLessThanOrEqual(1.0);
            }
        }
    });

    it('test_rotation_inverses', () => {
        const original = createTestMatrix(3);
        expectMatricesEqual(rotateClockwise(rotateCounterclockwise(original)), original);
        expectMatricesEqual(rotateCounterclockwise(rotateClockwise(original)), original);
    });

    it('test_zero_matrix', () => {
        for (let size = 2; size <= 6; size++) {
            const zeroed = zeroMatrix(createTestMatrix(size));
            expect(zeroed).toHaveLength(size);
            for (const row of zeroed) expect(row).toEqual(new Array(size).fill(0));
        }
    });

    it('test_flip_sign', () => {
        const original = createTestMatrix(3);
        const flipped = flipSign(original);
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                expect(Math.abs(flipped[i][j] - -original[i][j])).toBeLessThan(0.001);
            }
        }
        expectMatricesEqual(flipSign(flipped), original);

        expect(
            flipSign([
                [1.0, -0.5, 0.0],
                [-1.0, 0.3, -0.8],
                [0.0, 0.7, -0.2],
            ])
        ).toEqual([
            [-1.0, 0.5, 0.0],
            [1.0, -0.3, 0.8],
            [0.0, -0.7, 0.2],
        ]);
        // Negating a zero gives `0`, not `-0`. Rust produces `-0.0` here and
        // nothing downstream can tell the difference numerically, but `toEqual`
        // and `Object.is` both can, and a `-0` survives into a preset's JSON.
        expect(Object.is(flipSign([[0]])[0][0], 0)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Properties the Rust tests do not cover
// ---------------------------------------------------------------------------

describe('matrix operation algebra', () => {
    const OPERATIONS = {
        flipHorizontal,
        flipVertical,
        rotateClockwise,
        rotateCounterclockwise,
        shiftLeft,
        shiftRight,
        shiftUp,
        shiftDown,
        zeroMatrix,
        flipSign,
    };

    it('leaves the input untouched — every operation, every size', () => {
        for (let size = 1; size <= 6; size++) {
            for (const [name, op] of Object.entries(OPERATIONS)) {
                const input = createTestMatrix(size);
                const snapshot = structuredClone(input);
                const result = op(input);
                expect(input, `${name} mutated its input`).toEqual(snapshot);
                // A copy, never an alias: mutating the result must not write
                // back through a shared row.
                if (result.length > 0 && result[0].length > 0) {
                    result[0][0] = 999;
                    expect(input).toEqual(snapshot);
                }
            }
            const input = createTestMatrix(size);
            const snapshot = structuredClone(input);
            scaleForceMatrix(input, 3.0);
            expect(input).toEqual(snapshot);
        }
    });

    it('rotations invert each other and flipSign is an involution', () => {
        for (let size = 1; size <= 8; size++) {
            const original = createTestMatrix(size);
            expect(rotateCounterclockwise(rotateClockwise(original))).toEqual(original);
            expect(rotateClockwise(rotateCounterclockwise(original))).toEqual(original);
            expect(flipSign(flipSign(original))).toEqual(original);
            expect(flipHorizontal(flipHorizontal(original))).toEqual(original);
            expect(flipVertical(flipVertical(original))).toEqual(original);
        }
    });

    it('each shift composes back to the identity over n applications', () => {
        for (let size = 1; size <= 8; size++) {
            const original = createTestMatrix(size);
            for (const shift of [shiftLeft, shiftRight, shiftUp, shiftDown]) {
                let m = original;
                for (let k = 0; k < size; k++) m = shift(m);
                expect(m).toEqual(original);
            }
            // …and the opposite shifts undo each other one step at a time.
            expect(shiftRight(shiftLeft(original))).toEqual(original);
            expect(shiftUp(shiftDown(original))).toEqual(original);
        }
    });

    it('four clockwise rotations, two flips and a transpose all agree', () => {
        const original = createTestMatrix(5);
        // Rotating 180° is the same as flipping both ways.
        expect(rotateClockwise(rotateClockwise(original))).toEqual(
            flipVertical(flipHorizontal(original))
        );
        // CW then flip-horizontal is the transpose.
        const transposed = flipHorizontal(rotateClockwise(original));
        for (let i = 0; i < 5; i++) {
            for (let j = 0; j < 5; j++) expect(transposed[i][j]).toBe(original[j][i]);
        }
    });

    it('handles the empty matrix without throwing', () => {
        for (const op of Object.values(OPERATIONS)) expect(op([])).toEqual([]);
        expect(scaleForceMatrix([], 2)).toEqual([]);
    });

    it('preserves a rectangular matrix instead of truncating it to rows × rows', () => {
        // Every Rust operation uses `force_matrix.len()` — the row count — as
        // the column extent too, so a 2×4 matrix loses its last two columns and
        // a 4×2 one panics. The force matrix is square today, but only because
        // `set_species_count` resizes both dimensions; a preset deserializes
        // straight into `force_matrix` with whatever shape its JSON had.
        const wide = [
            [1, 2, 3, 4],
            [5, 6, 7, 8],
        ];
        expect(flipHorizontal(wide)).toEqual([
            [4, 3, 2, 1],
            [8, 7, 6, 5],
        ]);
        expect(shiftLeft(wide)).toEqual([
            [2, 3, 4, 1],
            [6, 7, 8, 5],
        ]);
        expect(shiftRight(shiftLeft(wide))).toEqual(wide);
        // A rows×cols input rotates into cols×rows, losing nothing.
        expect(rotateClockwise(wide)).toEqual([
            [5, 1],
            [6, 2],
            [7, 3],
            [8, 4],
        ]);
        expect(rotateCounterclockwise(rotateClockwise(wide))).toEqual(wide);
        expect(rotateClockwise(rotateCounterclockwise(wide))).toEqual(wide);

        const tall = [
            [1, 2],
            [3, 4],
            [5, 6],
            [7, 8],
        ];
        expect(rotateCounterclockwise(rotateClockwise(tall))).toEqual(tall);
        expect(zeroMatrix(tall)).toEqual([
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
        ]);
    });

    it('scale clamps and is therefore not invertible once an entry saturates', () => {
        const m = [[0.9, -0.9]];
        const up = scaleForceMatrix(m, 2.0);
        expect(up).toEqual([[1, -1]]);
        // Scaling back does not recover 0.9 — the clamp threw the magnitude away.
        expect(scaleForceMatrix(up, 0.5)).toEqual([[0.5, -0.5]]);
    });

    it('the operations round-trip a generated matrix, which is what the editor does', () => {
        for (const generator of MATRIX_GENERATORS) {
            const m = generateForceMatrix(generator, 8, createRng(11));
            expect(rotateCounterclockwise(rotateClockwise(m))).toEqual(m);
            expect(flipSign(flipSign(m))).toEqual(m);
            expect(shiftRight(shiftLeft(m))).toEqual(m);
            // Scaling by 1 is a no-op even through the clamp, because every
            // generated entry is already inside [-1, 1].
            expect(scaleForceMatrix(m, 1.0)).toEqual(m);
        }
    });
});
