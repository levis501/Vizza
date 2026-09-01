# Vizza Wiki

Explanations of what Vizza's simulations actually _do_ — written for someone who
just opened the app, clicked a simulation, and is now looking at a panel of
sliders with no idea which one is the interesting one.

This is deliberately not API documentation and not a changelog. The code already
says what happens; these pages say **why it looks like that**, and which knob to
reach for.

## Contents

One page per simulation, each built around the single mechanism that simulation
reduces to. In main-menu order:

| Simulation               | Page                                                       | The one idea                                                                     |
| ------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **Slime Mold**           | [Pheromone Deposition](slime-mold/pheromone-deposition.md) | Agents that cannot see each other, coordinating through a shared trail map       |
| **Gray-Scott**           | [Feed and Kill](gray-scott/feed-and-kill.md)               | Two numbers whose interesting region is a sliver that closes at K = 1/16         |
| **Particle Life**        | [The Force Matrix](particle-life/force-matrix.md)          | An asymmetric table: i can chase j while j flees i                               |
| **Flow Field**           | [Advection](flow-field/advection.md)                       | One operation applied twice a frame — to the particles, and to their own trails  |
| **Pellets**              | [Overlap Resolution](pellets/overlap-resolution.md)        | The positional correction that is the only thing keeping two pellets apart       |
| **Gradient Editor**      | [Color Schemes](gradient-editor/color-schemes.md)          | How every simulation's scalar becomes a color — the 768-byte lookup table        |
| **Voronoi CA**           | [Raycast Adjacency](voronoi-ca/raycast-adjacency.md)       | Life's rules applied to a moving tessellation that has the wrong number of sides |
| **Moiré**                | [Beat Frequencies](moire/beat-frequencies.md)              | Two grids multiplied, and the difference frequency that appears in neither       |
| **Vectors**              | [Noise to Angle](vectors/noise-to-angle.md)                | A scalar field wearing a vector field's name: `angle = value × τ`                |
| **Primordial Particles** | [The Motion Law](primordial-particles/the-motion-law.md)   | One signed turn per frame, and the cells that grow and divide out of it          |

[Color Schemes](gradient-editor/color-schemes.md) is the shared page: every
simulation maps some scalar through the same lookup table, so the other nine
link there rather than explaining it again.

### Where these run

The desktop build has all ten. The browser port (`WEB_PORT.md`) is landing them
one milestone at a time, and today runs **Slime Mold, Gray-Scott, Moiré, Vectors
and the Gradient Editor**. Particle Life, Primordial Particles, Pellets, Voronoi
CA and Flow Field are desktop-only for now (milestones M8–M12), so half the menu
is missing at `:9994` — that is the port's progress, not a broken build.

Where the two builds genuinely disagree, the pages say so. Vectors is the sharp
case: desktop uses the Rust `noise` crate and the browser an independent WGSL
reimplementation, so the same Noise Type, Seed and Scale give different fields.

## What belongs here

A page earns its place if it answers a question a curious user would actually
ask while the app is running:

- _"What is this slider, in terms of what I'm seeing?"_
- _"Why does the pattern collapse when I turn this up?"_
- _"These three settings clearly interact — how?"_

Good pages connect three things: **the word in the UI**, **the line of code that
implements it**, and **the visible consequence on screen**. A page that only
does one of the three is either a tooltip or a code comment, and belongs in the
UI or in the source instead.

## Conventions

- **One directory per simulation**, named after it in kebab-case
  (`slime-mold/`, `gray-scott/`, `particle-life/`). Cross-cutting topics —
  gradients, masks, camera, post-processing — go in `shared/`.
- **Cite code with a path and a line number**
  (`slime_mold/shaders/compute.wgsl:384`). Line numbers drift; that is an
  acceptable cost for making a claim checkable. The path is the durable half, so
  make sure the surrounding prose names the function or setting too, and a stale
  number is still recoverable with a grep. Include enough of the path to be
  unambiguous — three simulations have a `compute.wgsl`, three have a
  `particle_render.wgsl`, and `mod.rs` is everywhere. A bare basename is fine
  only after the page has established which directory it means, and `…/` stands
  in for that prefix.
- **Say what the code does, not what the app claims it does.** Every page in
  this set found at least one place where a label, an About panel or a menu
  blurb disagrees with the shader — inverted sliders, dead settings, a
  simulation whose advertised feature does not exist. Document the behavior,
  name the contradiction plainly, and let the reader decide whether it is a bug.
  A wiki that repeats the UI is worth nothing to someone who has already read
  the UI.
- **Shaders live in the Rust tree, once.** `src-tauri/src/simulations/**/*.wgsl`
  is the single corpus — the desktop build embeds it with `include_dir!` and the
  web build globs the same files (`src/lib/engine/shaders/index.ts`). So a
  shader citation is true for both platforms, and there is never a second copy
  under `src/` to cite instead.
- **Name settings as the UI labels them**, then give the internal identifier
  once in parentheses — `Deposition Rate` (`pheromone_deposition_rate`). The
  reader is looking at the UI, not at the struct.
- **Prefer an experiment to an adjective.** "Set it to 0 and watch the structure
  dissolve" teaches more than "it is very important."
- **Add new pages to the Contents list above** when you write one.
