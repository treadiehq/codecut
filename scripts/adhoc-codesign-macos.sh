#!/usr/bin/env bash
#
# Ad-hoc sign a macOS binary produced by `bun build --compile`.
#
set -euo pipefail

BIN="${1:?usage: adhoc-codesign-macos.sh <binary>}"

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

codesign --force --sign - "$BIN"
codesign --verify --strict "$BIN"
