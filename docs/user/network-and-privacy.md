# Network and privacy

How forksplit talks to the chains, what it reveals, and how to point it at your own nodes.

## Defaults

Public servers reached **over Tor**, failing closed if Tor isn't running:

| Chain | Default (Esplora API)                                            |
| ----- | ---------------------------------------------------------------- |
| BTC   | mempool.space onion                                              |
| XBT   | mempool.guide onion                                              |
| ECX   | `https://explorer.ecash.com/api` via a Tor exit (no onion known) |

`init` shows where queries will go and asks before contacting anything. It sends only the chain tip
and a few fixed block hashes. Importing and scanning stay disabled until you confirm, and changing
any network setting closes the gate again.

## Privacy defaults

- Nothing coin-related leaves the machine before network settings are confirmed.
- Tor is the default for public hosts, and there's no clearnet fallback.
- DNS is resolved by Tor (SOCKS5 domain addressing).
- Each chain and each broadcast gets a separate Tor circuit (SOCKS credential isolation).
- Queries are shuffled and jittered.
- `status` reports how many addresses were revealed to remote servers.
- HTTP goes over connections the tool opens itself (no `fetch()`), so `HTTP(S)_PROXY` environment
  variables can't silently reroute traffic.

## Tor

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

Maintainers bundling Tor: see [Releasing](../dev/releasing.md).

## Using your own nodes

Each chain has its own backend list. Local and LAN hosts are reached directly; everything else goes
through Tor unless you opt that chain into clearnet (`config clearnet <chain> on`).

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

- **Adding your own backend for a chain removes that chain's profile default**, so the default is
  never contacted. `config backend fallback` and `config backend reset` bring defaults back.
- Backends are tried in priority order and the tool stops at the first that passes its identity
  check; lower ones are contacted only if every backend above them failed.
- With node RPC, `txindex=1` lets forksplit report how deep a spend is and fetch previous
  transactions for PSBTs. Without it, a spent coin shows as "spent/absent ?" and stays **pending**.
- Configuring your own node-RPC backends also lets `verify` ask `testmempoolaccept` on every chain.
- RPC passwords are never stored, only the name of the environment variable that holds them, or a
  cookie file path.

## Chain identity checks

Each backend must report the pinned block hash at every checkpoint, before use and on every scan.
This also stops a BTC explorer being used as the XBT backend. The checkpoints are listed in the
[security model](../reference/security-model.md#network-identity).

## Data directory

`~/.local/share/forksplit` (Linux), `~/Library/Application Support/forksplit` (macOS) or
`%APPDATA%\forksplit` (Windows). Override with `--data-dir` or `FORKSPLIT_DATA_DIR`. Files are
written atomically with `0600` permissions.
