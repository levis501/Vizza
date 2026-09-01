# Color Schemes

_Every simulation → Color Scheme picker → **Reverse** / 🎨, and the **Gradient
Editor** on the main menu_

Every simulation in Vizza ends the same way: it computes a number, and something
turns that number into a color. This page is that something. If you arrived here
from a page about pheromone trails, chemical concentrations, particle mass or
Voronoi cell states, the piece it left out is here — and it is the same piece in
all of them.

## The mental model

A simulation produces a **scalar intensity** — one `f32` per pixel, per particle,
per cell, held in `0.0 … 1.0`. What it _means_ differs (pheromone concentration,
reagent `u`, particle mass, velocity, heading), and that is each simulation's own
business. What happens next is not:

```
intensity (0…1)  →  index (0…255)  →  three bytes  →  the pixel
```

The color scheme is a **1-D lookup table**: 256 rows, each row an RGB triple. The
intensity picks a row. That is the whole mechanism. There is no color math at
render time, no palette function, no gradient evaluated per pixel — just an array
index.

Everything else on this page is detail about that table: how it is stored, how it
gets to the GPU, where the 167 built-in ones come from, and how you author your
own.

## The lookup, exactly

Here is the function, from the Slime Mold display pass
(`slime_mold/shaders/display.wgsl:102`). Five other shaders carry their own copy of
it — Moiré, Vectors, Flow (twice) and Primordial Particles — plus two `u32`-indexed
variants in Pellets, and an inlined one in the shared render path. They are
hand-duplicated rather than shared, so they drift slightly; the differences are
noted below.

```wgsl
fn get_lut_color(intensity: f32) -> vec3<f32> {
    let idx = clamp(i32(intensity * 255.0), 0, 255);
    let r_srgb = f32(lut_data[idx]) / 255.0;
    let g_srgb = f32(lut_data[256 + idx]) / 255.0;
    let b_srgb = f32(lut_data[512 + idx]) / 255.0;

    return vec3<f32>(
        srgb_to_linear(r_srgb),
        srgb_to_linear(g_srgb),
        srgb_to_linear(b_srgb)
    );
}
```

Four things are worth reading off that:

- **The layout is planar, not interleaved.** All 256 red bytes, then all 256
  green, then all 256 blue — hence `idx`, `256 + idx`, `512 + idx`. It is not
  `r,g,b,r,g,b…`, and code that assumes otherwise produces a recognisably wrong
  image (channels smeared across the ramp) rather than a subtly wrong one.
- **The lookup is a truncation, not an interpolation.** `i32(intensity * 255.0)`
  floors. There are exactly 256 colors on screen, ever, no matter how smooth the
  underlying field is.
- **It clamps.** Anything ≥ 1.0 lands on entry 255; anything ≤ 0.0 on entry 0.
  A simulation that overshoots does not wrap or go black — it pins.
- **It converts sRGB → linear** (`display.wgsl:93`, `srgb_to_linear`). The `.lut`
  bytes are sRGB, the render targets are linear, and skipping this step visibly
  washes colors out. The same conversion exists on the CPU side in Rust
  (`color_scheme.rs:73`) and in TypeScript (`ColorScheme.ts:25`).

The buffer it reads is bound as plain read-only storage
(`display.wgsl:37`):

```wgsl
var<storage, read> lut_data: array<u32>;
```

768 `u32`s — one widened byte each. Four bytes to carry one is wasteful, and the
TypeScript port says so out loud (`ColorScheme.ts:127`), but it is the layout every
shader in the corpus binds, so it stays.

### The copies that drift

Three variations, all reading the same table:

- **Index directly.** Pellets passes a `u32` it computed itself
  (`pellets/shaders/particle_render.wgsl:42`); the caller does the `× 255` scaling
  (`:60`). Same table, one less clamp.
- **Skip the color conversion.** Vectors' copy
  (`vectors/shaders/line_fragment.wgsl:7`) returns the raw sRGB bytes without
  calling `srgb_to_linear` (`:12`). Every other consumer converts. It writes a
  larger number than the others do for the same LUT entry, so the same scheme reads
  brighter in Vectors than everywhere else — a shader inconsistency, not a
  color-scheme one.
- **Sample n stops.** Particle Life colors by _species_, not by a scalar, so it
  never indexes the LUT at all. Instead `get_colors(n)` (`color_scheme.rs:64`)
  takes n equidistant samples along the ramp and hands them over as uniforms —
  reached through the `get_species_colors` command
  (`src/lib/rpc/handlers/colorSchemes.ts:93`). This is why changing the color
  scheme still recolors Particle Life even though there is no intensity anywhere
  in it.

## What a color scheme actually is on disk

A `.lut` file is **768 raw bytes with no header**: `[R×256][G×256][B×256]`, one
`u8` per channel per entry. Nothing else — no name, no magic number, no version.
The name is the filename.

The loader is that blunt about it (`color_scheme.rs:38`):

```rust
pub fn from_bytes(name: String, data: &[u8]) -> io::Result<Self> {
    if data.len() != 768 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid LUT data size",
        ));
    }
```

There are **167** of them, in `src-tauri/src/simulations/shared/LUTs/`, and they
fall into four families named by their filename prefix:

| Prefix        | Count | What they are                                           |
| ------------- | ----- | ------------------------------------------------------- |
| `MATPLOTLIB_` | 89    | The matplotlib colormaps — `viridis`, `plasma`, `bone`… |
| `KTZ_`        | 62    | Hand-authored schemes, mostly dark-to-saturated ramps   |
| `ZELDA_`      | 15    | Themed palettes                                         |
| `ASHLEY_`     | 1     | `ASHLEY_Go Bears!`                                      |

The picker lists them by exactly those filenames, which is why the dropdown reads
`MATPLOTLIB_bone` rather than "Bone".

The **default** is bone, reversed (`color_scheme.rs:223`):

```rust
pub fn get_default(&self) -> ColorScheme {
    let mut lut_data = self.get("MATPLOTLIB_bone").unwrap();
    lut_data.reverse();
    lut_data
}
```

Note what `reverse` does _not_ do: it mutates in place and keeps the name
(`color_scheme.rs:32`), so the app's default reports itself as `MATPLOTLIB_bone`
while actually serving the flipped ramp. Bone runs black → white, so the default
runs **white → black**: low intensity is bright, high intensity is dark. That is
not a quirk of one simulation; it is why Vizza's default look is dark structure on
a light field.

### How it reaches the GPU

Two builds, one corpus of files.

**Desktop (Rust).** `include_dir!` embeds the whole directory into the binary at
compile time (`color_scheme.rs:113`), keyed by file stem
(`color_scheme.rs:118–124`). At bind time the scheme is widened to `u32`s
(`to_u32_buffer`, `color_scheme.rs:104`) and uploaded as a storage buffer —
Gray-Scott's is representative (`gray_scott/simulation.rs:378`):

```rust
let lut_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
    label: Some("GrayScott Color Scheme Buffer"),
    contents: bytemuck::cast_slice(&lut_u32),
    usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
});
```

Changing scheme is a `queue.write_buffer` over the same allocation
(`gradient/simulation.rs:171`, `update_lut`) — the pipeline and bind group never
change.

**Web (Vite).** The browser cannot read 167 separate files without 167 requests,
so `vite-plugin-luts.ts` reads _the same directory_ (`vite-plugin-luts.ts:20`) and
concatenates it into one blob, sorted by name so a scheme's offset is
`index * 768` (`vite-plugin-luts.ts:28`, `packLuts`). It serves two URLs:

| URL          | Contents                                               |
| ------------ | ------------------------------------------------------ |
| `/luts.bin`  | 167 × 768 = **128,256 bytes**, back to back            |
| `/luts.json` | `{ stride: 768, names: [...] }` — the name→index table |

Both are served from middleware in dev (`vite-plugin-luts.ts:59`) and emitted as
build assets in `generateBundle` (`vite-plugin-luts.ts:75`), so dev and production
answer identically. The plugin refuses to pack a file that is not exactly 768
bytes (`vite-plugin-luts.ts:38`) — a malformed scheme breaks the build rather than
the render.

The browser fetches both once (`ColorSchemeManager.ts:94`) and slices the blob on
demand (`ColorSchemeManager.ts:166`). There is no forked copy of the assets under
`src/`; the `.lut` files are the single source of truth for both platforms, in
the same way the WGSL corpus is.

## The Gradient Editor is a tool, not a simulation

The main menu lists **Gradient Editor** as a card alongside Slime Mold and
Gray-Scott (`src/lib/MainMenu.svelte:73`), which is misleading. Nothing evolves in
it. It has no compute pass, no state, and no settings — its `Settings` struct is
literally empty (`gradient/settings.rs:4`), `update_setting` accepts and ignores
every name (`gradient/simulation.rs:308`), and `randomize_settings` does nothing
(`:352`). All it draws is one full-screen quad whose fragment shader reads the LUT
left-to-right as a ramp (`gradient/shaders/gradient.wgsl:314`):

```wgsl
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    // Use X coordinate for gradient position (0.0 to 1.0)
    let gradient_pos = input.uv.x;
```

It is a **preview strip for the color scheme you are authoring**, wrapped in an
editor. Note that its ramp _does_ interpolate between adjacent entries
(`gradient.wgsl:139`, `sample_lut`) while every simulation's `get_lut_color` does
not — so the editor's preview is very slightly smoother than what a simulation
will show you.

### From stops to 768 bytes

What you manipulate is a list of **stops**: a position in `0…1` and a `#rrggbb`
color (`spaces.ts:411`). Everything else the editor offers is a way to produce or
modify that list — the Preset dropdown, the Random Generator, dragging a handle,
double-clicking to add one.

Turning stops into a LUT is one function, `buildGradientLut`
(`src/lib/engine/color/spaces.ts:569`):

```ts
for (let i = 0; i < 256; i++) {
    const hex = sampleSorted(sorted, i / 255, options);
    lut[i] = parseInt(hex.slice(1, 3), 16);
    lut[i + 256] = parseInt(hex.slice(3, 5), 16);
    lut[i + 512] = parseInt(hex.slice(5, 7), 16);
}
```

256 samples, evenly spaced, written planar. That is the entire bridge between the
editor and the rest of the app. Two controls change what `sampleSorted` returns:

- **Color Space** (`GradientEditorMode.svelte:107`) — `RGB`, `Lab`, `OkLab`,
  `OkLCh` (`spaces.ts:365`), defaulting to OkLab (`spaces.ts:378`). This is the
  space the mix between two stops happens in (`spaces.ts:447`, `mixSrgb`).
  Interpolating red→blue in RGB passes through a muddy dark purple; in OkLab it
  stays saturated. The stops themselves land on the same LUT entries either way —
  only the entries between them differ.
- **Interpolation** (`GradientEditorMode.svelte:125`) — `Smooth` or `Stepped`.
  Stepped returns the left stop's color outright (`spaces.ts:546`), so the LUT
  becomes flat plateaus with vertical cliffs between them.

The editor pushes the rebuilt LUT at the live preview on every edit, debounced
50 ms (`GradientEditorMode.svelte:486`, `updateGradient`), through
`update_gradient_preview` (`:505`). That command bypasses the catalogue entirely
and writes straight at the running simulation
(`src/lib/rpc/handlers/colorSchemes.ts:86`) — which is why an unsaved gradient
previews without polluting your scheme list.

**Save Color Scheme** (`GradientEditorMode.svelte:754`) sends the same 768 bytes to
`save_custom_color_scheme` and then selects the result by name. Where it lands
depends on the build: the desktop writes `~/Vizza/LUTs/<name>.lut`
(`color_scheme.rs:177`, `save_custom`, over `get_settings_dir` at
`app_settings.rs:100`) — a real 768-byte file, indistinguishable in format from a
built-in. The browser base64-encodes it into `localStorage` under
`vizza.colorSchemes.custom` (`ColorSchemeManager.ts:304`). A custom scheme may not
take a built-in's name; the save is refused with a message rather than silently
losing your work (`ColorSchemeManager.ts:261`).

**Export** (`GradientEditorMode.svelte:791`) downloads exactly those 768 bytes as
`<name>.lut`. Drop the file into `src-tauri/src/simulations/shared/LUTs/` and it
becomes a built-in for both builds — there is no registration step.

### The other editor

The same editor exists twice. The 🎨 button next to every simulation's scheme
picker (`ColorSchemeSelector.svelte:21`) opens a dialog headed **Color Scheme
Editor** (`ColorSchemeSelector.svelte:45`) with the same stops, the same Space and
Interpolation controls, and the same `buildGradientLut`. The differences are
cosmetic plus one behaviour: closing that dialog restores the color scheme you had
before you opened it (`ColorSchemeSelector.svelte:387`). The full-screen Gradient
Editor has no such undo — it is the mode you are in.

## What you will actually notice

### Reverse flips the table, not the image

The **Reverse** button beside every scheme picker
(`ColorSchemeSelector.svelte:13`) reverses each channel array in place
(`ColorScheme.ts:70`) and re-uploads. Entry 0 becomes what entry 255 was. The
simulation is untouched — same numbers, opposite colors — so a field that read as
"bright wisps on black" becomes "dark wisps on white".

The reversal happens **once, on the CPU, before upload**. The shader has no idea.
This matters if you are reading the port's `updateColorScheme`
(`src/lib/engine/sims/gradient/index.ts:343`): it takes a `reversed` flag and
deliberately does not apply it, because the bytes arriving have already been
flipped.

Don't confuse it with the Gradient Editor's own **Reverse** button
(`GradientEditorMode.svelte:192`), which mirrors your stop _positions_
(`:571`) before the LUT is built. Same visual result, different object edited.

### A dark low end makes a simulation look empty

Most of a simulation's pixels sit near zero most of the time — background, decayed
trail, unreacted medium. Those pixels all read entry 0. Pick a scheme whose entry 0
is black (`KTZ_Klein_Blue` starts at `(0,0,0)`; so does unreversed
`MATPLOTLIB_bone`) and the great majority of the screen is black, so the
simulation looks sparse and under-populated.

It usually is not. Try the same parameters under `MATPLOTLIB_viridis`, whose entry
0 is a dark violet `(68,1,84)` rather than true black: the faint activity that was
invisible against black is suddenly legible. Nothing changed but the first row of
the table. When a simulation "looks like nothing is happening", check the low end
of the scheme before touching a single slider.

### Hard steps band, and so does everything else eventually

There are 256 colors and no dithering in the simulation path, so a smooth field
stretched over a large screen shows Mach bands wherever adjacent LUT entries differ
noticeably. That is the floor, and it is unavoidable.

A **Stepped** gradient, or a scheme with an abrupt color change between two
adjacent entries, turns that floor into the ceiling: an intensity field varying
smoothly across the screen renders as flat plateaus with hard contour lines. This
is sometimes exactly what you want — contour maps of a Gray-Scott field are far
more readable than the smooth version — and sometimes it is the reason your image
looks posterised. Either way it is the scheme's doing, not the simulation's.

The Gradient Editor's **Display Mode** (`GradientEditorMode.svelte:116`) offers a
`Dithered` option that quantises to 16 levels per channel and ordered-dithers the
result (`gradient.wgsl:205`, `apply_display_mode`). It applies to the preview strip
only — no simulation dithers its color output.

### The top of the ramp is a saturation flag

`i32(intensity * 255.0)` floors, so entry `i` covers the half-open range
`[i/255, (i+1)/255)` — except entry 255, whose only inhabitant is intensity
exactly 1.0 (plus everything the clamp drags down to it). Entry 255 is therefore
not "very high"; it is **saturated**, and it is worth choosing deliberately.

Slime Mold makes this vivid. Its trail map is clamped to `1.0` on every write, and
at the default Deposition Rate of 100 a single agent visit drives a pixel straight
to saturation (see [Pheromone Deposition](../slime-mold/pheromone-deposition.md)).
So the screen is full of pixels sitting on entry 255 while entry 254 is nearly
unvisited. Give entry 255 a color that stands out from its neighbour and every
saturated pixel announces itself; make the last few entries similar and saturation
becomes invisible, which is why heavily-saturating settings can look flat under one
scheme and blown-out under another.

## Where this lives in the code

| Piece                       | Location                                                        |
| --------------------------- | --------------------------------------------------------------- |
| The lookup itself           | `src-tauri/src/simulations/slime_mold/shaders/display.wgsl:102` |
| LUT storage binding         | `…/slime_mold/shaders/display.wgsl:37` (`array<u32>`)           |
| The shared render path      | `src-tauri/src/simulations/shared/infinite_render.wgsl:283`     |
| Index-by-`u32` variant      | `…/pellets/shaders/particle_render.wgsl:42`                     |
| `ColorScheme` (Rust)        | `src-tauri/src/simulations/shared/color_scheme.rs:9`            |
| 768-byte parse              | `…/shared/color_scheme.rs:38` (`from_bytes`)                    |
| Widen to GPU form           | `…/shared/color_scheme.rs:104` (`to_u32_buffer`)                |
| Desktop embedding           | `…/shared/color_scheme.rs:113` (`include_dir!`)                 |
| Default scheme              | `…/shared/color_scheme.rs:223` (bone, reversed)                 |
| Custom LUT files (desktop)  | `…/shared/color_scheme.rs:177` → `~/Vizza/LUTs/<name>.lut`      |
| n species colors            | `…/shared/color_scheme.rs:64` (`get_colors`)                    |
| The 167 built-ins           | `src-tauri/src/simulations/shared/LUTs/*.lut`                   |
| Web packing plugin          | `vite-plugin-luts.ts:28` (`packLuts`)                           |
| `ColorScheme` (web)         | `src/lib/engine/color/ColorScheme.ts:29`                        |
| Catalogue + custom (web)    | `src/lib/engine/color/ColorSchemeManager.ts:51`                 |
| Stops → 768 bytes           | `src/lib/engine/color/spaces.ts:569` (`buildGradientLut`)       |
| Interpolation spaces        | `src/lib/engine/color/spaces.ts:365`                            |
| Scheme commands             | `src/lib/rpc/handlers/colorSchemes.ts:49`                       |
| Gradient preview simulation | `src-tauri/src/simulations/gradient/simulation.rs:171`          |
| Gradient preview (web port) | `src/lib/engine/sims/gradient/index.ts:343`                     |
| Preview shader              | `src-tauri/src/simulations/gradient/shaders/gradient.wgsl:139`  |
| Full-screen editor UI       | `src/lib/GradientEditorMode.svelte`                             |
| Picker + in-panel editor UI | `src/lib/components/shared/ColorSchemeSelector.svelte`          |

The `.lut` files are shared between platforms the same way the shaders are: one
directory, embedded by `include_dir!` for the desktop build and concatenated by
`vite-plugin-luts.ts` for the web build. There is no second copy to edit.
