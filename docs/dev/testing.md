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
`tests/vsize_estimate_test.ts` signs a one-input spend of every script kind and many m-of-n shapes
(1-of-2 up to 11-of-15) and checks the planner's size estimate never falls below the real size.

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
roughly 5 minutes for it (the eCash node compiles from source); the run itself (190 steps) then
takes about 3 minutes with warm Docker caches, and one earlier run took 10. It builds three images,
none of which touches an existing container or volume:

| Chain | Node                                                                                |
| ----- | ----------------------------------------------------------------------------------- |
| BTC   | Bitcoin Core 31.0, official binary, pinned SHA-256                                  |
| XBT   | Bitcoin Knots 29.4.1.knots20260508, BLAKE2b from regtest height 110, pinned SHA-256 |
| ECX   | `ecash-com/bitcoin` at commit `c8474e0b` (reports eCash v1.2.0), built from source  |

The nodes share blocks 1 to 109, so the test coins exist at the same outpoint on all three chains,
then each mines its own chain. splayed's real CLI runs against their JSON-RPC, and the suite checks
that each fork split is rejected by the other two nodes. It does this for eleven wallets: `pkh`,
`wpkh`, `sh(wpkh)`, `tr` (key path), 2-of-3 `sh`, `wsh` and `sh(wsh)` `sortedmulti`, three more
quorum shapes (3-of-5 `wsh`, 2-of-2 `sh(wsh)`, 3-of-4 `sh`), and a mixed wallet whose single
`--batch all` transaction per fork spends all seven of the first script types at once.

Per wallet, ECX is signed by **hardware-style devices** (`hardwareStyleSign` in
`tests/integration/signers.ts`): one device per master key, each signing the same unsigned PSBT on
its own into its own file, as a multisig user would. These devices are stricter than software. They
refuse unless every input has the previous transaction (hashing to the outpoint) or, for Taproot,
the previous output; the redeem and witness scripts hash to the output script; the Taproot output
key is the tweak of the internal key; a multisig's cosigner keys all have key origins; the sighash
type is plain ALL; every output goes to a destination they were shown; and the fee is sane. The
suite also checks that each refusal fires. XBT is signed with a 0x21 signer, and every transaction's
planned size and fee are compared with what the node mined: never below the real size, a little
above it, and the rate paid at least the rate asked for.

**The nodes' own wallets sign too.** In a second pass every wallet is signed again from scratch (all
signed files and the earlier verification deleted) by the real signing code of the nodes: each
cosigner is a descriptor wallet holding only its own key, ECX is signed by Bitcoin Core and the
eCash node in turn, XBT by Bitcoin Knots. `verify` must then accept them and report every
transaction as verified, since it exits 0 for a transaction it has no signed file for.

**Node RPC with and without `-txindex`** (`rpc_paths.ts`, two passes). With: the real nodes.
Without: the same nodes, with the test transport answering as a node run without `-txindex` would
(`getindexinfo` empty, `getrawtransaction` only for mempool transactions, with Core's error). Three
scenarios each: a send whose reply is lost (the node got it, splayed did not hear back) is found
again and not sent twice, and is held, not sent and not called a conflict, when it can no longer be
seen; the tool's own fee bump is recognised as `REPLACED`, never a conflict; a stranger's spend of
the coin means nothing is sent and the plan entry is a conflict (naming the spender only where the
node can).

To run only some wallets while changing them, set `SPLAYED_IT_WALLETS=name,name` (the wallet names
in the output) and `SPLAYED_IT_WALLETS_ONLY=1` to skip the longer scenarios after them;
`SPLAYED_IT_SCENARIOS=rpc-paths` (with `SPLAYED_IT_WALLETS=` empty) runs just the node-RPC
scenarios. In CI (`.github/workflows/ci.yml`) the `regtest` job runs the whole suite on pull
requests, on `main` and by hand.

Each run uses a random Compose project with fresh volumes and loopback-only ports, and removes them
afterwards. Regtest profiles exist only in test code (`registerProfileForTesting`); the CLI,
environment and UI cannot select one.

To drive the same nodes by hand, use the [regtest playground](regtest-playground.md).
