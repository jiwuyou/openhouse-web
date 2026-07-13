#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
command -v node >/dev/null 2>&1 || { printf 'ERROR: node is required\n' >&2; exit 1; }
major=$(node -p 'Number(process.versions.node.split(".")[0])')
[ "$major" -ge 20 ] || { printf 'ERROR: Node >=20 is required\n' >&2; exit 1; }
cd "$ROOT_DIR"
npm run check
npm test
npm run build
npm run integration
printf 'OpenHouse Web checks passed.\n'
