# Security

forksplit builds and broadcasts transactions that move real coins. Please report vulnerabilities
privately to the maintainers, not in a public issue. Disclosure contact: **TBD (set before the
repository is made public).**

## Scope

The most sensitive parts:

- `src/core/sigcheck.ts`: signature verification and final transaction assembly.
- `src/core/planner.ts` and `src/core/psbt.ts`: replay markers, sighash types and PSBT contents.
- `src/core/profiles.ts`: pinned replay constants and chain checkpoints.
- `src/net/`: Tor/SOCKS routing, the no-clearnet-fallback policy, and the HTTP client.
- `src/ui/server.ts`: the local web UI's access controls.

## Known limitations

See TODO.md, sections 1 and 2. In short:

- Nothing has been tested against live servers, real signers, or a real Tor circuit yet.
- The bundled Tor isn't pinned yet.
