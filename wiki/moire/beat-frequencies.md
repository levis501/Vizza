# Beat Frequencies

_Moiré → Moiré Patterns → Grid Scale (`moire_scale`)_

Moiré is the only simulation in Vizza that has no state to speak of. There are no
agents, no chemical field, no cells. Every frame the shader evaluates a closed-form
function of position and time and writes it out. All of the structure you see —
the enormous slow lobes, the hairline stripes crawling inside them — comes from
one arithmetic operation performed on two nearly identical grids.

This is that operation, and why a change of 0.01 in one slider changes everything.

## What is actually being combined

Two grids, generated from the same `base_freq` and differing only in how the
sampling position is transformed before they are evaluated.

The first grid is evaluated on raw coordinates (`compute.wgsl:76`):

```wgsl
let grid1 = sin(pos.x * params.base_freq + t) * sin(pos.y * params.base_freq + t * 0.7);
```

The second is evaluated on the _same_ coordinates after a rotation and a scale
(`compute.wgsl:79–81`):

```wgsl
let rotated_pos = rotate2d(pos, params.moire_rotation + t * 0.1);
let scaled_pos = rotated_pos * (params.moire_scale + sin(t) * 0.1);
let grid2 = sin(scaled_pos.x * params.base_freq + t * 1.3) * sin(scaled_pos.y * params.base_freq + t * 0.9);
```

Note what this means: **there is only one frequency setting.** Grid 2 does not have
a frequency of its own. Its effective frequency is `base_freq × moire_scale`,
because scaling the coordinates and scaling the frequency are the same thing.
Grid Scale _is_ the frequency-ratio control, and Grid Rotation is the angle
control. Those two are the whole instrument.

Then the combination (`compute.wgsl:88`):

```wgsl
let interference = mix(grid1 * grid2, (grid1 + grid2) * 0.5, params.moire_interference);
```

**The grids are multiplied.** The `Interference` slider mixes that product toward
a plain average, and the default of 0.5 sits halfway between the two. Multiply is
the operation that matters, and the next section is why.

A third grid exists (`compute.wgsl:85`) and is multiplied in on top
(`compute.wgsl:89`), but **it has no UI control at all** — `moire_rotation3`,
`moire_scale3` and `moire_weight3` are reachable only through presets and the
Randomize button. Ignore it while you are learning the mechanism; it is a garnish
on the same operation.

## The mechanism: multiplication makes difference frequencies

Take the one-dimensional version. Two gratings, frequencies f₁ and f₂:

```
cos(f₁·x) · cos(f₂·x)  =  ½·cos((f₁ − f₂)·x)  +  ½·cos((f₁ + f₂)·x)
```

The product contains a frequency that is in neither input: **f₁ − f₂**. That is
the moiré. It is not an illusion or a perceptual artifact here — it is a literal
term in the arithmetic, at half amplitude, sitting in the output the LUT reads.

Here f₂ = f₁ · s, where s is Grid Scale, so the difference frequency is
f₁·|1 − s| and the wavelength of the visible banding is

```
λ_beat  =  λ_grating / |1 − s|
```

**Divide by a number near zero.** That single division is the entire reason this
simulation is interesting, and the entire reason it is twitchy:

| Grid Scale | Beat is this much coarser than the grating |
| ---------- | ------------------------------------------ |
| 2.00       | 1×                                         |
| 1.50       | 2×                                         |
| 1.10       | 10×                                        |
| 1.05       | 20×                                        |
| 1.01       | 100×                                       |
| 1.00       | ∞ — no banding at all, a flat field        |

Going from 1.10 to 1.01 is a 9% change in the slider and a **tenfold** change in
the size of what you see. Nothing else in Vizza is this steep.

Rotation does the same job through a different door. With both grids at nearly the
same frequency and a small angle θ between them, the beat wavevector has magnitude
f·√((1 − s)² + θ²), so rotation and scale mismatch trade off directly: a scale
error of 0.05 and a rotation of 0.05 rad (about 3°) produce beats of the same
coarseness.

At the **defaults** — `base_freq` 20, Grid Scale 1.05, Grid Rotation 11° (0.2 rad)
— √(0.05² + 0.2²) ≈ 0.21, and the 0.2 from rotation dominates the 0.05 from scale
by four to one. So out of the box you are looking at a rotation moiré, not a
frequency moiré, and nudging Grid Scale barely moves it. Zero the rotation first
if you want to see what Grid Scale does.

### Why the pattern breathes on its own

`moire_scale` is never used as typed. Line 80 adds `sin(t) * 0.1` to it, so the
effective scale swings ±0.1 around your value on a slow cycle. At the default of
1.05 that sweep runs from 0.95 through **exactly 1.0** to 1.15 — twice per cycle
the two grids come into perfect agreement, the difference frequency falls to zero,
and the banding briefly expands past the size of the screen before contracting
again. That slow inhale-exhale is not the advection. It is the beat frequency
passing through zero.

It also means you cannot pin the grids at exactly equal frequency. The closest you
can get is a value the wobble sweeps through.

### And why `Interference` at 1.0 is the least interesting setting

At `moire_interference = 0` the grids are multiplied, and the difference frequency
is a real term in the output — you get broad regions of near-solid color.

At `moire_interference = 1` they are averaged. Addition is linear and creates no
new frequencies: `cos α + cos β = 2·cos((α−β)/2)·cos((α+β)/2)`, so the beat
survives only as an _envelope_ modulating the original fine grating, at half the
rate. You still see moiré, but as slowly-varying contrast on visible stripes
rather than as broad fields of color.

The slider named "Interference" produces the crispest interference at **zero**.

## What "fluid advection" actually is

The menu blurb and the in-app description both promise fluid advection. Half of
that is true, and it is worth knowing which half.

**There is no fluid.** No velocity field is stored, nothing is integrated, there is
no pressure projection and no divergence-free constraint. `compute_velocity`
(`compute.wgsl:159–221`) is a closed-form expression: three octaves of sin/cos
(`compute.wgsl:166–184`), a global amplitude pulse (`compute.wgsl:187–188`), up to
three exponentially-decaying rotation fields centered on hardcoded coordinates
(`compute.wgsl:191–211`), and a fine noise-like term (`compute.wgsl:214–218`). It
reads only `pos` and `time`. It never looks at the previous frame. The flow is a
fixed stirring pattern baked into the shader, the same on every run.

`Curl` is not curl either. It computes no ∇×v of anything; it adds rigid rotation
`(−y, x)` about those three fixed centers (`compute.wgsl:197`, `204`, `210`).

**The advection is real, though.** Every frame the shader reads the _previous
frame's finished image_ back at a displaced coordinate and blends it with the newly
generated pattern (`compute.wgsl:294–303`):

```wgsl
let advected_uv1 = current_uv - vel * 0.5;
let advected_uv2 = current_uv - vel;
let advected_uv3 = current_uv - vel * 1.5;
```

That is a semi-Lagrangian backward trace — the standard "where did this pixel come
from" step — done at three points along the streamline and averaged
(`compute.wgsl:303`), which smears as well as transports. The two textures
ping-pong (`simulation.rs:996`).

So: **genuine advection of the image, driven by a procedural flow field that is
not a fluid.** What you see moving is the moiré pattern's own history being dragged
around, which is why the trails always look like the pattern and never like
anything else.

## The settings that interact, and the cliff in one of them

The blend that closes the loop (`compute.wgsl:306–308`, `313`):

```wgsl
let advection_mix = params.advect_strength * 1.2;
let new_pattern_weight = 1.0 - advection_mix;
let advected_weight = advection_mix * params.decay;
...
let final_color = nn_color * new_pattern_weight + prev_color * advected_weight;
```

Three things fall out of those four lines.

**Flow Strength (`advect_strength`) does two jobs at once.** It scales the velocity
(`compute.wgsl:220`, `vel * params.advect_strength * 0.15`) _and_ it sets the blend
weight. Turning it up moves the image further per frame and simultaneously keeps
more of the moved image, so its effect is roughly quadratic. It is the most
powerful control in the panel and the least linear.

**Flow Strength has a hard cliff at 0.833.** `advection_mix` is `advect_strength ×
1.2`, so at `advect_strength = 1/1.2 ≈ 0.8333` the weight on the fresh pattern hits
zero, and above it goes **negative** — the newly generated moiré is _subtracted_
from the output. The UI lets you go to 5.0 (`MoireMode.svelte:332`), which gives a
weight of −5 on the new pattern and +5.88 on the history: a saturated, clipping,
inverted feedback smear that has almost nothing to do with the moiré pattern any
more. The default of 0.6 sits comfortably below the cliff. Cross it deliberately or
not at all.

**Decay is loop gain, not a fade.** It multiplies only the history term, so the
total weight per frame is `(1 − m) + m·decay` for `m = advect_strength × 1.2`. At
the default 0.98 and 0.6 that is 0.986 — the loop loses 1.4% per frame and trails
fade over a few seconds. At Decay = 1.0 (the slider maximum,
`MoireMode.svelte:366`) the sum is exactly 1.0: the feedback never forgets, and
smears accumulate indefinitely.

**Flow Speed (`advect_speed`) does not change how fast anything moves.** It only
scales `t` inside `compute_velocity` (`compute.wgsl:160`), i.e. how fast the flow
field itself churns. Set it to 0 and the field freezes — but it is still nonzero,
so the image is dragged along fixed streamlines forever, giving hard steady streaks.

Two smaller things worth knowing, because they will otherwise puzzle you:

- Line 245 adds `sin(2x)·cos(2y)·0.2` and line 246 adds `sin(time·0.5)·0.1` to
  every pixel, unconditionally. That is a permanent four-lobe brightness vignette
  and a global slow flicker that **no setting turns off**. If you zero everything
  and still see a soft four-blob wash breathing, that is these two lines.
- `dynamic_mix` (`compute.wgsl:311`) is computed and never used anywhere. It looks
  like it was meant to modulate the blend; it does nothing.

The sampler is `ClampToEdge` (`simulation.rs:185`), so near the border advection
drags edge pixels inward and you get streaking along the frame — a texture-boundary
artifact, not part of the pattern.

## The Radial generator has no beat at all

Switching Generator Type to Radial (`MoireMode.svelte:198`) routes to
`compute_radial_moire` (`compute.wgsl:94–129`), and **every combination in it is
additive** — `mix` and weighted sums, no product anywhere
(`compute.wgsl:121–126`). There is no difference frequency, so there is no moiré in
the sense this page describes; it is a superposition of starbursts, concentric
rings and a swirl. `moire_scale` and `moire_rotation` survive, but only as small
perturbations to one secondary term (`compute.wgsl:116–118`), and the third grid's
parameters are not used at all.

Radial is a nice-looking generator. It is not the mechanism. Learn the linear one
first.

## Things to try, in order

1. **Set Moiré Amount to 0.** The pattern term is scaled to nothing
   (`compute.wgsl:91`) and you are left with the flat 0.5 midpoint plus the
   hardcoded four-lobe wash. This is the control condition — remember what it looks
   like, so you can tell it apart from the pattern later.
2. **The canonical demonstration.** Set Grid Rotation to 0, Interference to 0,
   Flow Strength to 0, Moiré Amount to 1, Base Frequency to 20. You now see one
   clean grating and nothing else. Set Grid Scale to 1.0 — still one grating (it is
   squared, so brighter, but the same). Now set Grid Scale to **1.1**: broad bands
   appear at ten times the grating's scale, in a pattern present in neither grid.
   That is the beat frequency, and it appeared from a 10% change.
3. **Now type 1.01 instead of dragging to it.** Grid Scale's drag step is 0.1
   (`MoireMode.svelte:252`), which snaps (`NumberDragBox.svelte:120`) and so cannot
   reach the interesting values at all. Double-click the box and type — a typed
   value is clamped but not snapped (`NumberDragBox.svelte:156`). At 1.01 the
   banding is 100× the grating scale, larger than the frame, and the whole screen
   becomes one slowly-shifting lobe. Watch it breathe as the `sin(t)` wobble sweeps
   the effective scale through 1.0.
4. **Use Grid Rotation for fine control instead.** Its step is 1°
   (`MoireMode.svelte:240`), which is fine enough to drag through the whole
   interesting range. From 0°, drag slowly up: the bands sweep in from infinitely
   coarse to grating-scale over the first twenty degrees or so, and then stop being
   dramatic. All the good behavior is in the first few degrees.
5. **Raise Interference from 0 to 1** with a beat visible. Watch the broad solid
   fields turn into fine stripes with slowly-varying contrast. Same beat, additive
   instead of multiplicative.
6. **Flow Strength from 0 upward, slowly, stopping at 0.8.** The pattern begins to
   drag and smear along the fixed flow field. Then push past 0.84 and watch the
   image invert and saturate as `new_pattern_weight` goes negative.
7. **Flow Speed to 0 with Flow Strength around 0.4.** The flow field freezes and
   the pattern is pulled along unchanging streamlines — the clearest possible view
   of the shape of the hardcoded velocity field.
8. **Decay to 1.0.** Nothing ever fades. The screen slowly fills with accumulated
   smear until the fresh pattern is barely visible under it.

Color mapping is a separate topic — the LUT lookup at `compute.wgsl:59`
(`get_lut_color`) is covered in
[Color Schemes](../gradient-editor/color-schemes.md).

## Where this lives in the code

| Piece                        | Location                                                    |
| ---------------------------- | ----------------------------------------------------------- |
| Grid 1                       | `src-tauri/src/simulations/moire/compute.wgsl:76`           |
| Grid 2 (rotated + scaled)    | `…/compute.wgsl:79–81`                                      |
| The multiply — the mechanism | `…/compute.wgsl:88`                                         |
| Third grid (no UI control)   | `…/compute.wgsl:85`, mixed in at `:89`                      |
| Moiré Amount                 | `…/compute.wgsl:91`                                         |
| Unconditional wash + flicker | `…/compute.wgsl:245–246`                                    |
| Procedural flow field        | `…/compute.wgsl:159–221` (`compute_velocity`)               |
| Curl's three fixed vortices  | `…/compute.wgsl:191–211`                                    |
| Semi-Lagrangian backtrace    | `…/compute.wgsl:294–303`                                    |
| Feedback blend weights       | `…/compute.wgsl:306–308`, `:313`                            |
| Dead code (`dynamic_mix`)    | `…/compute.wgsl:311`                                        |
| Radial generator             | `…/compute.wgsl:94–129`                                     |
| Intensity → color            | `…/compute.wgsl:59` (`get_lut_color`)                       |
| Ping-pong swap, `speed`      | `src-tauri/src/simulations/moire/simulation.rs:996`, `:922` |
| Sampler (ClampToEdge)        | `…/simulation.rs:185`                                       |
| Desktop settings + defaults  | `src-tauri/src/simulations/moire/settings.rs:123`           |
| Built-in presets             | `src-tauri/src/simulations/moire/mod.rs:20–57`              |
| Web settings + uniform pack  | `src/lib/engine/sims/moire/settings.ts`                     |
| Web render loop              | `src/lib/engine/sims/moire/index.ts:278`, `:297`            |
| UI controls                  | `src/lib/MoireMode.svelte:218` … `:270`, `:332` … `:373`    |

The shader is not duplicated between platforms: the desktop build embeds
`src-tauri/src/simulations/**/*.wgsl` with `include_dir!`, and the web build globs
the same files (`src/lib/engine/shaders/index.ts`). One corpus, both targets.
