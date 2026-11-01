# Architecture

## Layout

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
third_party/            licenses for adapted code
```

## Core modules (`src/core/`)

| Module                                | Role                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------- |
| `profiles.ts`                         | Pinned replay constants, fork heights, checkpoint hashes. Not configurable. |
| `config.ts`, `store.ts`               | Network settings and atomic `0600` data files.                              |
| `descriptors.ts`, `wallet.ts`         | Descriptor parsing and address derivation.                                  |
| `scan.ts`, `state.ts`                 | Finding coins on all chains and classifying them.                           |
| `planner.ts`, `psbt.ts`, `tx.ts`      | Building replay-protected PSBTs (in-house encoder).                         |
| `sigcheck.ts`, `unified_sighash.ts`   | Signature verification and final tx assembly; the XBT unified digest.       |
| `execute.ts`                          | `verify`, `broadcast` and `track`.                                          |
| `bump.ts`                             | RBF and CPFP replacement plans.                                             |
| `donors.ts`, `origin.ts`, `fanout.ts` | Donor wallets, provenance proofs, fan-out.                                  |
| `ur.ts`                               | Uniform Resources / fountain coding for animated QR.                        |
| `identity.ts`                         | Backend chain-identity checks against checkpoints.                          |

## Backends and networking

`src/backends/` has Esplora, Electrum and node-RPC clients behind one interface. `src/net/` routes
every connection: Tor for public hosts, direct for local and LAN, no clearnet fallback, and an
HTTP/1.1 client written on raw connections so proxy environment variables don't apply. The Tor
manager starts and supervises splayed's own Tor.

## Web UI

`src/ui/server.ts` serves static assets and runs the same CLI commands as jobs, with prompts relayed
to the browser as dialogs. Its access controls are listed in [Web UI](../user/web-ui.md#security).

## Related

- [Transaction model](../reference/transaction-model.md)
- [Security model](../reference/security-model.md)
- [Testing](testing.md)
