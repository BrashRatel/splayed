# forksplit

Keyless tool for separating the **BTC**, **XBT** (Bitcoin BLAKE2b) and **ECX** (eCash) copies of the
same coins after the 2026 forks: forksplit builds replay-protected PSBTs, your (cold) wallet signs
them, and forksplit verifies and broadcasts each split only to its own chain, over Tor.

Coins that existed before a fork exist on both chains at the same outpoint. An ordinary spend on one
chain can be **replayed** on the others, moving the copies you meant to keep. forksplit finds your
coins on all three chains, tells you which ones are still shared, and walks each shared coin through
plan → sign (in your wallet) → verify → broadcast. Your keys never leave your wallet.

> **Status: milestone 4.** The full guided route works end to end against test chains: `init`,
> `import`, `scan`, `status`, `dest`, `plan`, `verify`, `broadcast` and `track`, from the CLI or the
> local web UI, with Esplora, Electrum and node-RPC backends and a managed or system Tor. It has not
> yet been run against live servers or real signers; start with one small coin.

## The chains

|     | Last block shared with BTC | First own block                    | Replay protection                                                                              |
| --- | -------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| XBT | 961,631                    | 961,632 (BLAKE2b PoW from 961,640) | Opt-in per signature: `SIGHASH_UNIFIED` bit 0x20 (ALL becomes 0x21)                            |
| ECX | 973,727                    | 973,728                            | Opt-in per transaction: `nLockTime = 499,999,998` plus one input with `nSequence < 0xffffffff` |

Both protections are one-directional: they stop a fork transaction from replaying onto BTC, but an
ordinary BTC transaction still replays onto the forks. That is why the guided route splits the forks
first and leaves BTC alone.

## Guided route (forks-first + 0x21)

For each coin that is still shared:

1. **ECX:** send it to yourself with the ECX marker. Any signer works, hardware wallets included.
2. **XBT:** send it to yourself with a 0x21 (`SIGHASH_ALL|SIGHASH_UNIFIED`) signature. This needs a
   signer that supports it (Bitcoin Knots wallet, the Sparrow BLAKE2b build, Shrike, embit). Stock
   hardware wallets can't make these signatures.
3. **BTC:** once both splits are deeply confirmed, the BTC copy can be spent normally.

Advanced donor-input routes exist in the design and will be opt-in.

## Install and run

Requires [Deno 2.x](https://deno.com).

```sh
deno install
deno task cli --help
```

### First run: network settings come before anything else

```sh
deno task cli init
```

`init` shows where every query will go, then checks each backend is on the right chain. It asks only
for the chain tip and a few fixed block hashes, so nothing about your coins is sent. Importing and
scanning stay disabled until you confirm. Changing any network setting closes the gate again.

Defaults are public servers reached **over Tor**, and fail closed if Tor isn't running:

| Chain | Default (Esplora API)                                            |
| ----- | ---------------------------------------------------------------- |
| BTC   | mempool.space onion                                              |
| XBT   | mempool.guide onion                                              |
| ECX   | `https://explorer.ecash.com/api` via a Tor exit (no onion known) |

#### Tor

forksplit finds or starts Tor for you, but only when a backend that's about to be contacted needs
it. Local and LAN backends never start Tor.

| Mode             | What it does                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | Uses a Tor that's already running: the configured address, then `127.0.0.1:9050` (tor daemon), then `127.0.0.1:9150` (Tor Browser). If none is running, it starts forksplit's own. |
| `managed`        | Always starts forksplit's own Tor.                                                                                                                                                 |
| `system`         | Only uses a Tor you run, and never starts one. Fails closed if it isn't there.                                                                                                     |

```sh
deno task cli config tor auto
deno task cli config tor system 127.0.0.1:9150   # Tor Browser
deno task cli config tor managed
```

forksplit's own Tor:

- runs as a child process, with its own data directory under the forksplit data dir;
- uses SOCKS on a random loopback port with `IsolateSOCKSAuth`, so each chain and each broadcast
  gets its own circuit;
- sets `SafeSocks 1`, so every name is resolved inside Tor;
- is tied to forksplit with `__OwningControllerProcess`, so it exits if forksplit dies, and is
  stopped on normal exit or Ctrl+C.

The binary comes from, in order:

1. `tor.binary` in the config, or `FORKSPLIT_TOR_BINARY`;
2. the bundled copy in `vendor/tor/<os>-<arch>/`;
3. `tor` on `PATH`.

**Bundling Tor (maintainers / release builds):**

```sh
deno task update-tor-manifest 15.0.1   # pin hashes after verifying the Tor Browser team's GPG signature
deno task fetch-tor --all              # download Tor Expert Bundles, check SHA-256, unpack to vendor/tor/
deno task compile                      # dist/forksplit; ship it next to vendor/tor/
```

`fetch-tor` refuses anything that isn't pinned in `vendor/tor-manifest.json`. That file pins Tor
Browser 16.0 (tor 0.4.9.15). Re-pin with `update-tor-manifest` after checking the signature
yourself.

### Using your own nodes

Each chain has its own backend list. Local and LAN hosts are reached directly; everything else goes
through Tor unless you opt that chain into clearnet.

```sh
# Bitcoin Core (no address index needed; scantxoutset runs on your node)
deno task cli config backend add btc --kind rpc --url http://127.0.0.1:8332 \
  --cookie-file ~/.bitcoin/.cookie
# Bitcoin Knots on the XBT chain, password from an environment variable
deno task cli config backend add xbt --kind rpc --url http://127.0.0.1:18332 \
  --user me --password-env XBT_RPC_PASSWORD
# Your own Esplora/mempool instance for ECX
deno task cli config backend add ecx --kind esplora --url http://192.168.1.20:3002/api
# An Electrum server (Fulcrum/electrs). XBT needs a BLAKE2b-aware one (164-byte headers).
deno task cli config backend add xbt --kind electrum --url ssl://electrum.example.org:50002
# Self-signed TLS certificate? Pin it:
deno task cli config backend add btc --kind electrum --url ssl://192.168.1.20:50002 \
  --ca-file ~/fulcrum-cert.pem
deno task cli config show
deno task cli init
```

**Adding your own backend for a chain removes that chain's profile default**, so the default is
never contacted (`config backend fallback` / `reset` bring defaults back). Backends are tried in
priority order and the tool stops at the first that passes its identity check; lower ones are
contacted only if every backend above them failed. `init` shows where queries will go and asks
before contacting anything. With node RPC, `txindex=1` lets forksplit report how deep a spend is and
fetch previous transactions for PSBTs. Without it, a spent coin shows as "spent/absent ?" and stays
**pending**.

### Web UI

```sh
deno task ui        # or: deno task cli ui [--port N] [--open]
```

The UI runs the same `forksplit` commands as the CLI, with the same checks. Their confirmation
prompts appear as dialogs in the browser. It has four tabs:

1. **Network:** backends, privacy level per backend, Tor mode, and "Check servers & confirm".
2. **Wallet:** descriptors and fork destinations.
3. **Coins:** scan, plus per-coin status on all three chains.
4. **Plans & signing:** create a plan, download the unsigned PSBTs (binary or base64), upload signed
   files, then verify, broadcast and track.

Security:

- The server listens on 127.0.0.1 only, on a random port.
- Access needs a random token passed in the URL fragment. It's never sent in a request URL or
  `Referer`; it's removed from the address bar and sent only as an `Authorization` header.
- Requests naming another `Host` are refused, which blocks DNS rebinding.
- POST requests must be JSON and same-origin.
- The CSP allows only the UI's own script and stylesheet.
- Server data is only ever inserted as text, never as HTML.
- The UI can't change the data directory, Tor address or profile, and can't start another UI.

The UI is dark by default. The header button switches to light mode, and the choice is remembered in
that browser.

`deno task demo-ui` starts a UI filled with in-memory test chains (no network), for development.

### Import and scan

```sh
deno task cli import "wpkh([d34db33f/84h/0h/0h]xpub6.../<0;1>/*)#checksum" --label cold
deno task cli scan
deno task cli status        # or: status --json
```

`import` prints the first address of each branch. Check they match your wallet.

Supported descriptors:

- `pkh`, `wpkh`, `sh(wpkh)` and `tr` (key path);
- `sh`, `wsh` and `sh(wsh)` with `multi` or `sortedmulti`.

`ypub` and `zpub` keys are accepted and converted to xpub. Private keys are refused.

Each coin gets one status:

| Status       | Meaning                                                          |
| ------------ | ---------------------------------------------------------------- |
| `shared`     | Unspent on two or more chains. The output lists the next steps   |
| `separated`  | Unspent on one chain; every other copy is deeply spent or absent |
| `pending`    | A spend is unconfirmed, shallow, or its depth can't be checked   |
| `unverified` | A chain couldn't be asked. Never treated as safe                 |
| `spent`      | Not unspent anywhere                                             |

### Plan the splits (unsigned PSBTs)

```sh
# Where split coins go on each fork (best: a new seed per fork). Ranged descriptor, branch 0 used.
deno task cli dest set ecx "wpkh([fp/84h/0h/0h]xpub.../0/*)"
deno task cli dest set xbt "tr([fp/86h/0h/0h]xpub.../0/*)"
# Say what will sign XBT: knots, sparrow-blake2b, shrike, embit, privkeyio-firmware
deno task cli plan --xbt-signer knots --fee-rate ecx=2,xbt=3
```

For every coin the last scan saw as shared, `plan`:

1. re-checks the coin on the target fork;
2. fetches the previous transaction and checks it hashes to the right txid;
3. builds one PSBT per batch.

What it stamps on each fork's PSBTs:

| Fork | Locktime    | Sequence                    | Sighash type                                           | Signer                                       |
| ---- | ----------- | --------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| ECX  | 499,999,998 | `0xfffffffd` on every input | not set                                                | any signer, including stock hardware wallets |
| XBT  | 0           | `0xfffffffd` on every input | `0x21` (`SIGHASH_ALL\|SIGHASH_UNIFIED`) on every input | must support SIGHASH_UNIFIED                 |

Each input carries:

- BIP32 origins;
- the full previous transaction for non-Taproot inputs (hardware wallets need it);
- the redeem and witness scripts for multisig, plus `PSBT_GLOBAL_XPUB`.

Options:

- `--batch coin` (default) keeps coins unlinked. `--batch address`, `--batch N` and `--batch all`
  combine coins, and the summary says which addresses that links publicly.
- Fees come from `--fee-rate` or the backend's 6-block estimate. A batch whose fee would be over 10%
  of its value is skipped.

The smallest transaction on each chain is marked **TEST FIRST**. Destination addresses are reserved,
so re-planning never reuses one.

Plans go to `<data dir>/plans/<id>/` (`ecx/*.psbt`, `xbt/*.psbt`, `plan.json`, `README.txt`).

### Sign, verify, broadcast

Sign each PSBT in your wallet and save the result next to the original as `<name>.signed.psbt`.
Finalized PSBTs, partially signed PSBTs, and raw transaction hex (`.hex`/`.txn`) are all accepted.

```sh
deno task cli verify <plan-id>          # or: verify <plan-id> path/to/signed files...
deno task cli broadcast <plan-id>
deno task cli track <plan-id>
```

`verify` takes only signatures from the signer's file. Scripts, keys and amounts come from the
plan's own PSBTs. Each signed file is matched to its planned transaction by content, then:

1. The transaction must be identical to the plan: same inputs, sequences, outputs and locktime.
   Anything a signer changed (a fee bump, a swapped address) doesn't match.
2. ECX transactions must have locktime 499,999,998 and a non-final input sequence.
3. Every signature is checked against the digest its own chain will compute:
   - **ECX:** Bitcoin's legacy, BIP143 or BIP341 digest, with SIGHASH_ALL or DEFAULT only.
   - **XBT:** the Knots unified digest, and **every** signature must be 0x21. A signer that quietly
     signs SIGHASH_ALL instead is caught here, because that transaction would also be valid on BTC.
4. The fee must equal the plan's, and the final txid must match.
5. If you configured your own node-RPC backends, each node is asked `testmempoolaccept` (nothing is
   broadcast). The target chain should accept. **Any other chain accepting means the transaction
   isn't replay-protected, and verification fails.**

The final transaction is rebuilt canonically from the verified signatures.

`broadcast` sends only verified transactions:

- It re-verifies the exact bytes, re-checks the broadcast backend's identity, and re-checks each
  input is still unspent on that chain.
- It saves progress to disk before sending.
- Each transaction goes only to its own chain, over its own Tor circuit.
- On each chain it sends the **TEST FIRST** transaction alone and waits for it to confirm before
  sending the rest (`--all` overrides).
- An unknown result (timeout, Tor failure) is recorded as unknown, never as failed, and is safe to
  retry. Re-running is idempotent.

`track` shows confirmations against your configured depth. When the splits are deep, run `scan`: the
BTC copies then show as separated and can be spent normally.

### Reorgs

`track` remembers the block each split was confirmed in. If a later `track` finds that a split that
was confirmed has changed, it says so loudly and exits with status 1:

| What happened                                                                                    | What `track` says                                                         |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Re-mined in a different block (a reorg)                                                          | `REORG`, with the old and new block. Still confirmed; depth restarts      |
| Back in the mempool                                                                              | `REORG`: back in the mempool                                              |
| Gone from the chain and the mempool, input unspent again                                         | `REORG`: the coin is shared with BTC again. `broadcast` can send it again |
| Input spent by a different transaction (an outside spend, or a BTC spend replayed onto the fork) | `CONFLICT`. The split is marked conflicting and will not be re-sent       |

Until every split is confirmed again, leave the BTC copies alone. `scan` also warns when a spend it
saw last time has disappeared or been replaced by a different transaction.

Reorg detection needs a backend that can report a transaction's own status: Esplora, Electrum, or
node RPC. Node RPC without `txindex` can't tell a confirmed transaction from one that never existed,
so `track` shows `unknown` rather than guessing. In the web UI, reorg alerts appear above a plan's
table, and each broadcast split has a "Fee bump…" button (plus one for the whole plan).

### Stuck transactions: fee bump (RBF)

Every planned transaction signals RBF. If one is stuck at too low a fee:

```sh
deno task cli bump <plan> --fee-rate ecx=6,xbt=8   # or leave --fee-rate off for an estimate
deno task cli verify <plan>-bump1
deno task cli broadcast <plan>-bump1
```

`bump` writes a new plan whose transactions spend the **same inputs** to the **same destination** at
a higher fee, from the original's own unsigned PSBT. Only the output value changes: inputs,
sequences, locktime (the ECX marker) and the 0x21 request are copied, so the replacement is
replay-protected exactly like the original. Sign it in your wallet and `verify` it like any plan.

- It must follow BIP125: at least the old fee plus 1 sat/vB for its own size. A lower `--fee-rate`
  is refused, and the message says the minimum.
- Only transactions that are broadcast and not yet confirmed can be bumped. A confirmed one, one
  whose input was spent by something else, or one already replaced is refused.
- `--chains ecx` and `--tx N` limit what is bumped. Without `--fee-rate`, the rate is the backend's
  estimate, at least 1.5x the old rate.
- When the replacement is sent, the original is marked `replaced` and `track` shows
  `REPLACED by plan ...`. If the original confirms first, the replacement is refused and `track`
  says so.

## Security model

- **Keyless.** forksplit never asks for, accepts or stores seeds or private keys. It reads your
  wallet through xpub-based (watch-only) descriptors, and your own (cold) wallet signs the PSBTs it
  builds.
- **Network identity is compiled in.** The replay constants, fork heights and checkpoint block
  hashes are in `src/core/profiles.ts` and can't be edited by configuration. Before it is used, and
  again on every scan, each backend must report the pinned hash at every checkpoint:
  - BTC: 961,640 and 973,728;
  - XBT: 961,640;
  - ECX: 973,728 and 974,017. The second rejects ECX nodes still on v1.0.0.

  This also stops a BTC explorer being used as the XBT backend: they run the same software.
- **Privacy defaults:**
  - Nothing coin-related leaves the machine before network settings are confirmed.
  - Tor is the default for public hosts, and there's no clearnet fallback.
  - DNS is resolved by Tor (SOCKS5 domain addressing).
  - Each chain and each future broadcast gets a separate Tor circuit (SOCKS credential isolation).
  - Queries are shuffled and jittered.
  - `status` reports how many addresses were revealed to remote servers.
- **PSBTs are built in-house** (`src/core/psbt.ts`): general-purpose libraries reject sighash type
  0x21. The ECX PSBTs are tested against `@scure/btc-signer`, which signs them as a stock signer
  would; the signed transaction keeps the replay marker and the predicted txid.
- **No fetch().** HTTP goes over connections the tool opens itself, so `HTTP(S)_PROXY` environment
  variables can't silently reroute traffic.
- **The Esplora trap.** `/tx/{txid}/outspend/{n}` reports "unspent" even for transactions that don't
  exist, so existence is always checked first with `/tx/{txid}`.
- **Private files.** Data files are written atomically with `0600` permissions. RPC passwords are
  never stored, only the name of the environment variable that holds them, or a cookie file path.

Data directory: `~/.local/share/forksplit` (Linux), `~/Library/Application Support/forksplit`
(macOS) or `%APPDATA%\forksplit` (Windows). Override with `--data-dir` or `FORKSPLIT_DATA_DIR`.

## Roadmap and open work

Done:

1. Read-only core: profiles, Tor transport, Esplora and node-RPC backends, descriptors, scan,
   status.
2. Electrum backend. XBT works through a BLAKE2b-aware server.
3. `plan`: unsigned PSBTs for the guided route.
4. `verify`: invariant checks, the unified-sighash vectors, and `testmempoolaccept` on your own
   nodes.
5. `broadcast` and `track`.
6. Local web UI and the Tor manager.

What's left, including the **release blockers** (live tests with real signers, pinning a Tor
release, confirming endpoints and checkpoints), is in [TODO.md](TODO.md). Please read it before
using forksplit with real coins.

## Project layout

```
main.ts                 CLI entry (`deno task cli`)
src/core/               profiles (pinned constants), config, descriptors, scan + coin state,
                        planner, PSBT encoder, signature checks, verify/broadcast/track
src/backends/           Esplora, Electrum and node-RPC clients
src/net/                SOCKS5/Tor routing policy, HTTP/1.1 client, Tor manager
src/cli/                command-line interface
src/ui/                 local web UI server, job runner, static assets
scripts/                fetch-tor / update-tor-manifest (bundled Tor)
testdata/               Knots unified-sighash vectors (166)
tests/                  unit + end-to-end tests (fake chains, fake Tor/SOCKS/Electrum/RPC)
tests/integration/      Docker regtest suite: compose file, node images, test profile, signers
vendor/tor-manifest.json  pinned Tor Expert Bundle hashes (Tor Browser 16.0 / tor 0.4.9.15)
```

## Development

```sh
deno install
deno task demo-ui # UI filled with in-memory test chains
deno task test    # unit + end-to-end tests against in-memory chains and a fake SOCKS proxy
deno task test:integration # regtest: real Core, Knots (BLAKE2b) and eCash nodes in Docker
deno task regtest # long-lived regtest environment with the web UI (see below)
deno task check
deno task lint
```

### Regtest integration suite

`deno task test:integration` needs Docker Compose v2, internet access for the first build and
roughly 5 minutes for it (the eCash node compiles from source). It builds three images, none of
which touches an existing container or volume:

| Chain | Node                                                                                |
| ----- | ----------------------------------------------------------------------------------- |
| BTC   | Bitcoin Core 31.0, official binary, pinned SHA-256                                  |
| XBT   | Bitcoin Knots 29.4.1.knots20260508, BLAKE2b from regtest height 110, pinned SHA-256 |
| ECX   | `ecash-com/bitcoin` at commit `c8474e0b` (reports eCash v1.2.0), built from source  |

The nodes share blocks 1 to 109, so the test coins exist at the same outpoint on all three chains,
then each mines its own chain. forksplit's real CLI runs against their JSON-RPC, and the suite
checks that each fork split is rejected by the other two nodes. It does this for eight wallets:
`pkh`, `wpkh`, `sh(wpkh)`, `tr` (key path), 2-of-3 `sh`, `wsh` and `sh(wsh)` `sortedmulti`, and a
mixed wallet whose single `--batch all` transaction per fork spends all seven of those script types
at once. Each run uses a random Compose project with fresh volumes and loopback-only ports, and
removes them afterwards. Regtest profiles exist only in test code (`registerProfileForTesting`); the
CLI, environment and UI cannot select one.

### Regtest playground: try it by hand

`deno task regtest` runs the same three nodes as a long-lived environment with stable ports, wires
the web UI to them, and lets you use your own regtest wallets (Sparrow, Shrike, ...) to sign. It
never touches Tor, mainnet data or other containers.

```sh
deno task regtest up                          # start the nodes, mine the shared history
deno task regtest fund '<your wallet descriptor>' --coins 2 --btc 1
deno task regtest fork                        # split the chains apart
deno task regtest ui                          # open the printed URL
```

**Order matters.** A coin is shared on all three chains only if it was created before the fork, so
`fund` must come before `fork` (it refuses afterwards). Up to 8 funding blocks fit before the fork.

1. **Create a regtest wallet** in Sparrow (network: regtest). Connect it to the BTC node: Server,
   Bitcoin Core, `127.0.0.1`, port `18443`, user `regtest`, password `regtest`. The XBT node is on
   `18543` (for the Sparrow BLAKE2b build) and the ECX node on `18643`.
2. **Copy the wallet's output descriptor** (Sparrow: Settings, Script Policy, or the descriptor
   export). It looks like `wpkh([fp/84h/1h/0h]tpub.../<0;1>/*)`. The regtest profile accepts
   `tpub`/`upub`/`vpub` and shows `bcrt1` addresses, so they match what your wallet displays.
3. **`fund` it** with that descriptor. The coins now exist on all three chains.
4. **`fork`**, then **`ui`**. In the UI: Network tab, check servers and confirm; Wallet tab, import
   the same descriptor and set a fork destination for ECX and XBT (use other wallets); Coins tab,
   scan (every coin shows `SHARED`); Plans tab, create a plan.
5. **Export** each PSBT from the Plans tab (binary or base64), **sign it in your wallet** (ECX: any
   signer; XBT: a signer that makes 0x21 signatures), save the result, and **import** it with the
   upload button. Then verify, broadcast and track.
6. **`verify` asks all three nodes.** The target chain must accept the transaction and the other two
   must reject it. `deno task regtest check <plan-id>` asks them again directly, independent of
   forksplit's own checks, and prints a table of what each node said.
7. **`mine`** to confirm what you broadcast (`deno task regtest mine all 1`). `reorg ecx 2` undoes
   two ECX blocks so you can see what `track` reports.

The node RPC ports bind to `127.0.0.1` by default. To reach them or the UI from another machine, use
an SSH tunnel with the same port numbers (`ssh -L 18080:127.0.0.1:18080 host`), or pass
`up --bind 0.0.0.0` on a network you trust: the RPC password (`regtest`) is public. The UI listens
on `127.0.0.1:18080` only, and accepts `localhost:18080` too, so a tunnel works.

`stop` pauses the nodes, `up` resumes them with the same chains, and `down` deletes everything
(containers, volumes and the playground's forksplit data under `.data/regtest/`).

## Credits and license

`src/core/unified_sighash.ts` and `testdata/unified_sighash.json` (166 Knots vectors) are vendored
from smolcars/bcashjr-wallet. Other parts are adapted from
[smolcars/bcashjr-wallet](https://github.com/smolcars/bcashjr-wallet) and
[smolcars/ecashjr-wallet](https://github.com/smolcars/ecashjr-wallet) (MIT, © 2026 Hampus Sjöberg):
byte helpers, the checkpoint-verification pattern, and Esplora response validation. See
`third_party/LICENSE.smolcars`.

License: MIT (see `LICENSE`).
