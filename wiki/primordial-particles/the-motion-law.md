# The Motion Law

_Primordial Particles → Physics Parameters → Alpha (`alpha`) and Beta (`beta`)_

Every particle in this simulation runs the same three-step loop, forever: count
who is nearby, turn, move forward. There is no attraction, no repulsion, no
collision, no force of any kind. The turn is the entire physics, and it is one
line of shader code.

This page is that line — what it does, what the five knobs around it actually
change, and the three places where Vizza's version departs from the published
rule it is named after.

## What you are looking at

10 000 particles (`state.rs:133`), each drawn as a small circular quad — the
fragment shader discards anything outside a disc (`particle_render.wgsl:147`) so
they read as dots rather than squares. They live on a **torus**: world space is
`[-1, 1]` in both axes, and by default Wrap Edges is on, so a particle leaving
the right edge reappears on the left (`particle_update.wgsl:205–216`). Turn Wrap
Edges off and positions are hard-clamped to the boundary instead
(`particle_update.wgsl:219`), which pins particles to the walls rather than
bouncing them.

**Nothing in the picture is a field.** Unlike Slime Mold there is no canvas being
written to and read back; the particles are the image, drawn directly.

### The default color does not mean what you might expect

Particle Color Mode defaults to **Heading** (`state.rs:144`), not Density. So out
of the box the color of a dot is the direction it is pointing
(`particle_render.wgsl:120`), and neighbor count is invisible. That is worth
knowing before you try to read structure out of the colors: two dots the same
color are travelling the same way, not sitting in equally crowded places.

Switch Particle Color Mode to **Density** and color becomes local crowding — and
that is what makes the cell structures legible, because a cell _is_ a
concentration. But the density it shows is not the `N` in the motion law. It is a
separate quantity computed by a separate pass, and it differs in two ways:

- **A different radius.** Density Radius (`density_radius`) defaults to 0.04
  (`state.rs:162`) while Interaction Radius defaults to 0.1. They are independent
  sliders and nothing keeps them in sync.
- **A different formula.** It is not a count. Each neighbor contributes
  `1.0 / (1.0 + distance²)` (`density_compute.wgsl:61`), so closer neighbors
  weigh more, and the sum is normalized by dividing by 16
  (`particle_render.wgsl:115`) before it hits the color scheme.

That `/ 16.0` is a fixed constant tuned for roughly the default particle count.
At 10 000 particles a typical dot has about 12–13 neighbors inside a 0.04 disc,
so the scale lands near the top of the LUT without clipping. **Raise Particle
Count and Density mode saturates**: everything past 16 reads as the same
end-of-scheme color and all contrast disappears. The fix is to pull Density
Radius down (its range is 0.005–0.1, `PrimordialParticlesMode.svelte:94–95`)
until the picture opens up again.

How the numbers become colors is the color scheme's job, covered in
[Color Schemes](../gradient-editor/color-schemes.md).

## The line

Every frame, each particle counts the particles within Interaction Radius and
splits them into those on its **left** and those on its **right**, relative to
where it is currently heading (`count_neighbors`, `particle_update.wgsl:74–121`).
Then it turns (`particle_update.wgsl:174–175`):

```wgsl
let delta_phi_mag = sim_params.alpha + sim_params.beta * f32(total_neighbors);
particle.heading = (particle.heading + turn_dir * delta_phi_mag * sim_params.dt) % (2.0 * PI);
```

and steps forward along the new heading (`particle_update.wgsl:198–202`). That
is the whole simulation.

Unpacked term by term:

- **`total_neighbors`** — `N`, everyone within Interaction Radius, in _all_
  directions (`particle_update.wgsl:87`). It is a full disc, not a forward cone;
  a particle senses what is behind it as readily as what is ahead.
- **`turn_dir`** — the sign, ±1, set by which side is more crowded
  (`particle_update.wgsl:166–171`). More on the right, turn right; more on the
  left, turn left. On an exact tie — which includes every isolated particle,
  where `L = R = 0` — it defaults to **+1**, right. The comment on that line
  calls it a "tie-breaker to the right to preserve alpha effect," and it is the
  only thing left of the published rule's constant handedness.
- **`alpha`** — a turn the particle makes whether or not anyone is nearby. It
  arrives in radians, converted from the degrees you see in the UI
  (`settings.rs:43–44`).
- **`beta`** — a turn _per neighbor_. This is the only term that knows how
  crowded things are.
- **`dt`** — a fixed 0.016 (`state.rs:136`). It is not measured from the frame
  clock; nothing in the simulation ever writes it except an explicit `dt`
  setting, and the UI exposes no control for it. So one frame is always 0.016
  units of simulated time, and **α and β are rates per second, not turns per
  step.**

The header comment on the shader states the rule it implements
(`particle_update.wgsl:2`):

```
Δφ = sgn(R-L) * (α + β * N_t,r)
```

## Where this diverges from the paper

The simulation is named for Schmickl, Stefanec & Crailsheim's 2016 paper _"How a
life-like system emerges from a simplistic particle motion law"_ (Nature
Scientific Reports), whose rule is

    Δφ = α + β · N · sign(R − L)

Vizza implements

    Δφ = sign(R − L) · (α + β · N)

The parenthesis moved, and it matters. In the paper **α is a constant
chirality**: every particle turns by α in the same direction on every step, no
matter what its neighbors do, and only the β term is steered by the crowd. That
constant bias is what gives the published system its handedness — its cells all
rotate the same way — and it is what makes α ≈ 180° special, since a particle
alone in space then reverses direction on each step and effectively holds
position.

Here the sign is applied to the whole expression, so α flips with the crowd too.
The constant handedness survives only for particles whose left and right counts
happen to be exactly equal, thanks to the `turn_dir = 1.0` tie-break.

Two smaller departures follow from the same code:

- **α is per second, not per step.** The `* sim_params.dt` at
  `particle_update.wgsl:175` scales it by 0.016, so the default α = 180° is
  180°/second — about 2.9° per frame, roughly 62 frames to reverse. The comment
  claiming α = 180° "makes isolated particles hold position within 2 time steps"
  (`settings.rs:9`) describes the paper, not this build. An isolated particle
  here traces a slow circle of radius v/α = 0.2/π ≈ 0.064 world units instead.
- **α and β are in different units.** α is converted from degrees to radians on
  the way to the GPU; β is passed through raw (`simulation.rs:1114–1115`). So β
  is **radians per neighbor**, sitting next to a slider labeled the same way as
  one in degrees. β = 1 is 57.3° of turn per neighbor per second, not 1°.

None of this stops the simulation being interesting. It does mean that a preset
copied from the paper will not reproduce the paper's picture, and that the
regimes below have to be found by eye.

## How the parameters interact

The whole rule is neighbor-count driven, so **the parameter that matters most is
the one that sets N** — and N is not a slider. It falls out of Particle Count and
Interaction Radius together.

For particles spread uniformly over the 2 × 2 world, the expected neighbor count
inside a disc of radius r is `count · πr² / 4`. Interaction Radius enters
_squared_; Particle Count enters linearly. At the defaults (10 000 particles,
r = 0.1) that is about **79 neighbors**, and the β term is therefore
0.1 × 79 ≈ 7.9 rad/s against α's π ≈ 3.1 rad/s:

| Particle Count | Interaction Radius | Typical N | β·N at β = 0.1 | vs α = 180°/s    |
| -------------- | ------------------ | --------- | -------------- | ---------------- |
| 10 000         | 0.1 (defaults)     | ≈ 79      | ≈ 450°/s       | β wins ≈ 2.5 : 1 |
| 10 000         | 0.05               | ≈ 20      | ≈ 113°/s       | α wins ≈ 1.6 : 1 |
| 1 000          | 0.1                | ≈ 8       | ≈ 45°/s        | α wins 4 : 1     |
| 100 000        | 0.1                | ≈ 785     | ≈ 4 500°/s     | β wins 25 : 1    |

So Interaction Radius is not really a "how far can I see" knob. **It is the
density knob**, and because of the square it is a violent one: halving it from
0.1 to 0.05 cuts the β term by a factor of four. Note also that the default of
0.1 sits at the very top of its own UI range
(`settings.rs:35`, `PrimordialParticlesMode.svelte:286`) — the only direction it
can be moved is down.

Velocity does not enter the turn at all; it sets how far a particle travels
between decisions. At the default 0.2 world units per second a particle covers
0.0032 units per frame and needs about 31 frames to cross its own interaction
radius, so its neighborhood changes slowly compared to how fast it is turning.
The ratio worth thinking about is v/ω, the turning radius: at the defaults that
is 0.2 / 11 ≈ 0.018 world units, comfortably _inside_ the 0.1 perception disc.
Particles orbit within their own field of view, which is why they clump instead
of dispersing.

### Velocity changes take about four seconds to land

Speed is stored per particle rather than read fresh from the setting
(`particle_update.wgsl:134`), and when the cursor is not being used it relaxes
toward the Velocity setting at a rate of `0.25 * dt` per frame — 0.4%
(`particle_update.wgsl:193–194`). That is a time constant of roughly 250 frames.
Drag the Velocity box and nothing appears to happen for a second or two; give it
four before deciding the slider is broken.

### The cost is quadratic

Both the update pass (`particle_update.wgsl:79`) and the density pass
(`density_compute.wgsl:42`) loop over every particle for every particle. There is
no spatial grid. At the default 10 000 that is 10⁸ distance tests per pass per
frame; Particle Count's maximum of 100 000
(`PrimordialParticlesMode.svelte:232`) is a hundred times that work, not ten.
Treat the top of that range as a still-life setting.

## Two rough edges you can see

Both come from WGSL's `%` operator, which — like C's `fmod` — takes the sign of
its **left** operand rather than wrapping into a positive range.

**Headings are not reduced to a single turn.** `particle_update.wgsl:175` applies
`% (2.0 * PI)` to the heading, which leaves it anywhere in (−2π, 2π) rather than
in (−π, π). Heading coloring assumes the narrow range: it computes
`(heading + PI) / (2.0 * PI)` (`particle_render.wgsl:120`) and `get_lut_color`
clamps that to 0…1 (`particle_render.wgsl:59`). So every heading above +π reads
as the top color of the scheme and every heading below −π reads as the bottom.
Particles are seeded with headings across the full [0, 2π)
(`state.rs:215`), so roughly half of them start pinned to one end of the color
scheme. Heading mode is a coarse direction indicator, not a faithful one.

**The left/right split is approximate.** The classification at
`particle_update.wgsl:109–110` does the same thing:

```wgsl
let relative_angle = atan2(dy, dx) - current_particle.heading;
let normalized_angle = ((relative_angle + PI) % (2.0 * PI)) - PI;
```

When `relative_angle + PI` is negative the remainder is negative too, so
`normalized_angle` lands in (−2π, 0) instead of (−π, π) and the neighbor is filed
on the wrong side. Because headings range over (−2π, 2π), that is not a rare
case. The rule only uses the _sign_ of R − L, so misfiled neighbors change the
outcome only when they are enough to flip the majority — but the crowding test is
noisier than the code reads.

## Things to try, in order

1. **Set Beta to 0.** This is the control experiment: N drops out of the rule
   entirely and every particle turns at a flat 180°/s, direction chosen by
   whichever side is more crowded (or right, on a tie). Neighbors can still steer
   _which way_ a particle turns but no longer _how hard_. Every arc now has the
   same curvature — radius v/α ≈ 0.064 — and only its handedness varies, so you
   get wandering circles of one fixed size and no cell structure at all.
   Everything interesting in this simulation is downstream of that one
   multiplication.

    To type 0, double-click the Beta box. Dragging it snaps to whole numbers
    (`step={1}`, `PrimordialParticlesMode.svelte:265`), which cannot express the
    default of 0.1 at all — one drag from the default jumps straight to 0 or 1,
    and since β is in radians, β = 1 is a tenfold increase, not a small nudge.

2. **Set Alpha to 0 instead, Beta back to 0.1.** Now the only turning is
   crowd-driven: a particle with a symmetric neighborhood flies dead straight,
   and turning is entirely a response to imbalance. The opposite control to
   step 1.

3. **Walk Interaction Radius down from 0.1 to 0.05, then 0.02.** Watch the
   picture loosen at each step — you are dividing the β term by 4, then by 25.
   This is the single most effective knob for finding a regime, because it moves
   N faster than anything else on the panel.

4. **Now do the same from the other side with Particle Count** — 10 000 down to
   3 000. Similar effect on N, linear rather than squared, and it changes the
   cost of a frame rather than just the physics.

5. **Push Beta to 1 (one drag step).** Turn rate at default density goes to about
   4 500°/s, or 72° of turn per frame. Past roughly 90° per frame the discrete
   integration stops approximating a curve at all, and what you are watching is
   an artifact of the step size rather than the rule.

6. **Switch Particle Color Mode to Density and lower Density Radius to ~0.02.**
   Structure that was invisible under Heading coloring becomes obvious, because
   color is now crowding — the thing the rule actually responds to.

7. **Turn Wrap Edges off.** Particles clamp rather than wrap
   (`particle_update.wgsl:219`), so they accumulate along the boundary at
   artificially high density. Useful mainly as a demonstration that N is doing
   all the work: the densest, most active region is now wherever the geometry
   piles particles up.

## Where this lives in the code

| Piece                      | Location                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------- |
| The turn                   | `src-tauri/src/simulations/primordial_particles/shaders/particle_update.wgsl:174–175` |
| Left/right neighbor count  | `…/shaders/particle_update.wgsl:74–121` (`count_neighbors`)                           |
| Sign selection + tie-break | `…/shaders/particle_update.wgsl:166–171`                                              |
| Move forward               | `…/shaders/particle_update.wgsl:198–202`                                              |
| Wrap / clamp               | `…/shaders/particle_update.wgsl:205–221`                                              |
| Speed relaxation           | `…/shaders/particle_update.wgsl:193–194`                                              |
| Density for coloring       | `…/shaders/density_compute.wgsl:61` (`compute_density`)                               |
| Density → color            | `…/shaders/particle_render.wgsl:115`                                                  |
| Heading → color            | `…/shaders/particle_render.wgsl:120`                                                  |
| Settings + defaults        | `src-tauri/src/simulations/primordial_particles/settings.rs:29–39`                    |
| α degrees → radians        | `…/settings.rs:43–44`                                                                 |
| Runtime state defaults     | `…/state.rs:130–164`                                                                  |
| Uniform packing            | `…/simulation.rs:1109–1128` (`SimParams`)                                             |
| UI controls                | `src/lib/PrimordialParticlesMode.svelte:242–304`                                      |
| UI description of the rule | `src/lib/PrimordialParticlesMode.svelte:26–31`                                        |

Two notes on that table. Unlike Slime Mold, Primordial Particles is **desktop
only** — there is no entry under `src/lib/engine/sims/`, so the settings and
defaults exist once, in Rust. And the About box in the UI
(`PrimordialParticlesMode.svelte:27`) states the rule as **Δφ = α + β × N**,
omitting the sign term entirely. The sign is the part that makes the simulation
work; without it a particle's turn would not depend on where its neighbors are,
only on how many there are.
