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
2. **Wallet:** descriptors and fork destinations. **Scan QR** beside each field reads a wallet
   export by camera (or pasted text) and fills the field; you still press **Import** or **Set
   destination**. It reads:
   - a signer's xpub export: animated UR `crypto-account` (SeedSigner's default) or the newer
     `account-descriptor`, and SeedSigner's **Static** `[fingerprint/path]zpub…` text;
   - a whole wallet from a coordinator such as Sparrow: UR `crypto-output` or `output-descriptor`;
   - a plain descriptor.

   For **multisig**, scan each cosigner's multisig xpub export in turn (SeedSigner: Export Xpub →
   Multisig), set how many signatures are required and whether keys are sorted (`sortedmulti`, what
   most coordinators use), and compare the first receive address shown with the one in your
   coordinator before using it. Private keys are refused.
3. **Coins:** scan, plus per-coin status on all three chains. When a rescan finds shared coins that
   weren't in the previous scan (or weren't shared then), a red banner lists them with what to do
   and whether a plan already spends them (and whether it was broadcast). **Plan these coins** opens
   the plan form with exactly those coins ticked (any already in a plan are left out); **Go to
   Plans** opens it with the form's selection unchanged. Their rows carry a **new** badge. Once any
   plan exists, a **N new shared coins** pill in the header (and a line in the setup guide) points
   back to them from every tab. See [Coins that turn up later](guide.md#coins-that-turn-up-later).
4. **Plans & signing:** create a plan, download the unsigned PSBTs (binary or base64), upload signed
   files, then verify, broadcast and track. The **Coins** list in the New plan form shows every coin
   that is still shared per the last scan, the forks it is split from, and whether a plan (not
   archived) already spends it and was broadcast. Coins not in a plan yet start ticked; **Select
   all**, **Select none**, **Only new shared coins** and **Only coins not in a plan** change the
   pick, and a running total shows its value. The pick is passed as `plan --coin txid:vout` per coin
   (left out when it is every coin and none was planned before), and **Create plan** stays disabled,
   with the reason, while nothing is picked. Each transaction has **QR** and **Scan signed** buttons
   for [air-gapped signers](signers.md#air-gapped-signers-animated-qr).

Reorg alerts appear above a plan's table, and each broadcast split has a "Fee bump…" button (plus
one for the whole plan). See [Recovery](recovery.md).

A **Setup guide** above every tab lists the steps of the guided route, ticks off what's done (from
the actual state) and explains the next step. **Guide: on/off** in the tab bar hides it.

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
