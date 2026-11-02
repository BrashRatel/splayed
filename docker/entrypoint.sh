#!/bin/sh
# No arguments: run the web UI in proxied mode (settings from the SPLAYED_UI_* environment).
# With arguments: run that splayed command, e.g. `docker compose run --rm splayed scan`.
set -eu

if [ "$#" -gt 0 ]; then
  exec splayed "$@"
fi

token_file="${SPLAYED_UI_TOKEN_FILE:-/data/ui-token}"
if [ ! -s "$token_file" ]; then
  splayed ui --new-token-file "$token_file"
  echo "Created the UI access token in $token_file (inside the container's data volume)."
fi
echo "Show it with:  docker compose exec splayed cat $token_file"
exec splayed ui
