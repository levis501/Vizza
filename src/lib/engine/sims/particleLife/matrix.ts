/**
 * Particle Life force-matrix generators — a port of
 * `MatrixGenerator` and `Settings::randomize_force_matrix`
 * (src-tauri/src/simulations/particle_life/settings.rs:86 and :186).
 *
 * Pure CPU, no GPU and no settings object: `generateForceMatrix` takes the
 * generator and a species count and hands back a fresh matrix, so all 22
 * patterns are exercisable in node. The Rust instead mutates
 * `self.force_matrix` in place, which is why its generators can — and in one
 * case do — clobber their own earlier writes (see `PredatorPrey` below).
 *
 * **The Rust never resizes before it writes.** `randomize_force_matrix`
 * indexes `self.force_matrix[i][j]` over `0..species_count` and relies on some
 * earlier `set_species_count` having sized the matrix; a generator invoked
 * against a stale matrix panics. Building the result from scratch here makes
 * that class of mismatch unrepresentable, and it is why the caller gets a new
 * array rather than an in-place mutation.
 *
 * **`TypeGenerator` (11 variants) is deliberately absent.** It lives in the
 * same Rust file, but nothing on the CPU ever evaluates it: `state.rs` stores
 * it, `simulation.rs:780` casts it to `u32` into the init uniform, and
 * `shaders/init.wgsl:327` switches on that u32 to pick one of eleven
 * `generate_*_type` functions. It is shader logic and belongs with the
 * simulation module, not here.
 *
 * Values are in [-1, 1], where -1 is maximum repulsion, 0 neutral and +1
 * maximum attraction. Row i column j is the force species i feels toward
 * species j, so the matrix is **not** required to be symmetric — several
 * generators are asymmetric on purpose, and the ones that promise symmetry say
 * so in their comment.
 */

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

/**
 * A seeded uniform [0, 1) generator — mulberry32.
 *
 * The Rust seeds a `StdRng` from `rand::random::<u64>()`, i.e. it is
 * unseedable from the outside and its output is untestable. Everything below
 * takes an `rng` parameter instead, so a test can pin a generator's structure
 * against an exact matrix rather than only against bounds.
 *
 * Mulberry32 rather than anything stronger: 32 bits of state, no dependency,
 * and passes enough of the small-crush suite for choosing force values. It is
 * **not** a substitute for `crypto.getRandomValues` anywhere it matters.
 *
 * There is no shared RNG utility under `src/lib/engine/` today; if a second
 * simulation needs one this should be hoisted rather than copied.
 */
export function createRng(seed: number): () => number {
    // Coerce to a u32 so a float, a negative or a > 2^32 seed all land
    // somewhere legal instead of poisoning the state with NaN.
    let state = Math.imul(Math.floor(seed) >>> 0, 1) >>> 0;
    return function next(): number {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** `rng.random_range(lo..hi)` — uniform in [lo, hi), matching Rust's half-open range. */
function range(rng: () => number, lo: number, hi: number): number {
    return lo + rng() * (hi - lo);
}

/** `rng.random_range(lo..=hi)` over integers — inclusive at both ends. */
function intRange(rng: () => number, lo: number, hi: number): number {
    if (hi <= lo) return lo;
    return lo + Math.min(hi - lo, Math.floor(rng() * (hi - lo + 1)));
}

/** `rng.random_bool(0.5)`. */
function coinFlip(rng: () => number): boolean {
    return rng() < 0.5;
}

function clamp(value: number, lo: number, hi: number): number {
    return value < lo ? lo : value > hi ? hi : value;
}

// ---------------------------------------------------------------------------
// The generator enum
// ---------------------------------------------------------------------------

/**
 * The 22 `MatrixGenerator` variants, spelled exactly as serde serializes them
 * — these are the strings `update_simulation_setting("matrix_generator", …)`
 * matches on at simulation.rs:3555.
 */
export type MatrixGenerator =
    | 'Random'
    | 'Symmetry'
    | 'Chains'
    | 'Chains2'
    | 'Chains3'
    | 'Snakes'
    | 'Zero'
    // Biological/Ecological
    | 'PredatorPrey'
    | 'Symbiosis'
    | 'Territorial'
    // Physical/Chemical
    | 'Magnetic'
    | 'Crystal'
    | 'Wave'
    // Social/Behavioral
    | 'Hierarchy'
    | 'Clique'
    | 'AntiClique'
    // Mathematical
    | 'Fibonacci'
    | 'Prime'
    | 'Fractal'
    // Game theory
    | 'RockPaperScissors'
    | 'Cooperation'
    | 'Competition';

/** In Rust declaration order, which is the order the UI's picker cycles through. */
export const MATRIX_GENERATORS: readonly MatrixGenerator[] = [
    'Random',
    'Symmetry',
    'Chains',
    'Chains2',
    'Chains3',
    'Snakes',
    'Zero',
    'PredatorPrey',
    'Symbiosis',
    'Territorial',
    'Magnetic',
    'Crystal',
    'Wave',
    'Hierarchy',
    'Clique',
    'AntiClique',
    'Fibonacci',
    'Prime',
    'Fractal',
    'RockPaperScissors',
    'Cooperation',
    'Competition',
];

/**
 * Accept a serialized generator name, falling back to `Random`.
 *
 * The fallback is the Rust's (`_ => MatrixGenerator::Random`,
 * simulation.rs:3577) and matters for presets: an unknown name has to pick
 * *something*, and refusing would leave the matrix untouched while the UI
 * believes it changed.
 */
export function parseMatrixGenerator(value: unknown): MatrixGenerator {
    return typeof value === 'string' && (MATRIX_GENERATORS as readonly string[]).includes(value)
        ? (value as MatrixGenerator)
        : 'Random';
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Build a `speciesCount` × `speciesCount` force matrix.
 *
 * `rng` returns [0, 1) and defaults to `Math.random`. Every entry is finite and
 * within [-1, 1]; the final clamp below is a contract guarantee rather than a
 * behaviour change, since no generator's arithmetic can leave the range.
 *
 * A non-integral, negative or non-finite `speciesCount` yields an empty matrix
 * rather than throwing — the Rust clamps to 2..=8 at every call site it has,
 * but this function is also reached from preset load, where the number is
 * whatever was in the JSON.
 */
export function generateForceMatrix(
    generator: MatrixGenerator,
    speciesCount: number,
    rng: () => number = Math.random
): number[][] {
    const n = Number.isFinite(speciesCount) ? Math.max(0, Math.floor(speciesCount)) : 0;
    if (n === 0) return [];

    const m: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));

    switch (generator) {
        case 'Random': {
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) m[i][j] = range(rng, -1, 1);
            }
            break;
        }

        case 'Symmetry': {
            // Symmetric by construction: the upper triangle is drawn and
            // mirrored, so M[i][j] === M[j][i] exactly, not to a tolerance.
            const baseStrength = range(rng, 0.3, 0.8);
            const variation = range(rng, 0.1, 0.4);
            for (let i = 0; i < n; i++) {
                for (let j = i; j < n; j++) {
                    let value: number;
                    if (i === j) {
                        value = range(rng, -0.3, -0.05);
                    } else {
                        const sign = coinFlip(rng) ? 1 : -1;
                        const strength = range(rng, 0.2, baseStrength);
                        value = sign * strength + range(rng, -variation, variation);
                    }
                    m[i][j] = clamp(value, -1, 1);
                    m[j][i] = m[i][j];
                }
            }
            break;
        }

        case 'Chains': {
            // A band matrix: |i-j| === 1 attracts, everything else is background.
            const chainStrength = range(rng, 0.3, 0.7);
            const selfRepulsion = range(rng, -0.3, -0.05);
            const backgroundStrength = range(rng, -0.2, 0.1);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (i === j) m[i][j] = selfRepulsion;
                    else if (Math.abs(i - j) === 1) m[i][j] = chainStrength + range(rng, -0.1, 0.1);
                    else m[i][j] = backgroundStrength + range(rng, -0.05, 0.05);
                }
            }
            break;
        }

        case 'Chains2': {
            // Two bands: immediate neighbours attract, next-nearest are separate.
            const nearStrength = range(rng, 0.2, 0.6);
            const farStrength = range(rng, -0.3, 0.1);
            const selfRepulsion = range(rng, -0.4, -0.1);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    const d = Math.abs(i - j);
                    if (i === j) m[i][j] = selfRepulsion;
                    else if (d === 1) m[i][j] = nearStrength + range(rng, -0.15, 0.15);
                    else if (d === 2) m[i][j] = farStrength + range(rng, -0.1, 0.1);
                    else m[i][j] = range(rng, -0.1, 0.05);
                }
            }
            break;
        }

        case 'Chains3': {
            // Geometric decay with species distance rather than a hard band.
            const decayRate = range(rng, 0.6, 0.9);
            const baseStrength = range(rng, 0.3, 0.6);
            const selfRepulsion = range(rng, -0.3, -0.05);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (i === j) {
                        m[i][j] = selfRepulsion;
                    } else {
                        const strength = baseStrength * Math.pow(decayRate, Math.abs(i - j));
                        m[i][j] = clamp(strength + range(rng, -0.1, 0.1), -0.8, 0.8);
                    }
                }
            }
            break;
        }

        case 'Snakes': {
            // Chains, plus a single directed link from the last species back to
            // the first. Deliberately one-way — see the note in the file header
            // of the test suite; the Rust sets only M[0][n-1], never M[n-1][0].
            const snakeStrength = range(rng, 0.2, 0.5);
            const endConnectionStrength = range(rng, 0.1, 0.4);
            const selfRepulsion = range(rng, -0.3, -0.05);
            const backgroundStrength = range(rng, -0.1, 0.05);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (i === j) m[i][j] = selfRepulsion;
                    else if (i === 0 && j === n - 1)
                        m[i][j] = endConnectionStrength + range(rng, -0.1, 0.1);
                    else if (Math.abs(i - j) === 1) m[i][j] = snakeStrength + range(rng, -0.1, 0.1);
                    else m[i][j] = backgroundStrength + range(rng, -0.05, 0.05);
                }
            }
            break;
        }

        case 'Zero': {
            // Near-zero, not zero: the Rust's comment is "Zero matrix with tiny
            // random noise", and the noise is the point — an exactly-zero matrix
            // is what the `zeroMatrix` *operation* is for, and it freezes the
            // simulation into pure Brownian drift.
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) m[i][j] = range(rng, -0.01, 0.01);
            }
            break;
        }

        case 'PredatorPrey': {
            // Cyclic chase: i hunts (i+1) mod n and flees (i-1) mod n.
            //
            // Written per cell. The Rust writes M[j][i] = -0.3 as a side effect
            // of the (i, j) visit, and the later (j, i) visit then falls into
            // its `else` branch and overwrites it with 0.0 — so on the desktop
            // build only the single wraparound entry keeps its repulsion and
            // the chain is one-way attraction. `RockPaperScissors` below has the
            // explicit reverse branch this one is missing, which is what the
            // third case here restores.
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (i === j) m[i][j] = -0.1;
                    else if (j === (i + 1) % n) m[i][j] = 0.4;
                    else if (i === (j + 1) % n) m[i][j] = -0.3;
                    else m[i][j] = 0.0;
                }
            }
            break;
        }

        case 'Symbiosis': {
            // Mutualistic pairs (0,1), (2,3), … — symmetric by construction.
            const symbiosisStrength = range(rng, 0.4, 0.8);
            const selfRepulsion = range(rng, -0.3, -0.05);
            const backgroundStrength = range(rng, -0.1, 0.1);
            for (let i = 0; i < n; i++) {
                for (let j = i; j < n; j++) {
                    let value: number;
                    if (i === j) value = selfRepulsion;
                    else if (i % 2 === 0 && j === i + 1)
                        value = symbiosisStrength + range(rng, -0.1, 0.1);
                    else value = backgroundStrength + range(rng, -0.05, 0.05);
                    m[i][j] = value;
                    m[j][i] = value;
                }
            }
            break;
        }

        case 'Territorial': {
            // Everything repels everything; the only question is how hard.
            const selfRepulsion = range(rng, -0.9, -0.5);
            const otherRepulsionBase = range(rng, -0.5, -0.1);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    m[i][j] = i === j ? selfRepulsion : otherRepulsionBase + range(rng, -0.2, 0.2);
                }
            }
            break;
        }

        case 'Magnetic': {
            // Like "charges" (index parity) attract, unlike repel. Symmetric.
            const attractionStrength = range(rng, 0.2, 0.6);
            const repulsionStrength = range(rng, -0.6, -0.2);
            const selfRepulsion = range(rng, -0.3, -0.05);
            for (let i = 0; i < n; i++) {
                for (let j = i; j < n; j++) {
                    let value: number;
                    if (i === j) value = selfRepulsion;
                    else if (i % 2 === j % 2) value = attractionStrength + range(rng, -0.1, 0.1);
                    else value = repulsionStrength + range(rng, -0.1, 0.1);
                    m[i][j] = value;
                    m[j][i] = value;
                }
            }
            break;
        }

        case 'Crystal': {
            // A ring lattice: neighbours in index order attract, and the ends
            // are joined. Symmetric, so unlike Snakes the ring closes both ways.
            const latticeStrength = range(rng, 0.4, 0.8);
            const selfRepulsion = range(rng, -0.4, -0.1);
            const backgroundStrength = range(rng, -0.2, 0.05);
            const latticeVariation = range(rng, 0.05, 0.2);
            for (let i = 0; i < n; i++) {
                for (let j = i; j < n; j++) {
                    let value: number;
                    if (i === j) {
                        value = selfRepulsion;
                    } else if (Math.abs(i - j) === 1 || (i === 0 && j === n - 1)) {
                        value = latticeStrength + range(rng, -latticeVariation, latticeVariation);
                    } else {
                        value = backgroundStrength + range(rng, -0.1, 0.1);
                    }
                    m[i][j] = value;
                    m[j][i] = value;
                }
            }
            break;
        }

        case 'Wave': {
            // Force oscillates with |i - j|, so bands of attraction and
            // repulsion alternate along the diagonal. Symmetric.
            const amplitude = range(rng, 0.3, 0.7);
            const frequency = range(rng, 0.5, 2.0);
            const phase = range(rng, 0, Math.PI * 2);
            const selfRepulsion = range(rng, -0.3, -0.05);
            for (let i = 0; i < n; i++) {
                for (let j = i; j < n; j++) {
                    let value: number;
                    if (i === j) {
                        value = selfRepulsion;
                    } else {
                        const wave = Math.sin(Math.abs(i - j) * frequency + phase);
                        value = wave * amplitude + range(rng, -0.1, 0.1);
                    }
                    m[i][j] = value;
                    m[j][i] = value;
                }
            }
            break;
        }

        case 'Hierarchy': {
            // Strictly upper-triangular attraction: i is drawn to every j above
            // it, and j is indifferent to i. The asymmetry is the whole pattern.
            //
            // The Rust writes the lower-triangle cell twice — once as a side
            // effect of the i < j visit and again on the i > j visit, with a
            // fresh random draw each time — so the first write is always dead.
            // Same distribution, one draw.
            const hierarchyStrength = range(rng, 0.2, 0.5);
            const selfRepulsion = range(rng, -0.3, -0.05);
            const backgroundStrength = range(rng, -0.05, 0.05);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (i === j) m[i][j] = selfRepulsion;
                    else if (i < j) m[i][j] = hierarchyStrength + range(rng, -0.1, 0.1);
                    else m[i][j] = backgroundStrength + range(rng, -0.05, 0.05);
                }
            }
            break;
        }

        case 'Clique':
        case 'AntiClique': {
            // Contiguous index blocks. `Clique` binds each block together and
            // pushes the blocks apart; `AntiClique` does the reverse.
            const anti = generator === 'AntiClique';
            const maxGroupSize = Math.max(Math.floor(n / 2), 2);
            const groupSize = intRange(rng, 2, maxGroupSize);
            const withinStrength = anti ? range(rng, -0.7, -0.3) : range(rng, 0.3, 0.7);
            const betweenStrength = anti ? range(rng, 0.2, 0.5) : range(rng, -0.4, -0.1);
            const selfRepulsion = range(rng, -0.3, -0.05);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (i === j) m[i][j] = selfRepulsion;
                    else if (Math.floor(i / groupSize) === Math.floor(j / groupSize))
                        m[i][j] = withinStrength + range(rng, -0.1, 0.1);
                    else m[i][j] = betweenStrength + range(rng, -0.1, 0.1);
                }
            }
            break;
        }

        case 'Fibonacci': {
            // Attraction grows with species distance along the Fibonacci
            // sequence, normalized so the farthest pair sits at `scaleFactor`.
            const fib = [1, 1];
            for (let k = 2; k < n; k++) fib.push(fib[k - 1] + fib[k - 2]);
            const maxFib = fib[fib.length - 1];

            const scaleFactor = range(rng, 0.5, 1.5);
            const selfRepulsion = range(rng, -0.3, -0.05);
            const baseOffset = range(rng, -0.2, 0.2);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (i === j) {
                        m[i][j] = selfRepulsion;
                    } else {
                        const distance = Math.abs(i - j);
                        const fibValue = distance < fib.length ? fib[distance] : 1;
                        const baseForce = (fibValue / maxFib) * scaleFactor + baseOffset;
                        m[i][j] = clamp(baseForce + range(rng, -0.1, 0.1), -0.8, 0.8);
                    }
                }
            }
            break;
        }

        case 'Prime': {
            // Species whose *index* is prime form an in-group.
            const primeAttraction = range(rng, 0.4, 0.8);
            const mixedAttraction = range(rng, 0.1, 0.4);
            const nonPrimeRepulsion = range(rng, -0.2, -0.05);
            const selfRepulsion = range(rng, -0.3, -0.05);
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    const pi = isPrime(i);
                    const pj = isPrime(j);
                    if (i === j) m[i][j] = selfRepulsion;
                    else if (pi && pj) m[i][j] = primeAttraction + range(rng, -0.1, 0.1);
                    else if (pi || pj) m[i][j] = mixedAttraction + range(rng, -0.1, 0.1);
                    else m[i][j] = nonPrimeRepulsion + range(rng, -0.05, 0.05);
                }
            }
            break;
        }

        case 'Fractal': {
            // sin(π·log₂(1 + f·d/(n-1))) — a self-similar band pattern in the
            // normalized species distance.
            const scaleFactor = range(rng, 0.3, 0.7);
            const frequency = range(rng, 2.0, 4.0);
            const selfRepulsion = range(rng, -0.3, -0.05);
            const baseOffset = range(rng, -0.1, 0.1);
            // n === 1 has no off-diagonal cell, so the Rust's `species_count - 1`
            // divisor is never evaluated at zero — guarded anyway, because a
            // single NaN here would poison every particle's force.
            const span = n > 1 ? n - 1 : 1;
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (i === j) {
                        m[i][j] = selfRepulsion;
                    } else {
                        const normalizedDistance = Math.abs(i - j) / span;
                        const scale = Math.log2(normalizedDistance * frequency + 1.0);
                        const force = Math.sin(scale * Math.PI) * scaleFactor + baseOffset;
                        m[i][j] = clamp(force + range(rng, -0.1, 0.1), -0.8, 0.8);
                    }
                }
            }
            break;
        }

        case 'RockPaperScissors': {
            // Cyclic dominance: i beats (i+1) mod n and loses to (i-1) mod n.
            // Deterministic — no RNG draws at all, same as PredatorPrey.
            for (let i = 0; i < n; i++) {
                for (let j = 0; j < n; j++) {
                    if (i === j) m[i][j] = -0.1;
                    else if (j === (i + 1) % n) m[i][j] = 0.4;
                    else if (i === (j + 1) % n) m[i][j] = -0.2;
                    else m[i][j] = 0.0;
                }
            }
            break;
        }

        case 'Cooperation':
        case 'Competition': {
            // Uniform mutual attraction / repulsion. Symmetric.
            const pairStrength =
                generator === 'Cooperation' ? range(rng, 0.1, 0.4) : range(rng, -0.4, -0.1);
            const selfRepulsion = range(rng, -0.3, -0.05);
            for (let i = 0; i < n; i++) {
                for (let j = i; j < n; j++) {
                    const value = i === j ? selfRepulsion : pairStrength + range(rng, -0.1, 0.1);
                    m[i][j] = value;
                    m[j][i] = value;
                }
            }
            break;
        }
    }

    // Contract enforcement, not a behaviour change: every branch above is
    // already bounded well inside [-1, 1] (the widest is Crystal, whose
    // 0.8 + 0.2 upper bounds are both exclusive). This exists so a future
    // parameter tweak cannot quietly emit a force the shader would misread.
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) m[i][j] = clamp(m[i][j], -1, 1);
    }
    return m;
}

/** Trial division, ported verbatim from the closure at settings.rs:550. */
function isPrime(value: number): boolean {
    if (value < 2) return false;
    for (let d = 2; d <= Math.floor(Math.sqrt(value)); d++) {
        if (value % d === 0) return false;
    }
    return true;
}
