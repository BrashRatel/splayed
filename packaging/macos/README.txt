splayed {{VERSION}} for macOS
=============================

splayed finds your coins that exist on more than one chain (BTC, XBT, ECX) and writes unsigned
transactions that move them apart. It never holds your keys: your wallet signs. It is PRE-ALPHA
software that moves real coins, so start with a small amount.

NOTE: this macOS build has not been run on a Mac yet. If it will not start, please say so at
https://github.com/BrashRatel/splayed/issues (say which Mac and macOS version).


Start it
--------
1. Unpack the archive (double-click the .tar.gz) and move the folder somewhere you keep.
2. Right-click "Start splayed.command" and choose Open, then Open again in the dialog. (Double-click
   only works after the first time.)
3. A Terminal window opens, then your browser. If the browser does not open, copy the address shown
   in Terminal (it carries a one-time access token) into your browser. Use that exact address.
4. The first start takes a minute while splayed's own Tor connects. The page shows its progress.

Keep the Terminal window open while you use splayed. Closing it (or pressing Ctrl+C) stops splayed
and its Tor.


If macOS refuses to open it
---------------------------
The program is not signed or notarized by Apple, so macOS may block it ("cannot be opened", "is
damaged", or "unidentified developer"). First check the download (below). Then either:

- open System Settings > Privacy & Security, scroll to the message about "Start splayed.command" or
  "splayed", and click Open Anyway; or
- in Terminal, remove the download flag from the whole folder:

      xattr -dr com.apple.quarantine /path/to/this/folder

If "Start splayed.command" does not open at all, make it runnable first:

      chmod +x "/path/to/this/folder/Start splayed.command" /path/to/this/folder/splayed


Check the download first
------------------------
Compare the archive's SHA-256 with the line for it in SHA256SUMS on the release page:

    shasum -a 256 splayed-{{VERSION}}-macos-<arch>.tar.gz

SHA256SUMS is signed; see SECURITY.md in this folder for the key to check it against.


Keep the folder together
------------------------
"splayed" and the "vendor" folder (the bundled Tor) must stay side by side. If you move "splayed"
elsewhere, it cannot find Tor.


Where your data lives
---------------------
~/Library/Application Support/splayed

It holds your watch-only wallet, scan results and plans. It never holds seeds or private keys, but
it does reveal your addresses, so treat it like a wallet file and back it up. The "Burn history"
button in the web page erases it; so does `./splayed wipe`.


Command line
------------
In Terminal, from this folder:

    ./splayed --help

The web page runs the same commands.


Help
----
Full guide:   https://github.com/BrashRatel/splayed/blob/main/docs/user/web-ui-guide.md
Problems:     https://github.com/BrashRatel/splayed/issues
Security:     SECURITY.md in this folder
License:      LICENSE in this folder
