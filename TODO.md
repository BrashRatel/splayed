# splayed TODO

Open work only, grouped by kind and ordered by impact within each group. When an item is done, move
it to [docs/dev/todo-archive.md](docs/dev/todo-archive.md) (with what was checked and when) and
delete it here.

## Pre-alpha.2

Released 2026-11-05 (see the [archive](docs/dev/todo-archive.md)). Open:

- [ ] Publish the StartOS package to a registry (community, via Start9's submission process, or a
      self-hosted one) and document the steps in [releasing.md](docs/dev/releasing.md). Guides:
      [host registry administration](https://docs.start9.com/packaging/host-registry-administration.html#packages)
      and [publishing](https://docs.start9.com/packaging/publishing.html).

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

- [ ] Each remaining XBT signer produces 0x21 from our PSBTs, with steps written down: Sparrow
      BLAKE2b build (alone on the Knots node), embit.
- [ ] ECX hardware wallets Trezor and Ledger sign locktime 499,999,998 without complaint and keep
      the locktime and sequences. Record which devices warn or refuse. (Coldcard does.)
- [ ] A real stock hardware wallet signing both the shared and the donor input (XBT donor route).
- [ ] **Scan signed** and **Scan QR** (wallet import) with a Jade, Keystone and Passport. (A
      SeedSigner works, both ways.)
- [ ] Multisig and Taproot PSBTs in Sparrow, Shrike and SeedSigner (the regtest multisig PSBT now
      has `tpub` global xpubs), and on mainnet; 3-of-5 multisig end to end with a SeedSigner.
      (Bitcoin Core, Knots and the eCash node's wallets already sign them on regtest, up to 3-of-5.)

### Backends against real servers

- [ ] Electrum against Fulcrum and electrs: an XBT server patched for 164-byte headers, the
      "transaction not found" text per implementation (`isNotFound`), large-history scripts, and
      reorg status per transaction (unit-tested against a fake server only).
- [ ] Esplora/mempool: `/fee-estimates` format on each default server, the `POST /tx` error format,
      HTTP 429 handling and backoff. (Testing like this already found one real bug: both ECX
      backends answer `{"confirmed":false}` for a txid that was never broadcast, which is fixed in
      `EsploraBackend.txStatus`; see the archive.)
- [ ] Remote node RPC over an onion address, end to end.

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

## 3. Docs hygiene

- [ ] Keep `docs/images/web-ui/` current when the UI changes.

## 4. Features

- [ ] CPFP of donor, BTC and multi-output (fan-out) transactions. (RBF bumps of BTC and fan-out
      transactions are done; see the archive.)
- [ ] Air-gapped QR: BBQr (Coldcard Q) and plain base64 QR codes (the `ur:psbt` type is read but not
      written).
- [ ] PSBT v2 (BIP370) input, for signers that only emit v2.
- [ ] Descriptors: Taproot script trees, miniscript, `combo()`.
- [ ] Testnet profiles for rehearsals: testnet4 BLAKE2b (fork at 150,308) and ECX betanet (marker
      499,999,999), each with its own pinned checkpoints.
