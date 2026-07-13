#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
OUTPUT=${1:-"$ROOT_DIR/openhouse-web.tar"}
cd "$ROOT_DIR"
npm run check
npm test
npm run build
tmp="${OUTPUT}.tmp.$$"
trap 'rm -f "$tmp"' EXIT HUP INT TERM
tar --format=ustar --sort=name --mtime='UTC 2020-01-01' \
  --owner=0 --group=0 --numeric-owner \
  -cf "$tmp" -C "$ROOT_DIR/dist" .
mv "$tmp" "$OUTPUT"
if command -v sha256sum >/dev/null 2>&1; then sha256sum "$OUTPUT"; fi
