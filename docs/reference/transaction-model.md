# Transaction model

How forksplit makes a coin that exists on several chains spendable on exactly one of them. Audience:
advanced users and auditors. Pinned constants live in `src/core/profiles.ts`; the planner is
`src/core/planner.ts`, the PSBT encoder `src/core/psbt.ts`, and signature checks
`src/core/sigcheck.ts`.

## The problem

Coins that existed before a fork exist on every chain at the same outpoint. An ordinary spend on one
chain can be **replayed** on the others, moving copies you meant to keep.

## The chains

|     | Last block shared with BTC | First own block                    | Replay protection                                                                              |
| --- | -------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| XBT | 961,631                    | 961,632 (BLAKE2b PoW from 961,640) | Opt-in per signature: `SIGHASH_UNIFIED` bit 0x20 (ALL becomes 0x21)                            |
| ECX | 973,727                    | 973,728                            | Opt-in per transaction: `nLockTime = 499,999,998` plus one input with `nSequence < 0xffffffff` |

Both protections are one-directional: they stop a fork transaction from replaying onto BTC, but an
ordinary BTC transaction still replays onto the forks. That is why the guided route splits the forks
first and leaves BTC alone, and why moving BTC first needs a
[BTC donor](../user/advanced-donor-routes.md#the-btc-first-route).

## What `plan` stamps on each fork's PSBTs

| Fork | Locktime    | Sequence                    | Sighash type                                           | Signer                                       |
| ---- | ----------- | --------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| ECX  | 499,999,998 | `0xfffffffd` on every input | not set                                                | any signer, including stock hardware wallets |
| XBT  | 0           | `0xfffffffd` on every input | `0x21` (`SIGHASH_ALL\|SIGHASH_UNIFIED`) on every input | must support SIGHASH_UNIFIED                 |

Each input also carries:

- BIP32 origins;
- the full previous transaction for non-Taproot inputs (hardware wallets need it);
- the redeem and witness scripts for multisig, plus `PSBT_GLOBAL_XPUB`.

`0xfffffffd` also signals RBF, which is what makes [fee bumps](../user/recovery.md) possible.

PSBTs are built in-house because general-purpose libraries reject sighash type 0x21. The ECX PSBTs
are tested against `@scure/btc-signer`, which signs them as a stock signer would; the signed
transaction keeps the replay marker and the predicted txid.

## Coin states

| Status       | Meaning                                                          |
| ------------ | ---------------------------------------------------------------- |
| `shared`     | Unspent on two or more chains                                    |
| `separated`  | Unspent on one chain; every other copy is deeply spent or absent |
| `pending`    | A spend is unconfirmed, shallow, or its depth can't be checked   |
| `unverified` | A chain couldn't be asked. Never treated as safe                 |
| `spent`      | Not unspent anywhere                                             |

"Deeply" means the per-chain depth set with `config confirmations <chain> N`.

## What `verify` checks

`verify` takes only signatures from the signer's file. Scripts, keys and amounts come from the
plan's own PSBTs. Each signed file is matched to its planned transaction by content, then:

1. The transaction must be identical to the plan: same inputs, sequences, outputs and locktime.
   Anything a signer changed (a fee bump, a swapped address) doesn't match.
2. ECX transactions must have locktime 499,999,998 and a non-final input sequence.
3. Every signature is checked against the digest its own chain will compute:
   - **ECX:** Bitcoin's legacy, BIP143 or BIP341 digest, with SIGHASH_ALL or DEFAULT only.
   - **XBT:** the Knots unified digest, and **every** signature must be 0x21. A signer that quietly
     signs SIGHASH_ALL instead is caught here, because that transaction would also be valid on BTC.
     The digest is checked against 166 Knots test vectors (`testdata/unified_sighash.json`).
4. The fee must equal the plan's, and the final txid must match.
5. If you configured your own node-RPC backends, each node is asked `testmempoolaccept` (nothing is
   broadcast). The target chain should accept. **Any other chain accepting means the transaction
   isn't replay-protected, and verification fails.** `--no-mempool` skips this step.

The final transaction is rebuilt canonically from the verified signatures.

For donor transactions, the signature rule changes: every signature must be plain `SIGHASH_ALL` (or
Taproot default), and the node checks (target accepts, others reject) are what prove replay safety.
See [Advanced donor routes](../user/advanced-donor-routes.md).

## What `broadcast` does

- It re-verifies the exact bytes, re-checks the broadcast backend's identity, and re-checks each
  input is still unspent on that chain.
- It saves progress to disk before sending.
- Each transaction goes only to its own chain, over its own Tor circuit.
- On each chain it sends the **TEST FIRST** (smallest) transaction alone and waits for it to confirm
  before sending the rest (`--all` overrides).
- An unknown result (timeout, Tor failure) is recorded as unknown, never as failed, and is safe to
  retry. Re-running is idempotent.
- In the BTC-first route, the XBT transaction is held back until the coin is gone from BTC and ECX.

## Esplora and spend detection

Esplora's `/tx/{txid}/outspend/{n}` reports "unspent" even for transactions that don't exist, so
existence is always checked first with `/tx/{txid}`. Node RPC without `txindex` can't report spend
depth or fetch previous transactions, so those coins stay `pending`.
