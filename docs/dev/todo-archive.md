# Dev archive: completed work

Finished items moved out of [TODO.md](../../TODO.md), newest first. When you tick something off the
TODO, move it here (keep the evidence: what was checked, when, against what) and delete it from the
TODO.

## Completed after the pre-alpha tag (the `ui-deploy` branch)

- **Docker image** (`docker/`): built, run, signed in and Tor bootstrapped inside it; the
  Tor-container variant and `WITH_TOR=0` built and ran (2026-11-02).
- **Browser checks:** reorg alerts, fee bump buttons and the donor screen looked at in Chromium
  (Playwright) against fake chains with mining/reorg controls; findings fixed (see CHANGELOG).
- **Dropped splits:** an accepted split that was never confirmed and then falls out of every mempool
  is now flagged (a DROPPED alert) and `broadcast` sends any such split again. Checked in Chromium
  against fake chains.
- **Independent review of wp/2f (package 2g):** superseded kept on node RPC, own spends found by
  txid when the backend can't name the spender, `--yes` only answers the TEST FIRST question while
  the test spend is on the network, alerts can be acknowledged (`track --ack`, archive), the
  original beating its fee bump settles, a conflict whose spend left the chain can be sent again.
  End-to-end tests run on Esplora, Electrum and node RPC with and without `txindex`.
- **Coins that turn up later:** a rescan lists coins that are shared now but weren't in the previous
  scan: a **NEW SHARED COINS** block from `scan` / `status`, `newShared` in `scan.json`, and in the
  web UI a banner on Coins, **new** row badges, and a header pill / guide line once a plan exists.
- **Web UI features:** guided first-run wizard; live Tor bootstrap progress (needed in practice,
  2026-11-01: circuits over Tor are slow enough to look hung); auto-advance Network to Wallet to
  Coins; scan a QR descriptor into the wallet/destination fields; a waiting indicator on Coins while
  `scan` runs; edit scan gap limit and jitter; archive or delete plans; coin picker (**Plan these
  coins** from the new-shared-coins banner).
- **A TEST FIRST transaction that can't go out held the rest of its chain (2026-11-03):** it waited
  for a second run or `--all`. `broadcast` now describes the test's state and asks about the rest in
  the same run (`prepare()` in `cmdBroadcast`, `src/cli/main.ts`); a test already on the network
  releases the rest at once. Tests in `tests/test_first_yes_test.ts` and
  `tests/backends_e2e_test.ts`.
- **`tr(<64 hex>)` in descriptors (2026-11-03):** `parseDescriptor` took a bare 32-byte hex key in
  `tr()` as an x-only public key, so a pasted hex private key wasn't recognised. A bare 32-byte hex
  key is now refused everywhere with a keyless explanation (it can't be told from a private key);
  33-byte compressed keys still work. Test in `tests/descriptors_test.ts`.
- **StartOS package `v0.1.0:3` on a device (2026-11-03, verified by the project owner):** x86
  StartOS 0.4.1 server. Node on by default at first install and the retry loop (no restart after the
  RPC-login task), the **Burn history** action, Show/Reset UI token, a scan over the Tor service,
  and backup and restore all work. (`:0` had earlier run there too: Tor and the local node worked,
  the node on the second try, because the one-shot check ran before bitcoind restarted.)
- **Screenshots regenerated (2026-11-03):** all images redone with the Burn history / Burn eyes
  header buttons, plus a new `27-burn-history.png` (the question, answered No), used in the Advanced
  UI guide. `scripts/docs_screenshots.ts` has the new step.
- **Docs cleanup (2026-11-03):** Docker and StartOS options at the top of the README quick start;
  Docker and StartOS rows fixed in `docs/README.md`; Web UI guide cut down to the single-sig route,
  with multisig and the rest moved to [advanced-ui-guide.md](../user/advanced-ui-guide.md); tested
  wallets table in [signers.md](../user/signers.md); stale or time-bound lines removed from the docs
  (the "reaching 2 confirmations" line, the "nothing has moved real coins on mainnet" line, and
  references to the TODO's old release-gate section).

## Pre-alpha release gates (tagged `v0.1.0-pre-alpha.1`, 2026-11-01)

Target was a pre-alpha release so more people could test. What had been run when the tag was cut:

Target: a **pre-alpha** release, so more people can test. Section 1 is everything that has to be
true before tagging it. Everything after that is follow-up work and does not block the release.

What has been run so far: the full guided route, both donor routes, fee bumps and reorg handling
against real Bitcoin Core, Knots and eCash nodes on regtest (`deno task test:integration`); Sparrow
and Shrike signing our PSBTs on the regtest playground; a SeedSigner scanning the QR export; the
default servers probed through Tor. **One real coin has been split on mainnet** (2026-11-01): ECX
and XBT away from BTC, BTC confirmed untouched. Still only one coin, still early days.

2026-11-02 (the `ui-deploy` branch): the Docker image built and run (sign-in, throttling, Tor inside
it); the whole flow on regtest in the web UI with a SeedSigner (QR wallet import, single-sig and
2-of-3 multisig signing, verify, broadcast); the StartOS package on an x86 StartOS 0.4.1 server.

### Identity and endpoints (wrong here means wrong chain)

- [x] **Checkpoint hashes** in `src/core/profiles.ts`, each confirmed on at least two independent
      sources (2026-11-01):
  - BTC 961,640 and 973,728: mempool.space, blockstream.info and blockchair.com.
  - XBT 961,640: mempool.guide and pool.rabidmining.com/explorer/xbt.
  - ECX 973,728 and 974,017: explorer.ecash.com, esplora.ecash.ninja and explorer.blockfab.org.
  - ECX 974,017 is buried deep enough that a reorg can't replace it: the ECX tip was 982,129, about
    8,100 blocks later.
  - Still worth doing: confirm the ECX hashes against an eCash node (v1.2.0 is what the pinned
    commit reports), since explorers can share a backend.
- [x] **ECX default endpoint.** `explorer.ecash.com` stays the default (no Cloudflare challenge seen
      through Tor), and ships with `esplora.ecash.ninja` as the fallback in case that changes. The
      fallback needs the user's explicit confirmation before it is ever contacted.

### One real run

- [x] **One live end-to-end run on mainnet with one small coin**, ECX and XBT only: scan, plan
      `--batch coin`, sign ECX with an ordinary wallet and XBT with a real 0x21 signer, `verify`,
      `broadcast`, `track`, rescan. Confirm the BTC copy is untouched and shows as separated.
  - Done (2026-11-01), run through the local web UI: `verify` and `broadcast` accepted on all three
    nodes, `track` showed per-tx confirmations. Checked against block explorers: BTC copy confirmed
    untouched at the original address; XBT and ECX both confirmed at their new addresses (the ECX
    split hit the `bump` bug below along the way). Both forks have their first confirmation; `scan`
    itself will keep reporting `pending` rather than `SEPARATED` until they reach the profile's
    default depth (50 confirmations) — that's just the clock, not a functional gap.
  - **Bug found and fixed (2026-11-01): `bump` silently failed to broadcast ECX replacements.**
    `bump` on the ECX split reported `verify` clean and `broadcast` as `accepted`
    (`"detail": "already in the mempool"`), but neither `explorer.ecash.com` nor `blockfab.org` ever
    showed the replacement — only the original, lower-fee transaction. Root cause confirmed directly
    against both of ECX's default backends: `GET /tx/<txid>/status` returns HTTP 200
    `{"confirmed":false}` for **any** syntactically valid txid, including ones that were never
    broadcast (confirmed with a random txid on both `explorer.ecash.com` and `esplora.ecash.ninja`;
    `GET /tx/<txid>` on the same txid correctly 404s on both). This is the same "Esplora trap"
    already called out in `observeOutput`'s comment in `src/backends/esplora.ts` for the `/outspend`
    endpoint, but it also affects `/status`, and switching ECX backends doesn't dodge it since both
    share the bug. `confirmationDepth()` (`src/core/execute.ts`) trusted `txStatus()` and treated
    `{"confirmed":false}` as `state: "mempool"`, so `cmdBroadcast`'s fee-bump pre-check
    (`src/cli/main.ts`, the `t.replaces` branch) short-circuited on the brand-new replacement txid
    and reported it "already accepted" **without ever calling `broadcast()`**. Nothing was lost —
    the original transaction was never actually replaced, so the coin's on-chain state didn't change
    while this was happening. **Fixed:** `EsploraBackend.txStatus` (`src/backends/esplora.ts`) now
    checks existence via `GET /tx/<txid>` before trusting an unconfirmed status, the same guard
    `observeOutput` already had. Regression test added (`tests/core_test.ts`, `tests/fakes.ts`:
    `FakeChain.statusTrap`). Verified against the real `esplora.ecash.ninja` backend: a random txid
    now correctly reports `absent`. For the stuck coin itself, the already-verified signed bump
    transaction was broadcast directly (`POST /tx`) to get it out while the fix landed; it's now
    genuinely in the mempool on both explorers, and the original is correctly marked `replaced` in
    the plan's progress file.
- [x] **Working XBT signer steps in the docs** for at least one signer (Sparrow BLAKE2b build or
      Shrike are the candidates; both already signed our PSBTs on regtest). Cover Knots
      `walletprocesspsbt` (does it need an explicit `sighashtype`, and with what spelling?) only if
      Knots is the one you pick. Put the steps in `docs/user/signers.md`.
  - Confirmed working on mainnet (2026-11-01), but with a different signer than planned: a
    SeedSigner, stock firmware for the ECX split (plain signature, as expected) and the
    SIGHASH_UNIFIED-aware fork at [privkeyio/seedsigner](https://github.com/privkeyio/seedsigner)
    (release `v0.8.7-unified-sighash.6`, the `p10.img` asset) for the XBT 0x21 split. Both verified
    and broadcast; XBT reached 2 confirmations. Steps are written up in `docs/user/signers.md`.

### Tor (Linux first)

- [x] Managed Tor bootstraps on Linux from the bundled binary (Tor Browser 16.0 / tor 0.4.9.15,
      already pinned and signature-checked).
  - Confirmed (2026-11-01): `deno task fetch-tor` pulled the pinned bundle (hash matched the
    manifest), the binary reports `Tor version 0.4.9.15`, and `TorManager` (the same code path the
    CLI and UI use) bootstrapped it 0% to 100% in about 10 seconds.
- [x] Per-chain and per-broadcast circuits really differ (Tor control port, or distinct exit IPs).
      The docs claim this, so verify it.
  - Confirmed (2026-11-01): five isolation keys (`btc`, `xbt`, `ecx`, two distinct
    `broadcast:<txid>` keys) each got a different exit IP through the bundled Tor's SOCKS proxy.
    Re-using the same isolation key in the same session returned the same exit IP both times, so a
    key pins to one circuit rather than rotating per request.

### Packaging and project

- [x] **Release artifacts.** `deno task compile` for Linux x86_64 packaged with
      `vendor/tor/linux-x86_64/`, signed, with published checksums. Other platforms can follow
      (section 2).
  - Done (2026-11-01): tagged and published as
    [`v0.1.0-pre-alpha.1`](https://github.com/BrashRatel/splayed/releases/tag/v0.1.0-pre-alpha.1).
    Verified before publishing: the standalone binary ran from a directory with no source tree and
    served its own embedded UI; a clean copy of the packaged layout found the bundled `tor` binary,
    bootstrapped it to 100%, and passed real identity checks on all three chains over real Tor
    circuits. `SHA256SUMS` signed with the `SECURITY.md` key; re-verified against a fresh download
    from the published release, not just the local build.
- [x] **`SECURITY.md`**: contact `brash@in-btc.com` with the PGP key (fingerprint
      `E6D1FC8869F4317E0AEFC58851E2C57C67FA2A4A`, checked against the Keybase key), a disclosure
      policy (7-day acknowledgement, 90-day coordinated disclosure), and an up-to-date known
      limitations list.
- [x] **Name:** renamed to **splayed** (checked for conflicts: npm, PyPI, crates.io, jsr and
      RubyGems are free, no product or company found, and `splayed.com` is a parked domain).
  - [x] GitHub repo renamed to `BrashRatel/splayed`; links and the git remote updated.
- [x] **Pre-alpha messaging.**
  - [x] README status line says pre-alpha and no longer says "milestone 4".
  - [x] Release notes (`docs/release-notes/0.1.0-pre-alpha.1.md`) state plainly: not
        security-reviewed, start with one small coin. The mainnet line was reworded (2026-11-01)
        once the live run above was done.
  - [x] Known limitations are listed in the release notes: inputs with script timelocks (CLTV),
        Taproot script trees, miniscript and `combo()`, PSBT v2 input, and fee bumps for BTC and
        fan-out transactions are unsupported.
  - [x] `CHANGELOG.md` "Unreleased" is now under `0.1.0-pre-alpha.1 (2026-11-01)` (tagged) and
        `deno.json` / `package.json` are bumped from `0.1.0-dev`.
  - [x] Issue templates in `.github/ISSUE_TEMPLATE/`: tester report (wallet, signer, chain, backend,
        how far it got), bug report, and a link to `SECURITY.md` for vulnerabilities.

## Earlier work

Kept for reference.

Kept for reference; not open work.

- **Core:** profiles with pinned constants, Tor transport and manager, Esplora, Electrum and
  node-RPC backends, descriptors, scan and status, `plan`, `verify`, `broadcast`, `track`, local web
  UI.
- **Tor pinned:** Tor Browser 16.0 (tor 0.4.9.15), checked by running the fetched Linux binary. The
  signing-key fingerprint (`EF6E286DDA85EA2A4BA7DE684E2C6E8793298290`) was confirmed independently
  and `update-tor-manifest` verified the release signature against it.
- **Default endpoints (probed through Tor on 2026-10-31):** the mempool.space and mempool.guide
  onions match each site's `Onion-Location` header and serve the REST API under `/api`;
  `esplora.ecash.ninja` answers as the ECX fallback.
- **Real-node behavior confirmed on regtest:** `scantxoutset` with ranged descriptors on all three
  nodes; `testmempoolaccept` reject reasons (`missing-inputs`, `txn-already-known` and
  `insufficient fee` are tolerated on the target chain; `mempool-script-verify-flag-failed` stops
  everything; all three run full RBF); Knots `getdeploymentinfo` reports `blake2b` at the top level
  of the result, not under `deployments`.
- **Reorgs:** `track` records each split's block and reports re-mined, back-in-mempool,
  gone-from-chain and conflicting-spend cases (tested with `invalidateblock`, including the 14-day
  mempool expiry case); `scan` warns when a spend disappears or is replaced; alerts appear in the UI
  plans view.
- **Stuck splits:** `bump` (BIP125 RBF), `--cpfp` (tested on ECX and XBT), `--drop` for batches, and
  fee-bump buttons in the UI.
- **Donor routes:** XBT donor route (donor wallet, `donor scan`, `plan --donor`), fan-out, donors
  funded elsewhere (`verified-funding`), origin tracking, BTC-first (`plan --btc-first`, XBT held
  back until BTC and ECX are deep), and a Donors tab in the UI behind Advanced. All tested against
  real nodes on regtest.
- **Air-gapped signing:** animated QR export and camera import (UR `crypto-psbt`).
- **Regtest:** `deno task regtest` playground tried with real Sparrow and Shrike wallets; the
  integration suite runs real Core 31.0, Knots 29.4.1 and eCash (pinned commit, v1.2.0) in Docker
  and covers `pkh`, `wpkh`, `sh(wpkh)`, `tr` key path, 2-of-3 `sh`/`wsh`/`sh(wsh)` `sortedmulti`
  (including a multisig input below its threshold being refused) and a mixed batch spending all
  seven script types.
- **CI:** fmt, lint, type-check and tests on every push (`.github/workflows/ci.yml`).
- **Docs:** role-based `docs/`, the CLI reference and the screenshot Web UI guide.
