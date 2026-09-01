# Feed and Kill

_Gray-Scott → Reaction-Diffusion → Feed Rate (F) (`feed_rate`) and Kill Rate (K)
(`kill_rate`)_

The Gray-Scott panel gives you five numbers. Four of them are scenery. The whole
simulation — coral, fingerprints, worms, dividing cells, a blank screen — is
decided by where the pair (F, K) lands in a region of parameter space about
0.02 wide. This is what that region is, why it is so small, and why the app's
own presets all sit on the edge of it.

## Two numbers per pixel

There is one texture, `rgba16float`, and the simulation only ever uses two of
its four channels (`reaction_diffusion.wgsl:337`). Per pixel:

- **u** in the red channel — the _substrate_. Think of it as food, or empty
  medium. It starts at 1.0 everywhere.
- **v** in the green channel — the _autocatalyst_. It starts at 0.0 everywhere,
  and it is the thing that makes patterns.

Both are clamped to `0.0 … 1.0` on every write
(`reaction_diffusion.wgsl:334–335`). The texture is a torus: every neighbor
lookup wraps with a modulo (`reaction_diffusion.wgsl:63–66`), so a pattern that
walks off the right edge arrives at the left.

## You are only looking at u

This matters more than it sounds. The render pass reads the **red channel only**
and uses it as the index into the 256-entry LUT:

```wgsl
let lut_index = u32(clamp(u_interpolated * 255.0, 0.0, 255.0));
```

`shared/infinite_render.wgsl:283`, in `fs_main_storage` (`:223`), with the comment
`// R channel contains u value` on the sample two dozen lines earlier (`:229`).

**v is never drawn.** So the structure on screen is not the chemical that makes
it — it is the _hole_ that chemical burns in the substrate. Undisturbed medium
sits at u = 1.0 and pins to LUT index 255; the reaction front drops u toward
0.2–0.3, somewhere near the middle of the LUT. Which colors those become is the
color scheme's business, not this page's — see
[Color Schemes](../gradient-editor/color-schemes.md). The default is
`MATPLOTLIB_prism`, reversed (`state.rs:243–244`), a cyclic scheme, so
brightness on screen is not monotonic in u and you should not read "brighter"
as "more of anything."

## The mechanism, in three lines

Every pixel, every frame, runs one explicit Euler step. The reaction is one
statement (`reaction_diffusion.wgsl:277`):

```wgsl
let reaction_rate = uv.x * uv.y * uv.y;
```

That is `u·v²`, and it is the whole chemistry: **U + 2V → 3V**. Two units of V
plus one of U make three of V. It is autocatalysis — V is both an input and the
product, so V makes more V, but only where U is available to consume. The `v²`
is why a single stray molecule of V does nothing and a small _clump_ of V takes
off.

Then the two derivatives (`reaction_diffusion.wgsl:331–332`):

```wgsl
let delta_u = effective_delta_u * laplacian.x - reaction_rate + effective_feed_rate * (1.0 - uv.x);
let delta_v = effective_delta_v * laplacian.y + reaction_rate - (effective_kill_rate + effective_feed_rate) * uv.y;
```

Read them term by term:

| Term              | In `delta_u`              | In `delta_v`              |
| ----------------- | ------------------------- | ------------------------- |
| Diffusion         | `Du · ∇²u`                | `Dv · ∇²v`                |
| Reaction (`u·v²`) | **minus** — U is eaten    | **plus** — V is made      |
| Feed / removal    | `+F · (1 − u)` — refill U | `−(K + F) · v` — remove V |

`∇²` is a 5-point stencil: subtract 4× the center, add the four cardinal
neighbors (`reaction_diffusion.wgsl:60`, `:78–81`). Then the step itself, with
the clamp that keeps the field from exploding
(`reaction_diffusion.wgsl:334–335`).

One dispatch per frame, one Euler step per dispatch — there is no substep loop
anywhere (`simulation.rs:1305`; the web port says so explicitly at
`sims/grayScott/index.ts:25–27`). Δt is the only speed control.

## What F and K actually do — and why they are not symmetric

**Kill Rate (K)** appears once, in `delta_v`: it removes V at a rate
proportional to how much V is there. Straightforward.

**Feed Rate (F) appears twice.** It pushes u back toward 1.0 — the `F·(1 − u)`
term — _and_ it removes v, because it is inside `(K + F)·v`. That second
appearance is the one people miss, and it is the reason the parameter space is a
curve rather than a rectangle. Physically it is a flow-through reactor: the feed
stream carries fresh U in and washes everything, V included, out. So turning F
up is never simply "more food."

The consequence: V's total removal rate is **F + K**, and the system's behavior
depends on F and on the sum F + K, not on F and K separately.

## The interesting region is a sliver, and it closes at K = 1/16

Set both derivatives to zero, ignore diffusion, and ask whether the well-mixed
system has any state with v ≠ 0. From the two lines above:

```
u·v² = (K + F)·v        ⟹   u·v = F + K
F·(1 − u) = u·v² = (F + K)·v
```

Substituting gives `(F+K)·v² − F·v + F·(F+K) = 0`, whose discriminant is
non-negative only when

```
F ≥ 4·(F + K)²        equivalently   √F ≥ 2·(F + K)
```

Outside that, the _only_ steady state is the trivial one, u = 1 and v = 0 — the
blank screen you started from. Two things fall out of it:

- **Solve for the F band at fixed K.** At the default K = 0.062, patterns can
  persist only for F between **0.052 and 0.074**. The default F is 0.055. The
  Feed Rate drag box steps by 0.001 (`GrayScottDiagram.svelte:58`), so **four
  presses of the down arrow walk you out of the entire pattern-forming region.**
- **The band closes entirely at K = 1/16 = 0.0625.** The discriminant of that
  quadratic in F is `(8K − 1)² − 64K² = 1 − 16K`, which is zero at exactly
  K = 0.0625, at F = 0.0625 too. The whole existence region is a horn with its
  tip at F = K = 1/16, and nothing above K = 0.0625 has a nontrivial steady state
  at any feed rate whatsoever.

The default (F = 0.055, K = 0.062) sits 0.0005 below that tip, just inside the
horn where it is at its narrowest. That is not an accident, and it is why Gray-
Scott feels so twitchy compared to every other simulation in the app: the
defaults are parked on a bifurcation.

### The presets are a tour of the boundary

`gray_scott/mod.rs:17–27` defines nine presets. **Every one of them differs only
in (F, K)** — the loop at `:29–42` hands all nine the same Du = 0.16, Dv = 0.08,
Δt = 1.0. That alone is the argument of this page: the app itself treats the
feed–kill pair as the simulation's entire identity.

Here they are with the margin `F − 4(F+K)²`, positive meaning inside the horn:

| Preset           |      F |      K | Margin  |         |
| ---------------- | -----: | -----: | ------- | ------- |
| Undulating       | 0.0260 | 0.0510 | +0.0023 | inside  |
| U-Skate World    | 0.0620 | 0.0610 | +0.0015 | inside  |
| Worms            | 0.0780 | 0.0610 | +0.0007 | inside  |
| Custom           | 0.0350 | 0.0580 | +0.0004 | inside  |
| Brain Coral      | 0.0545 | 0.0620 | +0.0002 | inside  |
| Fingerprint      | 0.0545 | 0.0620 | +0.0002 | inside  |
| Ripples          | 0.0180 | 0.0510 | −0.0010 | outside |
| Mitosis          | 0.0367 | 0.0649 | −0.0046 | outside |
| Soliton Collapse | 0.0220 | 0.0600 | −0.0049 | outside |

Not one of them is further than 0.005 from the boundary. They all hug it,
because that is the only place anything happens. (Brain Coral and Fingerprint
are byte-for-byte the same preset — two names, one point. Picking between them
does nothing.)

The classic reading of the two sides:

- **Inside**, a V blob has a stable state to settle into. It grows until it runs
  into itself or into a neighbor, and then it stops — labyrinths, coral,
  fingerprint ridges, worms. Structure that _holds still_.
- **Outside**, there is nothing for V to settle into, so it cannot hold still.
  A blob's front keeps advancing into fresh U while its interior starves, so it
  hollows, thins and breaks in two. That is what "Mitosis" is: cell division as
  a consequence of having no fixed point to sit at. Note Mitosis is the one
  preset with K above 1/16 — it is outside at _every_ F.
- **On the boundary**, blobs neither settle nor divide cleanly; they translate.
  U-Skate World, at (0.062, 0.061), is essentially sitting on the tip of the
  horn, which is why it produces gliders.

Go far enough outside in any direction and V dies out completely: the field
relaxes to u = 1 everywhere, and since that is exactly what the display maps to
LUT index 255, you get one flat color and no way to tell "dead" from "not
started."

## Diffusion: only the ratio matters

**Diffusion U (Du)** (`diffusion_rate_u`) defaults to 0.16 and **Diffusion V
(Dv)** (`diffusion_rate_v`) to 0.08 (`settings.rs:22–23`) — exactly 2:1, and
`gray_scott/mod.rs:34–35` calls those "canonical Gray-Scott diffusion coefficients."

The 2:1 is the Turing condition and it is not decorative. V activates itself
locally; the U it consumes is replenished from further away. If U spreads faster
than V, the depletion outruns the activation, and a growing blob is choked from
outside before it can fill the plane — that is what makes a _boundary_ and hence
a pattern. Set Du = Dv and there is no scale separation left: fronts smear and
you get a uniform wash, no matter how carefully you tuned F and K.

## Timestep, and the stability limit the default ignores

**Timestep (Δt)** (`timestep`) defaults to 2.5 (`settings.rs:24`). It multiplies
the whole derivative (`reaction_diffusion.wgsl:334–335`), so it is both "speed"
and "accuracy," and forward Euler has a hard ceiling on it.

The shader knows what that ceiling is. `calculate_adaptive_timestep`
(`reaction_diffusion.wgsl:242`) computes the von Neumann condition itself:

```wgsl
let diffusion_limit = 0.25 / (delta_u + delta_v);
```

`reaction_diffusion.wgsl:245`. At the defaults that is 0.25 / 0.24 ≈ **1.04** —
and the default Δt is **2.5**, about 2.4× over. What keeps it from diverging is
the clamp to `0.0 … 1.0` on every write, which is a safety net rather than a
correct integration. The nine presets all set Δt = 1.0 (`gray_scott/mod.rs:36`), right at
the limit; the top-level default does not.

So Δt is a speed/fidelity trade with a visible failure mode. Push it toward the
drag box's ceiling of 10.0 (`GrayScottDiagram.svelte:153`) and the smooth fronts
break into pixel-scale checkerboard: that is the Euler step overshooting and the
clamp catching it, not a rendering artifact.

## Things to try, in order

1. **Reset, and do nothing.** The initial field is u = 1, v = 0 everywhere
   (`noise_seed.wgsl:75`), which is an exact fixed point — `u·v²` is zero,
   `F·(1 − u)` is zero. **Nothing will ever happen.** This is the control
   condition, and it is why the panel has a 🌱 Seed Noise button
   (`GrayScottMode.svelte:120–131`): the seeder scatters patches of u ≈ 0.2–0.5,
   v ≈ 0.8–1.0 (`noise_seed.wgsl:70–71`) wherever fBm noise falls below its
   threshold (`:68`). Left-click paints the same thing by hand
   (`paint.wgsl:75–76`); right-click erases back to (1, 0) (`paint.wgsl:80–81`).
2. **Seed, let it settle, then drop Feed Rate from 0.055 to 0.051.** Four
   presses of the drag box. You have crossed out of the horn and the entire
   pattern dissolves to flat color. Nudge it back to 0.055 and — with the field
   now uniform — nothing returns. You have to re-seed. This is the single most
   instructive thing in the simulation: the pattern is not stored anywhere, it is
   a standing structure that exists only while the parameters support it.
3. **Compare Brain Coral to Mitosis.** Two presets, identical in every field
   except (F, K), 0.018 apart in F and 0.003 in K. One holds still and one keeps
   dividing forever — margin +0.0002 versus −0.0046.
4. **Set Kill Rate to 0.07.** Above 1/16 there is no F that works. Sweep Feed
   Rate across its whole 0.01–1.0 range (`GrayScottDiagram.svelte:150`) and
   confirm the screen stays blank the entire way. Then bring K back to 0.06 and
   re-seed.
5. **Set Dv equal to Du (both 0.16).** Keep F and K at good values. The
   structure goes soft and washes out — a direct demonstration that the pattern
   comes from the _difference_ in diffusion speeds, not from the reaction alone.
   Then try Dv = 0.02: the V regions shrink into hard, thin filaments.
6. **Push Timestep to 8.** Watch smooth fronts turn into blocky checkerboard as
   the integrator goes unstable, then drop back to 1.0.
7. **Only after all of that, use the XY plot.** The Feed-vs-Kill plot
   (`GrayScottDiagram.svelte:9–25`) is a literal map of the space this page
   describes, and dragging its handle is the fastest way to feel the horn.

## Footnote: two controls that do less than they look like

**The drag boxes lie about the useful range.** Feed and Kill both accept
0.01–1.0 (`GrayScottDiagram.svelte:150–151`), but everything interesting is
below 0.09 and 0.0625 respectively. The XY plot is honest about this — it is
scaled to F ∈ [0.01, 0.1] and K ∈ [0.03, 0.07]
(`GrayScottDiagram.svelte:155–156`), with a comment at `:140–144` explaining
that the full axis made every preset land inside 17 pixels. Trust the plot's
axes, not the drag boxes' bounds.

**Adaptive timestep is unreachable.** `enable_adaptive_timestep`,
`stability_factor` and `max_timestep` exist in the settings struct
(`settings.rs:12–14`) and `GrayScottMode.svelte:169–177` has switch arms ready
to forward all three — but no widget dispatches those names, and the desktop
`update_setting` has no match arm for them either (the match ends at
`cursor_strength`, `simulation.rs:1230`, then `_ => {}` at `:1235`). And
`max_timestep` is never read by the shader at all: `calculate_adaptive_timestep`
returns `min(diffusion_limit, reaction_limit) * stability_factor`
(`reaction_diffusion.wgsl:254`) without consulting it. The web port's uniform
packer keeps the field only to hold the slot
(`sims/grayScott/settings.ts:709–712`). In practice Δt is always your number.

**The mask can vary F and K across space.** Selecting Feed Rate or Kill Rate as
the Mask Target scales that parameter per-pixel by `0.5 + influence · 0.5`
(`reaction_diffusion.wgsl:305–312`) — a 2:1 range, never zero. Given how narrow
the horn is, a mask at full strength is easily enough to put half the canvas
inside it and half outside, which is how you get one region of coral against a
region of blank medium.

## Where this lives in the code

| Piece                        | Location                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------- |
| The reaction `u·v²`          | `src-tauri/src/simulations/gray_scott/shaders/reaction_diffusion.wgsl:277`   |
| The two derivatives          | `…/reaction_diffusion.wgsl:331–332`                                          |
| Euler step + clamp           | `…/reaction_diffusion.wgsl:334–335`                                          |
| Laplacian (5-point, wrapped) | `…/reaction_diffusion.wgsl:47` (`get_laplacian`), stencil at `:60`, `:78–81` |
| Stability limit              | `…/reaction_diffusion.wgsl:245` (`calculate_adaptive_timestep`, `:242`)      |
| Mask on F / K / Du / Dv      | `…/reaction_diffusion.wgsl:305–320`                                          |
| Initial + noise seeding      | `…/shaders/noise_seed.wgsl:68–75`                                            |
| Click to seed / erase        | `…/shaders/paint.wgsl:72–81`                                                 |
| u → color                    | `src-tauri/src/simulations/shared/infinite_render.wgsl:283`                  |
| Desktop settings + defaults  | `src-tauri/src/simulations/gray_scott/settings.rs:20–24`                     |
| The nine (F, K) presets      | `src-tauri/src/simulations/gray_scott/mod.rs:17–27`                          |
| One step per frame           | `src-tauri/src/simulations/gray_scott/simulation.rs:1305`                    |
| Web settings + defaults      | `src/lib/engine/sims/grayScott/settings.ts:95–106`                           |
| Uniform packing              | `src/lib/engine/sims/grayScott/settings.ts:694–714`                          |
| UI panel                     | `src/lib/GrayScottMode.svelte:137`                                           |
| The F–K plot and drag boxes  | `src/lib/components/gray-scott/GrayScottDiagram.svelte:9–25`, `:150–158`     |

The shader is not duplicated between platforms: the desktop build embeds
`src-tauri/src/simulations/**/*.wgsl` with `include_dir!`, and the web build
globs the same files (`src/lib/engine/shaders/index.ts`). One corpus, both
targets.
