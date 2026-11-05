#!/bin/sh
# Starts splayed's web UI and opens it in your browser. Closing this window stops splayed.
cd "$(dirname "$0")" || exit 1
if [ ! -x ./splayed ]; then
  echo "splayed is not next to this file (or is not executable)."
  echo "Keep everything from the archive together in one folder."
  printf '\nPress Return to close. '
  read -r _
  exit 1
fi
echo "Starting splayed. Your browser should open in a moment."
echo "Keep this window open while you use splayed; close it to stop."
echo
./splayed ui --open
printf '\nsplayed has stopped. Press Return to close. '
read -r _
