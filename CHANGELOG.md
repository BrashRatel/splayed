# Changelog

All notable changes to splayed. See [TODO.md](TODO.md) for what's still open. Newest first.

## Unreleased

### Added

- **`splayed wipe` and a Burn history button** in the web UI header (next to the theme button, which
  now reads Burn eyes / Go back): forgets the wallet, destinations, scan results and all plans, and
  resets the network confirmation, keeping the network settings and any servers you added. It asks
  first (No is the default), warns about sent transactions that aren't confirmed yet, and with
  `--yes` refuses in that case unless `--force`.

### Changed

- The header's theme button now reads **Burn eyes** (switch to light) and **Go back** (switch to
  dark). The new **Burn history** button next to it looks the same.
- `deno task regtest` runs with `--allow-sys=hostname,networkInterfaces`; without it `regtest ui`
  (LAN mode) crashed on `Deno.hostname()`.

### Fixed

- **A bare 32-byte hex key in a descriptor is refused** (it was accepted as an x-only key in
  `tr()`). It looks the same as a raw private key, so a pasted secret wasn't recognised as one. Use
  an xpub or a 33-byte compressed public key.

- **Multisig signing:** a second cosigner's signed PSBT replaced the first one's instead of adding
  to it, so a 2-of-3 could never reach 2 signatures. Uploads (file or QR) for a transaction that
  already has a signed PSBT are now merged (BIP174 combine), the plans list shows "1 of 2
  signatures", and `splayed verify` combines several signed files for one transaction. Verify still
  refuses until enough signatures are present.

- **Real-node regtest scenarios** (`deno task test:integration`): two assertions had gone stale
  against the reworded conflict text and the quiet recovery of a dropped split. All 135 steps pass
  on real Core, Knots and eCash nodes.
- A 3-of-5 multisig (built from five cosigner keys like the QR import does, signed by cosigners 5, 2
  and 4) is tested end to end through the UI API: the count goes 1, 2, 3 of 3 and verify passes only
  at 3.
- QR windows (show PSBT, scan signed PSBT, wallet import) close on a click outside the box.

### Docs

- Docker, StartOS and `wipe`: see [docs/user/docker.md](docs/user/docker.md), the
  [CLI reference](docs/reference/cli.md) and the Web UI guide. `DEMO_LAN=1 deno task demo-ui` serves
  the fake-chain demo on the LAN (random token, allowed hosts), for trying the UI from another
  machine.
- The Web UI guide and its screenshots are regenerated for the current UI (26 screens: setup guide,
  scan settings, progress boxes, QR multisig import, new shared coins, coin picker, TEST FIRST
  question, DROPPED alert, archived plans). `scripts/docs_screenshots.ts` pins Playwright and takes
  `SPLAYED_SHOTS_CHROMIUM` for an existing browser.

### StartOS package (separate repo)

[`BrashRatel/splayed-startos`](https://github.com/BrashRatel/splayed-startos) packs this branch for
StartOS (SDK 3.1.1, x86_64 and aarch64). It is at `v0.1.0:3`: the Bitcoin node is switched on at
first install when one is already installed, and its check retries every 20 s until the node answers
(no restart after the RPC-login task); a **Burn history** action runs `splayed wipe`. Tested on an
x86 StartOS 0.4.1 device: Web UI and token, the node and its retry loop, **Burn history**, a scan
over Tor, and backup and restore all work. Still open: an aarch64 build, a real icon and a first-run
view of the package's instructions.

### Added (Phase 4)

- **Docker image** (`docker/Dockerfile`, `docker/compose.yml`, `docs/user/docker.md`):
  - runs the web UI in proxied mode or any CLI command;
  - non-root, read-only root filesystem, data in a volume;
  - the entrypoint creates the access token on first start;
  - Tor from Debian's signed repository, started by splayed inside the container;
  - a variant with Tor in its own container (`docker/compose.tor.yml`), for amd64 and arm64.
- `SPLAYED_TOR_MODE` environment variable (`auto` | `managed` | `system`).

### Added (Phase 3)

- **Web UI behind another server** (`ui --listen HOST:PORT --allowed-host NAME --token-file PATH`,
  and the `SPLAYED_UI_*` environment variables): for Docker, StartOS or a reverse proxy.
  - It answers only to the allowed Host names, and write requests need a matching `Origin`.
  - The access token is read from a file (`ui --new-token-file` makes one) and entered on a sign-in
    screen, kept for that tab only.
  - Wrong tokens are throttled.
  - It refuses to listen beyond loopback without allowed hosts and a token file.
  - The test-only "listen on all interfaces" option is gone; the regtest playground uses proxied
    mode with its own addresses.

- **`config backend detect`** (and **Detect chain & add** on the Network tab): asks a backend which
  chain it follows by running each chain's identity checks, and with `--add` adds it to that chain.
  Refuses a backend that matches no chain (or more than one). Useful for a node whose flavour you
  don't control (StartOS runs Core, Knots or Knots RDTS under one `bitcoind` package).

### Fixed (review of the track/broadcast fixes)

- **A stranger's spend is no longer passed off as one of your plans on node RPC.** When the backend
  can't name a spender, an own transaction now explains a split's conflict only if it spends every
  input of the split that is gone; one input spent by someone else keeps the CONFLICT. Explained
  conflicts are kept in the history, marked resolved and explained.
- **`track --ack` never mutes an alert first raised by the same run**, and its question shows each
  alert's full text.
- **TEST FIRST wording:** "can't be confirmed as sent (the backend can't tell)" instead of "has NOT
  gone out" when the backend can't see it; `--yes` still doesn't answer then.
- "Transaction outputs already in utxo set" (current Core/Knots) counts as already sent.

### Fixed (independent review of wp/2f)

- **Superseded stays superseded on node RPC.** `track` used to drop "superseded by plan …" whenever
  the backend didn't name the other plan's transaction, which node RPC never does: with `txindex`
  that became a false **CONFLICT** ("the key may be compromised", exit 1), without it a split that
  the next `broadcast` marked in conflict. It is now cleared only on positive evidence (this split
  on the network, its inputs seen unspent, or a named, different spender). When the backend can't
  name a spender, each of this tool's transactions spending the same coin is looked up by txid
  (`identifySpender()` in `plan_admin.ts`) before anything is called a CONFLICT.
- **`--yes` no longer answers the TEST FIRST question for a test that never went out.** It answers
  only while the TEST FIRST spend (or a fee bump of it) is confirmed or in the mempool; when it is
  not verified, not sent, rejected, in conflict, superseded, dropped or unknown, the rest of that
  chain is not sent, each says why, and `broadcast` exits 1. Answered yourself, the question now
  starts "The TEST FIRST transaction has NOT gone out on …", says what skipping it risks and
  recommends no (the web UI makes **No** the default button); yes still sends the rest (a soft
  gate). `--all` is unchanged. `TestFirstStatus` gains `out`.
- **A split is never in conflict with itself.** When the status lookup missed a split but its input
  showed spent by the split's own txid (it reached the mempool in between, or the server lags),
  `track` called it a CONFLICT; that spend now says where it is. `classifySpender()` returns
  `"self"` for the split's own txid.
- **`broadcast` looks up a send whose result was unclear before checking its inputs.** On node RPC a
  split that had got through had its input "gone" with no named spender and was marked conflict; it
  is now recorded as accepted ("already on chain: an earlier send got through"). A backend that
  can't tell holds it instead of sending again or calling it a conflict.
- **Node RPC without `txindex` can follow a split**: when neither the transaction's status nor its
  inputs can tell, its own first output in the UTXO set proves it is confirmed (with its depth) or
  in the mempool (`confirmationDepth()`).
- **Alerts that could never close.** `track <plan> --ack [--yes]` acknowledges the open alerts after
  listing them (in the web UI: **Acknowledge alerts…**), and archiving a plan acknowledges its
  alerts too. Acknowledged alerts stay in `progress.json` (`acknowledged`), are shown muted
  ("Acknowledged alert: …", grey in the web UI) and no longer make `track` exit 1; a new alert is
  loud again, and an acknowledged off-network alert ends once the split is back. The original
  confirming after its fee bump was sent is no longer an alert repeated forever: `track` notes it
  once, marks the bump plan(s) `superseded` by the original and follows the original from then on.
- **A conflict can end.** When the transaction that conflicted with a split leaves the chain and the
  mempool and the split's inputs are seen unspent, `track` closes the CONFLICT, raises a DROPPED
  alert (the coin is shared with BTC again) and sets the split to `unknown`, so **Broadcast
  verified** can send it again with its checks.
- **Wording.** The rest of a chain is told what happens to its TEST FIRST transaction in this run
  (it goes now; it is already on the network; or it isn't sent, and why) instead of always "goes
  first, in this run". `broadcast` recognises an accepted original whose input its own unrecorded
  fee bump spent, and marks it replaced instead of "spent by …, not by this split". A replaced
  original back in the mempool reads as itself ("back instead of its replacement"), not "the coin
  was then spent by plan <the original>". Long txids wrap in the web UI's question box.
- **Tests on every backend.** The end-to-end harness moved to `tests/e2e.ts` and runs against
  Esplora, Electrum (an in-memory server) and node RPC with and without `txindex`
  (`FakeNodeRpcTransport`); the broadcast, track, own-spend and TEST FIRST paths are tested on each.

### Changed

- **TEST FIRST asks instead of refusing.** On each chain `broadcast` (**Broadcast verified**) still
  sends the TEST FIRST transaction alone first. On a later run it no longer holds the rest back
  until that transaction is confirmed: it says where it is now (confirmed N deep, in the mempool,
  replaced by a fee bump, following bumps of bumps, superseded, dropped, in conflict, not verified,
  unknown, or that the lookup failed) and asks one question for every chain whose rest is ready
  ("Send the other 1 ECX and 1 XBT transaction(s) now?", phrased as reassurance once every test
  spend is confirmed). `--yes` answers yes (only while the test spend is on the network: see Fixed
  above), `--all` sends everything at once as before, and "no" sends none of the rest and says why
  per transaction. No state can leave the rest stuck. The per-transaction checks before any send are
  unchanged. `testFirstGate` is replaced by `describeTestFirst()` (`src/core/test_first.ts`).
  Questions in the web UI keep their line breaks.
- **`bump --another`** writes a second replacement while one is written and unsent; `--yes` now only
  skips the prompt (it used to do both).
- **`track` exits 1 while any alert is open**, naming it ("… is still open (now: 1 of 50)"), e.g. a
  split that is in a block again after a reorg but not deep enough yet. It used to print a note and
  exit 0.

### Added

- **A split that was sent but never confirmed and fell out of the mempool is flagged.** `track`
  raises a **DROPPED** alert (exit 1, the same warning block as reorgs) for a split whose send was
  accepted (or ended unknown), that was never in a block, and that is now on neither the chain nor
  the mempool with its inputs unspent. It says when it was last seen in the mempool (`unmined` in
  `progress.json`), names mempool minimum fee and mempool expiry as the likely causes, and says what
  to do: send it again, or fee bump it if the fee was too low. A split no mempool has shown yet gets
  10 minutes after its send first. **Broadcast verified** sends any such split again (not only a
  TEST FIRST one, and also when nothing else on its chain is pending), with all the usual checks.
  The split stays "accepted": it counts as sent and unsettled (`plans delete` refuses, the coin
  picker shows it as broadcast). In the web UI the row says "dropped from the mempool (last seen
  …)", the alert is titled DROPPED, and **Fee bump…** is offered. A fee bump's original vanishing
  never alarms; the bump itself vanishing does, on both plans.
- **Your own spends are recognised before anything is called a conflict.** When a split's input was
  spent by another transaction, `track` and `broadcast` look it up among the verified transactions
  of every plan (archived ones too, `classifySpender()` in `plan_admin.ts`): its own fee bump, at
  any hop, marks it replaced (and withdraws a CONFLICT it got); another plan's transaction marks it
  **superseded by plan …**, a note rather than an alarm, settled once that plan's transaction is
  deep, not counted as sent, never bumped or sent again. Only an unknown spender is a CONFLICT, now
  worded with the likely causes in order (another wallet or tool, a replayed BTC spend, and only
  then a compromised key) and saying so when the backend can't name the spender.
- **`track` follows bumps of bumps** to the replacement on the network
  (`REPLACED by plan C (via
  B)`), also through a bump whose send reply was lost. `replacedBy` now
  records the replacement's txid and first input, so it can be followed even without its plan, and a
  bump plan that a plan's `replacedBy` points to can't be deleted until that plan is archived.

- **Coin picker in the web UI's plan form.** The New plan card lists the coins a plan could take
  (shared per the last scan, with the forks each is split from), each with a checkbox, value, short
  outpoint, a **new** badge for new shared coins, and "in plan <id> · broadcast / not broadcast"
  when a plan that isn't archived already spends it. Coins not in a plan yet start ticked; **Select
  all / Select none / Only new shared coins / Only coins not in a plan**, a running total, and
  **Create plan** disabled with the reason while nothing is picked (or only XBT-only coins without
  an XBT signer). The pick is kept across re-renders until a plan is created and is passed as one
  `plan --coin txid:vout` per coin (omitted when it is every coin and none was planned before).
  `/api/status` now gives every coin `plannedIn` (non-archived plan ids, newest first) and
  `broadcastIn` (those that sent a transaction spending it), computed read-only by
  `plannedOutpoints()` in `src/core/plan_admin.ts`; `newShared` entries get `broadcastIn` too. The
  new-shared-coins banner on the Coins tab has a **Plan these coins** button (the plan form with
  exactly those coins ticked, skipping any already in a plan) next to **Go to Plans**, and no longer
  sends you to the command line. A UI job may now take up to 512 args (was 64), room for about 250
  picked coins; the form refuses more than 250 unless it is every coin.

- **Coins that turn up later.** Each `scan` compares itself with the previous one
  (`newSharedCoins()` in `src/core/scan.ts`) and lists coins that are shared now but weren't in the
  previous scan, or weren't shared then: a deposit to an old address, a pre-fork coin beyond the
  earlier gap limit, a split that left the chain. `scan` and `status` print a **NEW SHARED COINS**
  block (full `txid:vout`, value, chains, first seen, and what to do: don't spend them on BTC until
  split, plan them, `plan --coin` for only these). They are saved in `scan.json` as `newShared` with
  their first-seen time and stay listed until the split shows on the chains (a chain that couldn't
  be asked doesn't clear them). Exit codes are unchanged. The web UI shows them in `/api/status`
  (with the non-archived plans that already spend each one), as a banner on the Coins tab with a
  **Go to Plans** button, a **new** badge on their rows, and, once any plan exists, a header pill
  and a setup-guide line.

- **Setup guide in the web UI.** A checklist above every tab walks through the guided route (confirm
  network, import wallet, set fork destinations, scan, create a plan, sign/verify/ broadcast). Steps
  are ticked off from the real state, not from clicks; the next one is explained with a button to
  its tab. **Guide: on/off** in the tab bar hides it (remembered in that browser).

- **Wallet import by QR code, multisig included.** **Scan QR** on the Wallet tab (import field and
  each fork destination) reads animated UR wallet exports by camera, or pasted text: a signer's xpub
  (`crypto-account` / `account-descriptor`, SeedSigner's default), a coordinator's whole wallet
  (`crypto-output` / `output-descriptor`, e.g. Sparrow), SeedSigner's Static `[fp/path]zpub…` text,
  or a descriptor. Multisig: scan each SeedSigner cosigner, set the threshold and sorted/ordered
  keys; the first receive address is shown to compare with the coordinator. Private keys and network
  mismatches are refused. Decoding is `src/core/ur_wallet.ts` (its own bounded CBOR reader; the PSBT
  frame decoder is unchanged) with read-only endpoints `POST /api/wallet/qr` and
  `/api/wallet/preview`; importing still goes through `import` / `dest set`. Tested against frames
  from SeedSigner 0.8.7's own encoder (single-sig 84/49/86/44, Static text, 2-of-3 native and nested
  multisig, a coordinator `crypto-output`) and Sparrow's Hummingbird vectors, with addresses
  cross-checked in embit (`tests/fixtures/seedsigner/generate.py`, `testdata/seedsigner_ur.json`).
  The camera scan is shared with **Scan signed** (`startCamera` in `qr.js`).
- **QR import review fixes** (independent review): multisig keys marked `cosigner(…)` in
  `account-descriptor` / legacy exports are kept, BIP45 `sh()` keys dropped; exports with both
  single-sig and multisig keys can start a multisig; a wrong scan while building returns to the
  builder (and scans have **Back to the cosigners**); key derivations other than `<0;1>/*` or `0/*`,
  and whole-wallet descriptors with swapped or change-only branches, are refused instead of silently
  giving other addresses; duplicate cosigners are found by public key; origin path steps of 2^31 or
  more are refused (also in `parseDescriptor`); repeated CBOR map keys are refused; a seed phrase or
  SeedQR gets a clear warning; a stray plain-text code no longer discards an animated scan in
  progress; a late camera start can't leave the camera on.

- **Archive and delete plans** (`plans archive|unarchive|delete <plan>`, and **Archive** /
  **Delete…** buttons on the Plans tab with an "Archived plans" section). Archiving leaves a marker
  in the plan's folder rather than moving it, because the donor rules and fee-bump tracking read
  plan folders. Deleting asks first, says what would be lost, takes a plan id only (never a path),
  and is refused while any transaction of the plan was sent and isn't confirmed to the chain's
  required depth.

- **Web UI flow.** Progress boxes inside the Network tab (while checking servers over Tor) and the
  Coins tab (while scanning), with the current step, elapsed time and a note on why it's slow. The
  UI moves on by itself from Network to Wallet once the settings are confirmed, and from Wallet to
  Coins once a wallet is imported and both fork destinations are set (only on that transition, so
  revisiting a tab doesn't bounce you).
- **`config scan [--gap-limit N] [--jitter MIN-MAX]`**, and a **Scan settings** card on the Network
  tab with an estimate of how many addresses a scan reveals. Like other network settings, changing
  them re-locks importing and scanning until `init`.

- **Progress while commands run.** Long steps now report structured progress (Tor start-up, each
  backend identity check, addresses checked per chain during a scan, and the cross-check with a
  known total). The web UI shows the latest step and the elapsed time under the Activity header
  while a command runs, so a slow Tor connection or scan no longer looks hung. The terminal output
  is unchanged. (`src/core/progress.ts`; `progress` on `CliIO` and on job snapshots from
  `GET /api/jobs/<id>`.)

### Fixed

- **"Absent" is never concluded from an ambiguous answer.** `confirmationDepth` now needs every
  input seen unspent (another input spent elsewhere is a conflict; an input whose own transaction
  can't be found is unknown, where it used to read as absent or a conflict); Esplora's existence
  check after the `{"confirmed":false}` trap throws on an HTTP error instead of answering "mempool";
  and one failed lookup no longer aborts `track`: that row shows `? (lookup failed)`, its record is
  unchanged, and `track` exits 1.
- **A fee bump whose reply was lost** never marked its original replaced, so the original's `track`
  raised a CONFLICT ("treat the key as compromised"). The original is now marked replaced wherever
  the bump is found on the network: `broadcast`'s "already in the mempool / on chain" path, a server
  answering that it already has it, and `track`'s unknown→accepted restore.
- **A server that already has a transaction** ("txn-already-known", "already in block chain") is
  recorded as accepted, not rejected.
- **Older progress files** with a stale depth no longer let a send whose status is
  unknown/sending/conflict (or that `track` saw leave its block) be deleted, and no longer hide
  **Fee bump…** for it.
- **A split marked conflicting whose own transaction is confirmed deep** goes back to accepted (and
  counts for the donor rules again); so does a "rejected" send that `track` sees on the network.

Findings from a real-browser check of reorgs, fee bumps and the donor screen.

- **A split that left its block kept its old depth.** `track` only ever wrote the depth when a split
  was confirmed, so after a reorg (back in the mempool, dropped, or a conflict) the row still said
  "2 conf", the web UI hid **Fee bump…**, and `plans delete` could treat a split that had left the
  chain as settled. `track` now records the depth as it is: 0 with where the split is instead
  (`state`: mempool / absent / conflict) and the block it was last in (`previous`). A split that was
  never in a block still gets no record. The reorg alert repeats on every `track` while the split is
  out of a block, and is marked **resolved** once it (or the fee bump that replaced it) is confirmed
  deep enough again. A split whose earlier send ended `unknown` and that `track` sees on the network
  again goes back to `accepted`.
- **The rest of a plan never went out after its TEST FIRST transaction was fee-bumped.** `broadcast`
  treated the TEST FIRST spend as done only while its status was `accepted`, so once a bump had
  replaced it (status `replaced`) "Broadcast verified" said "Nothing to broadcast" forever. The rule
  is now: on each chain the rest waits until the TEST FIRST transaction **or the bump that replaced
  it** is in a block (asked on the chain each time, so a test spend that left the chain in a reorg
  closes the gate again). A TEST FIRST transaction that is not verified yet now holds the rest back
  too (it used to be skipped, sending the rest without a test). A TEST FIRST transaction that was
  sent but is no longer on the network is sent again. When something isn't sent, `broadcast` says
  why for each transaction (not verified, already sent, replaced, waiting for the test spend, held
  by the BTC-first gate, rejected, conflict) instead of only "Nothing to broadcast right now.".
- **A second fee bump for the same transaction.** The **Fee bump…** buttons stayed on the original
  until the replacement was broadcast, so `-bump2`, `-bump3`… could pile up. The row now says "bump
  written: plan <id> (not sent yet)" and offers no bump while one is waiting, and `bump` refuses a
  transaction that already has an unsent replacement (a bump plan that isn't archived and whose
  replacement was never sent, or whose send ended `sending`/`unknown`), naming the plan to send or
  delete; `--yes` writes another one anyway, with a warning. The bump prompt shows each
  transaction's current rate and the BIP125 minimum.
- **Reorg alerts.** Block hashes are shown as height plus their last 8 hex digits (the first digits
  are zeros on real chains, so "moved" printed the same text for both blocks); the same goes for the
  "wrong chain" identity message. The duplicated "ECX: REORG." prefix is gone (`REORG` or `CONFLICT`
  is said once, by `track` and by the web UI). In the web UI each alert shows its kind, the number
  of alerts for that transaction and a UTC time, and turns muted once resolved.
- **Donor screen.** "Create fan-out PSBT(s)…" and "Create plan with donors" stay disabled while no
  donor is ticked (a finished job used to re-enable every button); ticking a donor, or a job
  finishing, no longer wipes what was typed in the donor fields; a refused donor import keeps the
  pasted descriptor. "Scanned …" shows a local time instead of a raw ISO string, and "also plan ECX"
  sits next to its checkbox.
- **Refusals no longer dump the usage text.** `donor import` of a descriptor that is already the
  main wallet (and "import a donor wallet first", "run donor scan first", "import a descriptor
  first", "run scan first") print only the reason and exit 1, not 2 with ~100 lines of usage.
- **Smaller things.** `plan` no longer says "Sign the TEST FIRST transaction" when the plan has none
  (e.g. a single BTC-first transaction); the Status column keeps **Fee bump…** on one line; TEST
  FIRST and pending badges are readable in the light theme; the regtest **Mine** buttons track the
  plan you last broadcast, tracked or bumped rather than the newest one.

## 0.1.0-pre-alpha.1 (2026-11-01)

### Changed

- **Renamed from forksplit to splayed.** The command is `splayed`, the config file is
  `splayed.toml`, the data directory is `splayed` (`~/.local/share/splayed` on Linux), and the
  environment variables are now `SPLAYED_DATA_DIR`, `SPLAYED_PROFILE`, `SPLAYED_TOR_SOCKS` and
  `SPLAYED_TOR_BINARY`. Nothing was released under the old name, so there is no migration: move the
  old data directory by hand if you have one. The regtest playground project is now
  `splayed-regtest`, so run `deno task regtest down` on the old checkout first to remove its
  containers.

### Added

- **First tagged release.** `v0.1.0-pre-alpha.1` is published with a Linux x86_64 binary
  (`deno task compile`) bundled with the pinned Tor 0.4.9.15 binary at `vendor/tor/linux-x86_64/`, a
  `SHA256SUMS` file and a detached signature from the `SECURITY.md` key. Verified standalone (no
  source tree) before publishing, and re-verified against a fresh download afterward. Other
  platforms and a CI release workflow are still open (`TODO.md`).
- **First live mainnet run.** The full guided route (scan, plan, sign, verify, broadcast, track,
  rescan) split one real coin's ECX and XBT copies away from BTC, with BTC confirmed untouched at
  its original address and both forks confirmed at their new ones. ECX signed with stock SeedSigner
  firmware; XBT with the SIGHASH_UNIFIED-aware fork at
  [privkeyio/seedsigner](https://github.com/privkeyio/seedsigner) (release
  `v0.8.7-unified-sighash.6`). Steps for both are now in `docs/user/signers.md`.
- **Managed Tor verified against the real bundled binary.** `deno task fetch-tor` plus `TorManager`
  bootstraps the pinned Tor Browser 16.0 (tor 0.4.9.15) binary in about 10 seconds. Per-chain and
  per-broadcast SOCKS isolation keys were confirmed to land on distinct circuits (five keys, five
  different exit IPs), and re-using a key returns to the same circuit instead of rotating.
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
  trying splayed by hand. `up` starts the three nodes and mines the shared history, `fund` puts
  coins on your own wallet (a descriptor or an address) on all three chains before the fork, `fork`
  separates the chains, and `ui` runs the web UI against them. `mine`, `reorg`, `check` (asks every
  node about a plan's signed transactions, independent of splayed), `status`, `stop` and `down`
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
  `ecash-com/bitcoin` commit `c8474e0b` (reports eCash v1.2.0) run in Docker. splayed's CLI runs
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

- **`bump` silently failed to broadcast an ECX fee bump.** `EsploraBackend.txStatus` treated a
  `GET /tx/<txid>/status` answer of `{"confirmed":false}` as proof the transaction was in the
  mempool, but both of ECX's default backends (`explorer.ecash.com` and `esplora.ecash.ninja`) give
  that same answer for _any_ syntactically valid txid, including ones never broadcast. The fee-bump
  broadcast pre-check (`cmdBroadcast`'s `t.replaces` branch in `src/cli/main.ts`) then believed the
  replacement was "already accepted" and never actually sent it, while the original stayed live and
  unreplaced. `txStatus` now checks existence via `GET /tx/<txid>` first, the same guard
  `observeOutput` already had for the `/outspend` endpoint's identical trap. Found and fixed during
  the live mainnet run above; regression test in `tests/core_test.ts` (`FakeChain.statusTrap` in
  `tests/fakes.ts`).
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

- Describe splayed as keyless (your wallet signs) rather than watch-only.
- TODO.md with release blockers and open work, SECURITY.md, project layout in the README, and a CI
  workflow (fmt, lint, type-check, tests).
- UI: dark mode by default, with a light toggle that is remembered per browser.
- Tor: a failed bootstrap is not retried for every chain within 30 seconds.

## Milestone 4: managed Tor and local web UI (2026-10-31)

- Tor manager with `auto`, `managed` and `system` modes. splayed's own Tor uses `IsolateSOCKSAuth`,
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
