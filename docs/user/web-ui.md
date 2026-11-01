# Web UI reference

New here? Follow the [Web UI guide](web-ui-guide.md) instead; this page is the short reference and
the UI's security properties.

```sh
deno task ui        # or: deno task cli ui [--port N] [--open]
```

The UI runs the same `splayed` commands as the CLI, with the same checks. Their confirmation prompts
appear as dialogs in the browser.

## Tabs

1. **Network:** backends, privacy level per backend, Tor mode, and "Check servers & confirm".
2. **Wallet:** descriptors and fork destinations.
3. **Coins:** scan, plus per-coin status on all three chains.
4. **Plans & signing:** create a plan, download the unsigned PSBTs (binary or base64), upload signed
   files, then verify, broadcast and track. Each transaction has **QR** and **Scan signed** buttons
   for [air-gapped signers](signers.md#air-gapped-signers-animated-qr).

Reorg alerts appear above a plan's table, and each broadcast split has a "Fee bump…" button (plus
one for the whole plan). See [Recovery](recovery.md).

Switch on **Advanced** in the tab bar to get a **Donors** tab for the
[donor routes](advanced-donor-routes.md).

The UI is dark by default. The header button switches to light mode, and the choice is remembered in
that browser.

## Security

- The server listens on 127.0.0.1 only, on a random port.
- Access needs a random token passed in the URL fragment. It's never sent in a request URL or
  `Referer`; it's removed from the address bar and sent only as an `Authorization` header.
- Requests naming another `Host` are refused, which blocks DNS rebinding.
- POST requests must be JSON and same-origin.
- The CSP allows only the UI's own script and stylesheet.
- Server data is only ever inserted as text, never as HTML.
- The UI can't change the data directory, Tor address or profile, and can't start another UI.

## Demo

`deno task demo-ui` starts a UI filled with in-memory test chains (no network), for development. To
try the full flow against real node software, use the
[regtest playground](../dev/regtest-playground.md).
