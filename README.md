# splayed

Keyless tool for separating the **BTC**, **XBT** (Bitcoin BLAKE2b) and **ECX** (eCash) copies of the
same coins after the 2026 forks: splayed builds replay-protected PSBTs, your (cold) wallet signs
them, and splayed verifies and broadcasts each split only to its own chain, over Tor.

Coins that existed before a fork exist on both chains at the same outpoint. An ordinary spend on one
chain can be **replayed** on the others, moving the copies you meant to keep. splayed finds your
coins on all three chains, tells you which ones are still shared, and walks each shared coin through
plan → sign (in your wallet) → verify → broadcast. Your keys never leave your wallet.

> **Status: pre-alpha.** The full guided route works end to end against real Bitcoin Core, Knots and
> eCash nodes on regtest, and has split real UTXOs on mainnet (ECX and XBT away from BTC, BTC
> confirmed untouched). It is **not security-reviewed**: start with one small coin/utxo, and read
> the [release notes](docs/release-notes/0.1.0-pre-alpha.1.md) and [TODO.md](TODO.md) first. Testers
> wanted: please file a [tester report](https://github.com/BrashRatel/splayed/issues/new/choose).

## How it works

|     | First own block | Replay protection                                                       |
| --- | --------------- | ----------------------------------------------------------------------- |
| XBT | 961,632         | Opt-in per signature: `SIGHASH_UNIFIED` (ALL becomes 0x21)              |
| ECX | 973,728         | Opt-in per transaction: `nLockTime = 499,999,998` and a non-final input |

Both protections are one-directional: they stop a fork transaction replaying onto BTC, but an
ordinary BTC transaction still replays onto the forks. So the guided route is **forks first, BTC
last**:

1. **ECX:** send each shared coin to yourself with the ECX marker. Any signer works.
2. **XBT:** send it to yourself with a 0x21 signature. This needs a
   [supported signer](docs/user/signers.md); stock hardware wallets can use the
   [donor route](docs/user/advanced-donor-routes.md).
3. **BTC:** once both splits are deeply confirmed, spend the BTC copy normally.

## Quick start

### Docker

Runs the web UI in a container with Tor inside; your data lives in a volume. See
[Docker](docs/user/docker.md).

```sh
docker compose -f docker/compose.yml up -d --build
docker compose -f docker/compose.yml exec splayed cat /data/ui-token   # your access token
```

Then open <http://localhost:8080/> and paste the token.

### StartOS

Install the `.s9pk` for your server's architecture (x86_64 or aarch64) from the
[releases page](https://github.com/BrashRatel/splayed/releases), or build it from
[splayed-startos](https://github.com/BrashRatel/splayed-startos). It runs the web UI behind the
StartOS proxy, reaches public servers over the Tor service, and detects/uses your Bitcoin node (and
chain).

### Release binary

No Deno install needed; Tor is bundled. Archives are published for Linux x86_64 and aarch64, macOS
arm64 and x86_64, and Windows x86_64 on the
[releases page](https://github.com/BrashRatel/splayed/releases) (pre-alpha releases aren't marked
"latest" on GitHub, so go there directly). Only the Linux x86_64 one has been run from a clean
extract so far. Download, verify, then run; Linux x86_64 shown, other platforms are the same with
their archive name:

```sh
curl -LO https://github.com/BrashRatel/splayed/releases/download/v0.1.0-pre-alpha.1/splayed-0.1.0-pre-alpha.1-linux-x86_64.tar.gz
curl -LO https://github.com/BrashRatel/splayed/releases/download/v0.1.0-pre-alpha.1/SHA256SUMS
curl -LO https://github.com/BrashRatel/splayed/releases/download/v0.1.0-pre-alpha.1/SHA256SUMS.asc
sha256sum -c --ignore-missing SHA256SUMS   # check the download
gpg --verify SHA256SUMS.asc SHA256SUMS  # check it against the key in SECURITY.md
tar xzf splayed-0.1.0-pre-alpha.1-linux-x86_64.tar.gz
cd splayed-0.1.0-pre-alpha.1-linux-x86_64
```

Then run the same commands as below, with `./splayed` in place of `deno task cli` (and
`./splayed ui` in place of `deno task ui`).

The Windows and macOS archives skip the terminal: they hold a `README.txt` for that platform and a
launcher, `Start splayed.cmd` (Windows) or `Start splayed.command` (macOS, right-click and Open the
first time), that starts the web UI and opens it in your browser. The README covers the SmartScreen
and Gatekeeper prompts for these unsigned builds, checking the download, and where your data lives.

### From source (any platform Deno supports)

Requires [Deno 2.x](https://deno.com).

```sh
deno install
deno task cli init                   # review where queries go (Tor by default), then confirm
deno task cli import "wpkh([fp/84h/0h/0h]xpub.../<0;1>/*)" --label cold
deno task cli scan                   # find your coins on all three chains
deno task cli dest set ecx "wpkh([fp/84h/0h/0h]xpub.../0/*)"    # where split coins go
deno task cli dest set xbt "tr([fp/86h/0h/0h]xpub.../0/*)"
deno task cli plan --xbt-signer knots                 # write unsigned PSBTs
# sign each PSBT in your wallet, save as <name>.signed.psbt, then:
deno task cli verify <plan-id>
deno task cli broadcast <plan-id>    # each chain's TEST FIRST transaction goes first, alone
deno task cli track <plan-id>
deno task cli broadcast <plan-id>    # says where the test is, asks, then sends the rest
```

Prefer a browser? `deno task ui` (or `./splayed ui` for the release binary) runs the same steps in a
local web UI.

## Documentation

See [docs/](docs/README.md) for everything below.

| I want to...                                           | Read                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Separate my coins, step by step with screenshots       | [Web UI guide](docs/user/web-ui-guide.md)                                |
| Do the same from the command line                      | [User guide (CLI)](docs/user/guide.md)                                   |
| Know which wallet can sign what                        | [Signers](docs/user/signers.md)                                          |
| Use my own nodes or tune Tor and privacy               | [Network and privacy](docs/user/network-and-privacy.md)                  |
| Use the browser UI or an air-gapped signer             | [Web UI](docs/user/web-ui.md)                                            |
| Run it in Docker                                       | [Docker](docs/user/docker.md)                                            |
| Run it on StartOS                                      | [splayed-startos](https://github.com/BrashRatel/splayed-startos)         |
| Fix a stuck transaction or handle a reorg              | [Recovery](docs/user/recovery.md)                                        |
| Use a stock hardware wallet for XBT, or move BTC first | [Advanced donor routes](docs/user/advanced-donor-routes.md)              |
| Understand the transactions and what is verified       | [Transaction model](docs/reference/transaction-model.md)                 |
| Audit the trust boundaries                             | [Security model](docs/reference/security-model.md)                       |
| Look up a command or flag                              | [CLI reference](docs/reference/cli.md)                                   |
| Try it on regtest with my own wallets                  | [Regtest playground](docs/dev/regtest-playground.md)                     |
| Run tests or work on the code                          | [Testing](docs/dev/testing.md), [Architecture](docs/dev/architecture.md) |

## Security in brief

- **Keyless:** seeds and private keys are never requested, accepted or stored. Your wallet signs.
- **Pinned chain identity:** fork heights, replay constants and checkpoint hashes are compiled in,
  and every backend is checked against them.
- **Private by default:** nothing is sent before you confirm network settings; public hosts are
  reached over Tor with no clearnet fallback.
- **Verified before broadcast:** signed transactions must match the plan, keep their replay
  protection, and (with your own nodes) be rejected by every other chain.

Details in the [security model](docs/reference/security-model.md). Report vulnerabilities as
described in [SECURITY.md](SECURITY.md).

## Project

Open work: [TODO.md](TODO.md) (finished items: [dev archive](docs/dev/todo-archive.md)). History:
[CHANGELOG.md](CHANGELOG.md).

## Credits and license

`src/core/unified_sighash.ts` and `testdata/unified_sighash.json` (166 Knots vectors) are vendored
from smolcars/bcashjr-wallet. Other parts are adapted from
[smolcars/bcashjr-wallet](https://github.com/smolcars/bcashjr-wallet) and
[smolcars/ecashjr-wallet](https://github.com/smolcars/ecashjr-wallet) (MIT, © 2026 Hampus Sjöberg):
byte helpers, the checkpoint-verification pattern, and Esplora response validation. See
`third_party/LICENSE.smolcars`.

License: MIT (see `LICENSE`).
