# Regenerating the doc screenshots

The images in `docs/images/web-ui/` (used by the [Web UI guide](../user/web-ui-guide.md)) are
produced by a script that drives the real web UI against in-memory test chains, the same fakes as
`deno task demo-ui`. No network, Docker or real coins are involved. Re-run it whenever the UI
changes.

## Run it

```sh
# one time: get Playwright's browser (downloaded outside the project)
deno run -A npm:playwright install chromium

# regenerate all screenshots (default output: docs/images/web-ui/)
deno run -A --no-lock scripts/docs_screenshots.ts [output-dir]
```

`--no-lock` keeps Playwright out of `deno.lock`; it is loaded at run time and is not a project
dependency.

On Linux, Chromium needs system libraries. If it fails to start with "error while loading shared
libraries", install them with `deno run -A npm:playwright install-deps` (needs sudo), or use your
distro's packages.

## What it does

It starts the UI in-process on a throwaway data directory with three fake chains, then walks the
whole route in a headless browser: confirm the network, import a wallet, set destinations, scan,
create a plan, open the QR export, sign with test keys, upload, verify, broadcast (test first, then
the rest), track, and open the Donors tab. It writes one PNG per step, named `NN-name.png`.

## Changing a screenshot

- Add or rename a step in `scripts/docs_screenshots.ts` (the `shot("NN-name")` calls), then update
  the image references in `docs/user/web-ui-guide.md`.
- Selectors use the visible button labels, so a renamed button in `src/ui/static/app.js` needs the
  same change in the script.
- The images show demo data (fake chains, test keys). Don't capture a real wallet.
