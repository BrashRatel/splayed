# splayed TODO

Open work only, grouped by kind and ordered by impact within each group. When an item is done, move
it to [docs/dev/todo-archive.md](docs/dev/todo-archive.md) (with what was checked and when) and
delete it here.

## Pre-alpha.2

The next release. Small, low-risk work that can ship together. Already in (see the CHANGELOG's
Unreleased section): node RPC backends send JSON-RPC 2.0, so a 2.0-only node such as bitcoinpr
works.

- [ ] Fast unit-level regression for the P2SH-wrapped txid case (the regtest suite is its only
      coverage today).
- [ ] A real scan over the Docker container's Tor on mainnet with a real wallet (the multi-arch
      image builds and the arm64 image starts under emulation; no real arm64 host has run it).
- [ ] **Docs review:** an accuracy pass over every doc (commands, flags, versions, screenshots and
      links against the code as it is now), and a search of the repo and docs for sensitive
      information (keys, tokens, passwords, personal paths, hostnames, addresses, descriptors).
- [ ] **StartOS package:** rebuild the `splayed-startos` s9pk for the release, sign it, and publish
      it to the community registry. Guide:
      [host registry administration](https://docs.start9.com/packaging/0.4.0.x/host-registry-administration.html).
      (The build steps are in [docs/dev/releasing.md](docs/dev/releasing.md).)
- [ ] Cut the release: version bump, release notes, the CHANGELOG's Unreleased heading, packages and
      signed `SHA256SUMS` (see [docs/dev/releasing.md](docs/dev/releasing.md)).

## 1. Bugs and issues

No known high- or medium-impact bugs are open. Highest impact first:

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

### Signers

- [ ] Each remaining XBT signer produces 0x21 from our PSBTs, with steps written down: Bitcoin
      Knots, Sparrow BLAKE2b build (alone on the Knots node), embit.
- [ ] ECX hardware wallets Trezor and Ledger sign locktime 499,999,998 without complaint and keep
      the locktime and sequences. Record which devices warn or refuse. (Coldcard does.)
- [ ] A real stock hardware wallet signing both the shared and the donor input (XBT donor route).
- [ ] **Scan signed** and **Scan QR** (wallet import) with a Jade, Keystone and Passport. (A
      SeedSigner works, both ways.)
- [ ] Multisig and Taproot PSBTs with real signers (re-check the regtest multisig PSBT, now with
      `tpub` global xpubs, in Sparrow, Shrike, SeedSigner and Bitcoin Core, and on mainnet); 3-of-5
      multisig end to end with a SeedSigner and on the regtest chains (tested through the UI API
      with fake chains only).

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

### Platforms

- [ ] Run the macOS (arm64 and x86_64) builds from `scripts/package_release.ts` on real machines,
      with their bundled Tor: the binary starts, managed Tor bootstraps, and a scan works. They are
      cross-compiled and the Tor bundles are hash-checked, but nothing has been run there. Try the
      new `Start splayed.command` and README steps (Gatekeeper) there, and `Start splayed.cmd` on
      Windows.
- [ ] Run the Linux aarch64 archive on a real arm64 host: its bundled `tor` starts and bootstraps
      and a scan works (so far only checked statically: right architecture, libraries beside it).
- [ ] **StartOS package (`splayed-startos`) `v0.1.0:5`:** run the aarch64 build on an arm device if
      one is available (x86_64 is done).

### Test suite

- [ ] Regtest suite coverage still missing: other m-of-n shapes, reorgs, RBF fee bump, a
      hardware-wallet-style signer, and a CI job (needs Docker and a ~5 minute first build).

## 3. Docs hygiene

- [ ] Keep `docs/images/web-ui/` current when the UI changes.

## 4. Features

- [ ] **Explicit chain-specific coins.** Detect coins that are already chain-specific because their
      creating transaction is protected, rather than only "absent elsewhere". Feeds the donor work.
- [ ] UI: show the per-coin plan, verify and broadcast state on the Coins tab.
- [ ] UI: an opt-in screen explaining the donor rules and the on-chain linkage they create.
- [ ] Batch policy: cluster coins already linked on-chain (common-input heuristics) rather than just
      by address.
- [ ] Fee bump for BTC transactions, fan-out transactions, and CPFP of donor or multi-output
      transactions.
- [ ] Air-gapped QR: BBQr (Coldcard Q) and plain base64 QR codes (the `ur:psbt` type is read but not
      written).
- [ ] PSBT v2 (BIP370) input, for signers that only emit v2.
- [ ] Descriptors: Taproot script trees, miniscript, `combo()`.
- [ ] Testnet profiles for rehearsals: testnet4 BLAKE2b (fork at 150,308) and ECX betanet (marker
      499,999,999), each with its own pinned checkpoints.
