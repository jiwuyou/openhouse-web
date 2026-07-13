#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SM_URL=${SERVICE_MANAGER_URL:-http://127.0.0.1:20087}
TOKEN=${SERVICE_MANAGER_TOKEN:-}

if [ -z "$TOKEN" ] && command -v service-manager >/dev/null 2>&1; then
  TOKEN=$(service-manager token show 2>/dev/null | tr -d '\r\n' || true)
fi
[ -n "$TOKEN" ] || { printf 'ERROR: SERVICE_MANAGER_TOKEN is required\n' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { printf 'ERROR: curl is required\n' >&2; exit 1; }

work=$(mktemp -d "${TMPDIR:-/tmp}/openhouse-web-register.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
node -e '
  const fs = require("fs");
  const service = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const component = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  process.stdout.write(JSON.stringify({ components: [component], services: [service] }));
' "$ROOT_DIR/config/openhouse-web.service.json" "$ROOT_DIR/config/openhouse.component.json" >"$work/apply.json"
printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" >"$work/curl.conf"
printf '%s\n' 'header = "Content-Type: application/json"' >>"$work/curl.conf"
chmod 600 "$work/curl.conf" "$work/apply.json"
curl --fail --silent --show-error --config "$work/curl.conf" \
  --request POST --data-binary "@$work/apply.json" "$SM_URL/api/v1/registry/apply" >/dev/null
printf 'Registered openhouse-web with service-manager.\n'
