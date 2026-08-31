# Pheromone Deposition

_Slime Mold → Pheromone → Deposition Rate (`pheromone_deposition_rate`)_

Every structure the Slime Mold simulation produces — the veins, the lattices,
the slow braided trunks — comes out of a single line of shader code. This is
that line, what it does, and why it is the setting worth understanding first.

## The agents cannot see each other

The main menu calls Slime Mold an "agent collaboration simulation," which is
accurate but easy to misread. It does not mean the agents perceive one another
and coordinate. **There is no agent-to-agent interaction anywhere in the
simulation.** An agent cannot tell that another agent exists, has ever existed,
or is standing on the same pixel.

All coordination happens through the _environment_. Agents write into a shared
canvas; other agents later read that canvas and steer by it. The message and the
medium are the same object — the picture on screen. Biologists call this
**stigmergy**: coordination through traces left in a shared world rather than
through communication.

The useful image is not a conversation. It is a worn footpath across a field.
Nobody agreed on the route. Everyone walked where the grass was already flat,
which flattened it further.

## The pheromone field is what you are looking at

Alongside the agent buffer there is a second structure, the **trail map**: one
`f32` per simulation pixel (`compute.wgsl:44`), held in the range `0.0 … 1.0` by
the clamp on every write. That number is the pheromone concentration at that
point, and it _is_ the image — the display pass reads the trail map and maps its
intensity through the active color scheme, a 256-entry LUT
(`display.wgsl:102`, `get_lut_color`).

The agents themselves are never drawn. You only ever see their residue.

## What Deposition does

Each frame, every agent runs four steps (`update_agents` in `compute.wgsl`):

1. **Sense** — sample two points ahead-left and ahead-right, placed by Sensor
   Angle and Sensor Distance (`compute.wgsl:290–308`). The reading is the trail
   map combined with the optional gradient map — an independent attractant
   field, unrelated to the color scheme despite sharing the word "gradient."
   With no gradient configured, a sensor reads pheromone and nothing else.
2. **Turn** — rotate toward whichever sensor read the higher value, capped by
   Turn Rate (`compute.wgsl:311–323`).
3. **Move** — step forward at Speed (`compute.wgsl:326–328`).
4. **Deposit** — this one.

Step 4 is one statement (`compute.wgsl:384`):

```wgsl
trail_map[idx] = clamp(trail_map[idx] + effective_deposition_rate * 0.01, 0.0, 1.0);
```

The agent adds pheromone to the single pixel it is now standing on. It is a
single cell, not a brush or a splat, and it happens _after_ the move, so an
agent marks where it arrived rather than where it came from.

**Deposition Rate is how much it adds.**

### The numbers

The slider runs 0–100 and is shown as a percentage. The shader scales it by
`0.01`, so the value maps directly onto the trail map's `0.0 … 1.0` range:

| Deposition Rate | Added per visit | Visits to saturate a pixel |
| --------------- | --------------- | -------------------------- |
| 100 (default)   | 1.0             | 1                          |
| 25              | 0.25            | 4                          |
| 5               | 0.05            | 20                         |
| 0               | 0.0             | never                      |

At the default of 100 a single agent visiting a pixel once drives it to full
brightness immediately. That is a much blunter instrument than the slider's
appearance suggests, and it is why the default look is so high-contrast.

At 0, agents still wander — sensing and turning and moving as usual — but they
leave nothing behind, so there is nothing to sense, so they never organize.
You get permanent noise.

## Why it is the setting that matters

Deposition is the **write** half of a feedback loop, and it is the only write.
Reading it back is what steers every agent:

```
agents walk somewhere → deposition brightens that spot → brighter spots
attract more agents → they deposit more → …
```

That is positive feedback. On its own it would fill the screen white within
seconds. Two other settings in the same Pheromone panel are the brakes:

- **Decay Rate** (`pheromone_decay_rate`, `decay_trail` at `compute.wgsl:393`)
  fades the entire field toward zero each frame. This is forgetting. Without it
  everything saturates and all structure disappears into white.
- **Diffusion Rate** (`pheromone_diffusion_rate`, `diffuse_trail` at
  `compute.wgsl:432`) blurs the field into neighboring pixels each frame. This
  is how a trail becomes _wide enough to be found_ by an agent that is not
  already standing exactly on it. Zero diffusion means trails one pixel wide
  that nobody can discover.

Everything you see is the equilibrium of those three forces. So Deposition alone
is not really "the interesting one" — **the ratio of deposition to decay is.**
Deposition sets how loudly an agent shouts; decay sets how quickly the shout is
forgotten.

- Loud and quickly forgotten → sharp, restless filaments that rewire constantly.
- Quiet and long remembered → slow, thick, stable trunks.

Note that decay's slider goes to 10000 while deposition's stops at 100, so the
two are not on comparable scales; judge the ratio by eye, not by the numbers.

## Things to try, in order

1. **Set Deposition to 0.** Watch the structure dissolve into aimless drift.
   This is the control condition: identical agents, identical rules, no shared
   trace — and no pattern whatsoever. Every interesting thing in this simulation
   is downstream of that one line.
2. **Back to 100, then push Decay up sharply.** Trails become thin, twitchy and
   short-lived; the network never settles.
3. **Deposition ~10 with low decay.** Structure now takes many agent visits to
   establish, so only genuinely well-trafficked routes survive. Fewer, cleaner,
   more deliberate-looking channels.
4. **Deposition high, Diffusion 0.** Bright hairline trails that other agents
   mostly fail to find — a good demonstration of what diffusion is actually for.

## Footnote: the mask target of the same name

"Pheromone Deposition" also appears as a **mask target** (`mask_target == 0`,
handled at `compute.wgsl:257`). The mask is a pattern you paint over the canvas;
selecting this target makes it modulate the deposition rate per region — high
where the mask is bright, low where it is dark, blended by the mask's strength.

Same parameter, varied across space instead of set as one global number. It is
how you get agents to build structure only where you have drawn.

## Where this lives in the code

| Piece                   | Location                                                        |
| ----------------------- | --------------------------------------------------------------- |
| The deposit itself      | `src-tauri/src/simulations/slime_mold/shaders/compute.wgsl:384` |
| Decay pass              | `…/compute.wgsl:393` (`decay_trail`)                            |
| Diffusion pass          | `…/compute.wgsl:432` (`diffuse_trail`)                          |
| Mask modulation         | `…/compute.wgsl:257`                                            |
| Trail value → color     | `…/shaders/display.wgsl:102` (`get_lut_color`)                  |
| Desktop settings        | `src-tauri/src/simulations/slime_mold/settings.rs`              |
| Web settings + defaults | `src/lib/engine/sims/slimeMold/settings.ts`                     |
| Uniform packing         | `src/lib/engine/sims/slimeMold/settings.ts` (`f32[10]`)         |
| UI control              | `src/lib/SlimeMoldMode.svelte:174`                              |

The shader is not duplicated between platforms: the desktop build embeds
`src-tauri/src/simulations/**/*.wgsl` with `include_dir!`, and the web build
globs the same files (`src/lib/engine/shaders/index.ts`). One corpus, both
targets.
