# splayed TODO

Open work only, grouped by kind and ordered by impact within each group. When an item is done, move
it to [docs/dev/todo-archive.md](docs/dev/todo-archive.md) (with what was checked and when) and
delete it here.

## 1. Bugs and issues

No known high-impact bugs are open. Highest impact first:

### Medium

- [ ] **Multisig PSBTs on a non-mainnet network: wallets refuse the global xpubs.** The plan's PSBT
      writes each cosigner's `PSBT_GLOBAL_XPUB` with the mainnet `xpub` version bytes (`0488b21e`)
      even on regtest/testnet (`src/core/planner.ts`, `x.raw`). Shrike refuses the XBT multisig PSBT
      ("provided xpub extended key invalid on configured regtest network"); Sparrow's paste dialog
      just closed on the base64 and its file open said it could not recognise the format (very
      likely the same cause, not confirmed). Single-sig PSBTs have no global xpubs and open fine.
      Found 2026-11-02. Decide: write the network's own version bytes (`tpub`, `043587cf`), or leave
      the global xpubs out (the inputs' BIP32 derivations and witness scripts already carry what
      signers need), then check Sparrow, Shrike, SeedSigner and Bitcoin Core on regtest and mainnet.
      Mainnet is unaffected (the bytes already match).

### Low

- [ ] **Electrum on XBT (164-byte headers):** a block's hash is read from the next header, so a
      split confirmed in the tip block can't be placed (`? (lookup failed)`) until the next block.
      Check what a real server answers for `blockchain.block.header` at tip+1, and fall back to the
      header's own BLAKE2b hash or "confirmed, hash unknown" if needed. (The fake Electrum server
      serves tip+1.)
- [ ] **Chain upgrades (watch).** eCash node upgrades after v1.2.0 may need new checkpoints; XBT
      Knots changes: coinbase maturity ends at block 979,920, RDTS expires 2027-09-01.

## 2. Testing and review

### Review

- [ ] Independent review of `src/core/sigcheck.ts`, `src/core/planner.ts`, `src/core/psbt.ts`,
      `src/net/*` and `src/ui/server.ts`.
- [ ] One final review of the `ui-deploy` branch before merging, focusing on track/broadcast and the
      network boundary.

### Signers

- [ ] Each remaining XBT signer produces 0x21 from our PSBTs, with steps written down: Bitcoin
      Knots, Sparrow BLAKE2b build (alone on the Knots node), Shrike, embit.
- [ ] ECX hardware wallets (Coldcard, Trezor, Ledger) sign locktime 499,999,998 without complaint
      and keep the locktime and sequences. Record which devices warn or refuse.
- [ ] A real stock hardware wallet signing both the shared and the donor input (XBT donor route).
- [ ] **Scan signed** and **Scan QR** (wallet import) with a Jade, Keystone and Passport. (A
      SeedSigner works, both ways.)
- [ ] Multisig and Taproot PSBTs with real signers; 3-of-5 multisig end to end with a SeedSigner and
      on the regtest chains (tested through the UI API with fake chains only).

### Backends against real servers

- [ ] Electrum against Fulcrum and electrs: an XBT server patched for 164-byte headers, the
      "transaction not found" text per implementation (`isNotFound`), large-history scripts, and
      reorg status per transaction (unit-tested against a fake server only).
- [ ] Esplora/mempool: `/fee-estimates` format on each default server, the `POST /tx` error format,
      HTTP 429 handling and backoff. (Testing like this already found one real bug: both ECX
      backends answer `{"confirmed":false}` for a txid that was never broadcast, which is fixed in
      `EsploraBackend.txStatus`; see the archive.)
- [ ] Remote node RPC over an onion address, end to end.
- [ ] The lost-reply, own-spend and conflict paths on node RPC with and without `txindex` against
      the regtest nodes (covered against fakes only).
- [ ] Confirm the ECX checkpoint hashes against an eCash node (v1.2.0 is what the pinned commit
      reports), since explorers can share a backend.

### Platforms

- [ ] A `buildx` amd64+arm64 build of the Docker image (needs a host with QEMU/binfmt or an arm64
      builder), and a real scan over the container's Tor on mainnet.
- [ ] `deno task fetch-tor --all` and smoke-test the macOS and Windows Tor bundles (only Linux
      x86_64 has been fetched and run), then `compile` and package each platform; managed Tor
      bootstraps on macOS and Windows.
- [ ] **StartOS package (`splayed-startos`) leftovers:** an aarch64 build (`make arm`), a real icon,
      and a first-run view of the package's README/instructions.

### Test suite

- [ ] Fast unit-level regression for the P2SH-wrapped txid case (the regtest suite is its only
      coverage today).
- [ ] Regtest suite coverage still missing: other m-of-n shapes, reorgs, RBF fee bump, a
      hardware-wallet-style signer, and a CI job (needs Docker and a ~5 minute first build).

## 3. Docs hygiene

- [ ] Contributor docs: how to add a chain profile (the `src/` layout is in
      `docs/dev/architecture.md`).
- [ ] Keep `docs/images/web-ui/` current when the UI changes.

## 4. Features

- [ ] **Explicit chain-specific coins.** Detect coins that are already chain-specific because their
      creating transaction is protected, rather than only "absent elsewhere". Feeds the donor work.
- [ ] UI: show the per-coin plan, verify and broadcast state on the Coins tab.
- [ ] UI: an opt-in screen explaining the donor rules and the on-chain linkage they create.
- [ ] Batch policy: cluster coins already linked on-chain (common-input heuristics) rather than just
      by address.
- [ ] `status --json` and `plan --json` output for scripting.
- [ ] Fee bump for BTC transactions, fan-out transactions, and CPFP of donor or multi-output
      transactions.
- [ ] Air-gapped QR: BBQr (Coldcard Q) and plain base64 QR codes (the `ur:psbt` type is read but not
      written).
- [ ] PSBT v2 (BIP370) input, for signers that only emit v2.
- [ ] Descriptors: Taproot script trees, miniscript, `combo()`.
- [ ] Testnet profiles for rehearsals: testnet4 BLAKE2b (fork at 150,308) and ECX betanet (marker
      499,999,999), each with its own pinned checkpoints.
