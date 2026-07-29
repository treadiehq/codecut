#!/usr/bin/env bash
#
# Build standalone Codecut binaries for all supported platforms.
#
# Output: dist/release/codecut-<os>-<arch>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENTRY="$ROOT/src/cli.ts"
OUT="$ROOT/dist/release"

command -v bun >/dev/null 2>&1 || {
  echo "Bun is required to build binaries. Install it: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
}

VERSION="$(bun -p "require('$ROOT/package.json').version")"
[ -n "$VERSION" ] || { echo "Could not read the package version." >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"

PLATFORMS=(
  "codecut-linux-x64:bun-linux-x64"
  "codecut-linux-arm64:bun-linux-arm64"
  "codecut-darwin-x64:bun-darwin-x64"
  "codecut-darwin-arm64:bun-darwin-arm64"
  "codecut-windows-x64.exe:bun-windows-x64"
)

echo "Building Codecut v$VERSION with Bun $(bun --version)"
for entry in "${PLATFORMS[@]}"; do
  NAME="${entry%%:*}"
  TARGET="${entry##*:}"
  OUTFILE="$OUT/$NAME"

  printf '  %-26s' "$NAME"
  unset BUN_NO_CODESIGN_MACHO_BINARY
  case "$NAME" in
    *darwin*) export BUN_NO_CODESIGN_MACHO_BINARY=1 ;;
  esac

  bun build "$ENTRY" \
    --compile \
    --target="$TARGET" \
    --outfile="$OUTFILE" \
    --define __CODECUT_VERSION__="\"$VERSION\"" >/dev/null

  case "$NAME" in
    *darwin*)
      if [ "$(uname -s)" = "Darwin" ]; then
        bash "$SCRIPT_DIR/adhoc-codesign-macos.sh" "$OUTFILE"
      fi
      ;;
  esac

  echo "done ($(du -h "$OUTFILE" | cut -f1))"
done

echo
echo "Binaries written to $OUT:"
ls -lh "$OUT"
