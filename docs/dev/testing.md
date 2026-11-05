# Testing

```sh
deno install
deno task test              # unit + end-to-end tests against in-memory chains and a fake SOCKS proxy
deno task test:integration  # regtest: real Core, Knots (BLAKE2b) and eCash nodes in Docker
deno task check             # type-check
deno task lint
deno task demo-ui           # UI filled with in-memory test chains
DEMO_LAN=1 deno task demo-ui  # the same, on the LAN (random token) to try from another machine
```

## Unit and end-to-end tests

`tests/` uses fake chains and fake Tor/SOCKS/Electrum/RPC servers (`tests/fakes.ts`), so nothing
touches the network. `testdata/unified_sighash.json` holds 166 Knots vectors for the XBT digest.

The end-to-end harness (`tests/e2e.ts`: a wallet, a scan and a written plan, plus signers) runs on
any of four backend kinds over the same fake chains: Esplora, Electrum (`FakeElectrumConn`, an
in-memory server that names spenders from the script history) and node RPC with and without
`txindex` (`FakeNodeRpcTransport`: `gettxout` sees the mempool, `getrawtransaction` finds a
confirmed transaction only with `txindex`, nothing names a spender). `setup({ backend })` picks one;
`useBackend(kind)` switches a running scenario, as a user or a fail-over would. Paths whose outcome
depends on what a backend can see (own spends, lost send replies, conflicts, the TEST FIRST
question) are tested on each: `tests/backends_e2e_test.ts`, `alerts_e2e_test.ts`,
`test_first_yes_test.ts`.

## Regtest integration suite

`deno task test:integration` needs Docker Compose v2, internet access for the first build and
roughly 5 minutes for it (the eCash node compiles from source); the run itself then takes about 10
minutes (135 steps). It builds three images, none of which touches an existing container or volume:

| Chain | Node                                                                                |
| ----- | ----------------------------------------------------------------------------------- |
| BTC   | Bitcoin Core 31.0, official binary, pinned SHA-256                                  |
| XBT   | Bitcoin Knots 29.4.1.knots20260508, BLAKE2b from regtest height 110, pinned SHA-256 |
| ECX   | `ecash-com/bitcoin` at commit `c8474e0b` (reports eCash v1.2.0), built from source  |

The nodes share blocks 1 to 109, so the test coins exist at the same outpoint on all three chains,
then each mines its own chain. splayed's real CLI runs against their JSON-RPC, and the suite checks
that each fork split is rejected by the other two nodes. It does this for eight wallets: `pkh`,
`wpkh`, `sh(wpkh)`, `tr` (key path), 2-of-3 `sh`, `wsh` and `sh(wsh)` `sortedmulti`, and a mixed
wallet whose single `--batch all` transaction per fork spends all seven of those script types at
once.

Each run uses a random Compose project with fresh volumes and loopback-only ports, and removes them
afterwards. Regtest profiles exist only in test code (`registerProfileForTesting`); the CLI,
environment and UI cannot select one.

To drive the same nodes by hand, use the [regtest playground](regtest-playground.md).
