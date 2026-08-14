#!/usr/bin/env bash
#
# Download the Codecut binary and install it on PATH.
#
#   curl -fsSL https://raw.githubusercontent.com/treadiehq/codecut/main/scripts/install.sh | bash
#
# Environment overrides:
#   CODECUT_VERSION   release tag to install, e.g. v0.1.0 (default: latest)
#   CODECUT_BIN_DIR   installation directory
#   CODECUT_REPO      owner/repo to download from (default: treadiehq/codecut)
#
set -euo pipefail

REPO="${CODECUT_REPO:-treadiehq/codecut}"
VERSION="${CODECUT_VERSION:-latest}"
BIN_NAME="codecut"

if [ -t 1 ]; then
  bold=$(printf '\033[1m'); dim=$(printf '\033[2m'); green=$(printf '\033[32m')
  red=$(printf '\033[31m'); reset=$(printf '\033[0m')
else
  bold=""; dim=""; green=""; red=""; reset=""
fi
say() { printf '%s\n' "${dim}→${reset} $*"; }
ok() { printf '%s\n' "${green}✓${reset} $*"; }
die() { printf '%s\n' "${red}✗${reset} $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but was not found on PATH."; }

need curl

OS="$(uname -s)"
case "$OS" in
  Linux) OS="linux" ;;
  Darwin) OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    die "This is the Unix installer. On Windows, run:
  irm https://raw.githubusercontent.com/${REPO}/main/scripts/install.ps1 | iex" ;;
  *) die "Unsupported OS: $OS (Codecut supports Linux, macOS, and Windows)." ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) die "Unsupported architecture: $ARCH (Codecut supports x64 and arm64)." ;;
esac

ASSET="${BIN_NAME}-${OS}-${ARCH}"
if [ "$VERSION" = "latest" ]; then
  RELEASE_URL="https://github.com/${REPO}/releases/latest/download"
else
  RELEASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
fi
URL="${RELEASE_URL}/${ASSET}"
CHECKSUM_URL="${RELEASE_URL}/SHA256SUMS"

if [ -n "${CODECUT_BIN_DIR:-}" ]; then
  BIN_DIR="$CODECUT_BIN_DIR"
elif [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
  BIN_DIR="/usr/local/bin"
else
  BIN_DIR="$HOME/.local/bin"
fi
mkdir -p "$BIN_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading ${bold}${ASSET}${reset} (${VERSION})…"
if ! curl -fSL --progress-bar "$URL" -o "$TMP/$BIN_NAME"; then
  die "Could not download $URL
Check available releases: https://github.com/${REPO}/releases"
fi
if ! curl -fsSL "$CHECKSUM_URL" -o "$TMP/SHA256SUMS"; then
  die "Could not download checksums from $CHECKSUM_URL; the existing install was left untouched."
fi

EXPECTED="$(awk -v asset="$ASSET" '$2 == asset { print $1; exit }' "$TMP/SHA256SUMS")"
case "$EXPECTED" in
  ""|*[!0-9a-fA-F]*)
    die "SHA256SUMS does not contain a valid checksum for $ASSET; the existing install was left untouched." ;;
esac
[ "${#EXPECTED}" -eq 64 ] ||
  die "SHA256SUMS does not contain a valid checksum for $ASSET; the existing install was left untouched."

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP/$BIN_NAME" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TMP/$BIN_NAME" | awk '{print $1}')"
else
  die "sha256sum or shasum is required to verify the Codecut download."
fi
if [ "$ACTUAL" != "$EXPECTED" ]; then
  die "Checksum verification failed for $ASSET; the existing install was left untouched."
fi
ok "Verified SHA-256 checksum"

chmod +x "$TMP/$BIN_NAME"
if ! "$TMP/$BIN_NAME" --version >/dev/null 2>&1; then
  die "The downloaded binary failed to run; the existing install was left untouched."
fi

DEST="$BIN_DIR/$BIN_NAME"
OLD="$TMP/$BIN_NAME.old"
rollback() {
  if [ -f "$OLD" ]; then
    mv -f "$OLD" "$DEST" 2>/dev/null || true
  fi
}

if [ -f "$DEST" ]; then
  mv -f "$DEST" "$OLD" || die "Could not back up the existing binary at $DEST."
fi
if ! mv -f "$TMP/$BIN_NAME" "$DEST"; then
  rollback
  die "Could not install Codecut at $DEST."
fi
if ! "$DEST" --version >/dev/null 2>&1; then
  rollback
  die "The installed binary failed to run at $DEST."
fi

ok "Installed ${bold}Codecut $("$DEST" --version)${reset} at $DEST"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    printf '\n'
    say "Add ${bold}$BIN_DIR${reset} to your PATH:"
    case "$(basename "${SHELL:-}")" in
      zsh) printf '    echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc && source ~/.zshrc\n' "$BIN_DIR" ;;
      bash) printf '    echo '\''export PATH="%s:$PATH"'\'' >> ~/.bashrc && source ~/.bashrc\n' "$BIN_DIR" ;;
      fish) printf '    fish_add_path "%s"\n' "$BIN_DIR" ;;
      *) printf '    export PATH="%s:$PATH"\n' "$BIN_DIR" ;;
    esac
    ;;
esac

printf '\n'
ok "Codecut is installed. Start user-level Claude checks with:"
printf '    %scodecut setup%s\n' "$bold" "$reset"
