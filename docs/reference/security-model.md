# Security model

To report a vulnerability, see [SECURITY.md](../../SECURITY.md). Known gaps and release blockers are
in [TODO.md](../../TODO.md).

## Keyless

forksplit never asks for, accepts or stores seeds or private keys. It reads your wallet through
xpub-based (watch-only) descriptors, and your own (cold) wallet signs the PSBTs it builds. Private
keys in a descriptor are refused.

## Network identity

The replay constants, fork heights and checkpoint block hashes are compiled in
(`src/core/profiles.ts`) and can't be edited by configuration. Before a backend is used, and again
on every scan, it must report the pinned hash at every checkpoint:

- BTC: 961,640 and 973,728;
- XBT: 961,640;
- ECX: 973,728 and 974,017. The second rejects ECX nodes still on v1.0.0.

This also stops a BTC explorer being used as the XBT backend: they run the same software.

Regtest profiles exist only in test code (`registerProfileForTesting`); the CLI, environment and UI
cannot select one.

## Privacy

See [Network and privacy](../user/network-and-privacy.md) for the user-facing details. In short:
nothing leaves before you confirm, Tor by default with no clearnet fallback, Tor-side DNS, a
separate circuit per chain and broadcast, shuffled and jittered queries, and no `fetch()` so proxy
environment variables can't reroute traffic.

## Transactions

- PSBTs are built in-house (`src/core/psbt.ts`) because general-purpose libraries reject sighash
  type 0x21.
- `verify` rebuilds the final transaction from verified signatures and, with your own nodes, checks
  that every other chain rejects it. See the [transaction model](transaction-model.md).
- `broadcast` re-verifies, re-checks identity and unspent state, and persists progress before
  sending. Unknown outcomes are never recorded as failures.
- Donor spends are only allowed for donors with provable origin (see
  [Advanced donor routes](../user/advanced-donor-routes.md)).

## Files

Data files are written atomically with `0600` permissions. RPC passwords are never stored, only the
name of the environment variable that holds them, or a cookie file path.

## Web UI

The UI is loopback-only with a fragment token, Host checking, same-origin JSON POSTs, a strict CSP
and text-only rendering. The full list is in [Web UI](../user/web-ui.md#security). The regtest
playground's UI binds to all interfaces by default; it is a test environment only.

## Most sensitive code

- `src/core/sigcheck.ts`: signature verification and final transaction assembly.
- `src/core/planner.ts` and `src/core/psbt.ts`: replay markers, sighash types and PSBT contents.
- `src/core/profiles.ts`: pinned replay constants and chain checkpoints.
- `src/net/`: Tor/SOCKS routing, the no-clearnet-fallback policy, and the HTTP client.
- `src/ui/server.ts`: the local web UI's access controls.
