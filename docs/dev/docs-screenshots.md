# Regenerating the doc screenshots

The images in `docs/images/web-ui/` (used by the [Web UI guide](../user/web-ui-guide.md)) are
produced by a script that drives the real web UI against in-memory test chains, the same fakes as
`deno task demo-ui`. No network, Docker or real coins are involved. Re-run it whenever the UI
changes.

## Run it

```sh
# one time: get the browser for the pinned Playwright (downloaded outside the project)
deno run -A npm:playwright@1.64.1 install chromium

# regenerate all screenshots (default output: docs/images/web-ui/)
deno run -A --no-lock scripts/docs_screenshots.ts [output-dir]
```

Playwright is pinned in the script (`PLAYWRIGHT`), because each Playwright release drives one
browser build. When bumping it, install that release's browser. If you already have a matching
Chromium or `chrome-headless-shell` and can't download Playwright's own, point the script at it:

```sh
SPLAYED_SHOTS_CHROMIUM=/path/to/chrome-headless-shell deno run -A --no-lock scripts/docs_screenshots.ts
```

`--no-lock` keeps Playwright out of `deno.lock`; it is loaded at run time and is not a project
dependency. A full run takes a few minutes: the scan uses the default jitter, so the progress boxes
can be captured.

After a run, shrink the PNGs before committing (UI screenshots lose nothing visible at 256 colours),
e.g. with `pngquant --force --ext .png 256 docs/images/web-ui/*.png`.

On Linux, Chromium needs system libraries. If it fails to start with "error while loading shared
libraries", install them with `deno run -A npm:playwright install-deps` (needs sudo), or use your
distro's packages.

## What it does

It starts the UI in-process on a throwaway data directory with three fake chains, then walks the
whole route in a headless browser:

1. the setup guide, the network gate, scan settings and the server-check progress box;
2. a multisig wallet built from SeedSigner QR fixtures (pasted, since there's no camera), then a
   single-sig import and destinations;
3. a scan in progress, then the results;
4. new shared coins after a deposit, and "Plan these coins";
5. the plan form with the coin picker, the QR export, signing with test keys, upload and verify;
6. broadcast: TEST FIRST, the question about the rest, then everything;
7. tracking, a DROPPED alert, archived plans, and the Donors tab.

It writes one PNG per step, named `NN-name.png`.

## Changing a screenshot

- Add or rename a step in `scripts/docs_screenshots.ts` (the `shot("NN-name")` calls), then update
  the image references in `docs/user/web-ui-guide.md`.
- Selectors use the visible button labels, so a renamed button in `src/ui/static/app.js` needs the
  same change in the script.
- The images show demo data (fake chains, test keys). Don't capture a real wallet.
