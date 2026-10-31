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
- [ ] **Default endpoints.**
  - [ ] Confirm the mempool.space onion against mempool.space's own published link.
  - [ ] Confirm the mempool.guide onion against an operator-published link, such as an
        `Onion-Location` header.
  - [ ] Confirm both onions serve the REST API under `/api`.
  - [ ] Confirm explorer.ecash.com answers through Tor exits, with no Cloudflare challenge.
  - [ ] Confirm esplora.ecash.ninja works as the ECX fallback.
- [ ] **Checkpoint hashes** in `src/core/profiles.ts`.
  - [ ] Re-verify every hash from two independent sources.
  - [ ] ECX 974,017 in particular came from one explorer (via the user) and needs a second source,
        such as a v1.1.0 node.
  - [ ] Make sure it's buried deep enough that a reorg can't replace it.
- [ ] **Pin a Tor release.** On a machine that can reach torproject.org:
  1. Independently confirm the Tor Browser Developers signing-key fingerprint
     (`EF6E286DDA85EA2A4BA7DE684E2C6E8793298290`).
  2. Run `deno task update-tor-manifest <version>`.
  3. Review and commit `vendor/tor-manifest.json`.
  4. Run `deno task fetch-tor --all`.
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

- [ ] Node RPC against real Bitcoin Core 31.x, Knots 29.4.x (XBT) and eCash v1.1.0:
  - [ ] `scantxoutset` with ranged descriptors;
  - [ ] `testmempoolaccept` reject reasons. The pass/fail rules in `src/core/execute.ts`
        (`mempoolChecks`) assume Core's strings.
  - [ ] Knots `getdeploymentinfo`: confirm it really names the deployment `blake2b`.
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

- [ ] **Reorg handling.** `track` should notice if a split leaves the chain (its input becomes
      unspent again, or is spent by another txid) and warn loudly.
- [ ] **Stuck splits.** Add an RBF fee bump: a new plan revision that spends the same inputs at a
      higher fee, verified the same way.
- [ ] **Coins that turn up later.** Warn when a rescan finds new shared coins. Guidance in the UI,
      not just the CLI.
- [ ] **Chain upgrades.** Watch for:
  - eCash node upgrades after v1.1.0, which may need new checkpoints;
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
- [ ] Run the regtest integration suite against real nodes (Core, Knots and eCash in Docker),
      modelled on smolcars/bcashjr-wallet's setup.
- [ ] `SECURITY.md` contact address; decide on a disclosure policy.
- [ ] Decide on the project name and license before going public. The current license is MIT, to
      match the vendored smolcars code.
- [ ] Contributor docs: architecture overview (`src/` layout), how to add a chain profile.
