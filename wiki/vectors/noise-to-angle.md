# Noise to Angle

_Vectors → Noise Type / Noise Scale (`noise_scale`) / Density (`density`)_

Vectors draws a lattice of short line segments and lets you fly around it. The
whole simulation is one expression: a single number sampled at each grid point
is turned into an angle. Everything else on screen — how long a line is, what
colour it is, how the field moves — is downstream of that one number.

## The thing that makes it unusual: there is no vector

The main menu calls this a "vector field visualization." The panel calls the
first control **Vector Field Type**. Both are slightly generous. What the
simulation samples is a **scalar** field — one `f32` per grid point, in
`0.0 … 1.0` — and the direction is manufactured from it by multiplying by a full
turn.

The desktop build does it on the CPU (`simulation.rs:312–318`):

```rust
let angle = angle_val * TAU;
let len = line_length * (0.5 + angle_val * 0.5);
let dx = angle.cos() * len;
let dy = angle.sin() * len;
```

The browser build does the identical arithmetic in the vertex stage
(`line_instanced.wgsl:135–139`):

```wgsl
fn vectors_line_end(p0: vec2<f32>, value: f32, line_length: f32) -> vec2<f32> {
    let angle = value * VECTORS_TAU;
    let len = line_length * (0.5 + value * 0.5);
    return p0 + vec2<f32>(cos(angle), sin(angle)) * len;
}
```

That same `value` is passed through to the fragment stage untouched and used as
the LUT index (`line_fragment.wgsl:17`). So **one number is doing three jobs at
once**:

| Sample value | Angle        | Length             | Colour     |
| ------------ | ------------ | ------------------ | ---------- |
| 0.00         | 0 (east)     | 0.50 × Line Length | `LUT[0]`   |
| 0.25         | π/2 (north)  | 0.625 ×            | `LUT[64]`  |
| 0.50         | π (west)     | 0.75 ×             | `LUT[128]` |
| 0.75         | 3π/2 (south) | 0.875 ×            | `LUT[191]` |
| 1.00         | τ (east)     | 1.00 ×             | `LUT[255]` |

Two consequences are worth carrying around, because most of the field's
character follows from them.

**Length is not magnitude.** In every other vector plot you have ever read, a
long arrow means a strong field. Here length is just a second, redundant readout
of the same angle: it rises monotonically with the sample, so it tells you the
direction again rather than telling you anything new. There is no speed in this
simulation to encode — nothing is moving through the field. (If you want length
that means something, that is what [Flow Field](../flow-field/advection.md) is doing with the
same noise.)

**The mapping wraps, and the colour scheme does not.** Sample 0.0 and sample 1.0
produce the _same_ direction (east) but sit at opposite ends of the LUT and at
opposite ends of the length range. Wherever the noise crosses that boundary you
get a seam: a line of glyphs that all point the same way while the colour jumps
from one end of the gradient to the other. It is not a bug and it is not
avoidable from the settings panel — it is the τ in the expression above. Colour
choice is out of scope here; see [Color Schemes](../gradient-editor/color-schemes.md).

## What you are actually looking at

At the defaults (`settings.rs:39–41` — Density `0.02`, Line Length `0.03`, Line
Width `0.001`), at zoom 1, the grid is **121 × 121 = 14,641 line segments**.

The count comes from the camera, not from a fixed resolution
(`simulation.rs:266`, `274–278`): the sampled square runs from
`camera − 1.2/zoom` to `camera + 1.2/zoom` — the visible `[-1, 1]` view plus a
0.2 margin so glyphs do not pop in at the edge — and it is walked in steps of
`spacing`. So the number of lines is `(floor(2.4/zoom / spacing) + 1)²`.

Each segment is a two-triangle quad, flat-shaded, extruded sideways by half of
Line Width along the segment normal (`simulation.rs:222`, mirrored at
`line_instanced.wgsl:147–166`). The segment starts _at_ the grid point and grows
outward from it — it is not centred on it, so the lattice reads as a field of
tails rather than of arrows, and there are no arrowheads anywhere.

Nothing persists between frames. There is no particle buffer, no trail map, no
history of any kind. The state struct (`state.rs`) holds a clock and the last
camera pose and nothing else. Every frame the entire field is recomputed from
scratch, and `geometry_dirty` (`simulation.rs:393–400`) is true on essentially
every frame because the clock advanced. What you are watching is a plot being
redrawn, not a system evolving.

## Where the number comes from

**Noise Type** (`noise_type`) picks one of eleven generators (`settings.rs:65–77`).
On the desktop these are the `noise` crate's, built once per rebuild
(`noise_helper.rs:13–49`); in the browser they are ported into WGSL
(`noise.wgsl`, `noise_sample` at `noise.wgsl:496`). Either way the generator
returns `[-1, 1]` and is normalised the same way (`noise_helper.rs:57`):

```rust
(val + 1.0) * 0.5
```

**Noise Scale** (`noise_scale`, default 5.0) multiplies the _world_ coordinates
before sampling (`simulation.rs:304–306`). It does not touch the third
coordinate. **Noise Seed** (`noise_seed`, 0 … 4294967295) rerolls the generator;
Cylinders and Checkerboard ignore it, being deterministic by construction.

**Noise DT Multiplier** (`noise_dt_multiplier`) supplies the third coordinate
(`simulation.rs:272`):

```rust
let time = self.time as f64 * self.settings.noise_dt_multiplier as f64;
```

That is what animates the field: the plot is a moving 2D slice through a 3D
noise volume. Set it to 0 and the field freezes completely — which is the right
setting for reading structure, and the right setting for a screenshot.

Note that it multiplies _accumulated_ time, not the increment. Drag the slider
ten minutes into a run and the field does not smoothly change speed; it jumps to
a different slice, and the further into the run you are the bigger the jump.

**Vector Field Type** can be switched from Noise to Image, at which point the
sample is a pixel's luminance instead (`simulation.rs:289–300`). The angle
mapping is unchanged, so a photograph becomes a field the same way noise does:
black pixels point east and short, mid-greys point west, white points east and
long. The image covers a fixed world extent and does **not** follow the camera
(`line_instanced.wgsl:197–201`), so panning slides the lattice across a
stationary picture.

## Noise Scale against Density: the tradeoff

The **Density** slider (`density`, 0.001 … 0.1) is misnamed. It is used
_directly_ as the world-space spacing between sample points
(`simulation.rs:274`):

```rust
let spacing = density.max(0.001);
```

So turning "Density" **up** makes the field **sparser**. Read it as "spacing" and
the panel stops surprising you.

The single most useful quantity in this simulation is how many glyphs fall across
one feature of the noise. A generator's features are roughly one unit wide in its
own domain, and the domain is scaled by Noise Scale, so a feature is `1/noise_scale`
world units across, and:

```
glyphs per feature ≈ 1 / (noise_scale × density)
```

At the defaults that is `1 / (5 × 0.02) = 10` — ten glyphs to turn through one
lobe of the field, which is why the default look is legible swirls.

- **Below about 3 glyphs per feature the field stops existing visually.**
  Neighbouring samples are uncorrelated, every glyph points somewhere unrelated to
  its neighbour, and you get a shimmering hash. This is the "mush" failure, and it
  is what you get by raising Noise Scale without touching Density.
- **Above about 50 the structure leaves the screen.** One lobe is now wider than
  the view, so every visible glyph points nearly the same way — a comb that slowly
  sweeps. This is what you get by lowering Noise Scale and it is just as
  uninformative, only tidier.

Two settings sit on top of that:

- **Line Length** (`line_length`, default 0.03) is in world units, so what matters
  is its ratio to spacing. At the defaults, lines run 0.015 … 0.03 long against a
  spacing of 0.02 — the long ones already reach past their neighbour. Push Line
  Length well beyond spacing and the lattice fills in into a woven mat, which
  reads as texture rather than as direction; pull it well under and you get a
  stipple of dots whose orientation you cannot see.
- **Line Width** (`line_width`, default 0.001) is also world units — a twentieth
  of the default spacing. Raise it to spacing and adjacent glyphs merge into solid
  blocks of LUT colour, at which point you are looking at the scalar field as a
  heat map with the direction lost.

The uncomfortable truth is that Line Length and Line Width are absolute, so any
change to Density silently changes how the field reads. Halve Density and you
must roughly halve both to keep the same picture at higher resolution.

## Zoom and pan actually magnify — they do not reveal detail

The menu blurb advertises "zoom and pan," and it is worth being precise about
what they do, because it is not what a mapping application trains you to expect.

The camera transform is `clip = zoom × (world − camera)`
(`shared/camera.rs:111–122`), and Density, Line Length and Line Width are all in **world**
units. Meanwhile the sampled extent shrinks as `1.2/zoom`. Put those together and
zooming in by a factor _k_:

- multiplies every glyph's on-screen length and width by _k_,
- divides the number of glyphs on screen by _k²_,
- and samples the noise at **exactly the same world points**, so the field itself
  is unchanged.

You are magnifying a fixed plot, not resolving a finer one. Zoom in far enough and
you are looking at a handful of enormous fat strokes. **Noise Scale is the detail
knob; zoom is not.** To magnify and keep the picture, divide Density, Line Length
and Line Width by the same _k_ you zoomed by.

Zooming _out_ is the interesting direction: the extent grows, the world spacing
stays put, so more of the noise's large-scale structure comes into view at more
glyphs. In the browser build this is capped — past 262,144 lines the spacing is
raised rather than the field truncated (`sims/vectors/settings.ts:726`, `761–787`), so the
field keeps covering the whole view and merely coarsens. The desktop build has no
such cap and will happily try to build a 5.77 M-line grid at minimum Density.

## Not the same as Flow Field

Vectors and [Flow Field](../flow-field/advection.md) share an idea and almost nothing else.
Both take a noise sample, multiply it by τ, and call the result a direction —
compare the expression above with `flow_vector_compute.wgsl:429–430`. Everything
after that diverges:

|                       | **Vectors**                                                        | **Flow Field**                                                                                          |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| What is drawn         | the field itself, one line quad per sample point                   | particles, and the trails they leave                                                                    |
| Is the field visible? | it is the entire image                                             | never rendered; it is an invisible force                                                                |
| Grid                  | camera-derived, `2.4/zoom ÷ density` per axis, rebuilt every frame | fixed 128 × 128 over world `[-1, 1]` (`flow/simulation.rs:1126`, `flow_vector_compute.wgsl:404–405`)    |
| Where the field lives | nowhere — computed inline in the vertex stage and discarded        | a storage buffer of `FlowVector { position, direction }`, written by a compute pass                     |
| State between frames  | none at all                                                        | particle positions, plus a trail map with decay and diffusion (`trail_decay_diffusion.wgsl:116`, `130`) |
| What length encodes   | the sample value again (redundant with angle)                      | nothing — the field's magnitude becomes particle _speed_ (`flow/shaders/particle_update.wgsl:423`)      |
| Noise implementation  | `noise` crate on the CPU / a faithful WGSL port                    | an independent hash-based WGSL reimplementation                                                         |

The one-line version: **Vectors shows you the field; Flow Field shows you what
happens to something dropped in it.** If you want to know what shape the noise
is, this simulation answers directly. If you want to know what that shape _does_
to a moving particle, that is the other one — and the two do not agree in detail,
because their noise implementations are genuinely different code.

A practical use for that: set both to the same Noise Type, Seed and Scale, and
Vectors becomes a legend for what Flow Field's particles are being pushed
through — approximately, not exactly.

## Things to try, in order

1. **Set Noise DT Multiplier to 0.** The field freezes. Everything below is
   easier to see, and easier to judge, on a still image.
2. **Set Noise Type to Checkerboard.** This is the proof of the whole mechanism.
   Checkerboard returns exactly −1 or +1 (`noise.wgsl:438–442`), which normalises
   to exactly 0 or 1 — and both of those are `angle = 0`. So every line in the
   field points **east**, alternating only in length (half vs full) and in colour
   (the two ends of the LUT). A generator with no angular spread draws a comb, not
   a flow. Now go back to OpenSimplex and notice that what you were admiring was
   the _spread_ of the sample distribution, not the noise's spatial pattern.
3. **Leave Density at 0.02 and run Noise Scale from 0.5 to 50.** At 0.5 the whole
   view is one lobe — a comb that leans. Around 5 you get the default swirls. By
   20 the lobes are down to about one glyph across and it degenerates into
   shimmering hash. You have just walked the sampling limit in one slider.
4. **Now fix Noise Scale at 20 and bring Density down to 0.005.** Back to 10
   glyphs per feature, and the structure that was hash a moment ago resolves into
   a much finer version of the default field. Same ratio, four times the detail,
   sixteen times the geometry.
5. **Set Line Length to 0.005 with Density at 0.02.** A stipple: you can see
   _where_ the samples are and roughly what colour, but the direction is gone. Now
   raise Line Length to 0.15 — seven times the spacing — and the glyphs interleave
   into a woven mat. Somewhere between the two is the setting you actually want,
   and it moves every time you change Density.
6. **Raise Line Width to 0.02 (equal to spacing).** The lines merge into blocks
   and the plot collapses into a heat map of the raw scalar field. This is the
   underlying data with the angle mapping visually removed — worth seeing once, to
   confirm that the swirls really are just a colour ramp with directions attached.
7. **Zoom in by 4× without touching anything else.** Fewer, much fatter strokes,
   sampling the same world points. Then divide Density, Line Length and Line Width
   by 4 and watch the original picture come back at four times the resolution.
   That is the coupling between the camera and the three world-space settings, in
   one move.
8. **Try Cylinders.** In the browser it draws concentric rings about the origin
   and does not animate at all. On the desktop it does something else entirely —
   see the footnote.

## Footnote: two generators that do not behave

Two of the eleven are worth knowing about before you file a bug.

**Cylinders** takes its radius across two axes, and Vectors feeds the clock in as
the third coordinate. On the desktop that means the radius is `length(x, time)`,
which `time` dominates within a few seconds — the whole field collapses to one
spatially-uniform value that cycles, so every line points the same way and sweeps
round together. The browser port deliberately diverges and uses `length(x, y)`
instead, giving the concentric rings the name promises, at the cost of the type no
longer animating (`noise.wgsl:404–429`).

**Checkerboard** in the `noise` crate casts each floored coordinate to an unsigned
integer before XOR-folding, which saturates negatives and makes the pattern
degenerate for `x < 0` or `y < 0`. Since the Vectors grid is centred on the origin
that would flatten half the field, so the browser port does not reproduce it
(`noise.wgsl:432–442`). Expect the two builds to differ across the origin.

## Where this lives in the code

| Piece                        | Location                                                        |
| ---------------------------- | --------------------------------------------------------------- |
| The angle mapping (CPU)      | `src-tauri/src/simulations/vectors/simulation.rs:312–318`       |
| The angle mapping (GPU)      | `…/vectors/shaders/line_instanced.wgsl:135–139`                 |
| Grid extent from the camera  | `…/simulation.rs:266`, `274–278`                                |
| Grid walk (x outer, y inner) | `…/simulation.rs:284–322`                                       |
| Quad extrusion               | `…/simulation.rs:222` · `line_instanced.wgsl:147–166`           |
| Sample → colour              | `…/vectors/shaders/line_fragment.wgsl:17` (`get_lut_color`)     |
| Noise generators (desktop)   | `…/vectors/noise_helper.rs:13–49`                               |
| `[-1,1]` → `[0,1]`           | `…/vectors/noise_helper.rs:57`                                  |
| Noise generators (browser)   | `…/vectors/shaders/noise.wgsl:496` (`noise_sample`)             |
| Image-mode sampling          | `…/simulation.rs:289–300`                                       |
| Rebuild-every-frame check    | `…/simulation.rs:393–400` (`geometry_dirty`)                    |
| Desktop settings + defaults  | `src-tauri/src/simulations/vectors/settings.rs:31–49`           |
| Noise type list              | `…/vectors/settings.rs:65–77`                                   |
| Web settings + grid maths    | `src/lib/engine/sims/vectors/settings.ts:703`, `726`, `761–787` |
| Uniform packing + draw call  | `src/lib/engine/sims/vectors/index.ts:596–619`, `643`           |
| UI controls                  | `src/lib/VectorsMode.svelte:159–215`                            |
| Camera transform             | `src-tauri/src/simulations/shared/camera.rs:111–122`            |

The shader corpus is shared: the desktop build embeds
`src-tauri/src/simulations/**/*.wgsl` with `include_dir!` and the web build globs
the same files, so these citations are true for both targets. The one asymmetry
is that `line_instanced.wgsl` and `noise.wgsl` are used only by the browser — the
desktop samples noise on the CPU and uploads a vertex buffer instead, which is
why the same arithmetic appears twice above.
