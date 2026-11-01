# Vendored browser libraries (QR codes)

Copied unmodified from the npm packages below. `SHA256SUMS` pins the files; `tests/ui_test.ts`
checks it, so a changed file fails the tests. To update, fetch the new version, review it, and
replace the files and the sums together.

| File      | Package            | Version | License                         |
| --------- | ------------------ | ------- | ------------------------------- |
| qrcode.js | `qrcode-generator` | 1.4.4   | MIT (notice in the file header) |
| jsQR.js   | `jsqr`             | 1.4.0   | Apache-2.0 (`jsQR.LICENSE`)     |

`qrcode.js` draws the animated QR codes that show a PSBT to an air-gapped signer. `jsQR.js` reads
the signer's QR codes through the camera. Neither sends anything anywhere; the camera is only opened
when you press "Scan signed PSBT", and the image never leaves the browser.
