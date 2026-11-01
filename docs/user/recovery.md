# Recovery: reorgs and stuck transactions

## Reorgs

`track` remembers the block each split was confirmed in. If a later `track` finds that a split that
was confirmed has changed, it says so loudly and exits with status 1:

| What happened                                                                                    | What `track` says                                                         |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Re-mined in a different block (a reorg)                                                          | `REORG`, with the old and new block. Still confirmed; depth restarts      |
| Back in the mempool                                                                              | `REORG`: back in the mempool                                              |
| Gone from the chain and the mempool, input unspent again                                         | `REORG`: the coin is shared with BTC again. `broadcast` can send it again |
| Input spent by a different transaction (an outside spend, or a BTC spend replayed onto the fork) | `CONFLICT`. The split is marked conflicting and will not be re-sent       |

Until every split is confirmed again, leave the BTC copies alone. `scan` also warns when a spend it
saw last time has disappeared or been replaced by a different transaction.

Reorg detection needs a backend that can report a transaction's own status: Esplora, Electrum, or
node RPC. Node RPC without `txindex` can't tell a confirmed transaction from one that never existed,
so `track` shows `unknown` rather than guessing.

## Stuck transactions: fee bump (RBF)

Every planned transaction signals RBF. If one is stuck at too low a fee:

```sh
deno task cli bump <plan> --fee-rate ecx=6,xbt=8   # or leave --fee-rate off for an estimate
deno task cli verify <plan>-bump1
deno task cli broadcast <plan>-bump1
```

`bump` writes a new plan whose transactions spend the **same inputs** to the **same destination** at
a higher fee, from the original's own unsigned PSBT. Only the output value changes: inputs,
sequences, locktime (the ECX marker) and the 0x21 request are copied, so the replacement is
replay-protected exactly like the original. Sign it in your wallet and `verify` it like any plan.

- It must follow BIP125: at least the old fee plus 1 sat/vB for its own size. A lower `--fee-rate`
  is refused, and the message says the minimum.
- Only transactions that are broadcast and not yet confirmed can be bumped. A confirmed one, one
  whose input was spent by something else, or one already replaced is refused.
- `--chains ecx` and `--tx N` limit what is bumped. Without `--fee-rate`, the rate is the backend's
  estimate, at least 1.5x the old rate.
- When the replacement is sent, the original is marked `replaced` and `track` shows
  `REPLACED by plan ...`. If the original confirms first, the replacement is refused and `track`
  says so.
- Fee bumps are not supported for BTC transactions yet.

### Dropping a coin from a batch

A `--batch all` transaction replaces as a whole. To bump it without one of its coins, name that
coin:

```sh
deno task cli bump <plan> --tx 1 --drop txid:vout [--drop ...]
```

The dropped coin is not spent by the replacement and stays available for a later plan. At least one
input must stay (that is what makes it a replacement) and a donor input can't be dropped. The
replacement is sized for the smaller transaction, and still has to beat the original's fee.

## Child pays for parent (CPFP)

If the original can't be replaced (a node without full RBF and a transaction that didn't signal it),
lift it from below instead:

```sh
deno task cli bump <plan> --cpfp --tx 1 --fee-rate ecx=20,xbt=20   # the rate for the PAIR
```

This writes a child that spends the split's output to a fresh address of the same destination, so
parent and child together pay about that rate. Sign it with the **destination** wallet (it spends
the split's output), then `verify` and `broadcast` the new `-cpfp` plan. The child can only exist on
its parent's chain, so it needs no replay protection of its own: an XBT child is signed with plain
`SIGHASH_ALL`.
