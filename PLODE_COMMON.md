# How this workspace's instruction files fit together

Three files, chained by `@` imports:

    CLAUDE.md  ──@──▶  PLODE.md  ──@──▶  PLODE_COMMON.md

| File | Who owns it | What belongs in it |
|---|---|---|
| `PLODE_COMMON.md` | **plode** | This file: guidance shared by every plode container. **plode overwrites it on every `plode start`, so edits made here are lost.** |
| `PLODE.md` | **this workspace** | `@PLODE_COMMON.md`, plus everything about this project that the container is part of. Yours to edit; plode writes it once and never touches it again. |
| `CLAUDE.md` | **this workspace** | Everything about this project that has nothing to do with plode. Must `@PLODE.md` to pull the chain in. |

## Rules

1. **Commit `PLODE_COMMON.md` and `PLODE.md` to this workspace's git repo.**
   They are part of the project's agent setup, not local scratch, and they have
   to travel with a clone for the chain to work anywhere else. Committing
   `PLODE_COMMON.md` also means a plode upgrade shows up as a reviewable diff
   rather than a silent change under you.
2. **Never write workspace guidance here** — this file is replaced wholesale on
   the next `plode start`, so anything you add to it is lost. It goes in one of
   the other two, and **the container decides which**:
   - **`PLODE.md`** — anything the container is part of, whether it is about
     plode itself or about this project *as it runs in here*: which port to
     serve on, what lives outside `/workspace` and so does not survive
     recreation, a mount this project needs, a tool that behaves differently in
     a container, a workaround for something plode or the agent harness does.
     Project and container are not two categories to sort between — if the
     instruction only makes sense because of where the work is happening, it
     belongs here, below the `@PLODE_COMMON.md` import.
   - **`CLAUDE.md`** — everything outside plode: guidance that would read
     exactly the same on a bare laptop with no container in sight. The
     project's architecture, its conventions, its house style, what its tests
     mean, which commands to prefer.

   The test is whether a teammate cloning this repo and working on it directly
   would still need the instruction. If yes, `CLAUDE.md`. If it would puzzle
   them — or quietly mislead them — `PLODE.md`. When it genuinely could go
   either way, choose `PLODE.md`: that file already carries the container's
   context, and it keeps `CLAUDE.md` portable.
3. **Agent instruction files should `@PLODE.md`.** `CLAUDE.md` is the one plode
   wires up, and opencode reads `CLAUDE.md` too, so one import covers both. If
   you add another agent's instruction file, point it at `PLODE.md` as well —
   not at `PLODE_COMMON.md` — so every agent sees the same two layers in the
   same order.
4. **Where `PLODE.md` and this file disagree, this file is current.** It is
   rewritten from the installed plode on every start; `PLODE.md` is not, so
   anything in it that contradicts this file is stale — follow this one.
   Anything in `PLODE.md` that merely *repeats* this file is redundant and can
   be deleted from `PLODE.md`, but do that when the user asks you to tidy up,
   not on your own initiative: `PLODE.md` is theirs and is usually in git.

# Agent behavior

For any task that will take more than a few steps, run it in a subagent to keep
the main chat free. Use additional subagents for parallelization where useful.

# Python Environment: a project-local `.venv`, via uv

Each project gets its own virtualenv at `/workspace/.venv` — uv's default, so
`uv sync` and `uv run` find it with no configuration. There is no container-wide
venv and `VIRTUAL_ENV` is deliberately unset.

Two things make this work, and both are worth knowing:

- **`/workspace/.venv` persists.** `/workspace` is bind-mounted from the host, so
  the environment survives `plode rebuild` and `plode stop` + `plode start`.
- **uv's cache is shared and persistent.** `~/.cache/uv` is bind-mounted from the
  host and shared with **every other container on this machine**, so a large
  download (torch, CUDA wheels) is paid once per host, not once per container per
  recreation.

## Rules

1. **Use the project's `.venv`.** `uv sync` creates it on first use. `uv run
   <cmd>` runs inside it. Don't call a bare `python`/`pytest` — nothing puts the
   venv on `PATH`, which is what `uv run` is for.
2. **Do not set `UV_PROJECT_ENVIRONMENT`.** uv's default is exactly what you want
   now. ⚠️ Older guidance said to export `UV_PROJECT_ENVIRONMENT=/home/node/venv`,
   and **this project's own `CLAUDE.md` or `PLODE.md` may still say so** — those
   are the workspace's files and plode does not rewrite them. That instruction is
   now wrong: there is no `/home/node/venv`. If you find it, fix it and tell the
   user.
3. **Declare dependencies in `/workspace`.** The `.venv` persists, but it is a
   build product, not a record. Put deps in `pyproject.toml` (via `uv add`) or a
   `requirements.txt` so the environment is reproducible on another machine. This
   still applies to everything *outside* `/workspace`: `npm install -g`,
   `apt-get install`, and files written to `/home/node` are all lost on
   recreation. (For large installs no manifest can restore, see the
   `/workspace/local/` section below.)
4. **Never hand-edit anything under `.venv/` or in the uv cache.** If a dependency
   needs a change, pin a different version or vendor a fork — do not patch
   `site-packages`. The cache is shared host-wide, and treating installed files as
   editable is how you corrupt an environment you cannot see.
5. **Never run `uv cache clean`.** It wipes the cache for every container on the
   host, not just this one. `uv cache prune` is the safe one if space is tight,
   and even that is the user's call, not yours.

## Setup

```bash
uv sync            # creates /workspace/.venv and installs project + dev deps
```

For a project with no `pyproject.toml` yet, `uv init` then `uv add <package>`; for
one that only has a `requirements.txt`, `uv venv && uv pip install -r requirements.txt`.

## Everyday commands

```bash
uv run pytest -q
uv run python scripts/whatever.py
uv run uvicorn app:app --reload
uv add <package>            # add a dependency (writes pyproject.toml + uv.lock)
```

`pip` and `pip3` are shimmed to `uv pip`. They act on the `.venv` uv discovers
from the working directory, so run them from the project root — and note they
need the `.venv` to exist already (`uv sync` or `uv venv` first).

## Verify it's correct

```bash
uv run python -c "import sys; print(sys.prefix)"   # -> /workspace/.venv
uv cache dir                                       # -> /home/node/.cache/uv
```

## The shared cache is shared with other containers

`~/.cache/uv` is one host directory mounted into every plode container. That is
what makes large installs cheap, and it is a real trust relationship: a package
planted in the cache by one container is installed by the next.

What it is *not*: your `.venv` holds its own copy of every file, never a link into
the cache, so nothing you do inside `.venv` can affect another container. (The
cache and `/workspace` are separate mounts and hardlinks cannot cross a mount
point, so this holds structurally, not by configuration.) The exposure runs the
other way: the cache itself is writable by every container.

If a project should not participate — untrusted dependencies, a private index, or
anything you would not want another container to inherit — give it its own cache:

```bash
export UV_CACHE_DIR=/workspace/.uv-cache
```

That overrides the mount for that project only, at the cost of re-downloading its
dependencies. Add `.uv-cache/` to the project's `.gitignore` if you do.

## First run in this container after the environment change

plode used to give every container one shared virtualenv at `/home/node/venv`.
That is gone; the environment is now `/workspace/.venv`, per project. If this
project was set up before that change, the first thing to do is restore its
environment — **before** running tests or reaching conclusions about failures.

- **If there is a `pyproject.toml`** (with or without `uv.lock`): nothing to do.
  `uv run` and `uv sync` recreate `/workspace/.venv` from the manifest on first
  use.
- **If there is only a `requirements.txt`**: uv will **not** pick it up, and this
  fails misleadingly rather than loudly — `uv run` falls back to the system
  interpreter at `/usr/bin/python3`, so you get `ModuleNotFoundError` for your
  own dependencies, or worse, a *different* version of something Debian happens
  to ship. Create the env explicitly, once:

  ```bash
  uv venv && uv pip install -r requirements.txt
  ```

- **If something non-Python lived in the old venv** — a CLI like PlatformIO, or
  anything installed ad hoc and recorded in no manifest — it is gone. Check the
  project's own docs for a bootstrap script; if there is none, reinstall it and
  then *record it* in a manifest so this is the last time.

Confirm before moving on: `uv run python -c "import sys; print(sys.prefix)"`
must print `/workspace/.venv`. If it prints `/usr` you are on the system
interpreter and the environment was never created.

# Large installs: keep them under `/workspace/local/`

Everything outside `/workspace` is reset to its as-built contents whenever the
container is recreated (`plode rebuild`, or `plode stop` + `plode start`) — and
recreation is routine, not exceptional. A small `apt-get install` is cheap to
redo; a multi-hundred-MB toolchain, SDK, model download, or static binary is a
real setback to lose and download again. So:

1. **Install or unpack anything large into `/workspace/local/<name>/`** whenever
   the tool lets you choose where it lives — static builds (ffmpeg), SDKs,
   downloaded models, prebuilt release binaries, caches you can repoint via an
   env var. `/workspace` is the bind mount, so it survives recreation; nothing
   else does.
2. **If something big has already landed outside `/workspace`**, move it into
   `/workspace/local/` rather than leaving it to evaporate — relocate the
   install tree or the downloaded archive, then fix up whatever points at it
   (`PATH`, an env var, a config entry).
3. **Add `/local/` to the workspace's `.gitignore`**, the first time you create
   the directory. What lives there is machine artifacts by size and by nature —
   not project sources — and hundreds of MB do not belong in the repo. Add the
   rest of the block in the next section while you are in there.
4. **This does not replace declaring dependencies.** Python and npm project deps
   still belong in `pyproject.toml` / `package.json` (see the venv rules above)
   — a manifest restores those cheaply on any machine. `/workspace/local/` is
   for what no manifest can bring back: big binaries, SDKs, models, one-off
   downloads.
5. **Record what lives there in `PLODE.md`** — what it is and how it is wired in
   (the `PATH` line, the env var) — so the next session finds it instead of
   reinstalling it.

# What to put in `.gitignore`

A few things reliably accumulate in a plode workspace that must never be
committed. Add them as one block the first time you touch the repo, rather than
one at a time as each starts showing up in `git status`:

```gitignore
# Large, machine-local installs (see PLODE_COMMON.md) — never in the repo
/local/

# Python
.venv/
__pycache__/
*.py[cod]

# Machine-local agent settings
.claude/settings.local.json
```

Why each one:

- **`/local/`** — machine artifacts by size and by nature: SDKs, models, static
  binaries, hundreds of MB of them (see the section above). The leading slash
  pins it to the workspace root, so a *source* directory named `local/` deeper
  in the tree is untouched.
- **`.venv/`** — this project's Python environment (see the venv rules above).
  It belongs here and it persists, but it is a build product rebuilt from
  `uv.lock`, so it must never be committed.
  `__pycache__/` and `*.py[cod]` are the ordinary byte-code droppings.
- **`.claude/settings.local.json`** — Claude Code's *per-machine* settings, the
  sibling of a `.claude/settings.json` that a project may well want committed.
  It holds the local permission grants of whoever happened to run the agent, so
  it is not project configuration and does not travel.

If the workspace already has a `.gitignore`, append whichever of these lines are
missing instead of rewriting the file — it is the project's, and it may be
carrying rules that matter outside this container.

# Hosting servers: bind 0.0.0.0 on ports 9991–9999

When you need to serve something — run an app under test, expose a dev server,
share files or results with the user — **bind a port in the range 9991–9999, on
`0.0.0.0`**. Ports outside that range may be taken by the host or blocked.

**The port you bind is not always the port the user opens.** Three variables,
fixed when this container was created, tell you what it is:

| Variable | Meaning |
|---|---|
| `PLODE_HOST_OS` | `Linux` or `Darwin` — the host plode is running on |
| `PLODE_PORT_OFFSET` | add this to your port to get the user's port (`0` on Linux) |
| `PLODE_HOST_PORTS` | the host-side range corresponding to 9991–9999 |

So the URL to hand the user is always:

```bash
port=9992
python3 -m http.server "$port" --bind 0.0.0.0 >/tmp/http.log 2>&1 &
echo "http://localhost:$(( port + ${PLODE_PORT_OFFSET:-0} ))"   # tell the user THIS
```

## Why `0.0.0.0` matters

On a **Darwin** host, this container has its own network namespace and 9991–9999
are *published* to `$PLODE_HOST_PORTS` on the Mac. A server bound to `127.0.0.1`
is reachable only from inside this container, so the published port answers
"connection refused" — the user sees a broken link and you see no error at all.

On a **Linux** host, the container shares the host's network namespace, where
`127.0.0.1` is the host's own loopback, so it happens to work. `0.0.0.0` is
correct on both, so just always use it.

## Who else is using the range

- **Darwin**: nobody. This container has 9991–9999 to itself — every other plode
  container gets its own published block. `ss -ltnp` shows only your listeners.
- **Linux**: the host and every other plode container share the range, so a port
  one of them is using is unavailable to you. (19990 is reserved for the plode web
  dashboard — 9991–9999 is deliberately left free.)

To see what's already listening, use `ss` or `netstat` (both are installed):

```bash
ss -ltnp 'sport >= :9991 and sport <= :9999'   # what's bound in the range
netstat -ltnp | grep 999                       # same idea, older tool
```

You don't have to check first, though — binding a busy port fails immediately
with `OSError: [Errno 98] Address already in use`. Just try the next one.

## Serving files with `python3 -m http.server`

Particularly useful for sharing results, directory listings, HTML reports,
screenshots, logs, and debug artifacts. It's stdlib — nothing to install.

```bash
python3 -m http.server 9992 --bind 0.0.0.0                 # serve the cwd
python3 -m http.server 9992 --bind 0.0.0.0 --directory out  # serve a specific dir
```

**Bind `0.0.0.0`, not the default.** Then tell the user the URL — remembering to
add `$PLODE_PORT_OFFSET` to the port, as above — so they can open it in their
browser.

## Notes

1. **Run it in the background** when you need the shell back:
   `python3 -m http.server 9992 --bind 0.0.0.0 >/tmp/http.log 2>&1 &`. Stop it
   when you're done rather than leaving the port held.
2. **Directory listings are automatic** for any directory without an
   `index.html` — good enough for browsing a pile of output files.
3. **It's a plaintext, unauthenticated, single-threaded dev server.** Fine for
   sharing with the user; don't serve anything sensitive or treat it as durable.
4. **Pair it with `md2html`** — render a Markdown report to self-contained HTML,
   drop it in the served directory, and link the user to it.

# If `ping` fails: stop and ask the user (do not work around it)

`ping` is installed, but whether it can open a socket at all is decided by a
**host** kernel setting you cannot change from in here. If it is closed, every
ping fails immediately like this:

```
ping: socktype: SOCK_RAW
ping: socket: Operation not permitted     # or: Permission denied
```

**When you see that, stop and ask the user to open the range.** Which remedy to
quote depends on `$PLODE_HOST_OS`, because the sysctl has to be set wherever the
container's network namespace actually lives.

On **Linux** (`PLODE_HOST_OS=Linux`), that's the host itself:

> `ping` can't open an ICMP socket in the container. Please run on the host:
>
> ```bash
> sudo sysctl -w net.ipv4.ping_group_range="0 2147483647"
> # to persist across reboots:
> echo 'net.ipv4.ping_group_range = 0 2147483647' | sudo tee /etc/sysctl.d/99-ping-group.conf
> ```
>
> No container restart is needed — it takes effect immediately.

On **Darwin** (`PLODE_HOST_OS=Darwin`), the Mac has no `net.ipv4.*` sysctls at
all; the setting belongs to the Linux VM podman runs containers in:

> `ping` can't open an ICMP socket in the container. Please run on the Mac:
>
> ```bash
> podman machine ssh 'sudo sysctl -w net.ipv4.ping_group_range="0 2147483647"'
> ```
>
> No container restart is needed. Note this does **not** survive
> `podman machine rm` / `init` — it has to be redone if the VM is recreated.

Then retry the ping. Ordinary unreachability (`100% packet loss` with sockets
working, `Name or service not known`, `Destination Host Unreachable`) is a real
network result, not this problem — diagnose those normally.

## Why you cannot fix it yourself

Don't burn turns on workarounds; all of the obvious ones are dead ends here.

1. **`sudo sysctl` inside the container won't work.** `net.*` sysctls belong to
   the network namespace, and writing this one requires privilege in the user
   namespace that *owns* that netns. On Linux the container shares the host's
   netns (`--network=host`), so that means the initial namespace — real root on
   the host. On Darwin the container has its own netns but it is owned by the
   VM's initial namespace, so the same argument applies one level down. Either
   way, root inside the container is not that root, and podman refuses
   `--sysctl` for it.
2. **`setcap cap_net_raw` on `/usr/bin/ping` won't work either** — and will make
   things worse. Raw sockets on a host-owned netns need CAP_NET_RAW in the
   initial user namespace, which the container can't have. Worse, a file
   capability whose xattr isn't mapped in this user namespace makes the binary
   fail to *exec* at all, turning a clear error into a confusing one. The image
   deliberately strips that capability; leave it stripped.
3. **`ping -s`, `-4`/`-6`, running as root, reinstalling `iputils-ping`** — all
   irrelevant. The failure is at socket creation, before any packet.

## Meanwhile: prefer tools that don't need ICMP

For the usual "is it up / is that port open" question, these work right now and
are already installed — often they answer the real question better than ping:

```bash
nc -z -w2 host 22 && echo open || echo closed     # is a TCP port open
curl -sSf -m5 -o /dev/null http://host:9992/      # is an HTTP service answering
getent hosts host                                 # does the name resolve
ss -ltnp                                          # what's listening locally
```

`nc` (netcat-openbsd) is installed, and so is `socat` when you need a listener,
UDP, or a port forward. The bash `/dev/tcp` redirect also works and needs nothing
at all — `timeout 2 bash -c '</dev/tcp/host/22' 2>/dev/null` — which is handy in
a minimal shell elsewhere; it prints `bash: connect: Connection refused` on a
closed port, hence the redirect.

Use these first, and only escalate to the ping request above when you genuinely
need ICMP (e.g. checking a device that answers nothing else).

# Markdown to HTML: `md2html`

This container ships an `md2html` command that renders a Markdown file to
**standalone, self-contained** HTML (CSS and images embedded inline, so the
output can be opened or shared on its own) using pandoc and a bundled
dark-friendly stylesheet. **HTML is written to stdout**; redirect to save.

```bash
md2html notes.md                # print HTML to stdout
md2html notes.md > notes.html   # save to a file
```

## Rules / behaviour

1. **Exactly one argument** — `md2html <file.md>`. It reads that file and writes
   HTML to stdout (it never writes a file itself, so there's no overwrite prompt).
2. **No flags** — there's no `--help`/options; pass `--anything` and it's treated
   as a filename. Styling comes from `/usr/local/share/md2html/style.css`.

# Image understanding: `vision-tool`

This container ships `vision-tool`, a CLI that queries a vision-enabled LLM about
one or more images. It has its own env at `/opt/vision-venv`, deliberately kept
apart from your project's, so it is always available and never affects your
dependencies. Use it whenever you need to "look at" an image — screenshots,
diagrams, photos.

```bash
vision-tool "Enumerate the objects in this image" shot.png
vision-tool "Describe the differences between these" a.jpg b.jpg
vision-tool "Describe this UI" page.png --json        # machine-readable output
vision-tool --list-formats                            # supported: png jpg jpeg gif webp bmp tiff tif
```

## Notes

1. **API key can be left blank or unset.** The default endpoint needs no auth, so
   `--api-key` / the `VISION_TOOL_API_KEY` env var are optional — leave them empty
   and the tool uses a harmless `not-needed` placeholder.
2. **Defaults** target a local vision server (`--base-url http://fourk.lan:8080/v1`,
   model `qwen3.5-9b-q4_k_m.gguf`). Override per-call with `--base-url` / `--model`,
   or persist them in `~/.config/vision-tool/config.toml` (`[defaults]` table).
3. **Useful flags:** `--json` (raw JSON), `--match` (score how well one image fits
   a description, exactly 1 image), `--verbose` (dump request/response to stderr).

# Headless Chrome: Playwright's Chromium

This container ships Chromium, but **there is no `chromium`, `chromium-browser`,
or `google-chrome` on `PATH`** — so an empty `command -v chromium` does *not*
mean you have no browser, and `apt-get install chromium` is the wrong reflex.
Two binaries are already on disk, installed by Playwright:

| What | Path |
|---|---|
| Full Chromium — headless *or* headful | `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome` |
| Headless shell — smaller, headless only | `~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell` |

The `*` is a Playwright build number that changes whenever the image is rebuilt,
so **resolve the path, don't hardcode it**:

```bash
CHROME=$(echo ~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome)
HS=$(echo ~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell)
```

## Driving it from Playwright (the normal way)

`playwright` is installed **globally** under npm, and Node does not search global
modules — a bare `require("playwright")` from `/workspace` fails with
`Cannot find module`. Export `NODE_PATH` first:

```bash
export NODE_PATH=$(npm root -g)
node -e '
const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch();            // headless by default
  const p = await b.newPage();
  await p.goto("https://example.com");
  console.log(await p.title());
  await p.screenshot({ path: "shot.png" });
  await b.close();
})()'
```

Pair it with `vision-tool "What does this page show?" shot.png` when you need to
actually *look* at the result.

**Python Playwright is not installed** — only the Node package. If you want it,
`uv pip install playwright` and then `python -m playwright install chromium`,
**not** the bare `playwright` command: npm's bin directory comes first on `PATH`,
so `playwright` always resolves to the Node CLI. If the Python package's pinned
build number matches what is already in `~/.cache/ms-playwright` it reuses those
browsers; otherwise it downloads its own copy — a few hundred MB, and lost when
the container is recreated.

## Driving it straight from the command line

For one-shot jobs the headless shell needs no Node at all:

```bash
"$HS" --dump-dom https://example.com                                    # rendered DOM to stdout
"$HS" --screenshot=/tmp/s.png --window-size=1280,900 https://example.com
"$HS" --print-to-pdf=/tmp/s.pdf https://example.com
```

The same flags work on `$CHROME`, which additionally needs `--headless`.

## Notes

1. **Redirect stderr.** Chromium logs D-Bus, Bluetooth, and GPU warnings on every
   run in a container. They are harmless noise — `2>/dev/null` keeps the output
   readable, and errors that matter still surface as a non-zero exit.
2. **`/dev/shm` is only ~63 MB here.** Heavy pages can die on that; pass
   `--disable-dev-shm-usage` if a tab crashes for no obvious reason.
3. **The sandbox works** — rootless user namespaces are available, so
   `--no-sandbox` is *not* required (it's harmless if some tool insists).
4. **Headful works too.** `xvfb-run` and `Xvfb` are installed, so
   `xvfb-run -a node script.js` with `chromium.launch({ headless: false })` gives
   you a real X display for the occasional page that behaves differently headless.

# What's installed, and how to check

**Check before you conclude something is missing, and check before you install.**
The container is fuller than a `node:22-bookworm-slim` base suggests, and a
misfired `apt-get`/`npm i -g` costs a turn and is discarded at the next container
recreation anyway (see the venv rules above — the same "declare it in
`/workspace`" logic applies to everything outside it).

## Top-level inventory

| Area | What's here |
|---|---|
| Runtimes | **Node.js 22** + npm; **Python 3.11** with **uv** (per-project `.venv` in `/workspace`, shared host-wide cache); **JDK 17** (headless, for Gradle/`sdkmanager`/`aapt2`) |
| Agent CLIs (npm global) | `claude` (`@anthropic-ai/claude-code`), `opencode`, `playwright`, `serve` |
| Browser | Chromium + headless shell + Playwright's bundled ffmpeg, `Xvfb`/`xvfb-run`, and the CJK/emoji font set — see the section above |
| Python (`/opt/vision-venv`) | `vision-tool` and its dependency tree: `openai`, `mcp`, `pillow`, `httpx`, `pydantic`, `uvicorn`, `cryptography`, `jsonschema`. Kept out of your project's `.venv` on purpose. |
| plode-provided | `md2html`, `vision-tool`, a preconfigured `tmux`, `~/.gitconfig`, opencode config, the SSH-agent hookup |
| Version control / net | `git`, `curl`, `wget`, `openssh-client`, `rsync`, `nc` (netcat-openbsd), `socat`, `ss`, `netstat`, `ping` |
| Text / shell | `jq`, `pandoc`, `vim`, `less`, `tmux`, `rg` (ripgrep), `tree`, `file`, `tar`, `zip`/`unzip`, `perl`, `sudo` (passwordless) |
| Diagnostics | `ps`/`top` (procps), `htop`, `lsof`, `ncdu`, `strace` (ptrace of your own descendants works; `ptrace_scope=1`) |
| Android | `ANDROID_HOME=/opt/android-sdk` and its `platform-tools`/`cmdline-tools` are on `PATH`, but the SDK itself is a **bind mount** — present only if the host configured one. `ls "$ANDROID_HOME"` to find out. |

**Notably absent** — four things, each absent for a reason, so read the next
section before trying to work around one: a **compiler toolchain** (`gcc`,
`make`, `python3-dev`, so no building C extensions); **`ffmpeg`** (the binary in
the Playwright cache is *not* a substitute); **`gh`**; and `fd`/`fzf`. Everything
else you are likely to reach for is here — check with `command -v` first.

## The four absences, and what to do instead

Each of these was measured and left out on purpose. **Don't silently
`apt-get install` your way past one** — it works, but it is discarded the next
time the container is recreated, so it is a fix that quietly stops being applied.
Pick the durable option below, or tell the user what the project needs.

### No compiler (`gcc`, `make`, `python3-dev`) — 178 MB

You will meet this as a `uv pip install` that dies partway through building a
wheel, with `error: command 'gcc' failed: No such file or directory` or a missing
`Python.h`. It means the package had no prebuilt wheel for this platform.

In order of preference:

1. **Check for a wheel first** — `uv pip install --only-binary :all: <pkg>` fails
   fast and clearly instead of half-building. Often a slightly different pin, or
   the `-binary` variant of a package, has one.
2. **Look for a pure-Python or prebuilt alternative.** Most of the common native
   packages (`numpy`, `pandas`, `pillow`, `cryptography`, `lxml`) ship manylinux
   wheels and need no compiler at all — if one of *those* is trying to build from
   source, the real problem is usually an over-tight version pin.
3. **Install it for this session** if you genuinely need to compile:
   `sudo apt-get update && sudo apt-get install -y --no-install-recommends gcc python3-dev`
   (~235 MB, a minute or two). **Then tell the user**, because it will be gone
   after the next `plode stop`/`start` and the build will fail again for them.

### No `ffmpeg` — 221 MB, 120 packages

**The `ffmpeg` binary in `~/.cache/ms-playwright/ffmpeg-*/` is not a general
ffmpeg.** Playwright builds it `--disable-everything` purely to record its own
videos. It has exactly: mjpeg/png/matroska in, VP8/webm out, and `crop`, `pad`,
`scale`. **No H.264, no MP4, and no audio support whatsoever** — every common job
fails on it with a confusing "Unknown encoder" or "Invalid data" rather than a
clear "unsupported build". Don't route real work through it.

For anything else:

1. **Ask whether you need ffmpeg at all.** Reading image dimensions, converting
   stills, or assembling a contact sheet is Pillow's job — `uv add pillow` is a
   cached wheel and near-instant. Screenshots and page video are Playwright's.
2. **A static build is the durable answer.** One self-contained ~80-100 MB
   binary, no dependencies — unpack it into `/workspace/local/ffmpeg/` (see the
   large-installs section above) and it *survives container recreation*, unlike
   anything apt installs. (`xz-utils` is installed, so `.tar.xz` release assets
   extract normally.) Keep `/local/` gitignored.
3. **`sudo apt-get install -y --no-install-recommends ffmpeg`** works too but
   costs 221 MB and 120 packages, and is gone at the next recreation.

If a project needs ffmpeg routinely, say so — it belongs in that workspace's
setup, or in a plode image rebuild, not in a fix you redo every session.

### No `gh` — 39 MB

Two blockers, and size is the smaller one: **plode provisions no GitHub token**,
so `gh` would prompt for an interactive login you cannot complete unattended.
`git` over SSH already works (the agent socket is forwarded), so clone, fetch,
and push are fine — it's only the PR/issue API surface that's missing. Use
`curl` against `api.github.com` with a token the user supplies, and ask before
assuming you have one.

### No `fd`, no `fzf`

`find` covers `fd` (and `rg --files` is usually faster than either). `fzf` is
interactive-only — there is nothing for a non-interactive agent to select.

## Finding out the details

```bash
command -v <tool> && <tool> --version    # is it here, and which build

# Debian packages
apt-mark showmanual                      # the deliberately-installed set (short)
dpkg -l | grep <name>                    # everything, including transitive deps
dpkg -s <pkg>                            # version, size, Depends of one package
dpkg -L <pkg>                            # which files it installed
dpkg -S "$(command -v pandoc)"           # which package owns a binary
apt-cache depends <pkg>                  # what a package would pull in

# npm (global installs — this is where the agent CLIs live)
npm ls -g --depth=0                      # top-level global packages + versions
npm root -g                              # where they live (also for NODE_PATH)

# Python (always via uv — see the venv section)
uv pip list                              # everything in ./.venv
uv pip show <pkg>                        # version, location, Requires/Required-by
uv pip tree                              # the dependency graph
```

Two quirks worth knowing. `dpkg -S` on a `/usr/bin/...` path can report "no path
found" — `/bin` is a symlink to `/usr/bin` and dpkg records the pre-merge path,
so retry as `dpkg -S /bin/ss`. And `apt-mark showmanual` is not a list of things
plode chose: `playwright install-deps` marks its whole `fonts-*` / `lib*` set as
manual too, so treat those entries as browser dependencies.

# Math notation: use Unicode, not LaTeX

Output here is read in a **terminal** (the Claude CLI, shells, tmux — including the
plode web-view terminals), which is a plain character grid with no LaTeX/KaTeX
renderer. LaTeX markup like `$x\equiv1\pmod3$` or `$$…$$` shows up as literal
`$`, backslashes, and command names — noisy and hard to read.

**Write math in Unicode instead, with no `$…$` / `$$…$$` delimiters.**

- Relations/logic: `≡ ≈ ≠ ≤ ≥ ∧ ∨ ¬ ⟺ ⇒ ⇐ ∈ ∉ ⊆ ⊂ ∪ ∩ ∀ ∃`
- Operators/symbols: `× ÷ ± √ ∑ ∏ ∫ ∞ ∂ ∇ π λ μ θ α β γ`
- Super/subscripts: `x² xⁿ x₀ xᵢ aₙ` (use real Unicode sub/superscripts when they exist)
- Modular arithmetic: write `x ≡ 1 (mod 3)`, not `x\equiv1\pmod3`
- Fractions: inline as `x/2`, `(x−1)/3` (use the minus sign `−` where it reads better)

For example, prefer:

```
x even  ∧  x ≡ 1 (mod 3)   ⟺   x ≡ 4 (mod 6)
```

Reserve LaTeX only when explicitly asked for it, or when writing a `.tex` /
Markdown file that will be rendered by something that understands it. Things that
don't linearize cleanly (stacked fractions, matrices, `∑` with limits) may fall
back to a readable linear form (`sum_{i=1}^{n} …`) — that's fine.
