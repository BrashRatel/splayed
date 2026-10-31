# forksplit TODO

Status as of 2026-10-31: milestones 1–4 are done (see the README roadmap). Everything below is still
open. The build environment couldn't reach live explorers, the Tor network, torproject.org or
dl.deno.land, so **nothing has run against real servers, real signers or a real Tor circuit**.

## 1. Before anyone uses it with real coins (release blockers)

- [ ] **Live test, one small coin per chain.**
  1. Scan.
  2. Plan with `--batch coin`.
  3. Sign:
     - ECX with an ordinary wallet: Sparrow, plus a hardware wallet (Coldcard, Trezor or Ledger) via
       PSBT;
     - XBT with the real 0x21 signer.
  4. `verify`, `broadcast`, `track`, then rescan.
  5. Confirm the coin's BTC copy is untouched and shows as separated.
- [ ] **XBT signers and PSBT_IN_SIGHASH_TYPE = 0x21.** Check each one actually produces 0x21
      signatures from our PSBTs:
  - [ ] Bitcoin Knots `walletprocesspsbt` (does it need an explicit `sighashtype` argument, and with
        what spelling?)
  - [ ] Sparrow BLAKE2b build
  - [ ] Shrike
  - [ ] embit
  - [ ] privkeyio firmware forks (experimental)

  Write the working steps for each signer into the README.
- [ ] **ECX signers.** Confirm hardware wallets sign locktime 499,999,998 without complaint, and
      that the signed transaction keeps the locktime and sequences (`verify` checks this, but we
      should know which devices warn or refuse).
- [ ] **Default endpoints.** Probed through Tor on 2026-10-31.
  - [x] mempool.space onion matches the `Onion-Location` header mempool.space serves.
  - [x] mempool.guide onion matches the `Onion-Location` header mempool.guide serves.
  - [x] Both onions serve the REST API under `/api` (`/blocks/tip/height` answered 200).
  - [ ] explorer.ecash.com answered through a Tor exit with no Cloudflare challenge on one request.
        Repeat from several exits and under scan load before ticking.
  - [x] esplora.ecash.ninja answers as the ECX fallback.
- [ ] **Checkpoint hashes** in `src/core/profiles.ts`.
  - [ ] Re-verify every hash from two independent sources.
  - [ ] ECX 974,017 in particular came from one explorer (via the user) and needs a second source,
        such as an eCash node (v1.2.0 is what the pinned commit reports).
  - [ ] Make sure it's buried deep enough that a reorg can't replace it.
- [x] **Pin a Tor release.** Pinned Tor Browser 16.0, which bundles tor 0.4.9.15 (checked by running
      the fetched Linux binary). The signing-key fingerprint
      (`EF6E286DDA85EA2A4BA7DE684E2C6E8793298290`) was confirmed independently, and
      `update-tor-manifest` verified the release signature against it.
  - [ ] Run `deno task fetch-tor --all` and smoke-test the macOS and Windows bundles. Only the Linux
        x86_64 bundle has been fetched and run so far.
- [ ] **Real Tor run.**
  - [ ] Confirm managed Tor bootstraps on Linux, macOS and Windows.
  - [ ] Confirm per-chain and per-broadcast circuits really differ: check Tor's control port, or
        that exit IPs differ.
- [ ] **Release builds.**
  - [ ] Get `deno task compile` working for each platform.
  - [ ] Package each build with `vendor/tor/<platform>/`.
  - [ ] Sign the release artifacts.
  - [ ] Publish checksums.
- [ ] **Security review.** Get an independent review of `src/core/sigcheck.ts`,
      `src/core/planner.ts`, `src/core/psbt.ts`, `src/net/*` and `src/ui/server.ts` before a public
      release.

## 2. Backends against real servers

- [ ] Node RPC against real Bitcoin Core 31.x, Knots 29.4.x (XBT) and eCash v1.2.0 (the version the
      pinned `ecash-com/bitcoin` commit reports):
  - [ ] `scantxoutset` with ranged descriptors;
  - [ ] `testmempoolaccept` reject reasons. The pass/fail rules in `src/core/execute.ts`
        (`mempoolChecks`) assume Core's strings.
  - [x] Knots `getdeploymentinfo`: reports `blake2b` at the top level of the result, not under
        `deployments` (confirmed on a Knots 29.4.1 regtest node; the check was wrong and is fixed).
- [ ] Electrum against Fulcrum and electrs:
  - [ ] an XBT server patched for 164-byte headers;
  - [ ] the "transaction not found" error text for each implementation (`isNotFound`);
  - [ ] large-history scripts.
- [ ] Esplora/mempool:
  - [ ] the `/fee-estimates` format on each default server;
  - [ ] the `POST /tx` error format;
  - [ ] rate limits (HTTP 429 handling and backoff).
- [ ] Remote node RPC over an onion address, end to end.

## 3. Safety and correctness follow-ups

- [x] **Reorg handling.** `track` records each split's block and reports a split that was re-mined
      in another block, went back to the mempool, left the chain, or had its input spent by a
      different transaction; `scan` warns when a spend disappears or is replaced. Tested against
      real nodes with `invalidateblock`.
  - [ ] The "left the chain and the mempool, input unspent" case is only covered by unit tests: a
        regtest node can't be made to drop a transaction that way without a restart.
  - [ ] Electrum has no per-transaction status yet, so it can't see a block change.
  - [ ] Show reorg alerts in the web UI, not just in the `track` output.
- [x] **Stuck splits.** `bump` writes a BIP125 replacement plan (same inputs and destination, higher
      fee) that is signed, verified and broadcast like any plan. Tested against real nodes.
  - [ ] CPFP for the case where the original can't be replaced (no RBF signal from an old plan).
  - [ ] A bump button in the web UI (the command already works from it).
  - [ ] Bumping one transaction of a `--batch all` plan can't drop an input; it replaces the whole
        transaction.
- [ ] **Coins that turn up later.** Warn when a rescan finds new shared coins. Guidance in the UI,
      not just the CLI.
- [ ] **Chain upgrades.** Watch for:
  - eCash node upgrades after v1.2.0, which may need new checkpoints;
  - XBT Knots changes: coinbase maturity ends at block 979,920, RDTS expires 2027-09-01.
- [ ] **Explicit chain-specific coins.** Detect coins that are already chain-specific because their
      creating transaction is protected, rather than only "absent elsewhere". Feeds the donor work
      in section 4.
- [ ] **Locked inputs.** Decide how to handle inputs with script timelocks (CLTV breaks the ECX
      marker): today they're simply not supported.

## 4. Features

- [ ] **Advanced donor-input routes** (spec §4, opt-in):
  - [ ] Forks-first with an XBT donor, so stock hardware wallets can do the XBT step.
  - [ ] BTC-first with a BTC donor.
  - [ ] A donor pool that tracks where each donor came from (coinbase / protected-spend / derived).
  - [ ] A fan-out transaction to make several donors.
  - [ ] An opt-in screen explaining the donor rules and the on-chain linkage they create.
- [ ] Testnet profiles for rehearsals: testnet4 BLAKE2b (fork at 150,308) and ECX betanet (marker
      499,999,999). Each needs its own pinned checkpoints.
- [ ] PSBT v2 (BIP370) input, for signers that only emit v2.
- [ ] Descriptors: Taproot script trees, miniscript, `combo()`.
- [ ] Air-gapped signers: animated QR (BC-UR) export and import of PSBTs in the UI.
- [ ] UI:
  - [ ] live Tor bootstrap progress;
  - [ ] edit scan gap limit and jitter;
  - [ ] archive or delete plans;
  - [ ] show the per-coin plan, verify and broadcast state on the Coins tab;
  - [ ] a guided first-run wizard.
- [ ] Batch policy improvements, for example clustering coins already linked on-chain (common-input
      heuristics) rather than just by address.
- [ ] `status --json` and `plan --json` output for scripting.

## 5. Project hygiene

- [x] CI: fmt, lint, type-check and tests on every push (`.github/workflows/ci.yml`).
- [x] Regtest integration suite (`deno task test:integration`, `tests/integration/`): real Bitcoin
      Core 31.0, Knots 29.4.1 (BLAKE2b at regtest height 110) and eCash (built from the pinned
      commit, which reports v1.2.0) in Docker. Drives the real CLI through init, import, scan, plan,
      verify, broadcast, track and rescan, and checks replay rejection on the other nodes.
  - [x] Covers `pkh`, `wpkh`, `sh(wpkh)`, `tr` key path and 2-of-3 `sh`, `wsh` and `sh(wsh)`
        `sortedmulti`, including a multisig input below its threshold being refused.
  - [x] Mixed batch: one `--batch all` transaction per fork spending all seven script types.
  - [ ] Still to cover: other m-of-n shapes, Taproot with script trees or miniscript (not supported
        yet), reorgs, RBF fee bump, a hardware-wallet-style signer, a CI job (needs Docker and a ~5
        minute first build).
  - [ ] Add a fast unit-level regression for the P2SH-wrapped txid case (the regtest suite is its
        only coverage today).
- [ ] `SECURITY.md` contact address; decide on a disclosure policy.
- [ ] Decide on the project name and license before going public. The current license is MIT, to
      match the vendored smolcars code.
- [ ] Contributor docs: architecture overview (`src/` layout), how to add a chain profile.
