# Vizza Web — browser WebGPU port

Living document. Check tasks off as they land. Every milestone ends with
something visible at **http://localhost:9994**.

## What this is

`src-tauri/` is a Tauri v2 desktop app: a Rust/wgpu backend (11 GPU simulations,
64 WGSL files, 8,808 shader lines, 35 compute entry points) with a Svelte 5 HUD
floating over it. The Tauri window is `"transparent": true` and Rust renders
straight into the native surface *behind* the webview — there is no `<canvas>`
anywhere in the frontend.

We are rebuilding it as a browser app in this same repo. The Rust/Tauri layer is
replaced by TypeScript; the WGSL shaders and the Svelte UI carry across intact.

| Decision | Choice |
|---|---|
| Graphics API | **WebGPU only** (Chrome) — WGSL ports ~1:1; WebGL2 has no compute stage |
| UI | **Reuse the existing Svelte components** |
| Stack | **Svelte 5 + TypeScript + Vite**, same repo, Tauri dropped |
| Persistence | **`localStorage` only** |
| Milestones | One simulation per milestone |
| Ported desktop features | Image upload, Fullscreen + in-page window chrome |
| Omitted desktop features | Webcam, native dialogs, native window/transparency |

No Rust toolchain, no `apt-get`, no `libwebkit2gtk`, no `libclang`. This port
needs `npm install` and nothing else.

---

## Verified environment facts

Established by direct measurement in this container, not assumed:

- **Headless WebGPU works** via Chrome's bundled SwiftShader —
  `VK_ICD_FILENAMES=$(dirname $CHROME)/vk_swiftshader_icd.json` plus
  `--enable-unsafe-webgpu --enable-features=Vulkan`. Compute dispatch,
  `atomicAdd`, storage-texture writes, and render+pixel readback all confirmed.
  `maxComputeWorkgroupSizeX=256`. Note SwiftShader reports
  `maxStorageBuffersPerShaderStage=10`, but the reference device grants only the
  spec default of **8** — design against that, not against this.
- **Headless Chrome + SwiftShader cannot composite a WebGPU canvas** into page
  screenshots or `drawImage` readback; a direct bright-red canvas clear is
  invisible to both. Offscreen `copyTextureToBuffer` readback works, which is how
  the L3 harness is built. Canvas presentation is only verifiable in a real
  browser.
- **Worse than that (measured in M3):** one `context.getCurrentTexture()` call
  *drops the Dawn instance* for the whole page. Afterwards every
  `getCompilationInfo()` rejects with "Instance dropped" and every
  `createComputePipelineAsync` with "A valid external Instance reference no
  longer exists". So nothing that touches a canvas swap chain belongs in the L3
  harness — it would fail every test after it, not just itself — and a headless
  run of the app cannot get past its first frame into a second simulation.
- **Playwright's launcher blocks WebGPU.** `navigator.gpu` is `undefined` under
  `chromium.launch()` regardless of args, headless or headful, and also over
  `connectOverCDP`. GPU tests must drive raw Chrome.
- **167 LUT files, all exactly 768 bytes**, 128,256 B total.
- **319 `invoke()` call sites across 19 files, 85 distinct commands**, only 2 of
  them dynamic.
- Port 9994 is free; `PLODE_PORT_OFFSET=0`, so the URL is plainly
  `http://localhost:9994`.

### Storage-texture legality — measured, not inferred

Tested at the pipeline/bind-group-layout layer (shader-module compile does *not*
validate this, so testing there gives a false pass):

| Declaration | Result |
|---|---|
| `texture_storage_2d<rgba16float, read>` | **ACCEPTED** |
| `texture_storage_2d<rgba8unorm, read>` | **ACCEPTED** |
| `texture_storage_2d<rgba8unorm, read_write>` | **REJECTED** — format does not support read-write |
| `texture_storage_2d<rgba16float, read_write>` | **REJECTED** — format does not support read-write |
| `texture_storage_2d<r32float, read_write>` | ACCEPTED (only `r32*` may be read-write) |
| `texture_storage_2d<rgba8unorm, write>` | ACCEPTED |
| `var<storage, read> …: array<atomic<u32>>` | **REJECTED** at shader compile |

So **read-only storage textures are fine** — `gray_scott/reaction_diffusion.wgsl:32`
and `flow/trail_render.wgsl:48` need no work. There are **four** illegal
declarations, not six.

---

## Architecture

### The `invoke()` shim

The 10 mode components and `src/lib/utils/sync.ts` are built around
`invoke(command, args): Promise<T>` — 319 call sites. Rewriting them is the
largest single source of regression risk in the port and produces zero visible
output, so instead we implement a browser-side dispatcher with the same
string-keyed async contract.

This is not merely a compatibility hack: `Simulation::update_setting(name, Value)`
/ `get_settings() -> Value` at `src-tauri/src/simulations/traits.rs:66` *is*
already a string-keyed, JSON-valued interface. And the contract must stay async
and rejectable, because `sync.ts` rolls back optimistic updates in a `catch`.

```
src/lib/rpc/
  index.ts          export { invoke, listen, emit }
  invoke.ts         dispatcher; camelCase→snake_case key normalization
  registry.ts       Map<string, Handler>
  events.ts         typed bus: fps-update, simulation-initialized, simulation-resumed
  context.ts        EngineContext interface — the seam tests swap a fake into
  handlers/         lifecycle, settings, camera, interaction, colorSchemes,
                    presets, postProcessing, appSettings, images, perSim, webcamStubs
```

Each handler is a 3–10 line adapter over a **typed engine API**, so we get the
compat surface *and* a clean core. Mode components change one import line.

Per `.cursorrules`: Tauri converts camelCase arg keys to snake_case, but the
string **values** of `settingName`/`stateName` are already snake_case and must
pass through untouched. Normalize keys once, in `invoke.ts`.

### Engine core

```
src/lib/engine/
  gpu/       device.ts surface.ts limits.ts pointer.ts errorScopes.ts
  core/      Simulation.ts SimulationRegistry.ts SimulationHost.ts
             RenderLoop.ts Camera.ts coordinates.ts
  resources/ PingPongTextures.ts PingPongBuffers.ts buffers.ts
             bindGroupCache.ts textures.ts imageUpload.ts
  shaders/   index.ts preprocess.ts
  color/     ColorScheme.ts ColorSchemeManager.ts
  postprocess/ PostProcessing.ts averageColor.ts
  presets/   PresetStore.ts merge.ts builtins/<sim>.ts
  sims/      moire/ grayScott/ slimeMold/ particleLife/ flow/ pellets/
             primordial/ voronoiCa/ vectors/ gradient/ mainMenu/
  util/      random.ts positionGenerators.ts
```

### One WGSL corpus, not two

Do **not** copy the 64 `.wgsl` files into `src/`. Point `shaders/index.ts` at the
existing tree:

```ts
import.meta.glob('/src-tauri/src/simulations/**/*.wgsl', { query: '?raw', eager: true })
```

with `server.fs.allow: ['..', './src-tauri']` in `vite.config.ts`. The browser
build then reads the *same* files the Rust build embeds via `include_dir!`.

Where a shader must change, **fix it in the shared file and keep the Rust side
building** — every required change is a real bug or perf bug in the Rust app, not
a browser concession. If the corpora fork, 8,808 lines of WGSL drift within
weeks and the Rust app stops being a usable reference for "is this broken, or
just different?"

Same principle for the LUTs: a Vite plugin concatenates
`src-tauri/src/simulations/shared/LUTs/*.lut` into one 125 KB `luts.bin` plus a
name index at build time. One fetch, one source of truth.

### Canvas + HUD

The canvas goes **once, at App level, behind everything** — not per mode.
Creating a `GPUCanvasContext` per mode transition is the top source of flicker
and context-lost bugs.

In `index.html`, a sibling *before* `<div id="app">`:

```html
<canvas id="vizza-canvas"></canvas>
```
```css
#vizza-canvas { position: fixed; inset: 0; width:100%; height:100%;
                display: block; z-index: 0; pointer-events: none; }
#app          { position: relative; z-index: 1; }
```

This is **zero edits** to `SimulationLayout.svelte`, `SimulationControlBar`,
`SimulationMenuContainer`, or any mode component's markup. `.simulation-container`
already declares `background: transparent`, and `app.css` already sets `body` and
`#app` transparent — the exact properties that made the Tauri transparent-webview
trick work now make the canvas show through. The original architecture hands us
this for free.

**Input stays on the DOM, never on the canvas** (`pointer-events: none`), which
preserves the `isDirectTarget()` check that stops clicks on the menu panel from
painting into the simulation.

### The mouse-coordinate fix

Every mode repeats this (canonical: `SlimeMoldMode.svelte:1182-1184`, ~21 sites):

```js
const physicalCursorX = mouseEvent.clientX * (window.devicePixelRatio || 1);
```

Wrong in a browser three ways: `clientX` is viewport-relative but the canvas may
not start at 0,0; `devicePixelRatio` is not the backing scale once DPR is clamped;
and it ignores CSS zoom. The correct form uses the canvas's own ratio and reads
`devicePixelRatio` not at all:

```ts
// src/lib/engine/gpu/pointer.ts
x = (clientX - rect.left) * (canvas.width  / rect.width)
y = (clientY - rect.top ) * (canvas.height / rect.height)
```

**Do not touch the 21 call sites during the port.** In
`rpc/handlers/interaction.ts`, divide the incoming `screenX/screenY` back out by
`devicePixelRatio` to recover `clientX/clientY`, then apply `clientToCanvasPx` —
one line, in one file, exactly correct because all 21 sites use an identical
idiom. Schedule the codemod that deletes those lines for the final milestone.

`Camera.screenToWorld` consumes canvas **backing-store** pixels, so
`camera.resize()` must be fed `canvas.width/height`, never `window.innerWidth`.

### WGSL remediations

| # | Issue | Location | Fix |
|---|---|---|---|
| a | `read_write` rgba8unorm, gather-then-write-own-pixel | `flow/trail_decay_diffusion.wgsl:46` | Ping-pong. Was already racy natively |
| b | `read_write` rgba8unorm, alpha-composite | `flow/shape_drawing.wgsl:19` | **Make it a render pass** with src-alpha blending — deletes the compute pass and the ping-pong, and is faster |
| c | `read_write` rgba8unorm, **scatter** deposit | `flow/particle_update.wgsl:58` | The only hard one — see below |
| d | ~~`read_write` rgba16float, per-pixel RMW~~ | `gray_scott/paint.wgsl:16` | **Done, M4.** Ping-pong + copy-through at the two brush early-outs; source is a plain `texture_2d<f32>`, needing no WGSL feature |
| e | `array<atomic<u32>>` in a `read` binding | `pellets/physics_compute.wgsl:65` (used :179,:255,:318,:402) | Declare plain `array<u32>`, replace the four `atomicLoad` with plain reads. Same buffer, different views per pass; `grid_clear`/`grid_populate` keep their correct `read_write`. **Push upstream to Rust** |
| f | ~~`@workgroup_size(1,1,1)` dispatched w×h~~ | `gray_scott/reaction_diffusion.wgsl` | **Done, M4.** → `(8,8,1)`, 2,073,600 workgroups → 32,400 at 1920×1080. Verified safe: no workgroup memory, no barriers, in/out are different textures |

**(c), the scatter deposit.** `deposit_trail()` (`particle_update.wgsl:166-206`)
loops a (2r+1)² neighbourhood per particle for up to 100k particles, doing
load→blend→store at arbitrary colliding addresses — unsynchronised cross-workgroup
RMW that "works" natively only because dropped deposits are invisible.

Replace with an **atomic storage buffer + resolve pass**: deposits `atomicAdd`
premultiplied RGB + weight into `array<atomic<u32>>`; a second full-screen pass
divides by weight and stores into a write-only rgba8unorm trail texture. Correct,
deterministic, legal, and a mechanical translation of the existing math with no
fidelity risk — its results are exactly assertable in a test. Costs 67 MB at
2048², the largest single allocation in the app.

The faster answer (instanced additive point sprites, letting the ROP do the
blending) is a **post-port perf item**. Rewriting the deposit model mid-port
destroys the ability to diff against the Rust reference.

### Buffer budget

Measured struct sizes:

| Sim | B/elem | Current cap | Bytes at cap |
|---|---|---|---|
| Slime Mold | 16 | **UI allows 100 million** (`SlimeMoldMode.svelte:295 max={100}`, in millions) | **1.6 GB** |
| Particle Life | 24 | 50,000 | 1.2 MB |
| Flow | 32 | 100,000 | 3.2 MB |
| Primordial | 32 | 100,000 | 3.2 MB |
| Pellets | 48 | 5,000 | 240 KB |

**Only Slime Mold has a problem** — everything else is under 3% of the 128 MiB
default limit. Flow's *pool* was never the issue; its trail map is.

`src/lib/engine/gpu/limits.ts` derives every ceiling from the granted limits:

```ts
const B = device.limits.maxStorageBufferBindingSize;   // 134,217,728 default
export const caps = {
  slimeMoldAgents: Math.min(8_000_000, Math.floor(B * 0.90 / 16)),
  flowPool: 1_000_000, particleLife: 500_000, pellets: 50_000, primordial: 1_000_000,
  grayScottMaxDim: 2048,   // 2048² rgba16float ×2 = 33 MB, DPR-independent
  flowTrailMaxDim: 2048,   // 67 MB as atomic u32×4 — hard ceiling
};
```

### Reference device — Apple Silicon, Chrome 152 (measured)

The target machine grants **exactly the WebGPU spec defaults**, nothing more, so
requesting raised limits gains nothing here. Design against these numbers:

| Limit | Granted | Note |
|---|---|---|
| `maxStorageBufferBindingSize` | 128 MiB | the spec default — **sets the Slime Mold ceiling at ~7.5 M agents** |
| `maxBufferSize` | 256 MiB | spec default |
| `maxStorageBuffersPerShaderStage` | **8** | SwiftShader reported 10; 8 is the real floor. **Verified safe** — the heaviest shader (`flow/particle_update.wgsl`) binds 4 |
| `maxComputeInvocationsPerWorkgroup` | 256 | Slime Mold's `16×16×1` is **exactly at the limit** — no headroom to enlarge workgroups |
| `maxComputeWorkgroupSizeX` | 256 | |
| `maxComputeWorkgroupsPerDimension` | 65535 | see the 2D fold below |
| `maxTextureDimension2D` | 8192 | comfortably above the 2048 trail-map cap |
| features | `core-features-and-limits` only | **no `timestamp-query`** (no GPU-side profiling) and **no `float32-filterable`** — check Voronoi CA's rgba32float JFA textures use `textureLoad`, not a filtering sampler (M11) |

**Carry the 2D dispatch fold across.** `slime_mold/simulation.rs:1024` folds an
oversized 1D dispatch into two dimensions:

```rust
let workgroups_x = total_workgroups.min(max_workgroups_per_dim);
let workgroups_y = total_workgroups.div_ceil(max_workgroups_per_dim);
```

Without it, agents/256 would cap at 65535 × 256 ≈ 16.8 M — above the memory
ceiling, so it happens not to bind here, but the fold must survive the port
anyway. The Rust hardcodes `65535` in three places; the port must read
`device.limits.maxComputeWorkgroupsPerDimension` instead.

Then wire `SlimeMoldMode.svelte:295` to `max={caps.slimeMoldAgents / 1e6}` — a
one-line edit converting a guaranteed device-loss into a correct clamp. Lower the
default from 10M to ~1M too.

Request limits as `min(adapter, ceiling)`, never fixed:

```ts
requiredLimits: {
  maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 30),
  maxBufferSize:               Math.min(adapter.limits.maxBufferSize,               1 << 30),
}
```

This can never fail, whereas `src-tauri/src/main.rs:60-63`'s fixed 2 GB request
*will* fail on many browser/driver combos and take the whole app down. Do **not**
request `TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES` (no WebGPU equivalent) or
`readonly-and-readwrite-storage-textures` (absent on SwiftShader — requesting it
would break the test harness).

**Two latent bombs to defuse in M2:**
- Gray-Scott sizes its sim texture to the surface (`traits.rs:~262`). Unclamped
  3× DPR on a 4K display allocates an 11520×6480 rgba16float ping-pong pair ≈
  **1.2 GB**. Clamp DPR to 2 *and* cap the GS texture at 2048² independently.
- Pellets' grid explodes quadratically (`pellets/simulation.rs:538-540`:
  `cell_size = particle_size * 3`, `GridCell` = 260 B). At `particle_size=0.0005`
  → 1333² cells → **462 MB, over the limit**. Clamp total cell count to ~512².
  This crashes the Rust build too.

---

## Omitted features

| Feature | Original | Why omitted |
|---|---|---|
| **Webcam input** | `nokhwa` native capture (`shared/webcam.rs`, 407 ln); Slime Mold, Gray-Scott, Flow, Vectors, Moiré | Out of scope. The 10 `*_webcam_*` commands become stubs returning `[]`; `WebcamControls.svelte` hidden behind one `featureFlags.webcam = false` prop rather than editing 5 components. *(Portable later via `getUserMedia`.)* |
| **Native file dialogs** | `tauri-plugin-dialog`; `ImageSelector.svelte:25,44,55` passes a filesystem **path** | Replaced by `<input type="file">` → `createImageBitmap` → `copyExternalImageToTexture` |
| **Filesystem persistence** | `~/Vizza/settings.toml`, `~/Vizza/<sim>/presets/*.toml`, `~/Vizza/LUTs/*.lut` | Replaced by `localStorage`. **Uploaded images are session-only** — base64 of a 4K image blows the 5–10 MB quota instantly |
| **Transparent native window** | `tauri.conf.json:37`, `macOSPrivateApi`, `entitlements.plist` | No browser equivalent; the canvas replaces it |
| **Native window control** | `apply_window_settings`, `set_webview_zoom`, `get_current_window_size`, quit button | Partial: Fullscreen API + in-page title bar. `set_webview_zoom` falls back to the CSS path App.svelte already has. Quit button removed |
| **FPS limiter** | Rust thread sleep (`manager.rs:1332-1343`) | Frame skipping in `RenderLoop`; rAF caps at display refresh |
| **Paused-frame redraw** | `render_frame_paused` every frame | Render once on demand instead — fixes a real laptop-fan problem |
| **Crystal Growth** | `commands/crystal_growth.rs` | Already dead upstream — never registered in `main.rs` |
| **`zoom_to_cursor` sign bug** | `camera.rs:206` computes `pos += ndc·(1/z₁ − 1/z₀)` | **Deliberately not reproduced.** Holding the invariant requires the negation, `ndc·(1/z₀ − 1/z₁)`; the desktop app throws the world point under the cursor away from the pointer at roughly double the intended correction. Confirmed side-by-side at `/zoom-compare.html`: 1667 px of drift after 12 zoom steps vs 0.0 px corrected. Reviewed and signed off 2026-08-30 |
| **`simulation/render_loop.rs`** | 126 ln | Already dead upstream — never instantiated |

---

## Milestones

### M0 — Dependencies, dev server, scaffolding ✅
- [x] `npm install`
- [x] Add dev deps: `vitest`, `jsdom`, `@playwright/test`, `@webgpu/types`
- [x] `vite.config.ts`: host `0.0.0.0`, port 9994, `strictPort`, `fs.allow` covering `src-tauri`, `$lib` alias
- [x] Add `"webgpu"` to `tsconfig.json` types + `$lib/*` path mapping
- [x] `vite-plugin-luts.ts` — packs the 167 `.lut` files into `luts.bin` (128,256 B, verified exact) + `luts.json` index, served in dev and emitted at build
- [x] `src/lib/rpc/` — `invoke.ts`, `events.ts`, `registry.ts`, `context.ts`; all 97 commands stubbed
- [x] Codemod: 22 files moved off `@tauri-apps/api/{core,event}`
- [x] `.gitignore` block added
- [x] **Test (L2):** WGSL lint suite over all 64 shaders — 4 rules, with a **known-violations ledger** asserted exactly, so fixing a shader without updating the ledger fails the test
- [x] **Test (L1):** rpc registry completeness — greps command names out of the `.svelte` sources at test time, plus the two dynamic call-site families (post-processing, `loadCommand`). Caught `get_species_colors` and `get_current_window_size` on first run
- [x] **Test:** `curl` returns HTML; `luts.bin` serves 128,256 B; typecheck + build green

### M1 — Title page ✅
- [x] Repoint `App.svelte` / `MainMenu.svelte` to the rpc shim
- [x] Remove the quit button, its handler, styles, and the `@tauri-apps/api/window` import
- [x] Un-orphan the design tokens: `main.ts` now imports `src/styles.css`
- [x] Opaque backdrop on `html` in `app.css` (`body`/`#app` stay transparent for the canvas)
- [x] Delete `PhysicsDiagram.svelte` — 0 bytes and, contrary to the initial survey, imported by nothing
- [x] Replace the native file dialog in `ImageSelector.svelte` with `<input type="file">` (decode lands in M2)
- [x] Start stubs emit `simulation-initialized` / `simulation-resumed` so the loading overlay clears
- [x] **Test (L4):** 15 Playwright tests green — title, logo, 11 cards, no quit button, opaque backdrop, design tokens resolved, and all 10 modes navigate there-and-back
- [x] **Visible:** the Vizza title screen on :9994

### M2 — Engine core + all shared infrastructure ✅
Everything with fan-in across sims landed here, so no sim milestone re-debugs it.
- [x] `gpu/device.ts` (secure-context check first, limit negotiation, device-lost), `gpu/surface.ts` (`ResizeObserver`, **DPR clamped to 2**, aspect-preserving max-dim clamp), `gpu/limits.ts` (+ `foldDispatch`, the 2D dispatch fold), `gpu/pointer.ts`, `gpu/errorScopes.ts`
- [x] `core/Simulation.ts`, `SimulationRegistry.ts`, `SimulationHost.ts`, `RenderLoop.ts`
- [x] `core/Camera.ts` + `coordinates.ts` — ports of `shared/camera.rs` + `shared/coordinates.rs`
- [x] `color/ColorScheme.ts` + `ColorSchemeManager.ts`
- [x] `presets/PresetStore.ts` + `merge.ts` (port of `preset_manager.rs:169-212`)
- [x] `resources/` ping-pong helpers, `bindGroupCache`, `textures`, `buffers`, `imageUpload.ts`
- [x] `postprocess/` blur + average-color
- [x] Canvas in `index.html` + `app.css`; pointer path wired through one function
- [x] Port `main_menu/shaders/combined.wgsl`
- [x] `rpc/handlers/` — lifecycle, camera, settings, colorSchemes, presets over the stub baseline
- [x] `engine/bootstrap.ts` + `main.ts` wiring
- [x] **Test (L1):** 160 tests — camera round-trip + `zoomToCursor` invariant, `clientToCanvasPx`, LUT parse/reverse/sample, preset deep-merge, image fit geometry, rpc registry completeness
- [x] **Test (L3):** 19 GPU tests — device init, **all 64 WGSL modules compile**, pixel readback, ping-pong, create/destroy ×20
- [x] **Test (L4):** 15 Playwright tests, including the no-WebGPU degradation path

**Four defects found and fixed during M2:**
1. **4 new WGSL compile errors** — `flow/particle_render.wgsl` and `particle_life/{fragment,vertex,tile_render}.wgsl` pass `u32` between vertex and fragment stages without `@interpolate(flat)`. naga accepts this; Tint rejects it outright, so M8 and M12 were both blocked. Fixed in the shared corpus (standard WGSL, so the Rust build is unaffected).
2. **`:root` background regression** — importing `styles.css` for its design tokens (M1) also brought `:root { background-color: #f6f6f6 }`, which beats a bare `html` selector on specificity regardless of import order. The page was near-white behind the menu's 80% scrim. `app.css` now overrides at `:root`.
3. **No-WebGPU path left the UI unusable** — modes render `loading={loading || !settings}`, so a throwing `get_current_settings` pinned the loading overlay, which swallows pointer events including "Back to Menu". Every engine-dependent handler now degrades instead of throwing.
4. **Camera commands raced the boot** — `App.svelte` calls `set_camera_sensitivity` from `onMount`, before the async device request resolves.

**Environment limitation discovered:** headless Chrome + SwiftShader does **not** composite a WebGPU canvas into page screenshots or `drawImage` readback — a direct bright-red canvas clear is invisible to both. Offscreen `copyTextureToBuffer` readback works fine, which is why the L3 harness is built that way. **Canvas presentation can only be confirmed in a real browser.**

### M3 — Moiré ✅
Smallest sim in the repo: 1 shader, 316 lines, one already-legal write-only storage texture, no particles, no ping-pong, no grid, no atomics. It proves the whole spine end-to-end in the smallest possible surface.
- [x] Port `moire/compute.wgsl` (316) with advection feedback; 23 settings; 4 presets; image upload
- [x] `sims/moire/settings.ts` — defaults, enum parsing, uniform packing, randomize, texture sizing, all GPU-free so they unit-test in node
- [x] **`render/InfiniteRenderer.ts` landed early** — `shared/infinite_render.wgsl` was scheduled for M4, but Moiré renders through it too, so it went into `engine/` proper where the remaining five callers will find it. Includes the CPU half of `calculate_tile_count`, pinned against the WGSL by a test
- [x] `presets/builtins/moire.ts` — the 4 built-ins moved out of the index into the per-sim module the documented pattern calls for (exported as data, since a self-registering module would form an import cycle)
- [x] `EngineContext.loadImage(file, slot)` + `rpc/handlers/images.ts` — `load_moire_image` wired to `resources/imageUpload`; CPU does the fit, the shader does mirror/invert. Session-only, never persisted
- [x] `engine/testing/fakeEngine.ts` — the in-memory `EngineContext` the L4 layer needs, reached through a DEV-only `window.__vizza.installFakeEngine`. Absent from production bundles
- [x] `core/resourceLedger.ts` — split out of `SimulationHost` so the esbuild-bundled harness can use it without dragging in `import.meta.glob`
- [x] **Test (L1):** 35 tests — defaults field-by-field against `settings.rs`, enum parsing, the `decay` fallback, uniform field order, randomize ranges, all 4 presets round-tripping through the store, texture-size clamping, tile-count arithmetic checked against the shader text
- [x] **Test (L3):** 9 tests — construct/teardown inside a validation scope, deterministic varied output, feedback bounded over 40 frames at near-unity gain, the paused-frame ordering, zoom-out tiling, image upload changing the picture, create/destroy ×20 with a clean ledger
- [x] **Test (L4):** 8 tests — console-clean mount, every control round-tripping through `update_simulation_setting`, preset apply, image-mode controls, and the no-engine degradation path
- [x] **Visible:** first live simulation — **confirmed in a real browser** (Chrome 152, Apple Metal-3), not in this container; see the environment limitation below. Verified by hand: renders and animates, sliders respond, Radial mode reachable, colour-scheme reversal visible, presets persist across reload, pause/step behave, wheel-zoom and drag-pan work, and Flow Strength goes black at exactly 0.83 as the analysis predicted.

**Defects found and fixed during M3:**
1. **12 of the 13 numeric controls in `MoireMode.svelte` were dead.** Every drag box did `settings!.curl = detail` and stopped there; only "Grid Rotation" ever called `update_simulation_setting`. Speed, base frequency, interference, the whole radial group and the whole advection group moved a number on screen and changed nothing. All now go through one `setSetting` helper.
2. **The generator-type select could not work.** `MoireGeneratorType` serializes capitalised, the options were `"linear"`/`"radial"`, and the Radial fieldset was guarded on `=== 'radial'` — so the select showed nothing selected and the radial parameters were unreachable. Options are now `Linear`/`Radial`, and the handler mirrors the choice locally so the fieldset appears.
3. **The interference-mode select offered a value the backend rejects.** Two options, `Modulate` and `Blend`; `ImageInterferenceMode` has no `Blend`, so choosing it always failed, and four of the six real variants were unreachable. All six are listed now.
4. **Reversing a colour scheme is a no-op on the desktop build.** `update_color_scheme` reverses the LUT array *and* `params.color_scheme_reversed` makes the shader invert the index (`compute.wgsl:285`) — the two cancel exactly. Here the LUT arrives already reversed from `ColorSchemeManager.current()` and the shader flag stays 0, so reversal reverses. (`sims/mainMenu` still double-reverses; harmless there, since the menu has no colour-scheme picker, but it should be reconciled.)
5. **`render_frame_paused` displayed the frame before last.** The Rust writes `current`, renders `current`, then swaps — so a paused redraw picks up the *other* half of the pair. The port reads `current`, writes `inactive`, swaps, then renders, which is both the `PingPongTextures` convention and one frame less stale. Pinned by a test.
6. **"📖 Camera Controls" was a two-click dead end.** Moiré alone forwarded the event as `dispatch('navigate', { detail: e.detail })`; every other mode passes `e.detail`. `App.handleNavigation` therefore set `currentMode` to an object, no `{#if}` branch matched, and the page rendered *nothing* — with no control left to navigate back. Found by the user on the first pass through M3. Pinned by an E2E test that clicks the button and requires Back to work.
7. **Mouse wheel and drag did nothing, while the panel advertised them.** `handleMouseEvent` was `// Moiré simulation doesn't use mouse interaction`, yet `ControlsPanel` was given `"🖱️ Mouse wheel: Zoom | Drag: Pan camera"`. Moiré has no brush, so there is nothing to paint — but the camera is real and every other mode drives it, so the advertised controls are implemented rather than the text removed. **This is a deliberate divergence from the desktop build**, which has no camera control in Moiré at all. Also fixed `testing/fakeEngine`, whose camera methods mutated state without calling `record()`, so no camera command was assertable at the DOM layer.

**Known defects left alone, deliberately:**
- **Moiré is black for `advect_strength` above 1/1.2.** `compute.wgsl:307` makes the new-pattern weight `1 - advect_strength * 1.2`; above 0.833 that is negative, the feedback texture starts at zero, the negative term clamps away, and nothing ever seeds the loop. `MoireMode.svelte` puts the Flow Strength maximum at **5.0**, so six sevenths of the slider is a black screen. Every candidate fix changes the picture at *every* setting, which is an M14 visual-parity decision, not a mechanical port — so it is asserted as-is by a test that fails if the blend changes.
- `dynamic_mix` (`compute.wgsl:311`) is computed and never used.
- `randomize_moire_settings` exists in `commands/moire.rs` but **no `.svelte` calls it** — `MoireMode` uses the generic `randomize_settings`. It is deliberately not registered: the rpc completeness test asserts there are no unreachable handlers.

**Environment limitation, extending M2's:** a single `context.getCurrentTexture()` on a configured canvas **drops the Dawn instance** in headless Chrome + SwiftShader. Every subsequent `getCompilationInfo()` then rejects with "Instance dropped" and every subsequent `createComputePipelineAsync` with "A valid external Instance reference no longer exists". So it is not merely that a WebGPU canvas cannot be composited into a screenshot — after the app's first frame, *no further pipeline can be created at all*, which means switching modes in a headless run of the app always fails. Measured directly in the L3 harness with no debugger attached. **A headless smoke test of the running app is therefore impossible; :9994 in a real browser is the only way to confirm M3's visible result.**

### M4 — Gray-Scott
- [x] Remediation **(f)** — `reaction_diffusion.wgsl:261` `@workgroup_size(1,1,1)` → `(8,8,1)`, with the Rust dispatch at `simulation.rs:1303` ceil-divided to match. Verified safe first: no `var<workgroup>`, no barriers, no `local_invocation_id`, and in/out are different textures, so no neighbour read can see this step's writes. 2,073,600 workgroups → 32,400 at 1920×1080
- [x] Remediation **(d)** — `paint.wgsl:16` `texture_storage_2d<rgba16float, read_write>` → ping-pong. The source is a plain `texture_2d<f32>` rather than a read-only storage texture, which needs no WGSL feature. **The load had to be hoisted above the brush tests**: two of the three early-outs (`r2 > radius2`, `factor < 0.01`) now copy the texel through, because an unwritten destination texel is not "unchanged", it is whatever that texture held two frames ago. The bounds guard stays a bare `return` — those texels do not exist in the destination either
- [x] Port `reaction_diffusion.wgsl` (337), `noise_seed.wgsl`, `paint.wgsl` — as `engine/sims/grayScott/`, over one `rgba16float` `PingPongTextures` pair. One step per frame; there is no substep loop anywhere in `gray_scott/`
- [x] ~~Port `background_render.wgsl`~~ — **deliberately not ported.** Its params buffer is written once at construction and mutated by no command, so it always takes the `background_type == 0u` branch and emits opaque black; `InfiniteRenderer.encode` already clears black, so omitting it is pixel-identical
- [x] ~~Port `shared/infinite_render.wgsl` (306)~~ — landed in M3. Extended with an `options.path: 'texture' | 'storage'` switch: the storage path compiles `fs_main`, declares the sparse 3/4/5/7 layout, and gets its own **repeat** sampler (the field is toroidal), while Moiré's clamp-to-edge texture path is untouched
- [x] 8 settings + 9 built-in presets from `gray_scott/mod.rs:16` — each preset carries **five** keys, not two: all nine also pin `timestep: 1.0`, `max_timestep: 2.0`, `stability_factor: 0.8`, all of which differ from `Settings::default()`. Omitting them would have given every preset a 2.5× faster reaction than the desktop app
- [x] **Test (L2):** the ledger now passes for `reaction_diffusion` and `paint`; `singleInvocationWorkgroup` is empty
- [x] **Test (L1):** 58 tests — defaults field-by-field against `settings.rs` and `state.rs`, both enum parsers across all three spellings, the code tables, the effect map, randomize ranges, all 9 presets through `PresetStore`, forward-compatible merge, packer byte-length and field order, texture-size clamping
- [x] **Test (L3):** 13 tests — ping-pong ≡ whole-field reference after 10 steps, paint writes every destination texel, bounded and NaN-free over 60 steps across three configs, noise determinism and pair coherence, the f16 encoder round-tripped through a real texture, filtering mode honoured, image mask reaching the reaction, create/destroy ×20 with a clean ledger
- [x] **Test (L4):** 14 tests — the loading overlay lifting, every control class round-tripping, the mask-pattern selector surviving a sync, XY-plot pointer mapping, colour-scheme round trip, no-engine degradation
- [x] **Visible:** interactive reaction-diffusion — **confirmed in a real browser**, not in this container; see M3's environment limitation. Verified by hand: left-drag paints and right-drag erases (the port's first mouse-paint path), Seed Noise and Reset both act (both were dead before M4 wired `reset_simulation` away from the no-op `resetRuntimeState`), every mask pattern visibly changes the field in its own direction, and both XY-plot handles track the cursor and spread across the plot now that the axes are narrowed to the region the presets actually occupy

**Rust defects fixed rather than reproduced (each changes the picture — all four are deliberate):**
1. **The field was seeded with the wrong bytes.** The Rust builds a `Vec<UVPair>` of four `f32`s (16 B/element) and uploads it with `bytes_per_row: width * 16` into an **8 B/texel** `Rgba16Float` texture. `write_texture` treats that as a source stride, so each row consumes only its first `width * 8` bytes and reinterprets f32 bit patterns as pairs of f16: the intended `u=1, v=0` lands as `u=0, v≈1.875` in even columns and `(0,0,0,0)` in odd ones, and the right half of the source array is never read at all. Three sites — construction, `reset()`, resize. The port writes the *intent*, hand-encoded as IEEE binary16. **Consequence: the first frame differs from `example-gray-scott.png`, so any visual-parity assertion must be "after N steps", never at t=0.**
2. **`mask_target` was off by one.** `state.mask_target as u32` yields declaration discriminants **0–4**; `reaction_diffusion.wgsl:305` switches on **1–5**. The `From<MaskTarget> for u32` impl that does produce 1–5 has no callers anywhere in the repo. So on the desktop build "Feed Rate" applies no mask at all and the default "UV Concentration" silently runs the Diffusion-V branch. `MASK_TARGET_CODE` is 1–5 here, pinned by a test that reads the WGSL text.
3. **Texture filtering was always Lanczos.** The Rust binds the 68-byte `RenderSimulationParams` to binding 7, which the shader reads as the 16-byte `RenderParams` — so `filtering_mode` reads the f32 bit pattern of `feed_rate` (≈1.03e9), never 0 or 1, and `fs_main_storage` always fell through to Lanczos. The correctly-sized buffer exists and is kept current; it is simply bound nowhere. Bound properly here, so the default is now Linear.
4. **The mask enums could not round-trip.** `get_state` emits PascalCase (`"DiagonalGradient"`) while the UI's `<Selector>` options are display names (`"Diagonal Gradient"`), so after any sync the control fell back to its placeholder and its ◀/▶ buttons indexed from `-1`. Six of nine patterns and all five targets. The display spelling is canonical in TypeScript, the parser accepts all three spellings, and `GrayScottMode` now imports the option lists from the engine so the two copies cannot drift again.

**Also fixed, on the seam rather than in a simulation:**
- **Reset did nothing.** `reset_simulation` was routed to `resetRuntimeState()`, but Gray-Scott's runtime-state reset is a literal no-op (`simulation.rs:1919`) — the Rust blanks the field through an entirely separate path. `EngineContext` grew `resetSimulation()` and `seedRandomNoise()` as optional capabilities, in the style of `loadImage`, so the Reset and Seed Noise buttons reach the engine.
- **`load_gray_scott_nutrient_image` was a silent no-op** — registered now.
- **`WebcamControls` removed** rather than left permanently greyed out; its three stubs are gone from `registry.ts` while the other four sims keep theirs.
- **`update_cursor_position_screen` dropped** — an awaited RPC on every `mousemove` for a command that ignores its arguments on both sides.
- **`XYPlot` pointer coordinates were unscaled.** `canvas.width` is floored at 320 while the element renders at ≈280, and the handler used raw `clientX - rect.left` with no backing-store scale, landing the handle ~14% off the cursor. Now goes through `clientToCanvasPx`.
- **The XY plot axis ranges were ~10× too wide** — F/K spanned 0.01–1.0 when all nine presets live below 0.08, so every preset sat inside the first ~17px of a 220px axis and one pixel of drag was 4.5× coarser than the neighbouring drag box's step. Narrowed; the drag boxes keep the full range, so nothing is unreachable. A deliberate divergence.

**Known defect left alone, deliberately:** the adaptive-timestep path divides by `delta_u + delta_v` with no guard. Since the shader is shared with the Rust build, the guard is CPU-side — the adaptive flag is cleared in the *uploaded* copy when either stability limit is non-positive, leaving `getSettings()` reporting what the user actually set. Note `0.25/0` is `+inf`, which `min` bounds; the real failures are a negative total diffusion and both denominators degenerating at once.

### M5 — Vectors
- [x] `line_fragment.wgsl` reused verbatim as the fragment half of a two-module pipeline. **`line_vertex.wgsl` was left untouched and is now dead in the browser build** — it declares a `VertexInput` the Rust pipeline feeds from a vertex buffer, and editing it would break the desktop build
- [x] **Moved the CPU noise into the *vertex* stage, not a compute shader** — a correction to this plan. The Rust filled a vertex buffer one grid point at a time and rebuilt it whenever settings or the camera changed (`simulation.rs:399`); with the grid regular, a line's position derives from its instance index, so there is no intermediate buffer for a compute pass to fill and it would only add a round trip. New `line_instanced.wgsl`: one instance = one line, `draw(6, lineCount)`. `update_geometry`, `geometry_dirty` and the vertex buffer are all gone
- [x] `noise.wgsl` — all 11 types re-implemented as a binding-free function library (`noise_sample(type, p, seed) -> f32` in [0,1], codes 0-10 in declaration order). No include mechanism exists in the corpus, so consumers concatenate it ahead of their own source; `vectorsVertexShaderSource()` is the single place that does, and the corpus-compile test now compiles library consumers the way the app does
- [x] 13 settings + the one `Default` built-in preset; image path #2 wired through the existing `loadImage(file, slot)` seam
- [x] **Test (L1):** 50 tests — defaults field-by-field, all four enum parsers, `NOISE_TYPE_CODE`/`NOISE_TYPE_OCTAVES` pinned against the WGSL text, the effect map, the grid-geometry helpers, forward-compatible merge across the five `#[serde(default)]` fields
- [x] ~~**Test (L1):** noise matches Rust reference values for a fixed seed~~ — **not achievable, and abandoned deliberately.** There is no Rust toolchain in this container, so reference values cannot be generated, and hand-transcribing the `noise` crate's permutation tables and gradient sets would be large, brittle, and out of proportion to a field of decorative lines. Replaced by structural assertions (below). **Consequence: desktop and browser render different fields for the same seed.**
- [x] **Test (L3):** 26 tests — per type, finite, in [0,1], non-constant, deterministic byte-for-byte, seed-sensitive (or provably seed-*insensitive* for Cylinders/Checkerboard), central spread ≥ 0.15, and a near/far smoothness ratio that catches a "noise" function that is really just a hash. Plus the CPU/GPU grid mirror, pinned both by reading the shader text and by a compute probe comparing 96 instances at 2e-5
- [x] **Visible:** vector field — **confirmed in a real browser**, not in this container; see M3's environment limitation. Verified by hand: coherent flow structure at the defaults, all eleven noise types reachable and distinct, image path #2 wired. The check also settled two of the three open questions about the re-implemented noise (below) and found one real defect, now fixed.

**Defects found and fixed during M5:**
1. **The colour-scheme selection reverted on every sync** — `updateLutName` called only `apply_color_scheme_by_name`, which pushes LUT bytes but never writes the name into state, while the `<Selector>` binds `state.current_color_scheme` and the function ends in a sync. The same defect M4 fixed in Gray-Scott.
2. **The FPS readout was fabricated** — `currentFps = 60` hardcoded in the render loop. Now reads the `fps-update` event `RenderLoop` actually emits.
3. **The rAF loop was never cancelled on destroy**; only `returnToMenu` stopped it.
4. **Three drag boxes displayed "0" for every value below 0.005** — `NumberDragBox` defaults `precision` to 2 while Density, Line Length and Line Width step by 0.001.
5. **`apply_settings` never re-fits the image** (`simulation.rs:862`), so on the desktop a preset carrying a different `image_fit_mode` leaves the old fit on screen until some other control is touched.
6. **The camera clamp is a new cross-simulation seam.** Vectors is the first sim to want `set_position_clamp(None)` (`simulation.rs:85`), the host's camera is shared across simulations, and `Camera.reset()` does not restore the clamp — so it is unset in `attachCamera` and **restored in `destroy()`**, or the next mode opened silently inherits unbounded panning. Pinned by a test.
7. **The Rust grid is unbounded.** `update_geometry` walks the view at `density.max(0.001)` every frame with no cap; the UI's density minimum is a 2401² grid — 5.77M lines, a 277 MB vertex buffer against a 256 MiB `maxBufferSize`, and 5.77M CPU noise samples per frame. `vectorsGridExtent` clamps to `VECTORS_MAX_LINES` (512²) by *raising* the spacing, so the field still covers the whole view rather than filling a corner.

**Settled by the browser check, so the noise library's open questions are now down to one:**
- **Worley is right.** The concern was that `noise::Worley::default()` might return the nearest cell's *value* rather than the distance to it, which would show as blocks of parallel lines with hard edges. The browser shows cells whose lines rotate smoothly, i.e. distance ramps. Confirmed correct.
- **Cylinders was broken, and is now fixed** (see below).
- **Still open: `RidgedMulti`'s persistence.** Believed to be 1.0 with attenuation 2.0 in noise-rs 0.9, against the 0.5 implemented here; unverifiable without the crate source. *Not* diagnosable by comparing 6-octave `RidgedMulti` against 10-octave `FBMRidged` in the app — at persistence 0.5 octave 7 contributes 1.6% and octave 10 contributes 0.2%, and at the default density those frequencies are finer than the line grid resolves, so the two look identical either way. Same for the Billow pair. Judging this needs the crate, not the eye.

**Defect found by the browser check and fixed:**
- **Cylinders collapsed to a spatially-uniform field that swept round in unison.** `noise::Cylinders` is cylinders about the y axis, so its radius is `length(x, z)` — but Vectors passes the *clock* as z (`line_instanced.wgsl:228`, matching `simulation.rs:272`), so the radius was `length(x, time)` and the clock dominated it within seconds. Every line pointed the same way and cycled together. **The desktop build has the identical defect for the identical reason.** Fixed by taking the radius across the two spatial axes, giving the concentric rings the name promises. Cylinders consequently no longer animates, which is correct — a cylinder is invariant along its own axis — and is asserted static rather than merely skipped in the "advances with the animated third coordinate" test.

**Known defects left alone, deliberately:**
- **Randomize yields a near-uniform field.** `randomize_settings` (`simulation.rs:905`) randomizes `noise_scale` into `0.001..0.1` against a default of `5.0`. Scale multiplies world coordinates and the view spans ~2.4 units, so the whole screen then samples a noise interval ≤0.24 wide and every line points nearly the same way. Nothing in the repo records what the range was meant to be, so it is reproduced faithfully and pinned by a test; an M14 judgement.
- **`NoiseType` has two disagreeing spellings** — serde's `Fbm`/`FBMBillow`/`RidgedMulti` versus `Display`'s `FBM`/`FBM Billow`/`Ridged Multi`, for five of eleven variants. Unlike Gray-Scott's mask enums this is *not* a live bug: the `<Selector>` options, `get_settings` and `update_setting`'s arms all use the serde spelling and `Display` has no caller anywhere in the tree. Canonicalising on display names as M4 did would have **broken** a working control. The parser accepts both so they cannot diverge into a failure.
- `background_color_mode` triggers a full vertex/index rebuild in the Rust to change one clear colour; `apply_settings` swallows deserialization failure with `if let Ok(s)`; `get_state` returns 2 of 9 `State` fields.

**For M12 (Flow):** `flow/shaders/flow_vector_compute.wgsl:58-389` contains a much weaker duplicate of all eleven noise types — its "simplex" is value noise returning [0,1], so the `abs()` folding in its Billow branch is a no-op; its per-type lacunarity and persistence are invented; and it casts negative floats to `u32`, which is undefined. Delete that block and concatenate `noise.wgsl` instead.

### M6 — Gradient Editor
- [x] Port `gradient/shaders/gradient.wgsl` (326) as `engine/sims/gradient/`, following the `mainMenu` precedent — both are render-only shader backgrounds over a LUT with nothing to advance. Two display modes: `0` smooth, `1` quantise-to-16-levels-then-Bayer
- [x] **~180 of the shader's 326 lines are dead** — every sRGB↔linear↔XYZ↔Lab↔OKLab function and all three `interpolate_*` entry points are unreachable; `fs_main` calls `sample_lut` and `apply_display_mode` and nothing else. **The shader is not the reference implementation of anything the app runs**: interpolation is CPU-side and the GPU only ever samples a finished LUT
- [x] Colour-space maths extracted into `engine/color/spaces.ts` — the port of `gradient.wgsl`, kept separate from `ColorScheme.ts` (the port of `shared/color_scheme.rs`, a 768-byte container). Canonical space set is `rgb | lab | oklab | oklch`
- [x] **`culori` removed** — it was the app's only colour-conversion dependency and both importers now use `spaces.ts`. Production bundle 396 kB → **355 kB**
- [x] Custom LUT save/load in `localStorage` — `saveCustom` refuses a built-in's name with a reported error rather than silently skipping (unlike `PresetStore`, because both callers immediately switch the selection to the saved name, so a silent skip would show the built-in with the authored gradient nowhere in the picker). Listing deduped; writes roll back the in-memory map when the quota throws
- [x] **Test (L1):** 72 tests in `colorSpaces.test.ts` + 9 added to `colorScheme.test.ts`. **Anchored against published reference values, not just round trips** — Lindbloom's D65 Lab and Ottosson's OKLab primaries, each cited in a comment, because two mutually-inverse functions that are both wrong pass a round-trip test. Note culori's `lab` is **D50**: same nominal space, different numbers
- [x] **Test (L3):** 7 tests including the default identity ramp, the planar `[R][G][B]` layout, and two dither tests
- [x] **Test (L4):** 25 tests, parameterised over `GRADIENT_COLOR_SPACES` so a future space is covered automatically
- [x] **Visible:** working gradient editor — **partially confirmed in a real browser** (Chrome on macOS, secure-context flag set). What was actually exercised and reported: cycling the colour-space control through all four of RGB/Lab/OkLab/OkLCh, each re-rendering, console clean — i.e. the regression for defect 1, which is the one that reached all nine modes. **Not individually reported back:** the loading overlay, the Heat preset, coincident stops, the inward-drag extrapolation hold, the 768-byte `.lut` export, dither banding, and the teardown race. Those are covered by the L1/L3/L4 suites but have no eyes-on confirmation; treat the box as ticked on the user's instruction rather than as full manual coverage.

**Defects found and fixed during M6:**
1. **Two of five colour spaces threw, in all nine modes.** `ColorSchemeSelector` offered `Jzazbz` and `HSLuv` and mapped them to culori mode names culori does not register (it ships `jab` and `lchuv`). Selecting either threw `TypeError: converters[color.mode].rgb is not a function`, swallowed by a `console.error`, so the gradient silently stopped updating. `GradientEditorMode` offered the working names — the two copies had drifted, just not in the maths. Both now derive from one shared list.
2. **The two editors baked different bytes from the same stops.** `GradientEditorMode.getColorAtPosition` clamps to [0,1] and holds the terminal colour; `ColorSchemeSelector`'s neither clamped nor held, and **extrapolated with `t` outside [0,1]** whenever no stop pair bracketed the position — reachable by dragging a handle inward. Both now use `sampleGradient`.
3. **Both divided by zero on coincident stops**, reachable by dragging one handle onto another: `t = NaN`, and a poisoned LUT.
4. **Both `.lut` export buttons wrote a file neither build can read.** They built an *interleaved* `r,g,b,…` list and wrote it as newline-separated **text**; the format is 768-byte **binary planar**. Now `buildGradientLut`.
5. **`GradientEditorMode` had no loading gate at all** — `loading` was `const false`. Built properly, cleared in a `finally` so the no-WebGPU path is not bricked behind the overlay.
6. **Two teardown hazards**: `updateGradient()` is debounced 50 ms, so navigating away right after an edit fired `update_gradient_preview` *after* teardown; and `applyToSimulation` guarded on `hasEngineContext()` but not on a simulation running, so `requireSimulation()` threw. Each fix independently suppresses the symptom, so the E2E spec pins the pair.
7. **The preset selector offered `'Warm'` while `applyPreset` only matched `'Heat'`** — that option did nothing.
8. `oklab_to_xyz` (`gradient.wgsl:123`) is not the inverse of its own `xyz_to_oklab` (row 1 is CSS Color 4's LMS→XYZ, rows 2-3 invert Ottosson's M₁), and `xyz_to_lab` uses the rounded 1976 constants. Both in dead code, so nothing on screen changes; `spaces.ts` uses Ottosson's pre-composed matrix, which is the only one reproducing the published primaries exactly.

**Known defect left alone, deliberately:** **the dither never fires on the upper half of any band.** `apply_display_mode` quantises with `round` and then tests `color > quantized + threshold*step`; for a colour *below* its nearest level that is false at every threshold, so it snaps hard, and the lower half can only reach a 50% mix. Banding therefore survives at each band's midpoint — exactly what the pass exists to remove. An ordered dither wants `floor(color/step + threshold)*step`. The shader is shared with the desktop build and the fix changes the dithered preview at every colour, so this is an M14 visual-parity call, in the same class as M3's `advect_strength` blend. Asserted as-is.

**Testing note for whoever touches the dither:** the Bayer matrix is indexed from `uv`, not `@builtin(position)`, so it repeats 16× across the target and only a **256-pixel multiple visits all 256 thresholds**. Below that the sampled sub-lattice is biased low and the dither collapses to a hard edge that a smaller test would pass happily. All gradient render tests run at 256² for this reason (`BAYER_PERIOD_PX`). A single Bayer *column* is clustered rather than equidistributed, so accuracy must be measured over a 2D neighbourhood, not per-column.

### M7 — Slime Mold
- [x] Port `compute.wgsl` (610, 5 entry points: `update_agents`, `decay_trail`, `diffuse_trail`, `update_agent_speeds` at `16,16,1`, `reset_agents` at `64,1,1`), `display.wgsl`, `gradient.wgsl` (`generate_mask` at `256`, **1D only** — it ignores `id.y`, so it cannot be folded and the field's texel count is capped at `maxWorkgroupsPerDim × 256`), `quad.wgsl`. Renders through `InfiniteRenderer`'s **texture** path
- [x] ~~Port `background_render.wgsl`~~ — **not ported**, and for a stronger reason than Gray-Scott's: it draws into `display_view`, which the display compute pass then overwrites at *every* texel unconditionally. It has never put a pixel on screen on any build, so `background_mode: White` could not have worked even if its command were reachable — and no `.svelte` calls it
- [x] 15 settings, 9-variant `MaskPattern` / 7-variant `MaskTarget`, 13 built-in presets. Presets use `..Settings::default()`, so the house "only what differs" rule applies directly — unlike Gray-Scott's. Six pin `pheromone_decay_rate: 100.0` against a default of 10.0
- [x] **Clamp the UI to `caps.slimeMoldAgents`; default dropped to 1M.** Clamped in three places, each earning its place: the control (so the user is told), the mode (so a restored value never reaches the command), and the handler (last stop before `createBuffer`). `EngineContext` gained `caps()`, `setAgentCount()` and `resetAgents()`
- [x] Image upload for position + mask images — slots `position` and `mask`
- [x] **Test (L1):** 75 tests · **Test (L3):** 11 tests · **Test (L4):** 18 tests
- [ ] **Visible:** slime mold trails — **needs confirming at :9994 in a real browser**; see M3's environment limitation

**The headline defect: `update_agents` was skipping 15 of every 16 agents.**

`compute.wgsl` reconstructed its linear index as `id.x + id.y * (65535 * 16)` — a **constant** row stride — while `simulation.rs:1024` dispatches `x = min(ceil(n/256), 65535)`. The two agree only once x saturates, i.e. above 16.7M agents. Below that, `id.y` rows 1..15 land past the array end and return.

At the browser default of 1M agents that is **62,512 agents moving and 937,488 frozen**. At the desktop default of 10M, about 38% sit frozen. Verified independently against the dispatch arithmetic before accepting the fix.

Fixed in the shared shader — the three agent kernels now take `@builtin(num_workgroups)` and derive the stride from `num_workgroups.x`, which is dense for every shape the fold can produce and needs **no Rust change**, so the desktop build is fixed too. The new L3 test was checked to fail on the pre-fix shader.

This also unblocks the plan's "read `maxComputeWorkgroupsPerDimension` instead of the hardcoded 65535" — which was **unsafe until now**, because the shader baked 65535 into its index math and reading a different limit would have desynchronised the two.

**Other Rust defects fixed rather than reproduced:**
1. **Disabling the mask did not disable it.** The Rust gates the mask dispatch on `pattern != Disabled && != Image`, so switching away left the old pattern in `mask_map` — and `get_mask_factor` is read unconditionally by all three field kernels. `generate_mask` already writes 0.0 for Disabled; the port simply runs it.
2. **The trail-map ping-pong is vestigial and halved the diffusion rate.** `compute.wgsl` declares *one* `trail_map` binding, and `diffuse_trail` reads its neighbours and writes its own cell through it — there is no source/destination split. The Rust's swap only meant diffusion ran on a buffer nothing else wrote on alternate frames. Ported as a single buffer; **consequence: trails spread about twice as fast at the same `pheromone_diffusion_rate`.**
3. **The position and mask images clobbered each other.** They share one GPU buffer (`simulation.rs:1949` admits it), and a procedural mask — regenerated every frame — wiped a freshly-loaded position image within one frame. The port swaps the position plane in around the seeding dispatch and restores the mask after.
4. **`position_generator` was dead on the desktop.** The mode sends it via `update_simulation_state`, which has **no arm** for it, so the selector changed nothing, every reset re-seeded Random, and the **Image position generator — with its own file picker and `load_slime_mold_position_image` command — was unreachable**. Its option list also used serde spelling (`'UniformCircle'`) against the display spelling (`'Uniform Circle'`) the backend both emits and accepts.
5. **The colour scheme was the mirror image of M4/M5.** Those modes pushed LUT bytes but never wrote the name, so the selection reverted. Slime Mold wrote the name and never pushed the bytes — the control looked right and the picture never changed, which is the harder half of the pair to notice.
6. **Resize never re-fit a loaded image** (`reprocess_*_with_current_fit_mode` exists and is uncalled), leaving a stale-sized plane to be rescaled as if it were trail data.
7. **The agent-count control's validation rejected every value it advertised.** `n % 0.1 !== 0` with the message "Must be a whole number or single decimal place" — but `0.3 % 0.1` is `0.09999999999999998`.
8. `agent_possible_starting_headings` and `background_mode` are `Settings` fields with no `update_setting` arm at all; `update_setting` clamps `cursor_size`/`cursor_strength` where `update_state` — the path the UI uses — does not; and `update_setting` can panic (`unreachable!()`, two `.expect`s).

**Fixed globally rather than per-mode:** `handlers/settings.ts` and `lifecycle.ts` guarded on `hasEngineContext()` but not on a simulation actually running, while the host's methods throw via `requireSimulation()`. Both now check both, closing that teardown hazard for **every** mode — the M6 defect, generalised.

**Known defects left alone, deliberately:**
- **`trail_map_filtering` is doubly dead.** `update_display_sampler` reads the app-wide `texture_filtering` instead of the field it was called for, and never rebuilds the bind group holding the old sampler. Separately, `fs_main_texture`'s `filtering_mode` 0 (nearest) and 1 (linear) arms are *the same statement* through one filtering sampler — so "Nearest" has never been nearest on any build. The sampler lives in `InfiniteRenderer`; see the M14 line.
- `decay_frequency` / `diffusion_frequency` are stored, writable and read nowhere in the Rust. Honoured here as pass schedules; identical at their default of 1.
- `mask_reversed` is stored, defaulted, serialised and read by nothing — inert on every build, exactly as Gray-Scott's is.
- **`workgroup_optimizer.rs` (242 ln) does not port.** It picks workgroup sizes by GPU *vendor*, and WebGPU deliberately does not expose vendor reliably. No setting depends on it. The browser derives its size from `maxComputeWorkgroupSizeX`.
- **`buffer_pool.rs` (95 ln) is not ported.** It dodges Vulkan/Metal allocation latency on a 500 ms-debounced resize; `createBuffer` is cheap in WebGPU, the path is a user gesture rather than per-frame, and its `get_buffer` hands back a buffer with the previous owner's bytes still in it — for an agent pool, live agents at stale positions if a reseed is ever skipped.

### M8 — Particle Life
- [ ] Port 11 shaders incl. `compute.wgsl` (280), `init.wgsl` (375), `tile_render.wgsl` (248)
- [ ] Port 22 `MatrixGenerator`s + 11 `TypeGenerator`s (`settings.rs:186-670`) and `matrix_operations.rs` (567)
- [ ] **Test (L1):** all 22 generators produce N×N in [-1,1]; rotate ∘ rotate⁻¹ = identity
- [ ] **Visible:** particle life with a live interaction matrix

### M9 — Primordial Particles
Learn the grid_clear/grid_populate pattern here — 40% less shader code than Pellets and no atomic bug.
- [ ] Port `particle_update.wgsl` (230), `init.wgsl` (159), `density_compute.wgsl`, render + fade passes
- [ ] **Test (L3):** the Δφ = sgn(R−L)·(α + β·N) law reproduces known clustering from a fixed seed
- [ ] **Visible:** primordial particle system

### M10 — Pellets
- [ ] Remediation **(e)**; **clamp grid cell count to ~512²**
- [ ] Port `physics_compute.wgsl` (499), grid passes, density, render, trail, post-effect
- [ ] **Test (L3):** plain-`u32` read ≡ atomic readback; grid counts equal particle count; energy does not diverge
- [ ] **Visible:** gravity/collision pellets

### M11 — Voronoi CA
- [ ] Port all 10 shaders: JFA init/iteration (log₂N ping-pong), grid, adjacency count/build, `compute_update` (227), brownian, `voronoi_render_jfa` (168), its own `infinite_render.wgsl` (172)
- [ ] Rulestring (`B3/S23`) parser; **verify rgba32float storage on SwiftShader early**
- [ ] **Test (L1/L3):** parser accepts `B3/S23`, `B36/S23`, rejects malformed; JFA is a correct Voronoi diagram on a small case; adjacency symmetric; a B3/S23 blinker oscillates with period 2
- [ ] **Visible:** Voronoi cellular automata

### M12 — Flow *(last: largest corpus, 3 of 5 remediations, the only algorithmic one)*
- [ ] Remediations **(a)**, **(b)**, **(c)**
- [ ] Port `flow_vector_compute.wgsl` (455 — all 11 noise types), `particle_update.wgsl` (451), `trail_decay_diffusion.wgsl` (133), `shape_drawing.wgsl` (150), render passes
- [ ] 23 settings; image upload for the vector field
- [ ] **Test (L3):** deposit sum is **exact** (deterministic); trail ping-pong equivalence; trail-map memory ceiling; all 11 noise types finite and non-constant
- [ ] **Visible:** flow field with trails and image-driven fields

### M13 — Presets, persistence, window chrome
- [ ] Custom preset UI; import/export as downloaded/uploaded JSON; **quota handling** (5–10 MB is real)
- [ ] App settings in `localStorage`; Fullscreen API + in-page title bar
- [ ] Wire up the unused `UiHiddenIndicator.svelte` (273 ln, imported by nothing today)
- [ ] **Redesign `Selector.svelte` — the named-option cycler.** Reported from the M6 browser check: the control leaves **less than one character's width** for the option name, so a colour space, a display mode or an interpolation mode is effectively unreadable. **This is general, not gradient-specific** — it applies to every "cycle through named options" control in the app. Scope measured: one component, `src/lib/components/inputs/Selector.svelte`, with **44 instances across 14 files** — `ColorSchemeSelector.svelte` (8), `GradientEditorMode.svelte` (8), `VectorsMode.svelte` (5), `FlowMode.svelte` (5), then the rest. One component change plus a sweep, not a per-mode fix.

  **Decided: drop the ◀/▶ arrows and keep a plain text dropdown.** The alternative considered was keeping the arrows and moving the option name to an overlay over the render surface; rejected as the harder option, and it would not have suited most of the 44 sites anyway — mask target, fit mode and field type have no directly visible effect on the canvas to overlay onto. Removing the arrows recovers their width for the name, which is the whole problem.

  **Do this in M13, not M14.** M14's job is visual parity against the 7 reference screenshots; redesigning `Selector` inside that milestone would invalidate the parity work as it is being done. Landing it here means M14 compares the final UI.
- [ ] **Test:** old-schema preset loads after a field is added; export→import lossless

### M14 — Parity and cleanup
- [ ] Visual parity via `vision-tool` against the **7** reference screenshots — Flow, Gradient Editor, Gray-Scott, Moiré, Particle Life, Pellets, Slime Mold. **No reference exists** for Voronoi CA (`example-voronoi-ca.png` is referenced by `README.md` but absent), Primordial Particles, or Vectors
- [ ] **Expect `Selector` to differ from every reference screenshot, deliberately.** M13 redesigns the named-option cycler (see there for why and for both candidate directions), so all 7 references will show the old arrows-plus-dropdown control. Judge parity on the simulation surface, not on that control. Same class of intentional divergence as M5's XY-plot axis-range narrowing
- [ ] Codemod out the 21 `devicePixelRatio` mouse lines now every mode is proven
- [ ] **Decide the sRGB question once, for every simulation at the same time.** The shaders convert LUT bytes to linear (`infinite_render.wgsl:289`, `moire/compute.wgsl:66`) because the Rust picks an sRGB surface format, which re-encodes on write. The browser configures with `getPreferredCanvasFormat()`, which returns the **non-sRGB** `bgra8unorm` — so linear values are displayed as though sRGB-encoded and everything is darker than the desktop build. Either configure `viewFormats: ['bgra8unorm-srgb']` and render into the sRGB view, or drop `srgb_to_linear`. Deliberately not fixed per-simulation: Moiré and Gray-Scott share the construct, and fixing one alone would make the two inconsistent for no gain
- [ ] Wire `setFilteringMode` to the `texture_filtering` control in `Settings.svelte`, which currently reaches nothing (`InfiniteRenderer` and `GrayScottSimulation` both expose it)
- [ ] **"Nearest" filtering has never been nearest, on any build.** `infinite_render.wgsl`'s `fs_main_texture` runs `filtering_mode` 0 (nearest) and 1 (linear) through *the same statement* and the same filtering sampler, so the two are indistinguishable. Fixing it needs a second, non-filtering sampler in `InfiniteRenderer` and touches all five simulations that draw through it — hence here rather than in M7
- [ ] Remove `@tauri-apps/*` deps; consolidate per-mode `Settings`/`State` types into `src/lib/types/`
- [ ] Device-lost recovery; perf pass (consider the additive-render deposit rewrite)
- [ ] Decide the fate of `src-tauri/` — keep as the desktop build, or retire. **User's call**
- [ ] **Visible:** near-clone of the original, in the browser

---

## Test strategy

Four layers, because no single runner covers everything.

| Layer | Runner | Covers |
|---|---|---|
| **L1** unit | vitest (jsdom) | Camera, pointer, LUT, preset merge, generators, noise, caps, **rpc registry completeness** |
| **L2** WGSL lint | vitest (no GPU) | Static scan of all 64 shaders |
| **L3** GPU | **raw Chrome + SwiftShader** | Compute correctness, pixel output, resource leaks |
| **L4** DOM | Playwright + **fake engine** | Navigation, controls, presets, persistence |

**Write L2 first.** Ten minutes of regex over all 64 `.wgsl` files, asserting: no
`texture_storage_*<…, read_write>` on a non-`r32` format; no `var<storage, read>`
holding `atomic`; no `@workgroup_size(1, 1, 1)`; every `@group/@binding` has a
matching TS bind-group-layout entry. It fails immediately on all five known sites
and permanently prevents their reintroduction.

**The rpc registry-completeness test** greps the expected command list *from the
.svelte sources at test time*, so it cannot drift. It kills the entire "mode X
calls a command nobody implemented" bug class in one test.

**L4 runs against a fake engine** (`src/lib/engine/testing/fakeEngine.ts`) — same
handler signatures, in-memory state, zero GPU. That is the payoff of making
`EngineContext` an interface: every control in every menu can be asserted to
round-trip through `update_simulation_setting` with no GPU at all.

It lives under `src/` rather than `test/` because a Playwright page can only
reach modules the app itself bundles. `bootstrap.ts` hangs
`installFakeEngine` off `window.__vizza` behind a static `import.meta.env.DEV`
guard and a dynamic import, so production builds contain none of it (verified by
grepping `dist/`). A spec calls
`window.__vizza.installFakeEngine()` before navigating into a mode, and reads
the returned engine's command log to assert the round trip. Each ported
simulation adds its settings model to the `MODELS` table there; everything else
falls through to a permissive "remember whatever you are told" model, which is
all a navigation test needs.

**L3 harness.** Playwright's launcher cannot be made to expose WebGPU, so drive
raw Chrome and have the page POST results back:

```bash
CHROME=$(echo ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome)
VK_ICD_FILENAMES="$(dirname "$CHROME")/vk_swiftshader_icd.json" \
  "$CHROME" --headless --no-sandbox --disable-dev-shm-usage \
  --enable-unsafe-webgpu --enable-features=Vulkan http://127.0.0.1:<free-port>/
```

Use mean-absolute-error with a tolerance plus "not uniform" plus "no NaN" —
**never exact pixel hashes**, since SwiftShader's float ordering differs from real
hardware. SwiftShader validates correctness, not performance; keep grids and
particle counts small or tests time out. Frame-rate and visual-quality judgements
stay with a real Chrome on :9994.

**Port the existing Rust tests.** `src-tauri/src/simulations/*/tests.rs` holds
~152 KB of assertions encoding expected behaviour — Flow 50 KB, Particle Life
33 KB, Pellets 32 KB, Slime Mold 19 KB, Gray-Scott 15 KB, Voronoi CA 3 KB. Each
sim milestone starts by reading that sim's `tests.rs` and carrying the assertions
across, rather than inventing cases.

**Every sim milestone includes a create/destroy ×20 leak test.**
`reset_graphics_resources` exists in the Rust app because sims were crashing and
poisoning global state; in a browser a leaked buffer per mode switch is invisible
until the tab OOMs on the 20th navigation.

---

## Running it

```bash
npm run dev          # http://localhost:9994
npx vitest run       # L1 + L2
npm run test:gpu     # L3  (added in M2)
npx playwright test  # L4
```

### WebGPU requires a secure context

`navigator.gpu` is exposed **only in a secure context**. `localhost` and
`127.0.0.1` qualify automatically; a plain-HTTP LAN hostname does not, and the
API is then simply absent — which looks exactly like "this browser has no
WebGPU support" and sends you diagnosing the wrong layer. `navigator.clipboard`
is gated the same way, so a dead Copy button is a useful corroborating symptom.

Open **`/webgpu-check.html`** to see `window.isSecureContext`, the adapter, the
granted limits, and the derived Slime Mold agent ceiling.

Reaching this container from another machine over `http://<host>:9994`, allowlist
the origin in Chrome — this is a client-side setting, so **do not add HTTPS to
`vite.config.ts` to work around it**:

    chrome://flags/#unsafely-treat-insecure-origin-as-secure
      → Enabled, with  http://<host>:9994  in the box → Relaunch
