# Dev archive: completed work

Finished items moved out of [TODO.md](../../TODO.md), newest first. When you tick something off the
TODO, move it here (keep the evidence: what was checked, when, against what) and delete it from the
TODO.

## Features sprint after pre-alpha.2 (2026-11-11, unreleased)

- **Explicit chain-specific coins (2026-11-11):** `scan` proves a single-chain coin created after
  the forks can't exist elsewhere from its creating transaction (`src/core/chain_specific.ts`): an
  XBT `0x21` signature, the ECX locktime marker, a post-fork coinbase (BIP34 height against the
  per-pair shared heights), this tool's own protected sends, or an input whose creator is ruled out
  on that chain (several inputs may share the work). Bounded (4 generations, 12 fetches a coin, 200
  a scan); pre-fork coins are skipped without fetching. A proof is ignored when another chain
  reports the coin unspent or spent. Proven coins are `separated` (shown as "XBT only" etc.) even
  with an `unknown` or `gone` answer elsewhere, and donor scans take their provenance from it.
  _Checked:_ `tests/chain_specific_test.ts` (each rule, the height boundaries, inheritance, the
  search limit, contradiction, and an end-to-end scan on fake Esplora chains with one chain's server
  failing for the coin), plus a donor test. Not yet run against real chains.

## 0.1.0-pre-alpha.2 release (2026-11-05)

- **Released** as
  [`v0.1.0-pre-alpha.2`](https://github.com/BrashRatel/splayed/releases/tag/v0.1.0-pre-alpha.2) (PR
  #3 merged with CI green: unit tests, CodeQL, regtest).
  - _Sensitive information:_ tree and history since the last tag searched again; only public test
    vectors, the public security contact and public mempool onion hosts. No screenshot changed.
  - _StartOS package `0.1.0:7`_ (`splayed-startos` PR #1), built in the workspace clone from the
    clean merged commit. Installed on a StartOS server: x86_64 as an update over the previous build
    (service started, data and keys intact), aarch64 on an arm device (no synced node, so Tor and
    the default servers; network confirmed). Testing found a real bug, fixed in `0.1.0:7`: the
    "Create RPC Credentials" task came back on every update and failed with "user already exists";
    the store now remembers the user it was issued for and a migration marks an existing login done.
  - _Files:_ five platform archives and both `.s9pk`, `SHA256SUMS` signed with the `SECURITY.md` key
    (card subkey `245E7F8F43A0FBFA`). Re-downloaded from the release: signature good, 7 of 7 sums
    match.
  - _Process:_ the ordered checklist is in [releasing.md](releasing.md#release-checklist). Not done:
    registry publication (still in the TODO).

## Completed after the pre-alpha tag (2026-11-04 to 2026-11-05)

- **Node RPC paths and real signers on regtest (2026-11-05):**
  - _Lost reply, own spend, conflict, with and without `txindex`_ (`tests/integration/rpc_paths.ts`,
    six steps). Without `txindex` is the same real nodes behind a test transport that answers as a
    node started without it would (`getindexinfo` empty, `getrawtransaction` only for the mempool,
    with Core's error); a lost reply is the transport passing the send to the node and then failing
    the answer. Results: a send whose reply was lost is found in the mempool or, once mined, by txid
    (or, without `txindex`, by its own unspent output) and never sent twice; when the output has
    been moved on and nothing can be seen, it is held ("this backend can't tell"), not sent, not
    called a conflict; the tool's own fee bump shows as `REPLACED` in both modes; a stranger's
    confirmed spend of the coin means nothing is sent and the entry is a conflict, naming the
    spender only with `txindex`. Making every failure count as a refusal fails the lost-reply steps.
  - _Real signers:_ the nodes' own wallets (Bitcoin Core, the eCash node, Bitcoin Knots) sign
    splayed's PSBTs from scratch, one wallet per cosigner holding only its key, for every script
    kind and every quorum up to 3-of-5; `verify` accepts them and the nodes accept the transactions.
    Knots signs the XBT PSBTs with 0x21 using `walletprocesspsbt` at its default sighash type (the
    PSBT carries the request); `ALL|UNIFIED` is accepted, `UNIFIED` alone is not a valid spelling,
    and `ALL|ANYONECANPAY` is refused as not matching the PSBT. This answers the open question under
    the XBT signer steps above. Written up in `docs/user/signers.md`.
  - _Two weak spots found in the new tests themselves, both fixed:_ `verify` exits 0 for a
    transaction it has no signed file for, so the node-wallet step first looked like it passed with
    signing switched off; and its cleanup missed the signed files in the `ecx/` and `xbt/` folders.
    It now deletes every signed file and the progress file, and requires every transaction to be
    reported VERIFIED (the accept step does too). With signing off it fails: "4 transaction(s)
    failed verification".
  - _Result:_ 209 steps pass in about 4 minutes with warm caches.
  - _Observation, not changed:_ without `txindex`, when the held transaction is not the TEST FIRST
    one, `broadcast` prints "Nothing to broadcast right now" with the reason and exits 0.

- **Regtest suite built out (2026-11-05):**
  - _More quorum shapes:_ 3-of-5 `wsh`, 2-of-2 `sh(wsh)` and 3-of-4 `sh` join the three 2-of-3
    wallets; `multiSigPart` takes `m`.
  - _Hardware-style signer:_ `hardwareStyleSign` (see `docs/dev/testing.md`) signs ECX, one device
    per master key, each into its own file. splayed's PSBTs satisfied it on every script kind, and
    each refusal (unknown destination, high fee, foreign fingerprint, missing previous transaction)
    is checked to fire.
  - _Size and fee against real nodes:_ every mined transaction's planned vsize is at least the real
    one, within 3% + 8 vbytes of it, and the rate paid is at least the rate asked for. New unit test
    `tests/vsize_estimate_test.ts` does the same offline for every script kind and m-of-n up to
    11-of-15: the estimator never undershoots, and is at most 16 vbytes over on a 1,398-vbyte spend.
    Making the planner underestimate signatures fails both.
  - _CI:_ a `regtest` job in `.github/workflows/ci.yml` runs the suite on pull requests, on `main`
    and by hand (not run on GitHub yet).
  - _Result:_ 190 steps pass in about 3 minutes with warm caches (135 steps before); unit suite 287.
    Reorgs and RBF fee bump were already covered (the old TODO listed them by mistake).
  - _Dev loop:_ `SPLAYED_IT_WALLETS` and `SPLAYED_IT_WALLETS_ONLY` run a few wallets in about a
    minute.

- **Docs review (2026-11-05):**
  - _Sensitive information:_ searched every tracked file (186) and the whole git history for
    personal paths, email addresses, private keys (`xprv`/WIF/PEM), secret-looking assignments,
    secret-type file names, xpubs, addresses, onion hosts, IPs and other hosts, and the PNG metadata
    of all 28 screenshots. Nothing found beyond the public security contact in `SECURITY.md`. Every
    xpub, address and the one `xprv` in the tests is a public vector (BIP32 test vector 1, the BIP39
    and BIP84 "abandon ... about" vectors, the Hummingbird UR examples) or comes from the throwaway
    seeds of `tests/fixtures/seedsigner/generate.py`; nothing from a real wallet. The screenshots
    come from in-memory fake chains.
  - _Accuracy:_ all 198 relative links and image references resolve; all 17 CLI commands are in
    `--help` and `docs/reference/cli.md`, every option in the code is in `cli.md`, and every splayed
    flag in the docs exists; the checkpoint hashes (short form), fork heights and `--xbt-signer`
    names in the docs match `profiles.ts` and `planner.ts`; every external URL answered 200 except
    the Start9 guide, whose path had moved (fixed in the TODO).
  - _Fixed or added:_ the "only Linux x86_64 has been run" claims (README, `releasing.md`); notes on
    pruned nodes and JSON-RPC 2.0 (`network-and-privacy.md`) and on reaching a node on the Docker
    host (`docker.md`), all from what the real nodes did.

- **Real mainnet scan over the Docker container's Tor (2026-11-05, project owner):** the image built
  from this branch, a fresh data volume, the default public servers reached through the Tor started
  inside the container. The identity check passed, the scan took about 2 minutes, and the coins
  matched what was expected and showed as separated. (The arm64 image has still only started under
  emulation; see the Linux aarch64 item in the TODO.)

- **Unit regression for the P2SH-wrapped txid case (2026-11-05):** `tests/sigcheck_test.ts` now runs
  `verifySigned` on a one-input fixture of each script kind. `sh(wpkh)`, `sh(wsh(multi))` and `pkh`
  spends (which carry a scriptSig, so the txid changes on signing) must verify without the "Final
  txid differs from the plan" error; `wpkh`, `wsh(multi)` and `tr` must keep their planned txid and
  fail when it differs. The fixture gained an `sh-wsh-ms` kind, which also joined the finalize round
  trip. Checked by breaking the guard in `execute.ts` both ways: always comparing (the original bug)
  fails 4 tests, never comparing fails 3; the source was restored afterwards. Test-only, so no
  CHANGELOG entry.

- **Tor bundle for Linux aarch64 (2026-11-05):** Tor Browser 16.0 publishes
  `tor-expert-bundle-linux-aarch64-16.0.tar.gz`. `update-tor-manifest 16.0` (GPG signature checked
  against the Tor Browser Developers key) pinned it and left the other four hashes unchanged;
  `fetch-tor --all` downloaded it and matched the hash; `package_release.ts` now bundles it
  (`linux-aarch64` added to the three scripts). Checked: the extracted `tor` is an ARM aarch64 ELF
  with the same needed libraries as the x86_64 one, those libraries sit beside it, and splayed
  already points `LD_LIBRARY_PATH` at that directory (`src/net/tor.ts`); the packaged archive holds
  `vendor/tor/linux-aarch64/`. Not run: this machine can't execute arm64 binaries without QEMU's
  binfmt handlers, and no arm64 host was available (see TODO).

- **Windows and macOS launchers and READMEs (2026-11-05):** `packaging/windows/` and
  `packaging/macos/` hold a double-click launcher (`Start splayed.cmd`, `Start splayed.command`;
  both run `splayed ui --open`) and a `README.txt` per platform, and `scripts/package_release.ts`
  puts them in those archives instead of the generic README (new `--only` flag to build some
  platforms). Checked by building both bundles from Linux: files present, version filled in, CRLF
  throughout the Windows files, `Start splayed.command` still executable after extracting the tar
  and valid `sh`, the Windows binary a PE executable and the macOS one a Mach-O arm64, each with its
  pinned Tor. The Windows zip step couldn't run here (no `zip` installed), so the Windows folder was
  inspected before archiving. Not run on a real Windows or macOS machine (see TODO). Options
  weighed: starting the UI when the binary runs with no arguments (rejected for now: it changes what
  plain `splayed` does for CLI users) and a macOS app wrapper (more work, and needs signing to avoid
  Gatekeeper).

- **Windows x86_64 binary on mainnet (2026-11-04, tester report, issue #1):** the pre-alpha release
  binary with its bundled Tor, default public servers, web UI. A full ECX + XBT split of a wpkh
  wallet: ECX signed on a Coldcard (latest firmware, air-gapped `.psbt`; it accepted locktime
  499,999,998 and kept the sequences), XBT on a SeedSigner with the unified-sighash firmware
  (animated QR). Verify passed for both, broadcast, tracked to confirmation, rescanned: the BTC copy
  showed separated. No errors. (Also covers the TODO's "run the Windows build on a real machine" and
  "Coldcard signs the ECX locktime".) Left open: macOS, and an easier launcher for the Windows zip,
  which the tester asked for.
- **StartOS x86_64 package on mainnet (2026-11-04, tester report, issue #2):** BTC from the local
  Bitcoin Core node on StartOS (identity check passed), XBT and ECX from the default servers over
  the StartOS Tor service. A full ECX + XBT split of a wpkh single-sig wallet: ECX signed in Sparrow
  and XBT in Shrike (both `.psbt` files, the first mainnet use of Shrike for XBT), verified,
  broadcast, tracked, rescanned: the BTC copy showed separated. No errors. The package was
  `v0.1.0:5`, the latest; the aarch64 build has still not run on an arm device.
- **Checkpoint hashes against real nodes (2026-11-05):** an eCash node built from the pinned commit
  `c8474e0` (tag `ecash-v1.2.0-core32.1`, reports `/eCash Satoshi:1.2.0(Bitcoin Core 32.1.0)/`) and
  a bitcoinpr node, both fully synced, both pruned, no `txindex`. `config backend detect` matched
  ECX at 973,728 and 974,017 and BTC at 961,640 and 973,728, and rejected each node on the other
  chains. (XBT has no node of its own here, so its checkpoints are still confirmed on explorers
  only.)
- **Node RPC against real pruned nodes (2026-11-05):** `getblockcount`, `getblockhash`, `gettxout`
  (279 of 376 outputs of the tip block unspent, values matching the block), `scantxoutset` (79 to
  111 s, over a ranged descriptor and an address), `testmempoolaccept` and `estimatesmartfee` all
  answer; `getrawtransaction` of a confirmed transaction fails with -5 without `txindex`, as the
  docs say. The ECX node had no fee estimate right after syncing (`--fee-rate` covers it). bitcoinpr
  accepts only JSON-RPC 2.0, so splayed now sends `"2.0"` (CHANGELOG, tests in `tests/rpc_test.ts`).
  Not run: `sendrawtransaction` on a real split through either node. The regtest integration suite
  (`deno task test:integration`: Core 31.0, Knots 29.4.1.knots20260508 and eCash v1.2.0 in Docker)
  also passes with the 2.0 change: 135 steps in 10 minutes, covering scan, verify, broadcast, track,
  rescan, fee bump (drop and CPFP), reorg re-send and reject-reason classification.

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
- **Pre-merge review of the `ui-deploy` branch (2026-11-03):** the web UI server and jobs (Host and
  Origin checks, constant-time token compare, throttle, CSP, fixed static map, plan-id validation,
  command allowlist), the `ui` command's listen/token-file/allowed-host handling and the Docker and
  StartOS wiring, UR/CBOR parsing bounds, the wallet-import builders, `wipe`, plan archive and
  delete, the broadcast send loop, depth and spender logic, `assessReorg` and all of `cmdTrack`,
  `cmdBump` (replacements keep the locktime, sequences and PSBT metadata, so replay protection
  carries through; fee cap, dust and relay-minimum guards), the scan changes, the PSBT merge, and
  the new UI scripts (no `innerHTML`/`eval`; the page never passes `--yes` and `--all` only behind a
  confirmation). Two real findings, both fixed (below); the rest held up. Unit (252) and integration
  (135 steps, real Core, Knots and eCash) suites pass.
- **`track` skipped a chain with no usable backend silently (2026-11-03, found in the pre-merge
  review):** `cmdTrack` ignored the "no backend passed" result, so an unreachable chain showed `?`
  and the run exited 0 with the "run scan" advice. It now reports the chain and exits 1. Every other
  caller of `verifiedBackendsFor` already refused or threw. Test in
  `tests/track_unreachable_test.ts`.
- **A 5xx/408 broadcast reply was recorded as an explicit rejection (2026-11-03, found in the
  pre-merge review):** a gateway error in front of an Esplora node can hide a send that went
  through, yet `broadcast` held it as "rejected" and the coin counted as unsent.
  `isExplicitRejection` (`src/backends/types.ts`) now says what counts as the server's own refusal:
  node RPC errors (HTTP 500 with an RPC code, except warm-up codes -9/-10/-28), Electrum error
  replies, and Esplora HTTP 400. Anything else is "unknown", which `broadcast` re-checks on the
  chain before sending again. Tests in `tests/broadcast_failures_test.ts`. Findings dropped as not
  issues: `wipe` forgetting destination indexes (wiping is meant to forget everything), its warning
  skipping unreadable plans (the plan is gone after a wipe anyway), and the global wrong-token
  throttle (StartOS is used on a trusted network).
- **Platform builds (2026-11-03):** multi-arch Docker image (`buildx`, amd64 and arm64; the arm64
  image started under QEMU and reports `aarch64`); `fetch-tor --all` (all four pinned bundles,
  hashes matched, layout matches `src/net/tor.ts`); cross-compiled binaries for Linux
  x86_64/aarch64, macOS arm64/x86_64 and Windows x86_64 and a one-command packager
  (`deno task package`); the StartOS package `v0.1.0:4` built for x86_64 and aarch64
  (`splayed_x86_64.s9pk`, `splayed_aarch64.s9pk`, 63 MB each) with a new icon traced from
  `docs/images/logo.png`. Not run on the target platforms (see TODO).
- **Multisig PSBTs on a non-mainnet network: wallets refused the global xpubs (2026-11-03):** found
  2026-11-02 in the regtest session (Shrike: "provided xpub extended key invalid on configured
  regtest network"; Sparrow couldn't open the PSBT). Fixed by writing the network's own version
  bytes (`tpub`, `043587cf`) for regtest/testnet profiles (`xpubVersion` in `AddressNetwork`,
  `src/core/descriptors.ts`); mainnet unchanged. Research on what others do: BIP174 only says "78
  byte serialized extended public key as defined by BIP 32" (so the network's own bytes). Sparrow's
  `ExtendedKey` writes `Network.get().getXpubHeader()` and rejects another network's header when
  reading (that is Shrike's message); rust-bitcoin's `Xpub` encodes `0488B21E` for
  `NetworkKind::Main` and `043587CF` for `Test` (testnet, signet and regtest, which BDK follows);
  Bitcoin Core, embit, HWI and Coldcard keep the version bytes as given and don't check them on
  read. So `tpub` works everywhere, and mainnet `xpub` only works with the permissive readers. Left
  out instead? Rejected: signers and coordinators use the global xpubs to match cosigners. Test in
  `tests/descriptors_test.ts`. Not yet re-run against Sparrow, Shrike or the Docker integration
  suite (see TODO, signers).
- **Locked inputs (2026-11-03):** timelocked scripts (CLTV/CSV) were unsupported but nothing said
  so. They can only reach splayed through a descriptor (the scan finds coins by descriptor, and the
  supported forms are standard single-key and multi/sortedmulti scripts), so `import` now refuses
  `after()`, `older()` and every miniscript fragment or wrapper with a plain explanation. The
  descriptor parser also now reads function names with underscores (`and_v`) properly. Tests in
  `tests/descriptors_test.ts`; documented in `docs/user/guide.md`.
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
