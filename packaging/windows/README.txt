splayed {{VERSION}} for Windows (x86_64)
=======================================

splayed finds your coins that exist on more than one chain (BTC, XBT, ECX) and writes unsigned
transactions that move them apart. It never holds your keys: your wallet signs. It is PRE-ALPHA
software that moves real coins, so start with a small amount.


Start it
--------
1. Unzip the whole folder somewhere you keep (not inside the zip, not on a network drive).
2. Double-click "Start splayed.cmd".
3. A black window opens, then your browser. If the browser does not open, copy the address shown in
   the window (it carries a one-time access token) into your browser. Use that exact address.
4. The first start takes a minute while splayed's own Tor connects. The page shows its progress.

Keep the black window open while you use splayed. Closing it stops splayed and its Tor.

If Windows says "Windows protected your PC" (SmartScreen): the program is not code-signed. Click
"More info", then "Run anyway", but only after you have checked the download (below).


Check the download first
------------------------
Compare the zip's SHA-256 with the line for it in SHA256SUMS on the release page:

    Get-FileHash .\splayed-{{VERSION}}-windows-x86_64.zip -Algorithm SHA256

(run in PowerShell). SHA256SUMS is signed; see SECURITY.md in this folder for the key to check it
against.


Keep the folder together
------------------------
splayed.exe and the "vendor" folder (the bundled Tor) must stay side by side. If you move
splayed.exe elsewhere, it cannot find Tor.


Where your data lives
---------------------
%APPDATA%\splayed  (paste that into the File Explorer address bar)

It holds your watch-only wallet, scan results and plans. It never holds seeds or private keys, but
it does reveal your addresses, so treat it like a wallet file and back it up. The "Burn history"
button in the web page erases it; so does `splayed.exe wipe`.


Command line
------------
Open PowerShell in this folder and run:

    .\splayed.exe --help

The web page runs the same commands.


Help
----
Full guide:   https://github.com/BrashRatel/splayed/blob/main/docs/user/web-ui-guide.md
Problems:     https://github.com/BrashRatel/splayed/issues
Security:     SECURITY.md in this folder
License:      LICENSE in this folder
