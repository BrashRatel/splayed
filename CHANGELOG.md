# Changelog

All notable changes to Splayed. The first release will be `0.1.0-pre-alpha.1` (not yet tagged); see
[TODO.md](TODO.md) for what gates it. Newest first.

## 0.1.0-pre-alpha.1 (not yet tagged)

### Changed

- **Renamed from forksplit to Splayed.** The command is `splayed`, the config file is
  `splayed.toml`, the data directory is `splayed` (`~/.local/share/splayed` on Linux), and the
  environment variables are now `SPLAYED_DATA_DIR`, `SPLAYED_PROFILE`, `SPLAYED_TOR_SOCKS` and
  `SPLAYED_TOR_BINARY`. Nothing was released under the old name, so there is no migration: move the
  old data directory by hand if you have one. The regtest playground project is now
  `splayed-regtest`, so run `deno task regtest down` on the old checkout first to remove its
  containers.

### Added

- **Pre-alpha packaging.** `SECURITY.md` now has a reporting contact (email, PGP) and a disclosure
  policy; GitHub issue templates for tester reports and bugs (with a link to `SECURITY.md` for
  vulnerabilities); release notes for `0.1.0-pre-alpha.1`; a pre-alpha status line in the README;
  and `scripts/docs_screenshots.ts` to regenerate the Web UI guide images.
- **Role-based docs.** The README is a short overview; the detail lives in `docs/` (user guides, a
  screenshot Web UI guide, transaction and security models, a CLI reference, and developer docs).

- **Air-gapped signing by animated QR.** Each transaction in the web UI has **QR** (plays the
  unsigned PSBT as UR `crypto-psbt` frames) and **Scan signed** (reads the signer's frames through
  the camera and saves the signed PSBT like an upload). The UR codec (`src/core/ur.ts`: bytewords,
  fountain frames, xoshiro chooser) is written here and matches the reference implementation frame
  for frame, including the fountain frames; the decoder takes frames in any order, repeated or
  missing, and skips misread ones. Two small libraries are vendored and checksum-pinned
  (`qrcode-generator` MIT, `jsQR` Apache-2.0). Tried so far: the export (QR button) was scanned and
  signed by a SeedSigner set to regtest. Not yet tried: **Scan signed** with a real camera (browsers
  only allow the camera on `localhost`/`127.0.0.1`), and a Jade.
- **Fee bump: CPFP and dropping inputs.** `bump <plan> --cpfp --fee-rate ecx=N` writes a child that
  spends a stuck split's output so the pair pays that rate (plain signature from the destination
  wallet; the child exists only on its parent's chain). `bump <plan> --tx N --drop txid:vout`
  replaces one transaction of a batch without some of its coins, sized for the smaller transaction.
  Both tested against real nodes; a mutation check confirms the CPFP package rate is what the test
  measures.
- **Real-node checks.** The reject reasons of Core 31, Knots 29.4.1 and eCash are asserted on all
  three nodes, which found one gap: a lower-fee conflicting transaction is reported as "insufficient
  fee" (all three run full RBF), and `verify` now tolerates it on the target chain. A split that
  left the chain and expired from the mempool (mempool-expiry clock trick) is reported by `track`
  and re-sent by `broadcast`.
- **Donors funded elsewhere.** `donor scan` now traces a donor's funding transaction on chain
  (`verified-funding`): accepted when it carries a 0x21 signature (XBT) or an input that leads back
  to a coinbase of that chain or to a split this tool verified; plain-signed funding from shared
  coins stays `unproven` and refused. Unit tests for the tracer, and a real-node scenario (a
  0x21-funded donor is proven and fanned out; a plain-funded one is refused; turning the 0x21
  detection off breaks it).
- **Regtest playground: `donors --chain btc`** mines BTC-only donor coins for the BTC-first route
  (`deno task regtest donors '<descriptor>' --chain btc`); without `--chain` it still mines XBT
  donors.
- **Advanced BTC-first route** (`plan --btc-first --donor txid:vout`, `dest set btc`). The BTC copy
  is split first, protected by a BTC-only donor; ECX keeps its locktime; XBT is signed with plain
  `SIGHASH_ALL` and carries no replay protection, so `broadcast` holds it back until its coin is
  spent and confirmed on BTC and ECX and the user's own nodes reject it. Donors now have a home
  chain (XBT or BTC) and `donor scan`, `donor fanout` and the Donors tab handle both. Tested against
  real nodes, including a check that turning the gate off breaks the scenario.
- **Donor fan-out** (`donor fanout --donor txid:vout --outputs N [--value SATS]`): splits each
  chosen donor into smaller donors of the donor wallet, one transaction per donor. The new donors
  count as XBT-only once the fan-out is verified and broadcast. Plan transactions can now have
  several outputs (`outputs`). Tested against real nodes.
- **Web UI: Advanced toggle and Donors tab.** Import and scan the donor wallet, see each donor
  coin's origin and why it is or isn't usable, tick donors, and fan them out or plan the XBT splits
  with them. The plans view marks donor transactions and fan-outs.

- **Advanced XBT donor route.** `donor import|list|forget|scan|show` manage a donor wallet, and
  `plan --donor txid:vout` builds XBT splits that spend one XBT-only donor next to the shared coins,
  so they can be signed with plain `SIGHASH_ALL` by a stock hardware wallet. A donor must be absent
  from BTC and ECX and come from an XBT coinbase or a split this tool verified; anything else is
  refused. `verify` requires plain signatures that commit to the donor, and `broadcast` re-checks
  the donor against BTC and ECX first. Tested against real nodes, including a mutation check that
  the "absent elsewhere" test is what keeps a shared coin from being used as a donor.
  `deno task regtest donors` creates XBT-only donors in the playground.

- **Regtest playground UI: mining buttons.** The plans page shows the three chains' heights and
  "Mine 1 / Mine 6" per chain or for all, then tracks the newest broadcast plan. The endpoints exist
  only when the playground starts the UI; the real `splayed ui` does not have them.
- **Web UI: an uploaded signed file is now visible** in the plan table ("✓ received", the file name,
  and "signed file uploaded: press Verify") and in a short message at the top of the page.

- **Web UI: fee bump and reorg alerts.** Each broadcast, unconfirmed split has a "Fee bump…" button
  (and the plan has one for all of them); it asks for a rate and runs `bump`. The plans view shows
  the latest reorg alert for each split, "replaced by plan …" and "replaces …".
- **Electrum `txStatus`**, so `track` sees a block change through Electrum servers too. It reads the
  history of the transaction's first output script.

- **Regtest playground** (`deno task regtest`): a long-lived environment with stable ports for
  trying Splayed by hand. `up` starts the three nodes and mines the shared history, `fund` puts
  coins on your own wallet (a descriptor or an address) on all three chains before the fork, `fork`
  separates the chains, and `ui` runs the web UI against them. `mine`, `reorg`, `check` (asks every
  node about a plan's signed transactions, independent of Splayed), `status`, `stop` and `down`
  complete it. It was exercised end to end through the UI's HTTP API; Sparrow and Shrike themselves
  have not been tried yet.
- **Regtest address network for test profiles.** A regtest profile accepts the `tpub`, `upub` and
  `vpub` keys wallets export and shows `bcrt1` addresses, so addresses can be compared with a
  regtest wallet. Mainnet is unchanged and still refuses testnet keys. `import` says when it stores
  a key as the equivalent xpub.
- **`bump`: RBF fee bump.** `splayed bump <plan>` writes a replacement plan that spends the same
  inputs to the same destination at a higher fee, built from the original's own unsigned PSBT so the
  ECX marker and the 0x21 request carry over. It enforces BIP125 (old fee plus 1 sat/vB for the new
  size), refuses confirmed, conflicting and already-replaced transactions, and the result is
  verified and broadcast like any plan. `broadcast` knows a replacement's inputs are legitimately
  spent by the original in the mempool, and marks the original `replaced`; `track` shows it.
- **Reorg handling in `track`.** It remembers the block a split confirmed in and reports a re-mine
  in another block, a return to the mempool, a split that left the chain, and an input spent by a
  different transaction. Exit status 1 and a loud warning in each case; a dropped split can be
  broadcast again, and a conflicting one is marked and never re-sent. `scan` warns when a spend it
  saw before disappears or changes.
- `txStatus` on the node-RPC and Esplora backends (confirmed with block hash, mempool, absent).
- Regtest scenarios for both features against real nodes, including reorgs forced with
  `invalidateblock`, a fee bump broadcast after a reorg, and an outside spend of a split's input.
  Unit tests cover the replacement rules, the reorg classification and the scan comparison.
- **Regtest integration suite** (`deno task test:integration`, `tests/integration/`). Real Bitcoin
  Core 31.0, Bitcoin Knots 29.4.1 (BLAKE2b from regtest height 110) and an eCash node built from
  `ecash-com/bitcoin` commit `c8474e0b` (reports eCash v1.2.0) run in Docker. Splayed's CLI runs
  against their JSON-RPC: init, import, scan, plan, verify, broadcast, track and rescan, for eight
  wallets (`pkh`, `wpkh`, `sh(wpkh)`, `tr` key path, 2-of-3 `sh`, `wsh` and `sh(wsh)` `sortedmulti`,
  and a mixed wallet whose single `--batch all` transaction per fork spends all seven script types).
  It also checks that a node on the wrong chain is rejected, that XBT signatures without 0x21 fail
  `verify`, that a multisig input below its threshold fails `verify`, and that each confirmed fork
  split is rejected by the other two nodes. Every run uses a random Compose project with fresh
  volumes and loopback-only ports.
- `registerProfileForTesting()` in `src/core/profiles.ts`, so tests can register a `regtest-*`
  profile. It is not reachable from the CLI, the environment, the config file or the UI.
- Pinned Tor Browser 16.0 (tor 0.4.9.15) in `vendor/tor-manifest.json`. The release signature was
  verified against the Tor Browser Developers key (`EF6E286DDA85EA2A4BA7DE684E2C6E8793298290`). Only
  the Linux x86_64 bundle has been fetched and run.

### Fixed

- **QR export drew nothing in the browser.** `qr.js` called `.json()` on the result of the UI's
  `api()` helper, which already returns parsed JSON, so the call threw. A test now runs the browser
  module against a stub DOM using the real `api()` contract; it fails on the old code.
- **Plan form failed with "No fee estimate from the ECX backend"** in the regtest playground
  (regtest nodes have no estimates). In the playground the fee boxes now start at 2 sat/vB;
  elsewhere "auto" is unchanged.
- **Donors tab only described the XBT route.** It now explains both donor routes (XBT donors and the
  BTC-first route), and its fee boxes are labelled "Fee" since they apply to either chain.
- `verify` treated "insufficient fee" (what Core, Knots and eCash say for a lower-fee conflicting
  transaction) as a rejection by the user's own node; it is now tolerated on the target chain like
  the other "already known / conflicting" cases.
- The reorg warning said a split's "depth restarted" even when it stayed at the same height; it now
  says it is in a different block.
- `track` could not see confirmations through node RPC: a confirmed spend with no detail was read as
  "mempool" forever. It now asks the node about the transaction itself, and says `unknown` when a
  backend cannot tell.
- `verify` rejected every correctly signed transaction that spends a P2SH-wrapped segwit input
  (`sh(wpkh)` and `sh(wsh(...))`) with "Final txid differs from the plan". Those inputs carry the
  redeem script in `scriptSig`, which is part of the txid, so only native segwit and Taproot inputs
  keep the unsigned txid. The check now applies only to those. Found by the multisig runs of the
  regtest suite.
- The XBT node-RPC identity check never matched a real Knots node. Knots reports the fork at the top
  level of the `getdeploymentinfo` result (`{"blake2b": {"height", "active"}}`), not under
  `deployments`, so the check failed closed against genuine Knots. Found by the regtest suite.

### Changed

- `deno lint` and `deno fmt` skip `src/ui/static/vendor/` (the pinned third-party QR libraries).
- TODO: ticked the donor pool, the fan-out and the playground signer checks (Sparrow and Shrike were
  run by the project owner); added the real-signer and camera follow-ups for QR.
- TODO and README now name eCash v1.2.0, the version the pinned node commit reports (they said
  v1.1.0).
- Default endpoints probed through Tor: both onion addresses match the operators' `Onion-Location`
  headers, and both serve the REST API under `/api`.

## Docs and UI polish (2026-10-31)

- Describe Splayed as keyless (your wallet signs) rather than watch-only.
- TODO.md with release blockers and open work, SECURITY.md, project layout in the README, and a CI
  workflow (fmt, lint, type-check, tests).
- UI: dark mode by default, with a light toggle that is remembered per browser.
- Tor: a failed bootstrap is not retried for every chain within 30 seconds.

## Milestone 4: managed Tor and local web UI (2026-10-31)

- Tor manager with `auto`, `managed` and `system` modes. Splayed's own Tor uses `IsolateSOCKSAuth`,
  `SafeSocks 1` and `__OwningControllerProcess`, and starts only when a backend about to be
  contacted needs it.
- `fetch-tor` and `update-tor-manifest`: GPG-verified, SHA-256-pinned Tor Expert Bundles.
- Local web UI: loopback only, token in the URL fragment, Host, Origin and Content-Type checks,
  strict CSP. It runs the same CLI commands, with prompts shown as dialogs, and supports PSBT
  download and upload.

## Milestone 3: verify, broadcast, track (2026-10-31)

- `verify`: the transaction must match the plan; replay markers are checked; every signature is
  verified against its own chain's digest (legacy, BIP143 and BIP341 for ECX; the Knots unified
  digest for XBT, with 166 vendored vectors, and every XBT signature must be 0x21). The final
  transaction is rebuilt canonically. `testmempoolaccept` runs on your own nodes, and any other
  chain accepting fails verification.
- `broadcast`: re-verifies, re-checks backend identity and that inputs are unspent, saves progress
  before sending, uses a separate circuit per transaction and sends the TEST FIRST transaction
  first. Esplora, Electrum and RPC backends are supported.
- `track` reports confirmation depth.
- Adding a backend replaces that chain's profile default, identity checks stop at the first backend
  that passes, and `init` asks before contacting anything.

## Milestone 2: Electrum, destinations, PSBT planner (2026-10-31)

- Electrum backend over `ssl://` and `tcp://` with the same Tor or direct routing policy and
  optional certificate pinning. Identity uses the next header's prev-hash, so it works for XBT's
  164-byte headers.
- `dest` for fork destinations and `plan` for the guided route: live re-check, verified previous
  transactions, batching policies, fee handling and reserved destination addresses.
- BIP174 PSBT encoder and decoder, including `PSBT_IN_SIGHASH_TYPE = 0x21`.
- RPC: ranges are omitted for unranged descriptors.

## Milestone 1: read-only core (2026-10-31)

- Network profiles with pinned checkpoints, Tor-routed transport, Esplora and node-RPC backends,
  descriptor parsing (`pkh`, `wpkh`, `sh(wpkh)`, `tr` key path, `wsh` and `sh(wsh)` with
  `multi`/`sortedmulti`), `scan` and `status`.
- Coin classification: `shared`, `separated`, `pending`, `unverified` and `spent`.
