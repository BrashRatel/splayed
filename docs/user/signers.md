# Signers

Splayed never holds keys. Your wallet signs the PSBTs it writes. Which wallet you can use depends on
the chain.

| Chain | Needs                                                      | Works with                                                                                        |
| ----- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| ECX   | Any signer. The marker is in the locktime and sequence.    | Everything, including stock hardware wallets.                                                     |
| XBT   | A signer that makes `SIGHASH_ALL\|SIGHASH_UNIFIED` (0x21). | Bitcoin Knots wallet, the Sparrow BLAKE2b build, Shrike, embit, privkeyio-firmware.               |
| BTC   | Any signer, after the forks are split and deep.            | Everything. Before that, use the [BTC-first route](advanced-donor-routes.md#the-btc-first-route). |

Tell `plan` which signer will sign XBT so the PSBT is shaped for it:

```sh
deno task cli plan --xbt-signer knots
```

Valid names: `knots`, `sparrow-blake2b`, `shrike`, `embit`, `privkeyio-firmware`.

## Stock hardware wallets and XBT

They can't make 0x21 signatures. Options:

- Use the [XBT donor route](advanced-donor-routes.md#the-xbt-donor-route), which needs only plain
  `SIGHASH_ALL`.
- Move the XBT copy with a software signer from the list above.

`verify` catches a signer that quietly signs plain `SIGHASH_ALL` for an XBT split, because such a
transaction would also be valid on BTC.

## Air-gapped signers (animated QR)

In the web UI each transaction has a **QR** button and a **Scan signed** button.

- **QR** plays the unsigned PSBT as a looping animation of QR codes (Uniform Resources, type
  `crypto-psbt`, the format Keystone, Passport, Jade, SeedSigner and others read).
- The signer shows its own animated QR codes for the signed transaction.
- **Scan signed** reads them through the camera and saves the result exactly like an uploaded file,
  so the usual `verify` follows.

Frames can be scanned in any order, repeated, or missed: the stream carries extra "fountain" frames,
and a misread frame is skipped.

Notes:

- Browsers only allow the camera on `localhost` or `127.0.0.1`, so open the UI there (not at a LAN
  address).
- Plain base64 QR codes and the BBQr format are not supported yet.
- The coding is in `src/core/ur.ts`, checked frame for frame against the reference implementation.
  QR drawing and reading use two small vendored libraries in `src/ui/static/vendor/` (pinned by
  checksum).
