# forksplit TODO

Target: a **pre-alpha** release, so more people can test. Section 1 is everything that has to be
true before tagging it. Everything after that is follow-up work and does not block the release.

What has been run so far: the full guided route, both donor routes, fee bumps and reorg handling
against real Bitcoin Core, Knots and eCash nodes on regtest (`deno task test:integration`); Sparrow
and Shrike signing our PSBTs on the regtest playground; a SeedSigner scanning the QR export; the
default servers probed through Tor. **Nothing has moved real coins on mainnet.**

## 1. Pre-alpha release gates

### Identity and endpoints (wrong here means wrong chain)

- [ ] **Checkpoint hashes** in `src/core/profiles.ts`:
  - [ ] Re-verify every hash from two independent sources.
  - [ ] ECX 974,017 came from one explorer and needs a second source, such as an eCash node (v1.2.0
        is what the pinned commit reports).
  - [ ] Confirm it's buried deep enough that a reorg can't replace it.
- [ ] **ECX default endpoint.** `explorer.ecash.com` answered through a Tor exit with no Cloudflare
      challenge on one request. Repeat from several exits and under scan load. If it fails, decide
      on a different default or ship with the fallback (`esplora.ecash.ninja`).

### One real run

- [ ] **One live end-to-end run on mainnet with one small coin**, ECX and XBT only: scan, plan
      `--batch coin`, sign ECX with an ordinary wallet and XBT with a real 0x21 signer, `verify`,
      `broadcast`, `track`, rescan. Confirm the BTC copy is untouched and shows as separated.
- [ ] **Working XBT signer steps in the docs** for at least one signer (Sparrow BLAKE2b build or
      Shrike are the candidates; both already signed our PSBTs on regtest). Cover Knots
      `walletprocesspsbt` (does it need an explicit `sighashtype`, and with what spelling?) only if
      Knots is the one you pick. Put the steps in `docs/user/signers.md`.

### Tor (Linux first)

- [ ] Managed Tor bootstraps on Linux from the bundled binary (Tor Browser 16.0 / tor 0.4.9.15,
      already pinned and signature-checked).
- [ ] Per-chain and per-broadcast circuits really differ (Tor control port, or distinct exit IPs).
      The docs claim this, so verify it.

### Packaging and project

- [ ] **Release artifacts.** `deno task compile` for Linux x86_64 packaged with
      `vendor/tor/<platform>/`, signed, with published checksums. Other platforms can follow
      (section 2). A source-only release is acceptable if you'd rather not ship binaries yet.
- [ ] **`SECURITY.md`**: set the disclosure contact (it still says TBD) and the disclosure policy.
      Its "known limitations" list is out of date: it says Tor isn't pinned, and it points at the
      old TODO sections.
- [ ] **Name and license.** Decide before going public. The license is MIT today, to match the
      vendored smolcars code.
- [ ] **Pre-alpha messaging.**
  - [ ] README status line says pre-alpha and no longer says "milestone 4".
  - [ ] Release notes state plainly: not security-reviewed, never run on mainnet beyond the one
        small-coin test, start with one small coin.
  - [ ] Known limitations are listed in the release notes: inputs with script timelocks (CLTV) are
        unsupported; Taproot script trees, miniscript and `combo()` are unsupported; fee bumps for
        BTC and fan-out transactions are unsupported; PSBT v2 input is unsupported.
  - [ ] Move `CHANGELOG.md` "Unreleased" under the version heading and bump `deno.json` from
        `0.1.0-dev`.
  - [ ] An issue template for tester reports (wallet, signer, chain, backend, what was verified).

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
- [ ] **Scan signed** with a real camera, and a Jade, Keystone and Passport. The export was only
      tried on a SeedSigner; the UR coding is checked against the reference implementation, but the
      scanning UI has not been in front of a camera.
- [ ] Multisig and Taproot PSBTs with real signers.

### Backends against real servers

- [ ] Node RPC against mainnet Core 31.x, Knots 29.4.x and eCash v1.2.0. Only regtest so far.
- [ ] Electrum against Fulcrum and electrs: an XBT server patched for 164-byte headers, the
      "transaction not found" text per implementation (`isNotFound`), large-history scripts, and
      reorg status per transaction (unit-tested against a fake server only).
- [ ] Esplora/mempool: `/fee-estimates` format on each default server, the `POST /tx` error format,
      HTTP 429 handling and backoff.
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
  - [ ] live Tor bootstrap progress;
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
