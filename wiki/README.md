# Vizza Wiki

Explanations of what Vizza's simulations actually _do_ — written for someone who
just opened the app, clicked a simulation, and is now looking at a panel of
sliders with no idea which one is the interesting one.

This is deliberately not API documentation and not a changelog. The code already
says what happens; these pages say **why it looks like that**, and which knob to
reach for.

## Contents

### Slime Mold

- [Pheromone Deposition](slime-mold/pheromone-deposition.md) — the one line of
  shader code that every emergent structure in the simulation comes from.

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
- **Cite code with a path and a line number** (`compute.wgsl:384`). Line numbers
  drift; that is an acceptable cost for making a claim checkable. The path is
  the durable half, so make sure the surrounding prose names the function or
  setting too, and a stale number is still recoverable with a grep.
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
