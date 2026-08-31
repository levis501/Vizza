# Workspace instructions

@PLODE_COMMON.md

<!--
plode created this file and will not write it again — it is yours to edit.

  PLODE_COMMON.md  plode's guidance, common to every plode container. plode
                   overwrites it on every 'plode start', so edits there are lost.
  PLODE.md         this file: instructions specific to this workspace.

Commit both to this repository. See PLODE_COMMON.md for the full layout.
-->

## Workspace-specific instructions

### The dev server needs a secure context, not just a reachable port

The browser port (`WEB_PORT.md`) is a WebGPU app. **WebGPU is exposed only in a
secure context**, and so is `navigator.clipboard`. `localhost` and `127.0.0.1`
are trusted automatically; a plain-HTTP LAN hostname is not.

This container is reached from a Mac at **`http://meshed.lan:9994`**, which is
plain HTTP, so `navigator.gpu` is simply *absent* there. That looks identical to
"this browser has no WebGPU" and will send you diagnosing the wrong layer.

The agreed fix lives on the client, not here — in Chrome on the Mac:

    chrome://flags/#unsafely-treat-insecure-origin-as-secure
      → Enabled, with  http://meshed.lan:9994  in the text box → Relaunch

So **no server-side change is wanted**: do not add HTTPS or a certificate to
`vite.config.ts` to "fix" a report of missing WebGPU. Check
`window.isSecureContext` first — `/webgpu-check.html` reports it directly.

Related: `vite.config.ts` sets `server.allowedHosts: true`, because Vite's
DNS-rebinding guard otherwise rejects the `meshed.lan` Host header outright.
That guard assumes a dev server on the developer's own machine; here the server
is deliberately exposed on `0.0.0.0`.

### `gh` is installed under `/workspace/local/` — reconnect it after a rebuild

`PLODE_COMMON.md` says `gh` is absent from the image, and in the image it is.
This workspace installs it anyway, as a release tarball under `/workspace/local/`
so the 41 MB download survives container recreation:

    /workspace/local/gh/bin/gh        # the binary — persists
    /usr/local/bin/gh                 # symlink onto PATH — does NOT persist
    /home/node/.config/gh/hosts.yml   # gh's credentials — do NOT persist

Two of those three live outside `/workspace`, so **after every `plode rebuild` (or
`plode stop` + `start`) `gh` vanishes from `PATH` and git pushes stop
authenticating.** Nothing is actually lost; just re-run both lines:

    sudo ln -sf /workspace/local/gh/bin/gh /usr/local/bin/gh
    gh auth login --with-token < /workspace/local/.gh-token && gh auth setup-git

`/workspace/local/.gh-token` holds a **fine-grained** GitHub PAT (mode 0600,
gitignored via `/local/`) scoped to `levis501/Vizza` alone. `gh auth setup-git` is
the part that teaches `git` to use it — without it `gh` works but `git push` still
fails to authenticate.

When the token expires, replace that file and re-run the second line. Two traps if
a push ever 403s with `Permission to levis501/Vizza.git denied`:

- The fine-grained token needs **Contents: Read and write**. It is easy to create
  one with Contents left read-only — reads and `gh repo view` all succeed, and only
  pushes fail. Editing an existing token's permissions keeps the same secret, so
  there is no need to regenerate and re-paste it.
- Do not trust `gh api /repos/OWNER/REPO --jq .permissions`. Its `"push": true`
  reports *the account's* role on the repo, not the token's grant, so it reads
  `true` even when the token cannot push. The honest probe is an actual write —
  `403 Resource not accessible by personal access token` means the grant is
  missing.

### Remotes: `origin` is the fork, and `upstream` is deliberately unpushable

    origin    https://github.com/levis501/Vizza.git   (the fork — push here)
    upstream  https://github.com/Velfi/Vizza.git      (fetch only)

`upstream`'s *push* URL is set to the literal string `DISABLED`, so an absent-minded
`git push upstream` fails immediately instead of attempting a push to Velfi's
repository. That is intentional; don't "fix" it. Restore it only on purpose:

    git remote set-url --push upstream https://github.com/Velfi/Vizza.git

The fork is synced with upstream **through the GitHub web UI**, not from in here.
