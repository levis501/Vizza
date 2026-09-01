# The Force Matrix

_Particle Life → Settings → the unlabeled grid of numbers (`force_matrix`)_

Particle Life has one idea in it. Every particle carries a species number, and a
small table says how each species feels about each other species. That table is
the whole simulation; the physics around it is four lines of arithmetic.

The part nobody guesses on first look is that **the table is not symmetric**.
Species 1 can be attracted to species 2 while species 2 is repelled by species
1 — and that one-way relationship is where the chasing, the churning cells, and
the things that look like they are eating each other all come from.

## What you are actually looking at

There is one buffer, of one struct (`compute.wgsl:4–9`):

```wgsl
struct Particle {
    position: vec2<f32>,
    velocity: vec2<f32>,
    species: u32,
    _pad: u32,
}
```

Position, velocity, and a species index. That is the entire state of the
simulation — no grid, no field, no trail. Nothing is written into the world and
read back later. Compare
[Slime Mold](../slime-mold/pheromone-deposition.md), which is this simulation's
structural inverse: there the agents are invisible, they never perceive each
other, and the image is the field they leave behind. Here there is no field at
all and particles read each other directly. **The particles _are_ the image**,
drawn as small filled circles, one per particle, and the species index
picks the color out of a nine-entry uniform (`fragment.wgsl:50`). How those
colors get chosen is [a separate topic](../gradient-editor/color-schemes.md);
for this page all that matters is that color = species identity, so you can read
the matrix off the screen.

Species are assigned at spawn and **never change**. The Type Generator paints
them into the initial layout — random, stripes, radial, spiral
(`init.wgsl:327–364`) — and after that a particle's species is fixed for life
(`init.wgsl:367–374`). Nothing in the simulation converts one species into
another. The default is 4 species, 15000 particles
(`settings.rs:145`, `manager.rs:323`), split evenly.

## The matrix

Species Count (`species_count`) is 2–8 (`ParticleLifeMode.svelte:226`), and the
matrix is that many rows by that many columns, each cell in −1.0 … 1.0. It is
flattened row-major for the GPU (`simulation.rs:565`) and read back with
(`compute.wgsl:59–60`):

```wgsl
fn get_force(species_a: u32, species_b: u32) -> f32 {
    let index = species_a * params.species_count + species_b;
```

and the only call site passes the pair in this order (`compute.wgsl:166`):

```wgsl
let attraction = get_force(particle.species, other.species);
```

`particle` is the one being updated. `other` is the neighbor. So:

> **Row = who feels the force. Column = who is causing it.**
> `force_matrix[i][j] > 0` means _species i is pulled toward species j_.
> It says nothing at all about how j feels about i.

Read that off the panel as: pick a row by its color swatch on the left
(`InteractionMatrix.svelte:14`), and every number in it describes that species'
attitude to everyone else. The column headers along the top
(`InteractionMatrix.svelte:7`) are the species being reacted _to_.

The grid has no heading, no axis labels, and its only instruction is "Click and
drag to edit values" (`ParticleLifeMode.svelte:239`). Nothing in the UI tells you
which way round the rows and columns go, and nothing warns you that `[i][j]` and
`[j][i]` are independent — so it is very easy to spend an hour editing the matrix
under the assumption that you are setting a mutual relationship. You are not.

## The force curve

Once the number is fetched, the distance between the two particles turns it into
a force magnitude (`compute.wgsl:68–83`):

```wgsl
fn calculate_force(distance: f32, attraction: f32) -> f32 {
    let rmax = params.max_distance;
    let force_multiplier = params.max_force;
    let beta = params.beta;
    ...
    if (distance < beta_rmax) {
        // Close range: linear repulsion
        return (effective_distance / beta_rmax - 1.0) * force_multiplier;
    } else if (distance <= rmax) {
        // Far range: species-specific attraction/repulsion
        return attraction * (1.0 - (1.0 + beta - 2.0 * distance / rmax) / (1.0 - beta)) * force_multiplier;
    }
    return 0.0;
}
```

Two zones, split at `beta × rmax` — the Physics panel draws exactly this curve
and labels them "Close Range / Repulsion Zone" and "Far Range /
Attraction/Repulsion Zone".

- **Inside `beta × rmax`, the matrix is ignored entirely.** `attraction` does not
  appear in that branch. Every particle repels every other particle at close
  range, including its own species, including a pair whose matrix entry is +1.0.
  This is what stops attraction from collapsing everything to a point, and it is
  why clusters have a visible grain rather than being solid blobs.
- **Between `beta × rmax` and `rmax`, the matrix is the whole story.** The
  magnitude is `attraction` scaled by a ramp.
- **Beyond `rmax`, nothing.** The neighbor is skipped before the square root is
  even taken (`compute.wgsl:154`).

The sign convention: `direction` points from this particle toward the neighbor
(`compute.wgsl:172–173`), so positive is "move toward it".

### The numbers

At the defaults — Max Force 0.5, Max Distance 0.05, Beta 0.5
(`settings.rs:147–153`) — and for a matrix entry of `a`:

| Distance        | Force     | What it is                        |
| --------------- | --------- | --------------------------------- |
| 0.000           | −0.50     | maximum repulsion (= −Max Force)  |
| 0.0125          | −0.25     | repulsion, fading                 |
| 0.0250 (β×rₘₐₓ) | 0.00      | the crossover                     |
| 0.0375          | +0.50 × a | species force, half strength      |
| 0.0500 (rₘₐₓ)   | +1.00 × a | species force, **strongest here** |
| 0.0501          | 0.00      | out of range                      |

Note the shape of the far half: the species-dependent force **grows all the way
out to the cutoff and then stops dead.** Plug `distance = rmax` into line 80 —
the bracket evaluates to 2, so the peak is `2 × a × max_force`, twice the
strongest possible close-range repulsion, and it occurs at the exact edge of the
interaction radius.

Most Particle Life implementations use a tent instead: force rises from zero at
`β×rₘₐₓ`, peaks midway, and falls back to zero at `rₘₐₓ`, so a neighbor drifting
out of range lets go gently. This one does not — the expression on line 80 is
missing the absolute value that would make it a tent. The practical consequence
is that `rₘₐₓ` behaves like a hard membrane at a specific radius rather than a
soft falloff, and it is why structures here have such crisp, uniform spacing.
The Physics panel plots the same rising ramp
(`InteractivePhysicsDiagram.svelte:161–179`), so what you see in the panel is
what the shader does.

Also worth knowing: `rₘₐₓ` at its default of 0.05 is small. The world is
`[−1, 1]` on both axes, i.e. 2 units across, so each particle sees only a disc
2.5% of the world's width. Every structure on screen is assembled out of
interactions no longer-ranged than that.

## The settings that matter, and how they interact

**Max Force** (`max_force`) is a pure multiplier on both zones. It scales the
whole curve, so it changes speed and energy without changing any relationship.

**Max Distance** (`max_distance`) is the cutoff `rₘₐₓ`, and it is the expensive
one. The neighbor loop is O(n²) with no spatial partitioning — the shader says so
itself (`compute.wgsl:143`) — so 15000 particles means 225 million pair tests per
frame regardless. Raising `rₘₐₓ` does not cost more tests, but it does mean far
more of them pass the cutoff and contribute force, which blurs distinct clusters
into one soup. It also stretches the whole force curve: `beta × rmax` moves with
it, so **the repulsion zone widens whenever you widen the radius**, and particles
sit further apart.

**Beta** (`force_beta`) splits the two zones. Near 0.1 you get a hair-thin
repulsive core and a wide species-driven ramp — loose, gassy, long-range
structures. Near 0.9 the repulsion fills almost the whole radius and the
species force is squeezed into a narrow, steep outer shell — rigid, crystalline,
tightly packed. Beta is the setting that decides whether the matrix has room to
express itself at all.

**Friction** (`friction`) is not friction. It is a per-frame velocity
_retention_ factor (`compute.wgsl:248`):

```wgsl
particle.velocity *= pow(params.friction, dt * 60.0);
```

**The slider is inverted relative to its label.** At the maximum, 1.0, nothing is
damped and particles keep their momentum forever; at the minimum, 0.01, roughly
99% of velocity is destroyed each frame and particles barely coast at all. The
slider is labeled "Friction" and runs 0.01 to 1.0
(`InteractivePhysicsDiagram.svelte:59, 65–66`), so dragging it right — toward
"more friction" — is what removes the damping.

At the default of 0.5, `pow(0.5, 0.96) ≈ 0.514`: about half of a particle's
speed is gone every frame. That is heavy damping, and it is why the system reads
as viscous rather than ballistic. It also means velocity is nearly proportional
to force — a particle under sustained maximum attraction settles at about 0.016
world units per second at 60 fps, roughly three seconds to cross one interaction
radius.

**dt** (`dt`) is fixed at 0.016 (`simulation.rs:654`) and is **never derived from
elapsed frame time** — nothing writes it except an explicit setting change. It
appears three times per step: it scales the force into velocity, the friction
exponent, and the velocity into displacement (`compute.wgsl:245, 248, 251`).
There is no control for it in the UI. Two things follow: the simulation runs
faster on a faster display, and `dt` is not a clean speed control — because it
also sits in the friction exponent, raising it damps harder at the same time as
it steps further, and past a point the integrator is coarse enough that
particles step straight through the close-range repulsion core.

The interaction to hold in your head is **Max Force against Friction**. Force
injects energy, friction removes it, and what you see is their equilibrium.
High Max Force with the Friction slider near 1.0 is a hot gas that never
settles. Moderate force with the slider nearer 0.5 is the syrupy, deliberate
regime the defaults are tuned for.

## Things to try, in order

1. **Make the matrix symmetric, then asymmetric.** Regenerate Matrix →
   **Symmetry** (`settings.rs:199–221` copies each value across the diagonal).
   Watch what you get: blobs. Clusters form, sit there, and stay put. Every
   relationship is mutual, so nothing ever has a reason to move once it has found
   its partners. Now switch to **Random** and regenerate. The screen comes alive
   — things chase, orbit, chew holes in each other. That difference is the entire
   subject of this page: **symmetric matrices make structures, asymmetric
   matrices make behavior.**
2. **Regenerate Matrix → PredatorPrey.** This is the asymmetry in its purest
   form: `[i][j] = 0.4` and `[j][i] = −0.3` for consecutive species
   (`settings.rs:320–321`), zero everywhere else. Each species chases the next
   and flees the previous. You get chains that pursue their own tails.
3. **Regenerate Matrix → RockPaperScissors** (`settings.rs:611–629`), same idea
   closed into a cycle, then set Species Count to 3 to see it cleanly.
4. **Hand-edit one cell.** Zero the matrix (the `0` button below the grid,
   "Set all matrix values to zero"), then set exactly one
   off-diagonal cell to +1.0 and leave its mirror at 0. One species now stalks
   another that is completely indifferent to it. Nothing else in the simulation
   can produce that.
5. **Set the diagonal positive.** Every default and generated matrix uses mild
   self-repulsion on the diagonal (−0.1 is typical, `settings.rs:124`). Flip the
   diagonal to +0.5 and each species condenses into its own dense knot, held
   apart only by the close-range repulsion. Useful for seeing what that universal
   repulsion is actually doing.
6. **Push Beta to 0.9, then to 0.1**, matrix unchanged. Same relationships, two
   completely different materials — brittle lattice versus drifting cloud.
7. **Drag Friction to 1.0.** Nothing is damped; the system heats up until it is
   uniform noise. Then to 0.05: everything freezes into place mid-motion. Both
   extremes destroy all structure, from opposite directions.
8. **Brownian Motion to 0.** The random kick (`compute.wgsl:229–240`, scaled by
   Max Force) is off, and patterns become noticeably more static and more prone
   to getting stuck in a dead arrangement. The default of 0.5 is doing more work
   than it looks like.

## Footnote: two settings that are not wired up

`Settings` carries `repulsion_strength` (`settings.rs:32`) and `min_distance`
(`settings.rs:35`), and both are saved into presets. Neither reaches the GPU:
they are absent from `SimParams`, and the shader hardcodes the minimum distance
as `0.001` (`compute.wgsl:72`) and uses `max_force` as the close-range
multiplier. `min_distance` can even be set through the backend API
(`simulation.rs:3445`) with no effect whatsoever. Neither appears in the UI, so
this only bites if you are reading the settings struct and expecting it to
describe the physics.

## Where this lives in the code

| Piece                      | Location                                                                |
| -------------------------- | ----------------------------------------------------------------------- |
| Matrix lookup              | `src-tauri/src/simulations/particle_life/shaders/compute.wgsl:59–65`    |
| Which pair, in which order | `…/compute.wgsl:166`                                                    |
| The force curve            | `…/compute.wgsl:68–83` (`calculate_force`)                              |
| Cutoff test                | `…/compute.wgsl:154`                                                    |
| Neighbor loop (O(n²))      | `…/compute.wgsl:143–174`                                                |
| Integration + friction     | `…/compute.wgsl:245, 248, 251`                                          |
| Brownian kick              | `…/compute.wgsl:229–240`                                                |
| Species assignment         | `…/shaders/init.wgsl:327–374`                                           |
| Species → color            | `…/shaders/fragment.wgsl:50`                                            |
| Matrix flattened for GPU   | `src-tauri/src/simulations/particle_life/simulation.rs:565`             |
| Defaults                   | `src-tauri/src/simulations/particle_life/settings.rs:117–157`           |
| Matrix generators          | `…/settings.rs:186` (`randomize_force_matrix`)                          |
| `dt` (fixed at 0.016)      | `…/simulation.rs:654`                                                   |
| Startup particle count     | `src-tauri/src/simulation/manager.rs:323`                               |
| Matrix grid UI             | `src/lib/components/particle-life/InteractionMatrix.svelte:210`         |
| Force curve plot + sliders | `src/lib/components/particle-life/InteractivePhysicsDiagram.svelte:161` |
| Mode panel                 | `src/lib/ParticleLifeMode.svelte:245, 259`                              |

Unlike Slime Mold, Particle Life has **no web port yet** — there is no
`src/lib/engine/sims/particleLife/`. The shaders still live in the single
`src-tauri/src/simulations/**/*.wgsl` corpus, so they are ready for one, but
today the simulation runs only in the desktop build.
