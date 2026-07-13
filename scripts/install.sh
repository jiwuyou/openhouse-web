#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
HOME_DIR=${HOME:?HOME is required}
PREFIX_DIR=${PREFIX:-"$HOME_DIR/.local"}
INSTALL_DIR=${OPENHOUSE_WEB_INSTALL_DIR:-"$HOME_DIR/.local/lib/openhouse-web"}
BIN_DIR=${OPENHOUSE_WEB_BIN_DIR:-"$PREFIX_DIR/bin"}

command -v node >/dev/null 2>&1 || { printf 'ERROR: node is required\n' >&2; exit 1; }
case "$INSTALL_DIR" in
  /|"$HOME_DIR"|"$PREFIX_DIR") printf 'ERROR: unsafe install directory: %s\n' "$INSTALL_DIR" >&2; exit 1 ;;
esac

cd "$ROOT_DIR"
npm run build
parent=$(dirname -- "$INSTALL_DIR")
staging="${INSTALL_DIR}.staging.$$"
backup="${INSTALL_DIR}.backup.$$"
mkdir -p "$parent" "$BIN_DIR"
trap 'rm -rf "$staging" "$backup"' EXIT HUP INT TERM
cp -R "$ROOT_DIR/dist" "$staging"
if [ -e "$INSTALL_DIR" ]; then mv "$INSTALL_DIR" "$backup"; fi
if ! mv "$staging" "$INSTALL_DIR"; then
  [ ! -e "$backup" ] || mv "$backup" "$INSTALL_DIR"
  exit 1
fi
rm -rf "$backup"

launcher="$BIN_DIR/openhouse-web"
tmp_launcher="${launcher}.tmp.$$"
{
  printf '%s\n' '#!/bin/sh'
  printf '%s\n' 'set -eu'
  printf 'exec node %s/src/server.mjs "$@"\n' "$(printf '%s' "$INSTALL_DIR" | sed "s/'/'\\\\''/g")"
} >"$tmp_launcher"
chmod 755 "$tmp_launcher"
mv "$tmp_launcher" "$launcher"
printf 'Installed OpenHouse Web to %s\n' "$INSTALL_DIR"
