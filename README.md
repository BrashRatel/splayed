# forksplit

Watch-only tool for separating the **BTC**, **XBT** (Bitcoin BLAKE2b) and **ECX** (eCash) copies of
the same coins after the 2026 forks.

Coins that existed before a fork exist on both chains at the same outpoint. An ordinary spend on one
chain can be **replayed** on the others, moving the copies you meant to keep. forksplit finds your
coins on all three chains, tells you which ones are still shared, and (in later milestones) builds
replay-protected PSBTs for you to sign in your own wallet.

> **Status: milestone 2.** `init`, `import`, `scan`, `status`, `dest` and `plan` work with
> Esplora, Electrum and node-RPC backends. `plan` writes **unsigned** PSBTs; nothing in this
> version signs or broadcasts, so it cannot move funds. `verify` and `broadcast` come next.

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

Tor must be listening on `127.0.0.1:9050`. If you use the Tor Browser, run
`deno task cli config tor 127.0.0.1:9150`.

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

A backend you add is tried before the profile default, which is kept as a lower-priority
backend (`--priority` changes the order). With node RPC, `txindex=1` lets forksplit report how
deep a spend is and fetch previous transactions for PSBTs. Without it, a spent coin shows
as "spent/absent ?" and stays **pending**.

### Import and scan

```sh
deno task cli import "wpkh([d34db33f/84h/0h/0h]xpub6.../<0;1>/*)#checksum" --label cold
deno task cli scan
deno task cli status        # or: status --json
```

`import` prints the first address of each branch. Check they match your wallet.

Supported descriptors:

- `pkh`, `wpkh`, `sh(wpkh)` and `tr` (key path);
- `wsh` and `sh(wsh)` with `multi` or `sortedmulti`.

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

| Fork | Locktime | Sequence | Sighash type | Signer |
|---|---|---|---|---|
| ECX | 499,999,998 | `0xfffffffd` on every input | not set | any signer, including stock hardware wallets |
| XBT | 0 | `0xfffffffd` on every input | `0x21` (`SIGHASH_ALL\|SIGHASH_UNIFIED`) on every input | must support SIGHASH_UNIFIED |

Each input carries:
- BIP32 origins;
- the full previous transaction for non-Taproot inputs (hardware wallets need it);
- the redeem and witness scripts for multisig, plus `PSBT_GLOBAL_XPUB`.

Options:
- `--batch coin` (default) keeps coins unlinked. `--batch address`, `--batch N` and
  `--batch all` combine coins, and the summary says which addresses that links publicly.
- Fees come from `--fee-rate` or the backend's 6-block estimate. A batch whose fee would be over
  10% of its value is skipped.

The smallest transaction on each chain is marked **TEST FIRST**. Destination addresses are
reserved, so re-planning never reuses one.

Plans go to `<data dir>/plans/<id>/` (`ecx/*.psbt`, `xbt/*.psbt`, `plan.json`, `README.txt`).

## Security model

- **Watch-only.** No seeds or private keys are ever accepted.
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
- **PSBTs are built in-house** (`src/core/psbt.ts`): general-purpose libraries reject sighash
  type 0x21. The ECX PSBTs are tested against `@scure/btc-signer`, which signs them as a stock
  signer would; the signed transaction keeps the replay marker and the predicted txid.
- **No fetch().** HTTP goes over connections the tool opens itself, so `HTTP(S)_PROXY` environment
  variables can't silently reroute traffic.
- **The Esplora trap.** `/tx/{txid}/outspend/{n}` reports "unspent" even for transactions that don't
  exist, so existence is always checked first with `/tx/{txid}`.
- **Private files.** Data files are written atomically with `0600` permissions. RPC passwords are
  never stored, only the name of the environment variable that holds them, or a cookie file path.

Data directory: `~/.local/share/forksplit` (Linux), `~/Library/Application Support/forksplit`
(macOS) or `%APPDATA%\forksplit` (Windows). Override with `--data-dir` or `FORKSPLIT_DATA_DIR`.

## Before a release

- Confirm both onion addresses against the operators' own published links.
- Re-check each pinned hash from a second independent source:
  - ECX 974,017: from esplora.ecash.ninja or your own v1.1.0 node;
  - the BTC, XBT and ECX fork hashes copied from the smolcars repos.
- Check explorer.ecash.com accepts requests from Tor exits.

## Roadmap

1. ~~Read-only core: profiles, Tor transport, Esplora and node RPC backends, descriptors, scan,
   status~~
2. Electrum backend (XBT needs a BLAKE2b-aware server with 164-byte headers)
3. `plan`: unsigned PSBTs for the guided route
4. `verify`: invariant checks on signed PSBTs, including the unified-sighash vectors and
   `testmempoolaccept` on your nodes
5. `broadcast`: persist first, then re-check identity, then send through an isolated circuit
6. Local web UI on the same core; bundled Tor
7. Advanced donor-input routes (opt-in)

## Development

```sh
deno task test    # unit + end-to-end tests against in-memory chains and a fake SOCKS proxy
deno task check
deno task lint
```

## Credits and license

Parts are adapted from [smolcars/bcashjr-wallet](https://github.com/smolcars/bcashjr-wallet) and
[smolcars/ecashjr-wallet](https://github.com/smolcars/ecashjr-wallet) (MIT, © 2026 Hampus Sjöberg):
byte helpers, the checkpoint-verification pattern, and Esplora response validation. See
`third_party/LICENSE.smolcars`.

License: MIT (see `LICENSE`).
