# Advection

_Flow Field → Particles → Particle Speed (`particle_speed`), and Flow Field
Settings → Vector Magnitude (`vector_magnitude`)_

Flow Field reduces to one operation, applied twice each frame: **take a thing,
look up the field vector underneath it, move the thing along that vector.** Once
for the particles, and once for the picture the particles have already drawn.
Everything else in the panel is a modifier on those two advections.

## What you are actually looking at

Three layers are composited, back to front (`simulation.rs:1850`, `1855`,
`1861`):

1. **The background** — a flat fill, or the color scheme's darkest end.
2. **The trail map** — a full-screen `rgba8unorm` texture, one texel per screen
   pixel (`simulation.rs:1238`). RGB holds a color, alpha holds an intensity.
   This is the accumulated residue of every particle that has passed by, and it
   is almost always the thing you are admiring.
3. **The particles themselves** — one quad each, drawn only if **Show
   Particles** is on (`simulation.rs:1861`).

The distinction matters because the two upper layers are independently
switchable, and they answer different questions. Turn **Show Particles** off and
what remains is pure history. That is the honest view of what the simulation
computes.

## This is not the Vectors simulation

Vectors and Flow Field both build a noise-driven vector field and share the same
eleven noise types, then do completely different things with it. **Vectors draws
the field; Flow Field hides it and shows what it does to things.** No arrow,
glyph or line is ever drawn here.

The consequence that matters on this page: Flow's field is a fixed 128×128 grid
over world space `[-1, 1]²` (`DEFAULT_FLOW_FIELD_RESOLUTION`,
`simulation.rs:34`) and particles wrap at its edges
(`particle_update.wgsl:426–427`), so unlike Vectors there is nothing further out
to pan to.

[Noise to Angle](../vectors/noise-to-angle.md) covers the field itself — how the
eleven noise types differ, what Noise Scale and the seed do to it, and what it
looks like drawn — and carries the full side-by-side comparison of the two
simulations. This page is about what happens to something dropped into it.

## The first advection: the particle

Each particle is a position, an age, a color index and an alive flag
(`particle_update.wgsl:1–9`). The compute pass runs one invocation per pool slot
(`simulation.rs:1819`) and, for a living particle, does four things: age it,
sample the field, move it, deposit.

The move is one line (`particle_update.wgsl:423`):

```wgsl
particle.position += direction * sim_params.particle_speed * sim_params.delta_time;
```

That is forward Euler integration of the field, and it is the whole of the
simulation's dynamics. There is no velocity, no inertia, no mass, no force. A
particle does not accelerate toward the field direction; it simply _is_ moving
in the field direction, always, exactly. Stop the field and every particle stops
instantly.

`direction` comes from a bilinear sample of the 128×128 grid
(`sample_flow_vector`, `particle_update.wgsl:70`), so a particle between grid
nodes gets a blend of the four surrounding vectors.

### Two sliders, one number

The field vectors are built with their length already baked in
(`flow_vector_compute.wgsl:430`):

```wgsl
direction = vec2<f32>(cos(angle), sin(angle)) * params.vector_magnitude;
```

The angle comes from the noise; **Vector Magnitude** is the length. Then the
move above multiplies by **Particle Speed**. So the two sliders multiply into
one effective speed, and only the product is visible:

| Vector Magnitude | Particle Speed | World units / second | Time to cross the screen |
| ---------------- | -------------- | -------------------- | ------------------------ |
| 0.1 (default)    | 1.0 (default)  | 0.1                  | ~20 s                    |
| 0.5              | 1.0            | 0.5                  | ~4 s                     |
| 0.1              | 5.0            | 0.5                  | ~4 s                     |
| 5.0 (max)        | 100 (max)      | 500                  | 1/250 s                  |

(World space spans `-1 … 1`, so "the screen" is 2 units wide.)

Those middle two rows are the same picture. If you have both sliders raised and
the result is a blur, it does not matter which one you bring down.

At the defaults a particle covers 0.1 × 5 = **0.5 world units in its whole
lifetime** — a quarter of the screen. That is why the default look is short
dashes rather than long ribbons, and it is the single most useful number to
carry around.

One subtlety: the bilinear blend is applied to the _vectors_, not to the angles.
Where two neighboring grid nodes point in opposite directions their average is
near zero, so particles crossing a direction discontinuity genuinely slow to a
crawl. Those stalls are where the bright knots in a busy field come from.

### The deposit

Immediately after moving, the particle stamps itself into the trail map
(`particle_update.wgsl:447`, `deposit_trail` at `:167`). The footprint is not a
single texel: it scans a square of radius **Particle Size** pixels, rejects
texels outside the current **Particle Shape**, and writes with a linear radial
falloff (`particle_update.wgsl:192`):

```wgsl
let deposition_strength = sim_params.trail_deposition_rate * falloff;
```

So Particle Shape is not only cosmetic — a Flower-shaped particle lays a
Flower-shaped trail. And Particle Size is doing double duty as the trail's brush
width, which is why raising it thickens the whole image rather than just
enlarging the dots.

**Trail Deposition Rate** has a discontinuity worth knowing about
(`particle_update.wgsl:196`): at `>= 0.99` the texel's color is _replaced_ by
the particle's color; below that it is a weighted average of the existing color
and the new one. The default is exactly 1.0, so the default behaviour is
overwrite. Drop it to 0.98 and colors start blending — a bigger visual change
than the 2% suggests.

## The second advection: the trail map

Before the particles move, a second compute pass sweeps the trail map
(`simulation.rs:1759`, `trail_decay_diffusion.wgsl`). It applies four effects in
order, and the first of them is advection again — the same field, the same
speed, now applied to the image itself.

For each texel it samples the field, steps _backwards_ along it, and reads what
was there (`trail_decay_diffusion.wgsl:90`):

```wgsl
let back_pos_world = world_pos - flow * sim_params.particle_speed * dt;
```

That is a semi-Lagrangian backtrace: "what was upstream of me a moment ago is
what I should look like now." The result is blended in by **Trail Wash Out
Rate** (`trail_decay_diffusion.wgsl:111–113`):

```wgsl
let advection_blend = sim_params.trail_wash_out_rate;
current_intensity = mix(current_intensity, advected_trail.a, advection_blend);
```

At 0 the trail map is a static canvas that particles stamp onto. At 1 the whole
picture is dragged downstream at full speed every frame. The default 0.1 is a
10% pull — enough to smear stamps into strokes without the image sliding away.

Note that this uses `particle_speed`, so **Particle Speed moves the smear as
well as the particles**. It is the one setting that touches both advections.

Then, in the same pass:

- **Trail Decay Rate** (`trail_decay_diffusion.wgsl:116`) —
  `new = current * (1 - decay)`, an exponential fade toward black. The default
  is **0.0**, meaning trails never fade at all, and the screen fills up over
  time. That is a deliberate look, not an oversight, but it is why a
  long-running Flow Field eventually goes solid.
- **Trail Diffusion Rate** (`trail_decay_diffusion.wgsl:130`) — blends each
  texel toward the average of its four neighbors, wrapping at the edges. Default
  **0.0**. This is a blur, and it softens hairline trails into washes.

## How the trail settings interact

| Setting                   | Internal                | Default | What it does to the trail map                                         |
| ------------------------- | ----------------------- | ------- | --------------------------------------------------------------------- |
| **Trail Deposition Rate** | `trail_deposition_rate` | 1.0     | how hard a particle stamps (and, at 1.0, whether it overwrites color) |
| **Trail Wash Out Rate**   | `trail_wash_out_rate`   | 0.1     | how much the picture is dragged along the field                       |
| **Trail Decay Rate**      | `trail_decay_rate`      | 0.0     | how fast everything fades toward black                                |
| **Trail Diffusion Rate**  | `trail_diffusion_rate`  | 0.0     | how much everything blurs sideways                                    |

The useful framing is that deposition is the only _write_, and the other three
are the ways the written thing is destroyed — moved, forgotten, and smeared.
What you see is their balance:

- **Deposition high, decay 0** (the shipped default) → cumulative painting. The
  image only ever gets denser. Good for a still; poor for a screensaver.
- **Deposition high, decay ~0.02** → a steady state. Trails live about
  `1 / decay` frames — roughly 0.8 s at 0.02 and 60 fps — so you get a
  perpetually-refreshing ribbon field that never saturates.
- **Wash out 0, decay moderate** → discrete dashes that fade in place; you can
  see individual particle stamps.
- **Wash out ~0.6, decay moderate** → the classic smoke look. Stamps immediately
  stretch into streaks because the canvas is running away underneath the
  particles at nearly the same speed the particles are moving.
- **Diffusion up with everything else low** → the field turns into soft
  watercolor blooms.

The colors themselves — which LUT the intensity is looked up in, and what
Particle Color Mode's Age / Random / Direction choice selects — are
[color-scheme business](../gradient-editor/color-schemes.md), not trail
business.

## How many particles are actually alive

There is no "particle count" slider in the panel, and this trips people up. The
pool is fixed at `total_pool_size` (default 100 000), split evenly between
autospawn and brush halves (`simulation.rs:328–329`). Slots are not particles;
most are dead most of the time.

The **alive** count is set by two other sliders, and the shader states the
relationship outright (`particle_update.wgsl:236`):

```wgsl
let expected_alive = min(f32(sim_params.autospawn_rate) * sim_params.particle_lifetime, f32(pool));
```

**Alive ≈ Autospawn Rate × Particle Lifetime**, capped by the pool. At the
defaults that is 500 × 5 = 2500 particles on screen. Doubling either slider
doubles the density — but they are not interchangeable, because lifetime also
sets how _long_ each stroke is. 2500 particles as 1000/sec × 2.5 s is a dense
field of short marks; as 250/sec × 10 s it is a sparse field of long ones.

Lifetime does one more thing: in the default Age color mode, the particle's
intensity is `1 - age/lifetime` (`particle_update.wgsl:433–434`), so a stroke
changes color along its length. Raising lifetime stretches that gradient out
over a longer stroke.

## Things to try, in order

1. **Turn off Show Particles.** Nothing much appears to happen — which is the
   point. Almost everything you were looking at was the trail map. Now every
   trail setting below is legible without moving dots on top of it.
2. **Set Trail Wash Out Rate to 0, then to 1.** At 0 you get crisp discrete
   stamps and can watch individual particles lay them down. At 1 the entire
   image is swept along the field and the particles struggle to keep up with
   their own trails. This is the second advection, isolated.
3. **Set Trail Decay Rate to about 0.02.** The image stops filling in and
   settles into a permanent steady state. Compare against the default 0.0 after
   a minute of running.
4. **Raise Vector Magnitude to 1.0, then put it back and raise Particle Speed to
   10 instead.** Same picture. Convince yourself the two sliders are one
   control, and then pick whichever one you like and leave the other alone.
5. **Autospawn Rate 2000 with Particle Lifetime 0.5, then 100 with Lifetime 10.** Roughly the same number of particles, completely different images:
   a dense stipple versus a few long calligraphic sweeps.
6. **Particle Size 20 with Trail Deposition Rate 0.05.** The footprint is now a
   soft 41-pixel-wide brush laying very faint ink, so structure only appears
   where many particles have overlapped. Slow, and worth waiting for.
7. **Noise DT Multiplier above 0.** The field itself starts changing over time
   (`flow_vector_compute.wgsl:428` — the noise is sampled in 3D with time as the
   third axis), so trails laid a second ago no longer match the field the
   particles are following now. The default is 0, i.e. a frozen field.

## Footnotes

**The order within a frame** is decay/diffusion first, then particle update
(`simulation.rs:1759` then `:1819`). So a particle's deposit is never decayed on
the frame it is made — it gets one clean frame at full strength.

**The trail pass reads and writes the same texture in place**, without
double-buffering (binding 1 is a `read_write` storage texture,
`trail_decay_diffusion.wgsl:46`). Diffusion therefore reads neighbors that may
already have been updated this frame, depending on dispatch order. It is a
Gauss-Seidel-ish blur rather than a strict Jacobi one; harmless, but it is why
diffusion is not perfectly isotropic.

**The trail pass hardcodes a 128×128 field grid** (`grid_w`/`grid_h`,
`trail_decay_diffusion.wgsl:68–69`) while the particle pass reads
`flow_field_resolution` from the uniform. Both are 128 today
(`simulation.rs:34`), so the two advections agree — but they would silently
disagree if the resolution ever became adjustable.

## Where this lives in the code

| Piece                                 | Location                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| The particle move                     | `src-tauri/src/simulations/flow/shaders/particle_update.wgsl:423`                                                  |
| Field sample (bilinear)               | `…/particle_update.wgsl:70` (`sample_flow_vector`)                                                                 |
| Edge wrap                             | `…/particle_update.wgsl:426–427`                                                                                   |
| Trail deposit                         | `…/particle_update.wgsl:167` (`deposit_trail`), stamp at `:447`                                                    |
| Deposition strength / color overwrite | `…/particle_update.wgsl:192`, `:196`                                                                               |
| Spawn probability, alive-count model  | `…/particle_update.wgsl:236`                                                                                       |
| Trail advection (wash out)            | `…/trail_decay_diffusion.wgsl:90`, blend at `:111–113`                                                             |
| Trail decay                           | `…/trail_decay_diffusion.wgsl:116`                                                                                 |
| Trail diffusion                       | `…/trail_decay_diffusion.wgsl:130`                                                                                 |
| Field generation (angle → vector)     | `…/flow_vector_compute.wgsl:426–430`                                                                               |
| Trail map → screen                    | `…/trail_render.wgsl:100` (`fs_main`)                                                                              |
| Frame order                           | `src-tauri/src/simulations/flow/simulation.rs:1743`, `1759`, `1819`                                                |
| Layer compositing                     | `…/flow/simulation.rs:1850`, `1855`, `1861`                                                                        |
| Pool split                            | `…/flow/simulation.rs:328–329`                                                                                     |
| Field grid resolution                 | `…/flow/simulation.rs:34` (`DEFAULT_FLOW_FIELD_RESOLUTION`)                                                        |
| Settings + defaults                   | `src-tauri/src/simulations/flow/settings.rs:245`                                                                   |
| UI controls                           | `src/lib/FlowMode.svelte:300` (Vector Magnitude), `:333` (Particle Speed), `:428`–`:468` (the four trail settings) |

Flow Field is desktop-only at present: unlike Slime Mold, Gray-Scott, Moiré and
Vectors, it has no entry under `src/lib/engine/sims/`, so the shaders above are
compiled by the Tauri build alone.
