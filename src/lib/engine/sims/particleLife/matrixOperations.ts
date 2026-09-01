/**
 * The eleven force-matrix transforms behind Particle Life's matrix editor — a
 * port of src-tauri/src/simulations/particle_life/matrix_operations.rs.
 *
 * **Pure, where the Rust mutates.** Every function there takes
 * `&mut [Vec<f32>]` and rewrites it in place; here each returns a new matrix
 * and leaves its argument untouched. The reason is not stylistic: the Svelte
 * layer holds the matrix in a reactive store and needs a new reference to
 * notice a change, and an in-place version would also make the "apply, compare,
 * undo" shape the tests below use impossible to write.
 *
 * **Clamping is preserved exactly.** `scaleForceMatrix` clamps to [-1, 1] and
 * nothing else does — negating, reordering or zeroing an in-range matrix cannot
 * leave the range, so the Rust adds no clamp there and neither do we.
 *
 * **Rectangular input is handled correctly, where the Rust corrupts it.** Every
 * Rust operation takes `n = force_matrix.len()` — the *row* count — and then
 * uses it as the column extent too: `flip_horizontal` swaps `row[j]` with
 * `row[n-1-j]`, `shift_left` treats `row[n-1]` as the last column, and both
 * rotations allocate `n × n`. On a matrix with more columns than rows that
 * silently drops the surplus columns; with fewer it indexes out of bounds and
 * panics. The force matrix is square today, so none of it can fire — but it is
 * square only because `set_species_count` happens to resize both dimensions,
 * and a preset deserialized straight into `force_matrix` carries whatever shape
 * the JSON had. The functions below derive columns from the rows themselves.
 */

/** Read-only view of a matrix: accepted as input, never returned. */
export type ReadonlyMatrix = readonly (readonly number[])[];

function clamp(value: number, lo: number, hi: number): number {
    return value < lo ? lo : value > hi ? hi : value;
}

/** Widest row, so a ragged matrix rectangularizes rather than losing cells. */
function columnCount(matrix: ReadonlyMatrix): number {
    let cols = 0;
    for (const row of matrix) cols = Math.max(cols, row.length);
    return cols;
}

/**
 * Scale every entry, clamping the result into [-1, 1].
 *
 * The clamp makes this lossy and therefore **not** invertible by scaling back:
 * once an entry saturates at ±1 the original magnitude is gone. The Rust's own
 * test only checks round-tripping on values small enough never to saturate.
 */
export function scaleForceMatrix(matrix: ReadonlyMatrix, scaleFactor: number): number[][] {
    return matrix.map((row) => row.map((value) => clamp(value * scaleFactor, -1, 1)));
}

/** Mirror each row left-to-right: out[i][j] = in[i][cols-1-j]. */
export function flipHorizontal(matrix: ReadonlyMatrix): number[][] {
    return matrix.map((row) => row.slice().reverse());
}

/** Mirror the row order top-to-bottom: out[i][j] = in[rows-1-i][j]. */
export function flipVertical(matrix: ReadonlyMatrix): number[][] {
    return matrix.map((_, i) => matrix[matrix.length - 1 - i].slice());
}

/** Rotate 90° clockwise: out[j][rows-1-i] = in[i][j]. A rows×cols input gives cols×rows. */
export function rotateClockwise(matrix: ReadonlyMatrix): number[][] {
    const rows = matrix.length;
    const cols = columnCount(matrix);
    const out = emptyOf(cols, rows);
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < matrix[i].length; j++) out[j][rows - 1 - i] = matrix[i][j];
    }
    return out;
}

/** Rotate 90° counterclockwise: out[cols-1-j][i] = in[i][j]. Exact inverse of `rotateClockwise`. */
export function rotateCounterclockwise(matrix: ReadonlyMatrix): number[][] {
    const rows = matrix.length;
    const cols = columnCount(matrix);
    const out = emptyOf(cols, rows);
    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < matrix[i].length; j++) out[cols - 1 - j][i] = matrix[i][j];
    }
    return out;
}

/** Circular shift of columns towards zero: out[i][j] = in[i][(j+1) mod cols]. */
export function shiftLeft(matrix: ReadonlyMatrix): number[][] {
    return matrix.map((row) => (row.length === 0 ? [] : [...row.slice(1), row[0]]));
}

/** Circular shift of columns away from zero: out[i][j] = in[i][(j-1) mod cols]. */
export function shiftRight(matrix: ReadonlyMatrix): number[][] {
    return matrix.map((row) =>
        row.length === 0 ? [] : [row[row.length - 1], ...row.slice(0, -1)]
    );
}

/** Circular shift of rows towards zero: out[i] = in[(i+1) mod rows]. */
export function shiftUp(matrix: ReadonlyMatrix): number[][] {
    if (matrix.length === 0) return [];
    return [...matrix.slice(1), matrix[0]].map((row) => row.slice());
}

/** Circular shift of rows away from zero: out[i] = in[(i-1) mod rows]. */
export function shiftDown(matrix: ReadonlyMatrix): number[][] {
    if (matrix.length === 0) return [];
    return [matrix[matrix.length - 1], ...matrix.slice(0, -1)].map((row) => row.slice());
}

/** All entries zero, same shape. This is the *only* exactly-zero matrix — the `Zero` generator is not. */
export function zeroMatrix(matrix: ReadonlyMatrix): number[][] {
    return matrix.map((row) => new Array<number>(row.length).fill(0));
}

/** Negate every entry, turning attraction into repulsion and back. Its own inverse. */
export function flipSign(matrix: ReadonlyMatrix): number[][] {
    // `-0` normalized back to `0`: it compares equal everywhere it matters but
    // serializes into a preset as `-0`, and `Object.is` would then report two
    // otherwise identical matrices as different.
    return matrix.map((row) => row.map((value) => (value === 0 ? 0 : -value)));
}

function emptyOf(rows: number, cols: number): number[][] {
    return Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
}

/**
 * Put `original`'s diagonal back into `transformed` — the semantics every one of
 * the eleven buttons in `InteractionMatrix.svelte` has always had.
 *
 * The functions above are ports of `matrix_operations.rs`, which transforms
 * every cell. The **shipped** behaviour is not that: each of the eleven inline
 * implementations in the component wrote `if (i === j) new[i][j] = old[i][j]`
 * and the panel says so in as many words ("Transformations preserve diagonal
 * (self-repulsion) values"). Those eleven Rust functions have no callers
 * anywhere in the repo — the UI reimplemented all of them — so the
 * diagonal-preserving version is the only one any user has ever experienced,
 * and `force_matrix[i][i]` is a species' self-interaction, which is a
 * physically distinct quantity from how it feels about the *other* species.
 * Rotating it onto another cell, or flipping it into self-attraction, is not
 * what any of these buttons is for.
 *
 * A composed wrapper rather than a flag on each function, because the choice is
 * the *caller's* — the Rust semantics stay exactly as `matrix_operations.rs`
 * wrote them and as the sixteen ported tests pin them, and there is one place
 * where the divergence is stated instead of eleven near-duplicate branches.
 *
 * For a non-square result (a rotation of a rectangular matrix) only the cells
 * that are on both diagonals are restored, which for the square force matrix is
 * all of them.
 */
export function withPreservedDiagonal(
    original: ReadonlyMatrix,
    transformed: ReadonlyMatrix
): number[][] {
    const out = transformed.map((row) => row.slice());
    for (let i = 0; i < out.length && i < original.length; i++) {
        if (i < out[i].length && i < original[i].length) out[i][i] = original[i][i];
    }
    return out;
}
