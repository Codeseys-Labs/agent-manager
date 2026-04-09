#!/bin/sh
# Install agent-manager (am)
# Usage: curl -fsSL https://raw.githubusercontent.com/baladithyab/agent-manager/main/install.sh | sh
#
# Options:
#   --dry-run           Print what would be done without doing it
#   --version X.Y.Z     Install a specific version
#   --prefix /path      Install to /path/bin instead of ~/.local/bin
#
# Environment:
#   PREFIX              Same as --prefix
#   AM_VERSION          Same as --version

set -eu

REPO="baladithyab/agent-manager"
BASE_URL="https://github.com/${REPO}"
API_URL="https://api.github.com/repos/${REPO}"

# Defaults
DRY_RUN=0
VERSION="${AM_VERSION:-}"
PREFIX_DIR="${PREFIX:-}"

# Parse arguments
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --version)
      VERSION="$2"
      shift 2
      ;;
    --prefix)
      PREFIX_DIR="$2"
      shift 2
      ;;
    --help|-h)
      sed -n '2,/^$/s/^# //p' "$0" 2>/dev/null || true
      printf "Usage: install.sh [--dry-run] [--version X.Y.Z] [--prefix /path]\n"
      exit 0
      ;;
    *)
      printf "Unknown option: %s\n" "$1" >&2
      exit 1
      ;;
  esac
done

# Resolve install directory
if [ -z "$PREFIX_DIR" ]; then
  INSTALL_DIR="${HOME}/.local/bin"
else
  INSTALL_DIR="${PREFIX_DIR}/bin"
fi

# --- Platform detection ---

detect_os() {
  os="$(uname -s)"
  case "$os" in
    Linux*)   printf "linux" ;;
    Darwin*)  printf "darwin" ;;
    MINGW*|MSYS*|CYGWIN*) printf "windows" ;;
    *)        printf "unsupported: %s" "$os"; return 1 ;;
  esac
}

detect_arch() {
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)   printf "x64" ;;
    aarch64|arm64)  printf "arm64" ;;
    *)              printf "unsupported: %s" "$arch"; return 1 ;;
  esac
}

# --- Checksum verification ---

verify_checksum() {
  file="$1"
  expected="$2"

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$file" | cut -d' ' -f1)"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  else
    printf "Warning: no sha256sum or shasum found, skipping checksum verification\n" >&2
    return 0
  fi

  if [ "$actual" != "$expected" ]; then
    printf "Checksum verification failed!\n" >&2
    printf "  Expected: %s\n" "$expected" >&2
    printf "  Actual:   %s\n" "$actual" >&2
    return 1
  fi
}

# --- Version resolution ---

fetch_latest_version() {
  if command -v curl >/dev/null 2>&1; then
    tag="$(curl -fsSL "${API_URL}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  elif command -v wget >/dev/null 2>&1; then
    tag="$(wget -qO- "${API_URL}/releases/latest" | grep '"tag_name"' | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  else
    printf "Error: curl or wget is required\n" >&2
    exit 1
  fi

  if [ -z "$tag" ]; then
    printf "Error: could not determine latest release version\n" >&2
    exit 1
  fi

  # Strip leading 'v' if present
  printf "%s" "${tag#v}"
}

# --- Download helper ---

download() {
  url="$1"
  dest="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    printf "Error: curl or wget is required\n" >&2
    exit 1
  fi
}

# --- Main ---

main() {
  OS="$(detect_os)" || { printf "Error: %s\n" "$OS" >&2; exit 1; }
  ARCH="$(detect_arch)" || { printf "Error: %s\n" "$ARCH" >&2; exit 1; }

  ARTIFACT="am-${OS}-${ARCH}"
  if [ "$OS" = "windows" ]; then
    ARTIFACT="am-windows-x64.exe"
  fi

  # Linux arm64 is supported
  if [ "$OS" = "linux" ] && [ "$ARCH" = "arm64" ]; then
    ARTIFACT="am-linux-arm64"
  fi

  # Resolve version
  if [ -z "$VERSION" ]; then
    printf "Fetching latest version...\n"
    VERSION="$(fetch_latest_version)"
  fi

  TAG="v${VERSION}"
  BINARY_URL="${BASE_URL}/releases/download/${TAG}/${ARTIFACT}"
  CHECKSUM_URL="${BASE_URL}/releases/download/${TAG}/checksums.sha256"

  printf "  Platform:  %s/%s\n" "$OS" "$ARCH"
  printf "  Version:   %s\n" "$VERSION"
  printf "  Binary:    %s\n" "$ARTIFACT"
  printf "  Install:   %s/am\n" "$INSTALL_DIR"
  printf "\n"

  if [ "$DRY_RUN" = "1" ]; then
    printf "[dry-run] Would download: %s\n" "$BINARY_URL"
    printf "[dry-run] Would verify checksum from: %s\n" "$CHECKSUM_URL"
    printf "[dry-run] Would install to: %s/am\n" "$INSTALL_DIR"
    exit 0
  fi

  # Create install directory
  mkdir -p "$INSTALL_DIR"

  # Download to temp directory
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  printf "Downloading %s...\n" "$ARTIFACT"
  download "$BINARY_URL" "${TMP_DIR}/${ARTIFACT}"

  printf "Downloading checksums...\n"
  download "$CHECKSUM_URL" "${TMP_DIR}/checksums.sha256"

  # Extract expected checksum for this artifact
  EXPECTED="$(grep "${ARTIFACT}" "${TMP_DIR}/checksums.sha256" | cut -d' ' -f1)"
  if [ -z "$EXPECTED" ]; then
    printf "Warning: artifact %s not found in checksums file, skipping verification\n" "$ARTIFACT" >&2
  else
    printf "Verifying checksum...\n"
    verify_checksum "${TMP_DIR}/${ARTIFACT}" "$EXPECTED"
    printf "Checksum OK\n"
  fi

  # Install
  DEST="${INSTALL_DIR}/am"
  if [ "$OS" = "windows" ]; then
    DEST="${INSTALL_DIR}/am.exe"
  fi

  cp "${TMP_DIR}/${ARTIFACT}" "$DEST"
  chmod +x "$DEST"

  printf "\nInstalled am %s to %s\n" "$VERSION" "$DEST"

  # PATH check
  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) ;;
    *)
      printf "\n"
      printf "Add %s to your PATH:\n" "$INSTALL_DIR"
      printf "\n"
      printf "  # Add to ~/.profile, ~/.bashrc, or ~/.zshrc:\n"
      printf "  export PATH=\"%s:\$PATH\"\n" "$INSTALL_DIR"
      printf "\n"
      ;;
  esac

  printf "Get started:\n"
  printf "  am init\n"
}

main
