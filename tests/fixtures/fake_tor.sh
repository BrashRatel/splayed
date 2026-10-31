#!/bin/sh
exec deno run -A "$(dirname "$0")/fake_tor.ts" "$@"
