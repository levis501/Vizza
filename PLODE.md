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
