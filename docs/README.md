# forksplit documentation

Start with the [project README](../README.md) for what forksplit is and a quick start. Then pick
your path.

## I want to separate my coins

| Doc                                                    | Read it for                                           |
| ------------------------------------------------------ | ----------------------------------------------------- |
| [Web UI guide](user/web-ui-guide.md)                   | **Start here:** step-by-step with screenshots, no CLI |
| [User guide (CLI)](user/guide.md)                      | The same walkthrough from the command line            |
| [Signers](user/signers.md)                             | Which wallet signs which chain; air-gapped QR         |
| [Network and privacy](user/network-and-privacy.md)     | Tor, your own nodes, what is revealed                 |
| [Web UI](user/web-ui.md)                               | The browser interface                                 |
| [Recovery](user/recovery.md)                           | Reorgs, fee bumps (RBF), CPFP                         |
| [Advanced donor routes](user/advanced-donor-routes.md) | Stock hardware wallets for XBT; moving BTC first      |

## I want to understand or audit it

| Doc                                                 | Read it for                                         |
| --------------------------------------------------- | --------------------------------------------------- |
| [Transaction model](reference/transaction-model.md) | Replay protection, PSBT contents, verify, broadcast |
| [Security model](reference/security-model.md)       | Trust boundaries and pinned identity                |
| [CLI reference](reference/cli.md)                   | Every command and flag                              |

## I want to develop or test

| Doc                                             | Read it for                              |
| ----------------------------------------------- | ---------------------------------------- |
| [Regtest playground](dev/regtest-playground.md) | Real nodes and your own wallets, by hand |
| [Testing](dev/testing.md)                       | Unit tests and the Docker regtest suite  |
| [Architecture](dev/architecture.md)             | Project layout and modules               |
| [Releasing](dev/releasing.md)                   | Bundling Tor, building a release         |

## Project files

[TODO.md](../TODO.md) (open work and release blockers), [CHANGELOG.md](../CHANGELOG.md),
[SECURITY.md](../SECURITY.md).
