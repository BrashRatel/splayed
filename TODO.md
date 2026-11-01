# splayed TODO

Target: a **pre-alpha** release, so more people can test. Section 1 is everything that has to be
true before tagging it. Everything after that is follow-up work and does not block the release.

What has been run so far: the full guided route, both donor routes, fee bumps and reorg handling
against real Bitcoin Core, Knots and eCash nodes on regtest (`deno task test:integration`); Sparrow
and Shrike signing our PSBTs on the regtest playground; a SeedSigner scanning the QR export; the
default servers probed through Tor. **One real coin has been split on mainnet** (2026-11-01): ECX
and XBT away from BTC, BTC confirmed untouched. Still only one coin, still early days.

## 1. Pre-alpha release gates

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

- [ ] **Release artifacts.** `deno task compile` for Linux x86_64 packaged with
      `vendor/tor/<platform>/`, signed, with published checksums. Other platforms can follow
      (section 2). A source-only release is acceptable if you'd rather not ship binaries yet.
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
  - [x] `CHANGELOG.md` "Unreleased" is now under `0.1.0-pre-alpha.1 (not yet tagged)` and
        `deno.json` / `package.json` are bumped from `0.1.0-dev`. Drop "not yet tagged" when
        releasing.
  - [x] Issue templates in `.github/ISSUE_TEMPLATE/`: tester report (wallet, signer, chain, backend,
        how far it got), bug report, and a link to `SECURITY.md` for vulnerabilities.

## 2. Before beta (verification and hardening)

Wanted, but this is the work pre-alpha testers help with.

### Review

- [ ] Independent review of `src/core/sigcheck.ts`, `src/core/planner.ts`, `src/core/psbt.ts`,
      `src/net/*` and `src/ui/server.ts`.

### Signers

- [ ] Each remaining XBT signer produces 0x21 from our PSBTs, with steps written down: Bitcoin
      Knots, Sparrow BLAKE2b build (alone on the Knots node), Shrike, embit, privkeyio firmware
      forks (experimental).
- [ ] ECX hardware wallets (Coldcard, Trezor, Ledger) sign locktime 499,999,998 without complaint
      and keep the locktime and sequences. Record which devices warn or refuse.
- [ ] A real stock hardware wallet signing both the shared and the donor input (XBT donor route).
- [ ] **Scan signed** with a real camera, and a Jade, Keystone and Passport.
  - Confirmed on mainnet (2026-11-01), in front of a real camera: exporting to a SeedSigner (stock
    firmware for ECX, a unified-sighash firmware fork for XBT) and scanning its signed QR back in
    both worked. Jade, Keystone and Passport still untried.
- [ ] Multisig and Taproot PSBTs with real signers.

### Backends against real servers

- [ ] Node RPC against mainnet Core 31.x, Knots 29.4.x and eCash v1.2.0. Only regtest so far.
- [ ] Electrum against Fulcrum and electrs: an XBT server patched for 164-byte headers, the
      "transaction not found" text per implementation (`isNotFound`), large-history scripts, and
      reorg status per transaction (unit-tested against a fake server only).
- [ ] Esplora/mempool: `/fee-estimates` format on each default server, the `POST /tx` error format,
      HTTP 429 handling and backoff.
  - One concrete bug already found and fixed this way: see the `bump` entry under "One real run"
    above — both of ECX's default backends report `{"confirmed":false}` instead of 404 for a txid
    that was never broadcast, which made the fee-bump pre-check falsely believe a replacement
    already landed and skip sending it. Fixed in `EsploraBackend.txStatus`.
- [ ] Remote node RPC over an onion address, end to end.

### Platforms

- [ ] `deno task fetch-tor --all` and smoke-test the macOS and Windows Tor bundles (only Linux
      x86_64 has been fetched and run), then `compile` and package each platform.
- [ ] Managed Tor bootstraps on macOS and Windows.

### Browser checks

- [ ] Look at these in a real browser: reorg alerts, fee bump buttons, and the donor screen (these
      were rendered only against a stub DOM or not looked at).

### Safety follow-ups

- [ ] **Coins that turn up later.** Warn when a rescan finds new shared coins, with guidance in the
      UI and not just the CLI.
- [ ] **Chain upgrades.** Watch for eCash node upgrades after v1.2.0 (may need new checkpoints) and
      XBT Knots changes: coinbase maturity ends at block 979,920, RDTS expires 2027-09-01.
- [ ] **Explicit chain-specific coins.** Detect coins that are already chain-specific because their
      creating transaction is protected, rather than only "absent elsewhere". Feeds the donor work.
- [ ] **Locked inputs.** Decide how to handle script timelocks (CLTV breaks the ECX marker). Today
      they're unsupported; make sure the tool says so clearly instead of failing obscurely.

## 3. Features and nice-to-have

- [ ] Testnet profiles for rehearsals: testnet4 BLAKE2b (fork at 150,308) and ECX betanet (marker
      499,999,999), each with its own pinned checkpoints.
- [ ] PSBT v2 (BIP370) input, for signers that only emit v2.
- [ ] Descriptors: Taproot script trees, miniscript, `combo()`.
- [ ] Fee bump for BTC transactions, fan-out transactions, and CPFP of donor or multi-output
      transactions.
- [ ] Air-gapped QR: BBQr (Coldcard Q) and plain base64 QR codes (the `ur:psbt` type is read but not
      written).
- [ ] UI:
  - [ ] guided first-run wizard;
  - [ ] live Tor bootstrap progress; confirmed needed in practice (2026-11-01): after "Check servers
        and confirm", establishing circuits over Tor is slow enough to look hung without a progress
        or waiting indicator;
  - [ ] auto-advance from the Network tab to the Wallet tab once settings are confirmed;
  - [ ] scan a QR descriptor directly into the wallet/destination fields on the Wallet tab;
  - [ ] auto-advance from the Wallet tab to the Coins tab once all fork destinations are set;
  - [ ] a progress or waiting indicator on the Coins tab while `scan` runs (or at least a note to be
        patient over Tor and watch the activity log) — same issue as Tor bootstrap, it looks hung
        but is just slow, especially noticeable on re-scans after a split;
  - [ ] edit scan gap limit and jitter;
  - [ ] archive or delete plans;
  - [ ] show the per-coin plan, verify and broadcast state on the Coins tab;
  - [ ] an opt-in screen explaining the donor rules and the on-chain linkage they create.
- [ ] Batch policy: cluster coins already linked on-chain (common-input heuristics) rather than just
      by address.
- [ ] `status --json` and `plan --json` output for scripting.

## 4. Project hygiene

- [ ] Fast unit-level regression for the P2SH-wrapped txid case (the regtest suite is its only
      coverage today).
- [ ] Regtest suite coverage still missing: other m-of-n shapes, reorgs, RBF fee bump, a
      hardware-wallet-style signer, and a CI job (needs Docker and a ~5 minute first build).
- [ ] Contributor docs: how to add a chain profile (the `src/` layout is in
      `docs/dev/architecture.md`).
- [ ] Keep `docs/images/web-ui/` current when the UI changes (`docs/dev/docs-screenshots.md`).

## Done

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
