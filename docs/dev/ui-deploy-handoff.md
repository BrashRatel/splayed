# `ui-deploy` branch: plan, status and handoff notes

For whoever picks this branch up next (person or agent). Updated 2026-11-02.

The branch adds UI and deployment work on top of `main` (`f948971`). **Merge it into `main` only
after the checkpoints at the end.** CHANGELOG "Unreleased" lists every user-visible change in
detail; this file covers the plan, what's left and how the work has been done.

## The plan and where it stands

| Phase | What                                                                                                                                                                                                                             | Status                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 1     | UI: progress reporting; in-tab progress and auto-advance; `config scan`; plan archive/delete; QR wallet import with SeedSigner multisig; setup guide                                                                             | Done. Per-coin state on the Coins tab and a donor opt-in screen were skipped by decision   |
| 2     | Follow-ups: new-shared-coins warning; coin picker; real-browser checks; track/broadcast correctness (reorgs, DROPPED, own-spend recognition, soft TEST FIRST gate, `track --ack`, `bump --another`); docs and screenshot refresh | Done                                                                                       |
| 3     | A1: UI behind another server (`ui --listen --allowed-host --token-file`, sign-in, throttling). A2: `config backend detect`                                                                                                       | Done                                                                                       |
| 4     | Docker (`docker/`, `docs/user/docker.md`)                                                                                                                                                                                        | Built and run 2026-11-02 (image, Tor variant, `WITH_TOR=0`); multi-arch `buildx` not tried |
| 5     | StartOS package (separate `splayed-startos` repo)                                                                                                                                                                                | First version in `splayed-startos`; not packed or installed yet (below)                    |

Decisions made along the way:

- **TEST FIRST is a soft gate:** it asks, and doesn't refuse. The rest of a plan is released after 1
  confirmation of the test. `--yes` answers only when the test is confirmed or in the mempool;
  `--all` sends everything.
- **UI job argument cap is 512**, so the coin picker can pass one `--coin` per coin.
- **A1 tokens:** a generated token only (32+ characters, from a 0600 file) and a per-tab sign-in
  (sessionStorage), with no cookies. Proxied mode turns on whenever allowed hosts are given.
- **Security review of A1:** the separate review was folded into the final review.

## Left to do

1. **Docs and screenshots refresh:** done. `docs/images/web-ui/` was regenerated (26 screens) by
   `scripts/docs_screenshots.ts` (pinned Playwright; `SPLAYED_SHOTS_CHROMIUM`), and the Web UI guide
   was updated.
2. **Phase 5: the StartOS package:** first version in
   [`BrashRatel/splayed-startos`](https://github.com/BrashRatel/splayed-startos) (SDK 3.1.1, the
   published one; submodule pinned to this branch). Its README describes the design: image built
   with `WITH_TOR=0`; Tor service required (`SPLAYED_TOR_MODE=system`, SOCKS from its bridge
   binding); optional `bitcoind` through `rpc-local` with a login from `generate-rpc-dependent` and
   `config backend detect --add` on each start; allowed hosts from the UI binding; Show/Reset UI
   token actions; both volumes backed up. Type-checked, linted and bundled with ncc here; not yet
   packed (`start-cli` and Docker aren't available here) or installed.
3. **Checkpoints before merging into `main`** (status 2026-11-02):
   - **Docker testing:** done except multi-arch.
     - Image built and run; sign-in, host check and throttle checked; Tor bootstraps in the
       container; the Tor-container variant and `WITH_TOR=0` work.
     - `deno task test:integration` passes (135 steps on real Core, Knots and eCash). It first
       failed on two stale assertions in the real-node scenarios, now fixed.
     - Still open: a `buildx` amd64+arm64 build (no QEMU on the dev host) and a scan over the
       container's Tor with a real wallet.
   - **Real devices:** done in the regtest session with a SeedSigner: QR wallet import (single-sig
     and multisig), signing, a 2-of-3 sign/verify/broadcast, and the alert window clearing. Found
     and fixed there: a second cosigner's signed PSBT replaced the first (now merged; 3-of-5
     tested). Found and not fixed: multisig PSBTs carry mainnet xpub version bytes in
     `PSBT_GLOBAL_XPUB`, which Shrike refuses on regtest and Sparrow most likely does too (see
     TODO.md).
   - **StartOS:** `make x86`/`make arm` in `splayed-startos`, then install on a real device. Check
     first: the Web UI answers (no 403 from the Host check behind the StartOS proxy), Show UI token
     and sign-in, a scan over the Tor service, and with Use the Bitcoin node the bitcoind task, then
     the node added to the right chain. Also back up and restore. The icon is a placeholder drawn
     for the package. The device is an x86 StartOS 0.4.1 running on mainnet.
   - **One final review of the whole branch**, focusing on track/broadcast and on A1 (the network
     boundary).

Open TODO items added on this branch:

- **Electrum on XBT at the chain tip:** the block hash comes from the next header, so a split in the
  tip block may show "lookup failed" until the next block.
- **Bare hex keys:** `tr(<64 hex>)` is accepted as an x-only key, so a pasted hex private key isn't
  recognised as one.

## How the work was done (and what to keep doing)

- **Branching:** each package was made on its own branch or worktree from `ui-deploy`, and merged
  fast-forward after the gates passed.
- **Gates for every change:** `deno fmt --check`, `deno task lint`, `deno task check`,
  `deno task test` (235 tests at the time of writing).
- **UI checks:** every UI change was rendered in Chromium (Playwright) against the fake chains
  (`tests/demo_ui.ts`, `tests/e2e.ts`), with no console or page errors.
- **Track/broadcast tests:** these changes have end-to-end tests on four fake backends (Esplora,
  Electrum, node RPC with and without txindex; `tests/e2e.ts`). Each behaviour change came with a
  test that failed before it.
- **Change only with a strong reason and a review:** `src/core/profiles.ts` (checkpoints, replay
  constants), `sigcheck.ts`, `psbt.ts`, `planner.ts`, `unified_sighash.ts`, `vendor/`. None were
  changed on this branch, except a range check in `descriptors.ts`.
- **Keyless rule:** the UI does nothing the CLI can't (state changes run as CLI jobs; the QR
  endpoints are read-only), and private keys and seeds are refused everywhere.
- **Cost:** per-package subagents plus a review after every fix used up most of a week's usage
  budget. One review pass per phase, or one at the end, was enough to catch the important problems.
