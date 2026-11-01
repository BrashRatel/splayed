# Regtest playground: try it by hand

`deno task regtest` runs the same three nodes as the [integration suite](testing.md) as a long-lived
environment with stable ports, wires the web UI to them, and lets you use your own regtest wallets
(Sparrow, Shrike, ...) to sign. It never touches Tor, mainnet data or other containers. Needs Docker
Compose v2.

```sh
deno task regtest up                          # start the nodes, mine the shared history
deno task regtest fund '<your wallet descriptor>' --coins 2 --btc 1
deno task regtest fork                        # split the chains apart
deno task regtest ui                          # open the printed URL
```

**Order matters.** A coin is shared on all three chains only if it was created before the fork, so
`fund` must come before `fork` (it refuses afterwards). Up to 8 funding blocks fit before the fork.

## Walkthrough

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
   splayed's own checks, and prints a table of what each node said.
7. **`mine`** to confirm what you broadcast (`deno task regtest mine all 1`). `reorg ecx 2` undoes
   two ECX blocks so you can see what `track` reports.

The plans page of the playground UI has a "Regtest tools" card to mine blocks on each chain.

## Donors

`deno task regtest donors '<descriptor>'` mines XBT-only donors for a wallet; add `--chain btc` for
BTC-only donors. See [Advanced donor routes](../user/advanced-donor-routes.md).

## Networking

The node RPC ports bind to `0.0.0.0` by default, so a wallet on another machine on your LAN can
connect to `<this-host>:18443` (BTC), `18543` (XBT) and `18643` (ECX). The RPC password (`regtest`)
is public: use a network you trust, or pass `up --bind 127.0.0.1` to keep the ports on this machine.

`ui` listens on all interfaces too (test environment only: the real `splayed ui` is loopback-only).
Open `http://<this-host>:18080/#token=...` from the LAN, using the token it prints; it is plain
HTTP. `ui --bind 127.0.0.1` keeps it local, and then `ssh -L 18080:127.0.0.1:18080 host` works.

## Lifecycle

`stop` pauses the nodes, `up` resumes them with the same chains, and `down` deletes everything
(containers, volumes and the playground's splayed data under `.data/regtest/`).
