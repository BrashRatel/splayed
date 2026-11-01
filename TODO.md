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
  - [x] `scantxoutset` with ranged descriptors: every regtest wallet scan uses it on all three
        nodes.
  - [x] `testmempoolaccept` reject reasons, checked on all three nodes: `missing-inputs`,
        `txn-already-known`, `insufficient fee` (a lower-fee conflict; all three run full RBF, so
        this is what a conflict looks like) are tolerated on the target chain, and
        `mempool-script-verify-flag-failed` stops everything. "insufficient fee" was added to the
        tolerated list.
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
  - [x] The "left the chain and the mempool, input unspent" case, against a real node: reorg the
        split out, move the node's clock past the 14-day expiry, and let the mempool trim. `track`
        reports it and `broadcast` sends it again.
  - [x] Electrum per-transaction status (from the history of the transaction's first output script).
        Unit-tested against a fake server only; try it against Fulcrum and electrs.
  - [x] Reorg alerts in the web UI plans view. Not yet looked at in a real browser.
- [x] **Stuck splits.** `bump` writes a BIP125 replacement plan (same inputs and destination, higher
      fee) that is signed, verified and broadcast like any plan. Tested against real nodes.
  - [x] CPFP (`bump --cpfp`) for the case where the original can't be replaced. Tested on ECX and
        XBT against real nodes (package rate checked in the node's mempool). Not done: CPFP of a
        donor transaction or a multi-output one.
  - [x] Fee bump buttons in the web UI (per split and for the whole plan). Not yet looked at in a
        real browser.
  - [x] Bump one transaction of a batch without some of its coins (`bump --tx N --drop txid:vout`).
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
  - [x] Forks-first with an XBT donor, so stock hardware wallets can do the XBT step. Donor wallet,
        `donor scan`, `plan --donor`, verify, broadcast preflight, tested against real nodes.
    - [x] Donor fan-out (`donor fanout`): one transaction per donor, many outputs back to the donor
          wallet. Tested against real nodes. A fan-out can't be fee-bumped yet (`bump` handles
          single-output transactions only).
    - [x] Accept a donor whose funding transaction was made elsewhere (`verified-funding`): traced
          on chain to a 0x21 signature or back to a coinbase / a split this tool verified.
    - [x] A donor screen in the web UI, behind an Advanced toggle (import, scan, select, fan out,
          plan). Rendered only against a stub DOM so far; not looked at in a real browser.
    - [ ] Try it with a real stock hardware wallet signing both the shared and the donor input.
  - [x] BTC-first with a BTC donor (`plan --btc-first`): BTC with a donor, ECX, then a plain XBT
        split that `broadcast` holds back until BTC and ECX are deep. Tested against real nodes. Not
        done: fee bump of BTC transactions, a real hardware wallet run.
  - [x] A donor pool that tracks where each donor came from: `donor scan` records the home chain and
        the origin of each donor (coinbase / protected-spend / verified-funding / unproven).
  - [x] A fan-out transaction to make several donors (`donor fanout`).
  - [ ] An opt-in screen explaining the donor rules and the on-chain linkage they create.
- [ ] Testnet profiles for rehearsals: testnet4 BLAKE2b (fork at 150,308) and ECX betanet (marker
      499,999,999). Each needs its own pinned checkpoints.
- [ ] PSBT v2 (BIP370) input, for signers that only emit v2.
- [ ] Descriptors: Taproot script trees, miniscript, `combo()`.
- [x] Air-gapped signers: animated QR (BC-UR `crypto-psbt`) export and import of PSBTs in the UI.
  - [ ] Try it with a real signer and a real camera (Keystone, Passport, Jade, SeedSigner). Nothing
        here has been in front of a camera: the UR coding is checked against the reference
        implementation and the drawn QR codes against the vendored reader, but not the scanning UI.
  - [ ] BBQr (Coldcard Q) and plain base64 QR codes; the `ur:psbt` type is read but not written.
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

- [x] **Regtest playground with real signers.** `deno task regtest` was tried with real Sparrow and
      Shrike wallets (reported by the project owner): both connected to their nodes, imported
      descriptors, exported our PSBTs, signed them, and the signed files went through upload, verify
      and broadcast in the UI. The steps are in the README ("Regtest playground").
  - [ ] Still to try in the playground: the Sparrow BLAKE2b build on the Knots node by itself, and
        multisig and Taproot PSBTs with real signers.

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
