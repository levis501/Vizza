# Raycast Adjacency

_Voronoi CA → Voronoi Parameters — the setting that isn't there_

Every classical cellular automaton starts from a question so easy nobody asks
it: **who are my neighbors?** On a square grid the answer is free. It is the
eight cells touching yours, it is the same eight forever, and every rule anyone
ever wrote — B3/S23, Seeds, Day & Night — is a statement about a number between
0 and 8.

Voronoi CA runs those same rules on a tessellation of irregular polygons whose
seed points wander. So the free answer is gone. Something has to decide, every
frame, which cells touch which — and that decision, not the rule, is what makes
this simulation look the way it does.

There is no slider for it. This page is about what it actually does.

## What you are looking at

The whole simulation is one buffer of points. Each is 32 bytes
(`compute_update.wgsl:5–13`):

```wgsl
struct Vertex {
  position: vec2<f32>,
  state: f32,
  pad0: f32,
  age: f32,
  alive_neighbors: u32,
  dead_neighbors: u32,
  pad1: u32,
}
```

`position` is the **seed** — a point in pixel coordinates. `state` is the CA
cell: `>= 0.5` is alive, anything else is dead (`compute_update.wgsl:40`). At
startup 300 seeds are scattered uniformly and about 70% of them are switched on
(`simulation.rs:445`).

The polygons you see are not stored anywhere. They are the _consequence_ of the
seeds: every screen pixel is colored by whichever seed is nearest to it, and the
regions that fall out of that are the Voronoi cells. Move a seed and its polygon
reshapes itself, along with all of its neighbors', for free.

### The tessellation is a texture, built by jump flooding

Nearest-seed is computed on the GPU into an `Rgba32Float` texture the size of the
simulation, one texel per pixel, packing `(seed x, seed y, seed index, squared
distance)` (`jfa_init.wgsl:27–30`).

Two passes build it, both re-run from scratch **every frame**
(`simulation.rs:1505–1562`):

1. **Init** (`jfa_init.wgsl:55–75`) brute-forces it: each pixel loops over every
   seed and keeps the closest, under a toroidal metric that wraps at the edges
   (`jfa_init.wgsl:64–67`). The file's header comment advertises spatial
   partitioning; the code does not use it — line 53 says
   `let search_stride = 1u; // Always check every point for accuracy`.
2. **Jump flood** (`jfa_iteration.wgsl:44–77`) then runs the standard JFA:
   sample the eight neighbors at offset ±*k*, keep whichever seed is closest,
   halve _k_, repeat. The loop starts at the next power of two above the larger
   screen dimension and runs down to 1 (`simulation.rs:1519–1525`), so about a
   dozen passes.

The init pass alone already produces an exact diagram, so the flood is
belt-and-braces here. What matters downstream is that after these passes there
is a texture where **`textureLoad(...).b` is the index of the seed that owns
this pixel** — and that is the only handle the rest of the simulation has on the
geometry.

## Neighbors: 24 rays, and whatever they hit

Here is the mechanism. For each seed, `adjacency_build.wgsl` fires rays outward
in a full circle and records the first foreign territory each one lands in
(`adjacency_build.wgsl:82–101`):

```wgsl
for (var k = 0; k < sample_count; k = k + 1) {
  let angle = f32(k) * (two_pi / f32(sample_count));
  let dir = vec2<f32>(cos(angle), sin(angle));

  var t: f32 = step_size;
  var neighbor_id: u32 = center_site;
  var hit = false;
  var step = 0;
  loop {
    if (step >= max_steps) { break; }
    step = step + 1;
    let p = vec2<f32>(pos + dir * t);
    let q = vec2<i32>(
      (i32(floor(p.x)) % res.x + res.x) % res.x,
      (i32(floor(p.y)) % res.y + res.y) % res.y
    );
    let s = get_site_index_at_pixel(q);
    if (s != center_site) { neighbor_id = s; hit = true; break; }
    t = t + step_size;
  }
  …
}
```

The constants are three lines above it (`adjacency_build.wgsl:77–79`):
`sample_count = 24` rays, `step_size = 2.0` pixels per step, `max_steps = 1024`.
So the boundary is probed at **15° intervals**, marching outward two pixels at a
time. Hits are deduplicated against a local list and capped at
`MAX_NEIGHBORS = 16` (`adjacency_build.wgsl:35`, `109–112`), and the count of
distinct neighbors found is written out as that seed's **degree**
(`adjacency_build.wgsl:117`).

That is the entire definition of "neighbor" in this simulation. Not a radius,
not a k-nearest search, not a Delaunay triangulation — twenty-four rays and the
first thing each one bumps into.

### What that gets right

A Voronoi cell is convex, so a ray leaving the seed crosses its own boundary
exactly once, and the region on the far side of the edge it crosses is a genuine
Voronoi neighbor. Every hit is therefore a real neighbor. The raycast never
invents an adjacency.

### What it gets wrong, and why you can see it

**It misses small edges.** Twenty-four rays sample the cell's perimeter at 15°
of arc. A planar Voronoi tessellation of randomly scattered points has, by
Euler's formula, a mean of **six** edges per cell — so on average four rays land
on each edge and the sampling is comfortable. But cell degree is a distribution,
not a constant: an eight- or ten-sided cell has short edges subtending less than
15°, and those neighbors are simply not seen this frame. They may reappear next
frame after the seeds have shifted a pixel.

**Adjacency is not symmetric.** Each seed builds its own list independently and
counts only from its own list (`adjacency_count.wgsl:47–52`). Cell A can find B
while B misses A. In a classical CA the neighbor relation is symmetric by
construction; here it is a _directed_ graph that is only mostly symmetric, which
is a quiet source of the asymmetric, flickering fringes you see around dense
clusters.

**Small cells break it outright.** The ray marches in 2-pixel steps, and the
mean cell is about `sqrt(width × height / Point Count)` pixels across. Push
Point Count high enough and that number approaches the step size, at which point
rays leap clean over adjacent cells and land two or three cells away. Worse, the
shader first has to find a pixel it owns at all: it reads the texel under its
own seed and, if that texel belongs to someone else, probes a 3×3 neighborhood
(`adjacency_build.wgsl:57–71`). If _that_ fails — a cell smaller than a few
pixels — `center_site` silently stays as the wrong seed, and the site spends the
frame reporting somebody else's neighborhood.

## The rule does not know any of this

Neighbor counting is one loop over the list (`adjacency_count.wgsl:47–52`):

```wgsl
for (var k = 0u; k < deg && k < MAX_NEIGHBORS; k = k + 1u) {
  let j = neighbors.data[base + k];
  let u = vertices.data[j];
  if (u.state >= 0.5) { alive_n = alive_n + 1u; }
  else { dead_n = dead_n + 1u; }
}
```

and then `compute_update.wgsl` applies a Life-like rule to `alive_n`. Conway is
`case 4u` (`compute_update.wgsl:74–80`):

```wgsl
case 4u: { // B3/S23 - Conway's Game of Life
  if (is_alive) {
    next_state = select(0.0, 1.0, alive_n == 2u || alive_n == 3u);
  } else {
    next_state = select(0.0, 1.0, alive_n == 3u);
  }
}
```

Twenty-three rules are hard-coded this way as a `switch` on `rule_type`, from
Replicator at `case 0u` to `B9/S` at `case 22u`; the rulestring you pick in the
UI is mapped to that integer by a lookup table on the Rust side
(`simulation.rs:1347–1377`), falling back to Conway for anything unrecognized
(`simulation.rs:1375`).

**So: the rule does not cope with variable neighbor counts. It ignores them.**
There is no fraction, no threshold, no normalization — the comparisons are the
literal integers from the square-grid rule, applied to a degree that is whatever
24 rays happened to find. `alive_n == 3u` means _exactly three_, whether this
cell has four neighbors this frame or eleven.

The one place anything is normalized is _coloring_. Density mode divides
(`voronoi_render_jfa.wgsl:151–152`):

```wgsl
let total = max(1u, v.alive_neighbors + v.dead_neighbors);
intensity = clamp(f32(v.alive_neighbors) / f32(total), 0.0, 1.0);
```

That fraction is displayed and then thrown away. Nothing in the dynamics ever
sees it.

### The consequence: these are not the rules you remember

Life's B3/S23 was tuned against a Moore neighborhood of 8. Here the mean degree
is 6. Every birth and survival window is therefore being asked of a smaller
pool, which shifts the equilibrium upward — survival on 2 or 3 out of ~6 is a
much easier bar than 2 or 3 out of 8, so patterns stay denser and busier than
Conway ever looks on a grid.

At the other end the effect is absolute. The menu offers **Seeds (7 neighbors)**,
**(8 neighbors)** and **(9 neighbors)** — `B7/S`, `B8/S`, `B9/S`, which fire only
on `alive_n == 7u`, `8u`, `9u` (`compute_update.wgsl:186–206`). A cell needs
seven, eight or nine _distinct raycast neighbors, all alive simultaneously_.
With a mean degree of 6 and rays that under-sample high-degree cells, `B9/S` is
very nearly a null rule: pick it and the board goes dark and stays dark. That is
not a bug in the rule; it is the neighborhood being the wrong shape for it.

## The ground moves under the automaton

Seeds are displaced every frame by an independent random walk
(`brownian.wgsl:77–78`):

```wgsl
let dx = (random_displacement.x - 0.5) * 2.0 * speed * dt; // [-1, 1] * speed * dt
let dy = (random_displacement.y - 0.5) * 2.0 * speed * dt; // [-1, 1] * speed * dt
```

with toroidal wrapping so the world has no edges (`brownian.wgsl:84–85`), and
`speed` itself is a product (`brownian.wgsl:58`):

```wgsl
let speed = params.speed * uniforms.drift;
```

**Drift multiplies Brownian Speed.** Either one at zero freezes the seeds
completely; there is no other motion in the simulation. (The About panel calls
this "run-and-tumble dynamics" — it isn't. It is a plain uncorrelated random
walk, re-randomized every frame.)

This is the genuinely unusual part. In a normal CA the graph is a constant and
the states evolve on it. Here **both** evolve, and they evolve at different
rates. Every frame, unconditionally, the pipeline runs: move the seeds → rebuild
the JFA texture → recast all the rays → recount the neighbors. Only the last
step, the state update, is gated by a timer (`simulation.rs:1604–1606`):

```rust
let should_update_ca = !self.skip_next_state_update
    && (self.time_scale <= 0.0
        || self.time_accum - self.last_ca_update_time >= 1.0 / self.time_scale);
```

Since `time_accum` itself advances at `delta_time * time_scale`
(`simulation.rs:1389`), the period works out to `1 / time_scale²` seconds:

| Time Scale  | Generations per second  |
| ----------- | ----------------------- |
| 0           | every frame (see below) |
| 0.5         | 0.25 — one every 4 s    |
| 1 (default) | 1                       |
| 2           | 4                       |
| 5           | 25                      |

So at default settings the tessellation rewires sixty times for every one CA
generation. A cell's neighbors at generation _n_ are not the cells it was next
to at generation _n−1_. Nothing that depends on a stable neighborhood can
survive: gliders are impossible, oscillators do not close their cycles, and a
still life is only still for as long as its polygon is.

What you get instead is a slowly churning field where local density is
meaningful and local _structure_ is not — which is exactly what the default view
shows you.

### Time Scale 0 does not pause the automaton

Read the gate again. `time_scale <= 0.0` short-circuits to **true**, so the CA
updates every single frame. Meanwhile `dt` is zero, so the Brownian pass
displaces nothing.

**Time Scale = 0 is the static-topology mode**: seeds frozen, tessellation
frozen, adjacency frozen, and the rule running at full frame rate on a fixed
graph. It is a genuine irregular-lattice cellular automaton, and it is the single
most instructive thing in this simulation. Note that this is not what the label
suggests and not what the pause button does — pausing takes a different code
path that skips the update pass entirely (`render_frame_paused`,
`simulation.rs:2003–2013`), freezing states as well.

## The settings that matter, and how they interact

Named as the UI labels them, all in **Voronoi Parameters**:

| Setting                                     | Range    | What it actually controls                                                           |
| ------------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| **Cellular Automaton Rule** (`rulestring`)  | 23 rules | Which `case` in the switch. Assumes 8 neighbors; gets ~6.                           |
| **Point Count** (`numPoints`)               | 10–5000  | Number of seeds — and therefore cell size, and therefore whether the raycast works. |
| **Brownian Speed (px/s)** (`brownianSpeed`) | 0–300    | Base step size of the random walk.                                                  |
| **Drift** (`drift`)                         | 0–2      | Multiplier on Brownian Speed. Zero here is zero motion.                             |
| **Time Scale** (`timeScale`)                | 0–5      | Generations per second = Time Scale². Also scales motion, linearly.                 |

The interactions worth knowing:

- **Drift × Brownian Speed** is a single quantity. Two sliders, one number
  (`brownian.wgsl:58`). If motion looks stuck, check both.
- **Time Scale vs. motion.** Time Scale multiplies generations _quadratically_
  and seed motion _linearly_. Raise it and the automaton starts to outrun the
  geometry — the graph is more nearly constant from one generation to the next,
  and rule-like behavior begins to show through. Lower it and you get the
  opposite: a fully rewired world between every pair of generations.
- **Point Count vs. adjacency fidelity.** Cell width ≈ `sqrt(W × H / count)`
  pixels against a 2-pixel ray step and a 15° angular resolution. Low counts:
  big cells, clean and near-complete neighbor lists. High counts: cells a few
  pixels wide, rays overshooting, degree under- and mis-reported. The
  tessellation still _renders_ perfectly at 5000 points — the JFA is exact — so
  the degradation is invisible as geometry and shows up only as wrong dynamics.
- **Coloring Mode vs. everything.** Random mode hashes the seed index
  (`voronoi_render_jfa.wgsl:148`) and shows you nothing about the CA at all.
  Density shows the neighbor fraction, Binary shows raw state
  (`voronoi_render_jfa.wgsl:158`), Age shows how long a cell has been alive
  (`compute_update.wgsl:217–221`). The default is Density
  (`simulation.rs:1114`, `VoronoiCAMode.svelte:293`). Which colors those
  intensities become is the [color scheme](../gradient-editor/color-schemes.md)'s
  business, not this page's.

Left-click paints cells alive, right-click paints them dead, within the cursor
radius (`simulation.rs:2153–2155`, `2203–2209`). Painting sets a flag that
suppresses exactly one CA step so your stroke is not immediately eaten
(`simulation.rs:2250`).

## Things to try, in order

1. **Set Time Scale to 0, then paint.** The seeds stop, the tessellation locks,
   and the rule runs flat out on a fixed irregular graph. Switch Coloring Mode
   to **Binary** first so you are watching state and not density. Paint a blob
   with the left mouse button and watch it evolve. _This is the control
   condition_ — a real CA on a real, if strange, lattice. Everything else on this
   page is a departure from it.
2. **From there, nudge Time Scale to 1.** Motion resumes, generations drop to
   one per second, and whatever coherent structure you had dissolves within a few
   seconds. You have just watched the difference between a CA and this.
3. **Set Drift to 0 instead, with Time Scale back at 1.** Seeds frozen, but
   generations now timed rather than per-frame. Same static graph as step 1, at a
   watchable pace — the best way to actually read what a rule does here.
4. **Compare rules on the frozen graph.** With Drift 0, cycle Cellular Automaton
   Rule. **Life without Death** (`B3/S012345678`, `compute_update.wgsl:67–73`)
   fills the board and never retreats — a clean demonstration that the graph is
   connected. **Seeds** (`B2/S`) flickers and dies. **B9/S** does nothing at all,
   because nine simultaneously-alive raycast neighbors essentially never happen.
5. **Turn Point Count down to ~50, Drift back up to 1.** Huge cells, generously
   sampled by 24 rays, moving visibly. This is the regime where the adjacency
   graph is most trustworthy and you can actually watch a cell gain and lose
   neighbors as its polygon reshapes.
6. **Now take Point Count to 5000.** The picture gets prettier and the dynamics
   get worse: cells only a few pixels across, rays skipping over neighbors, some
   seeds reporting a stranger's neighborhood. Switch to Density coloring and note
   how much noisier the field is than at 50 points. That noise is measurement
   error, not emergence.
7. **Enable Borders.** Not part of the mechanism, but it draws the actual cell
   edges, which makes it possible to eyeball how many neighbors a cell really has
   versus how many 24 rays would find.

## Footnotes

**A spatial grid that nothing reads.** Every frame the pipeline clears and
populates a uniform spatial hash of the seeds (`simulation.rs:1463–1482`,
`grid_populate.wgsl`). Its bind group is built and kept
(`simulation.rs:595–606`), but there is no pipeline that consumes it — the JFA
init does a full O(N) scan by choice, and adjacency reads the texture. It is
vestigial work. If you are profiling, it is free performance.

**The About panel describes a different simulation.** The blurb at
`VoronoiCAMode.svelte:22–30` promises "run-and-tumble dynamics", and says
"parameters control neighborhood size, activity thresholds, and temporal
behavior", inviting you to experiment with "neighborhood radius". There is no
neighborhood-size parameter, no activity threshold, and no neighborhood radius
anywhere in this simulation — the neighborhood is 24 fixed rays, and the motion
is an uncorrelated random walk. Read the sliders, not the paragraph.

**The seeding comment is backwards.** `simulation.rs:445` reads
`state: if rng.random::<f32>() > 0.3 { 1.0 } else { 0.0 }, // More dead cells for painting`.
That produces roughly 70% _alive_, not more dead.

## Where this lives in the code

| Piece                             | Location                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **The raycast — 24 rays**         | `src-tauri/src/simulations/voronoi_ca/shaders/adjacency_build.wgsl:82–101`                                 |
| Ray constants (24 / 2px / 1024)   | `…/adjacency_build.wgsl:77–79`                                                                             |
| Neighbor cap, dedup, degree write | `…/adjacency_build.wgsl:35`, `109–112`, `117`                                                              |
| Own-pixel probe fallback          | `…/adjacency_build.wgsl:57–71`                                                                             |
| Alive/dead tally                  | `…/adjacency_count.wgsl:47–52`                                                                             |
| The rule switch (23 cases)        | `…/compute_update.wgsl:45–214`                                                                             |
| Conway's case                     | `…/compute_update.wgsl:74–80`                                                                              |
| Age update                        | `…/compute_update.wgsl:217–221`                                                                            |
| Seed motion                       | `…/brownian.wgsl:77–78`; Drift multiply at `…/brownian.wgsl:58`                                            |
| Voronoi texture, exact pass       | `…/jfa_init.wgsl:55–75` (format documented at `27–30`)                                                     |
| Voronoi texture, flood pass       | `…/jfa_iteration.wgsl:44–77`                                                                               |
| Density / Binary intensity        | `…/voronoi_render_jfa.wgsl:151–152`, `158`                                                                 |
| Per-frame pass order              | `src-tauri/src/simulations/voronoi_ca/simulation.rs:1414–1621`                                             |
| CA update gate                    | `…/simulation.rs:1604–1606`                                                                                |
| Rulestring → `rule_type`          | `…/simulation.rs:1347–1377`                                                                                |
| Painting                          | `…/simulation.rs:2153–2155`, `2203–2209`                                                                   |
| Initial seeding                   | `…/simulation.rs:436–452`                                                                                  |
| Desktop settings struct           | `src-tauri/src/simulations/voronoi_ca/settings.rs`                                                         |
| UI controls                       | `src/lib/VoronoiCAMode.svelte:152` (rule), `163` (count), `174` (speed), `185` (drift), `196` (time scale) |

The shader corpus is not duplicated between platforms: the desktop build embeds
`src-tauri/src/simulations/**/*.wgsl` with `include_dir!`, and the web build
globs the same files (`src/lib/engine/shaders/index.ts`). One corpus, both
targets — though note that unlike Slime Mold, Voronoi CA has no
`src/lib/engine/sims/` counterpart, so the Rust side is the only settings
implementation.
