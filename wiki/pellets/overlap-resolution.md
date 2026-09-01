# Overlap Resolution

_Pellets → Physics → Overlap Resolution Strength (`overlap_resolution_strength`)_

Two pellets never push each other apart. Nothing in Pellets applies a contact
force worth the name. What keeps a pile of discs from collapsing into a single
point is a **positional correction** — a pass that finds overlapping pairs and
teleports them apart a little, every frame, without touching their velocities.
Understand that one pass and the rest of the simulation falls into place.

## First, the claim in the menu

The main menu describes Pellets as _"2D particle physics with gravity and phase
transitions"_ (`src/lib/MainMenu.svelte:70`). Both nouns need adjusting before
anything else makes sense.

**There is no phase machinery.** No temperature setting, no cohesion setting, no
per-particle phase field, no state machine, no branch anywhere on solid / liquid
/ gas. The word "phase" appears in this simulation exactly three times, all in
the same sentence, and it means something else entirely — the three _stages of
the collision solver_: "broad phase, narrow phase, and overlap resolution"
(`src/lib/PelletsMode.svelte:22–23`, echoing the shader's own header comment at
`physics_compute.wgsl:3–6`). The menu blurb reads like someone glanced at that
line and promoted "3-phase collision system" into "phase transitions."

**There is no gravity either**, in the sense of a direction called down. There
is no floor, no gravity vector, and the world is a torus — a particle leaving the
right edge reappears on the left (`physics_compute.wgsl:201–211`). The setting
called Gravitational Constant is a pairwise attraction between pellets, N-body
style, and as we will see it is short-ranged enough to be better described as
cohesion.

So what _can_ you actually see? Something more interesting than the blurb, as it
happens. Pellets is a bag of hard discs on a torus, and hard discs on a torus
have a real, well-known phase behaviour that depends on one number: how much of
the available area the discs cover. You can cross that transition in this app.
You cross it with **Particle Count**, and nothing in the code knows it is
happening. The rest of this page is about why, and about the solver that decides
what the ordered side looks like.

## What you are looking at

One flat buffer of particles (`physics_compute.wgsl:11–21`):

```wgsl
struct Particle {
    position: vec2<f32>,
    velocity: vec2<f32>,
    mass: f32,
    radius: f32,
    clump_id: u32,
    density: f32,
    grabbed: u32,
    _pad0: u32,
    previous_position: vec2<f32>,
}
```

Half of that is vestigial. `mass` is set to `1.0` for every particle at spawn
(`simulation.rs:1511`) and never changes, so every mass term in the physics
cancels. `radius` is written per particle but the physics never reads it — it
uses the global `params.particle_size` instead. `clump_id` is set to `0` and
nothing ever writes another value. `previous_position` is repurposed as the grab
offset. `density` is not a physical quantity at all: it is a **display** value,
recomputed every few frames (`simulation.rs:1615`) and holding whatever the
active Particle Color Mode wants to show — a neighbour count, a speed, or a
per-index random number (`density_compute.wgsl:35–45`). It feeds the color
lookup and nothing else. For how that number becomes a color, see
[Color Schemes](../gradient-editor/color-schemes.md).

Each particle is drawn as one quad, instanced nine times so the torus wrap is
visible across all edges (`particle_render.wgsl:99–100`), with the fragment
shader discarding anything outside a disc of radius `0.45` in quad-UV space
(`particle_fragment_render.wgsl:51`). The quad half-extent is
`params.particle_size` (`particle_render.wgsl:120`, `:124`), so:

> **The disc you see has 90% of the radius the physics uses.** Two pellets in
> firm contact are drawn with a visible gap between them. If the screen looks
> loosely packed, it is 10% tighter in radius — 19% tighter in area — than it
> looks.

## The collision impulse is not doing the work

There _is_ a hand-written elastic collision response, in
`compute_collision_forces_grid`. For two overlapping particles approaching each
other it computes the textbook impulse (`physics_compute.wgsl:337–340`):

```wgsl
var impulse_magnitude = -2.0 * velocity_along_normal;
impulse_magnitude = impulse_magnitude / (1.0 / particle.mass + 1.0 / other.mass);
// Slight inelastic bias to help damp oscillations
impulse_magnitude *= min(params.collision_damping, 0.98);
```

With every mass equal to 1, that reduces to `-0.98 · v_normal` — a full, nearly
elastic reversal of the approach speed. It should make pellets bounce hard.

It does not, because of where the result goes. `compute_collision_forces_grid`
is called from `compute_acceleration` (`physics_compute.wgsl:239`), and
`compute_acceleration` supplies the `k` terms of a fourth-order Runge–Kutta step
(`physics_compute.wgsl:143–163`). An **impulse** returned as an **acceleration**
gets multiplied by `dt` on its way into the velocity. `dt` is hard-coded to
`1.0/60.0` (`simulation.rs:1653`), so the actual velocity change is:

    Δv ≈ dt × (−0.98 · v_normal) ≈ −0.016 · v_normal

Roughly **1.6% of the correct bounce per frame.** Pellets do not bounce off each
other in any meaningful sense; they sink into each other and drift out again.
Everything that looks like solidity is the next section.

## The mechanism: `resolve_collisions`

After integration, damping, and before the torus wrap, every particle runs
`resolve_collisions` (called at `physics_compute.wgsl:198`, defined at `:363`).
It ignores forces and velocities entirely and edits position. The whole pass
builds up to one statement (`physics_compute.wgsl:497`):

```wgsl
(*particle).position += separation;
```

That is the only thing in Pellets that separates two pellets. Everything else is
how `separation` is chosen.

**1. Find the overlaps.** Contact distance is `2.0 * particle_size`
(`physics_compute.wgsl:366`), so Particle Size is a **radius**, not a diameter.
Neighbours come from a 3×3 block of a uniform spatial grid, and each overlap
contributes its depth to a running sum (`physics_compute.wgsl:414–419`).
Directions are accumulated weighted by depth; the magnitude is a **sum over all
neighbours**, not a per-pair figure, so a particle wedged in a pile gets a large
`total_overlap` and a direction that is the average of everything shoving it.

**2. Scale it.** Three multipliers stack (`physics_compute.wgsl:445–457`): the
setting itself, up to 2.5× for a fast-moving particle, up to 2.5× for one with
many neighbours, and a flat 1.5× "50% stronger base resolution". The result is
capped at 1.2 — a cap the UI cannot reach, since 10% × 2.5 × 2.5 × 1.5 = 0.94.
The step is then `min(half_overlap × strength, max_separation_distance)`
(`physics_compute.wgsl:464`).

**3. Randomise the direction.** This is the part worth staring at
(`physics_compute.wgsl:472`):

```wgsl
let angle_variation = (angle_random - 0.5) * 1.6; // ±0.8 radians (±46 degrees)
```

The separation direction — the one physically correct vector in the whole pass —
is then rotated by up to **±46°** before being applied, plus a smaller tangential
jitter (`physics_compute.wgsl:493`). The comment says it is there "to break up
wave patterns," and it works: it is also, structurally, a machine for destroying
crystalline order. Keep it in mind when you get to the experiments.

**4. Do it three times, sometimes.** The whole thing loops three times per frame
(`physics_compute.wgsl:371`), but each particle only participates in each
iteration with probability ~60% (`physics_compute.wgsl:376`, `:382`), decided by
a hash of index, frame, and iteration. So a particle is corrected about 1.8 times
per frame on average, not 3, and _which_ particles get corrected changes every
frame. A tiny deadband stops the correction once overlaps fall below 0.3% of a
radius (`physics_compute.wgsl:490–492`), which is what lets a pile go still
instead of buzzing forever.

### The numbers

The slider is a percentage, 0–10, stored as 0.0–0.1. For a single resting
contact, one participating iteration moves this particle by `0.86 × S` of the
overlap, and its partner does the same, so the pair's gap closes by roughly
`3 × S` of its overlap per frame once you fold in the ~1.8 participating
iterations:

| Overlap Resolution Strength | Overlap removed per frame | Time to halve an overlap |
| --------------------------- | ------------------------- | ------------------------ |
| 10% (maximum)               | ~31%                      | ~2 frames                |
| 2% (default)                | ~6%                       | ~11 frames (0.2 s)       |
| 0.5%                        | ~1.6%                     | ~44 frames (0.7 s)       |
| 0%                          | 0                         | never                    |

**At the default of 2%, contacts are soft.** A pellet pushed into a pile stays
visibly buried for a fifth of a second before it works its way out. That is the
default look: not a crisp packing of hard discs, but a mound of overlapping,
slowly-relaxing ones.

At 0% there is nothing left. The impulse from the previous section is a
rounding error, so pellets pass straight through each other and the simulation
becomes a non-interacting gas. That is the control condition, and it is the
fastest way to convince yourself this pass is the whole story.

## Gravity is a short-range cohesion force

`compute_gravity_grid` looks like Newtonian gravity — softened inverse-square,
`G · m₁ · m₂ / r²` (`physics_compute.wgsl:269`). Two things shrink it drastically.

**The attenuation window.** Beyond `interaction_radius` the force is set to
exactly zero, and inside it the force is multiplied by a linear ramp
(`physics_compute.wgsl:271–273`). `interaction_radius` is hard-coded to `0.5`
(`simulation.rs:1655`) and is not exposed anywhere in the UI.

**The grid, which binds much harder.** Neighbours are only ever gathered from the
3×3 block around a particle's own cell, and the cell size is derived from
particle size (`simulation.rs:538`):

```rust
let cell_size = (settings.particle_size * 3.0).max(0.01);
```

At the default size of 0.015 that is a cell of 0.045, so a particle can only
ever see other particles within roughly 0.09 world units — three particle
diameters. The 0.5 attenuation radius never comes into play. **"Gravity" here
reaches about three pellet-widths and then stops.** It is a cohesion force with a
misleading name.

The default value makes it invisible on top of that. At `gravitational_constant
= 1e-7` (`settings.rs:146`), two touching pellets attract with an acceleration
around 2×10⁻⁴, against speeds of order 0.1. Nothing happens. The slider runs to
0.01, but by 0.01 the attraction is violent enough to slam every particle into
the speed cap within a couple of frames. **The usable band is roughly 1e-5 to
1e-3 — the bottom 10% of the slider.** The drag box steps by 1e-6, so you can get
there; you just have to know to stay down low.

Gravity Softening (`gravity_softening`, default 0.003) adds a constant to the
squared distance (`physics_compute.wgsl:267`) so the force does not blow up as
`r → 0`. At 0.003 against a contact distance of 0.03 it contributes 1% of the
denominator — it only matters for particles that are already deeply overlapped,
which is exactly the case it exists to survive.

## There is no temperature, and only a brake

The energy budget is worth laying out, because "phase" language invites you to
look for a heat knob and there is not one.

**Sources of kinetic energy:** the initial velocities at spawn
(`simulation.rs:1528`), and the mouse. That is all.

**Sinks:**

- **Energy Lost per Tick (%)** (`energy_damping`) — one multiply on the velocity
  every frame (`physics_compute.wgsl:166`). The UI shows `(1 − energy_damping) ×
100` (`PelletsMode.svelte:197–208`). It is a _velocity_ retention factor, so
  1% shown is closer to 2% of the kinetic energy; treat the label as indicative.
  **Default is 1.0 — zero loss.** Out of the box, nothing cools.
- **Energy Lost on Collision (%)** (`collision_damping`) — scales the impulse
  that we established is worth 1.6% of itself. Its practical effect is close to
  nil. Also note the shader silently clamps it: `min(params.collision_damping,
0.98)` (`physics_compute.wgsl:340`), so 0% loss in the UI is really 2%.
- **Density-Based Damping** (`density_damping_enabled`, off by default) — counts
  neighbours and removes up to 10% of velocity per frame in crowded regions
  (`physics_compute.wgsl:192–194`). This is the one honest, phase-flavoured
  control in the panel: it makes dense regions viscous and sparse regions not.
- **The speed ceiling** (`physics_compute.wgsl:214–216`):

    ```wgsl
    let dynamic_cap = 0.8 * params.particle_size * inv_dt;
    let max_velocity = min(5.0, dynamic_cap);
    ```

    At default size and `dt = 1/60` that caps speed at 0.72 world units per second
    — deliberately under one radius of travel per frame, which is what stops
    particles from tunnelling through each other. It is also a hard ceiling on how
    "hot" the system can ever get.

Note what is missing: **there is no way to add energy from the settings panel.**
Initial Velocity Min/Max exist in the settings struct and in the backend's update
handler, but `PelletsMode.svelte` never draws a control for them. The only heat
source available to you at runtime is grabbing pellets and flinging them.

## What actually behaves like a phase transition

Strip all the above away and Pellets is a system of hard discs on a periodic
square with weak, tunable cohesion and adjustable dissipation. The parameter that
governs hard-disc behaviour is the **packing fraction** — the fraction of the
domain the discs cover:

    φ = N · π · s² / (4 · A)

where `N` is Particle Count, `s` is Particle Size (a radius), and `A` is your
window's aspect ratio. `A` is in there because collisions are measured in
aspect-corrected coordinates (`physics_compute.wgsl:326–327`) while the torus is
a fixed [−1, 1] square — so **widening the window genuinely lowers the density**
and can move you across the transition without touching a setting.

At the default Particle Size of 0.015 on a 16:9 window:

| Particle Count | φ    | What you get                                      |
| -------------- | ---- | ------------------------------------------------- |
| 1000           | 0.10 | dilute gas — long free flights, rare contacts     |
| 3000           | 0.30 | dense gas — contacts constant, no structure       |
| 5000 (default) | 0.50 | liquid — pellets always touching, freely flowing  |
| 7000           | 0.70 | the knee — flow slows, local order appears        |
| 9000           | 0.89 | jammed — collective motion only, near close-pack  |
| 10000          | 0.99 | over-packed — permanent overlap, nothing resolves |

Real 2D hard discs go from fluid to hexatic at φ ≈ 0.70 and hexatic to solid at
φ ≈ 0.72, and the qualitative change around 7000 pellets is that transition
showing up in your window. **That is the honest version of "phase transitions":
an emergent consequence of density, not a feature.** No code branches on it.

Two caveats keep it from being a clean demonstration:

- On a **square** window the same 5000 pellets give φ ≈ 0.88 — already jammed
  out of the box. The defaults are tuned for a wide window and are much more
  interesting there.
- The ±46° random rotation of every separation direction actively destroys the
  hexagonal ordering that would make the solid side legible. You get a jammed,
  shimmering mass rather than a crystal. Turning Overlap Resolution Strength up
  makes the packing tighter but not more ordered, because the noise scales with
  it.

## Things to try, in order

1. **Set Overlap Resolution Strength to 0.** Everything else untouched. The
   pellets stop interacting and drift through one another as if the others were
   not there. This is the control condition: it shows that the collision impulse
   contributes essentially nothing, and that this one positional pass is the
   entire contact model.
2. **Back to 2%, then take Particle Count from 5000 up through 9000, pausing at 7000.** Watch for the moment the mass stops flowing and starts moving in
   sheets — individual pellets can no longer swap places with their neighbours.
   That is the jamming transition, and it is the only "phase transition" in the
   app.
3. **Now go the other way, down to 1000.** A gas. Same rules, same solver, no
   structure — density was doing all the work.
4. **Back to 5000. Set Energy Lost per Tick to 2%, then raise Gravitational
   Constant from its default in steps: 1e-5, 1e-4, 5e-4.** Somewhere around 1e-4
   the cohesion starts winning and the sheet breaks into blobs that merge on
   contact. This is the closest thing to condensation the simulation offers — and
   note that because attraction only reaches three pellet-widths, distant blobs
   never find each other. They coarsen by collision, not by gravity.
5. **Push Gravitational Constant to 0.005 or beyond.** The attraction now beats
   the overlap resolver outright. Pellets crush into each other, visibly
   overlapping and refusing to separate, and the speed cap is the only thing
   keeping it stable. Then raise Overlap Resolution Strength to 10% and watch it
   fight back — this is the cleanest demonstration of the two forces that set the
   simulation's "hardness."
6. **Turn Density-Based Damping on with Particle Count at 7000.** Dense regions
   go viscous while sparse ones stay lively, which is much more phase-like than
   anything the phase blurb promised.
7. **Drag Particle Size up to 0.05 and watch collisions stop working.** See the
   footnote below — this one is a bug, not a setting.

## Footnote: Particle Size does not rebuild the grid

`cell_size`, `grid_width`, and `grid_height` are computed once, at construction,
from the particle size in effect at that moment (`simulation.rs:538–540`). The
runtime handler for `particle_size` updates the per-particle radii and the render
parameters and nothing else (`simulation.rs:2829–2835`).

So if you raise Particle Size while the simulation is running, the contact
distance `2 × particle_size` grows but the neighbour search does not. Once the
contact distance exceeds the 3×3 grid neighbourhood — around size 0.045 if you
started at the default 0.015 — pellets stop finding most of the neighbours they
are overlapping, and the pile turns into a soup of interpenetrating discs. The
overlap resolver is not broken; it is being handed an incomplete neighbour list.

There is a second, milder version of the same problem: each grid cell stores at
most 64 particle indices (`grid_populate.wgsl:30`, `:78`) and silently drops the
rest. At high packing fractions with small cells this is rarely hit, but it is
another way for neighbours to go missing.

Restart the simulation after a large Particle Size change and the grid is rebuilt
correctly.

## Footnote: the mouse does not attract

The UI offers "🖱️ Left click: Attract particles" (`PelletsMode.svelte:127`) and
there is an attraction force in the shader to match (`compute_mouse_force`,
`physics_compute.wgsl:286–303`). It never fires.

The force returns zero for anything further than `cursor_size` from the cursor
(`physics_compute.wgsl:291`) — but every particle within `cursor_size` has
already been **grabbed** a few lines earlier (`physics_compute.wgsl:98–108`), and
grabbed particles take an early-out path that skips force computation entirely
(`physics_compute.wgsl:118–139`). The two regions are identical, so the
attraction branch is dead in practice.

What the mouse actually does is grab-and-throw: pellets in the cursor lock to it
rigidly, and on release they inherit `mouse_velocity × cursor_strength × 2`
(`physics_compute.wgsl:112`). Only the left button does anything at all
(`simulation.rs:3070–3071`). It is a good tool — it is your only heat source —
but it is not attraction.

## Where this lives in the code

| Piece                         | Location                                                             |
| ----------------------------- | -------------------------------------------------------------------- |
| The separation itself         | `src-tauri/src/simulations/pellets/shaders/physics_compute.wgsl:497` |
| `resolve_collisions`          | `…/physics_compute.wgsl:363–499`                                     |
| Strength scaling              | `…/physics_compute.wgsl:445–464`                                     |
| The ±46° randomisation        | `…/physics_compute.wgsl:470–481`                                     |
| Stochastic participation      | `…/physics_compute.wgsl:371–388`                                     |
| RK4 integration               | `…/physics_compute.wgsl:143–163`                                     |
| Collision impulse (vestigial) | `…/physics_compute.wgsl:305–352`                                     |
| Pairwise attraction           | `…/physics_compute.wgsl:244–284` (`compute_gravity_grid`)            |
| Per-tick velocity damping     | `…/physics_compute.wgsl:166`                                         |
| Density-based damping         | `…/physics_compute.wgsl:169–195`                                     |
| Speed cap / anti-tunnelling   | `…/physics_compute.wgsl:213–220`                                     |
| Toroidal wrap                 | `…/physics_compute.wgsl:200–211`                                     |
| Grab and throw                | `…/physics_compute.wgsl:98–139`                                      |
| Spatial grid insertion        | `…/shaders/grid_populate.wgsl:58–82`                                 |
| Display-only `density`        | `…/shaders/density_compute.wgsl:26–48`                               |
| Quad + 9× wrap instancing     | `…/shaders/particle_render.wgsl:92–141`                              |
| Disc cutout (0.9 × radius)    | `…/shaders/particle_fragment_render.wgsl:51`                         |
| Grid sizing (once, at init)   | `src-tauri/src/simulations/pellets/simulation.rs:536–541`            |
| `dt`, `interaction_radius`    | `…/simulation.rs:1646–1669` (`update_physics_params`)                |
| Particle spawn                | `…/simulation.rs:1504–1547`                                          |
| Settings + defaults           | `src-tauri/src/simulations/pellets/settings.rs:88–155`               |
| UI controls                   | `src/lib/PelletsMode.svelte:180–263`                                 |
| Menu blurb                    | `src/lib/MainMenu.svelte:70`                                         |

Pellets has no web-engine port: unlike Slime Mold there is no
`src/lib/engine/sims/pellets/`, so the Rust tree is the only implementation, and
`PelletsMode.svelte` drives it entirely through Tauri commands.
