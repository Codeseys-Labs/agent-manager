#!/bin/sh
# Install agent-manager (am)
# Usage: curl -fsSL https://raw.githubusercontent.com/Codeseys-Labs/agent-manager/main/install.sh | sh
#
# Options:
#   --dry-run           Print what would be done without doing it
#   --version X.Y.Z     Install a specific version
#   --prefix /path      Install to /path/bin instead of ~/.local/bin
#   --insecure          Skip SHA-256 checksum verification (NOT recommended)
#   --skip-checksum     Alias for --insecure
#
# Environment:
#   PREFIX              Same as --prefix
#   AM_VERSION          Same as --version
#   AM_INSECURE=1       Same as --insecure

set -eu

REPO="Codeseys-Labs/agent-manager"
# BASE_URL / API_URL are overridable (env) so the installer can be pointed at a
# mirror or a local server for testing. They default to the canonical GitHub
# endpoints. Integrity does not depend on these URLs being trusted — every
# binary is SHA-256-verified against the downloaded manifest (fail-closed).
BASE_URL="${AM_BASE_URL:-https://github.com/${REPO}}"
API_URL="${AM_API_URL:-https://api.github.com/repos/${REPO}}"

# Defaults
DRY_RUN=0
VERSION="${AM_VERSION:-}"
PREFIX_DIR="${PREFIX:-}"
# Checksum verification is mandatory by default (fail closed). Opt out only
# with an explicit --insecure / --skip-checksum flag or AM_INSECURE=1.
INSECURE="${AM_INSECURE:-0}"

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
    --insecure|--skip-checksum)
      INSECURE=1
      shift
      ;;
    --help|-h)
      sed -n '2,/^$/s/^# //p' "$0" 2>/dev/null || true
      printf "Usage: install.sh [--dry-run] [--version X.Y.Z] [--prefix /path] [--insecure]\n"
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
    # Fail closed: with no checksum tool we cannot verify integrity. Refuse
    # to install an unverified binary unless the user explicitly opted out
    # with --insecure / --skip-checksum (handled by the caller).
    printf "Error: no sha256sum or shasum tool found; cannot verify checksum.\n" >&2
    printf "       Install coreutils (sha256sum) or pass --insecure to skip (NOT recommended).\n" >&2
    return 1
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

  # Resolve version
  if [ -z "$VERSION" ]; then
    printf "Fetching latest version...\n"
    VERSION="$(fetch_latest_version)"
  fi

  TAG="v${VERSION}"
  CHECKSUM_URL="${BASE_URL}/releases/download/${TAG}/checksums.sha256"

  # ADR-0033 / REV-5 HIGH-1: am ships TWO binaries now. `am` is the CLI, and
  # `am-acp-shell` is the Tier-2 wrapper that `am run <shim>` spawns after
  # `am agent enable-shim <name>`. Install both or Tier-2 is dead-on-arrival.
  if [ "$OS" = "windows" ]; then
    AM_ARTIFACT="am-windows-x64.exe"
    SHELL_ARTIFACT="am-acp-shell-windows-x64.exe"
  else
    AM_ARTIFACT="am-${OS}-${ARCH}"
    SHELL_ARTIFACT="am-acp-shell-${OS}-${ARCH}"
  fi

  printf "  Platform:   %s/%s\n" "$OS" "$ARCH"
  printf "  Version:    %s\n" "$VERSION"
  printf "  Binaries:   %s, %s\n" "$AM_ARTIFACT" "$SHELL_ARTIFACT"
  printf "  Install:    %s/{am,am-acp-shell}\n" "$INSTALL_DIR"
  printf "\n"

  if [ "$DRY_RUN" = "1" ]; then
    printf "[dry-run] Would download: %s\n" "${BASE_URL}/releases/download/${TAG}/${AM_ARTIFACT}"
    printf "[dry-run] Would download: %s\n" "${BASE_URL}/releases/download/${TAG}/${SHELL_ARTIFACT}"
    if [ "$INSECURE" = "1" ]; then
      printf "[dry-run] Would SKIP checksum verification (--insecure)\n"
    else
      printf "[dry-run] Would verify checksums from: %s\n" "$CHECKSUM_URL"
    fi
    printf "[dry-run] Would install to: %s/am and %s/am-acp-shell\n" "$INSTALL_DIR" "$INSTALL_DIR"
    exit 0
  fi

  # Create install directory
  mkdir -p "$INSTALL_DIR"

  # Download to temp directory
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  printf "Downloading checksums...\n"
  download "$CHECKSUM_URL" "${TMP_DIR}/checksums.sha256"

  # --- download + verify + install each binary ---
  install_binary() {
    artifact="$1"
    dest_name="$2"

    printf "Downloading %s...\n" "$artifact"
    download "${BASE_URL}/releases/download/${TAG}/${artifact}" "${TMP_DIR}/${artifact}"

    # Anchor the grep to the exact filename field of `sha256sum` output
    # (`<sha>  <filename>`): match the literal name at end-of-line, treat the
    # pattern as a fixed string (-F) so the `.` in `.exe` is not a wildcard,
    # and prefix with a space so `am-linux-x64` cannot also match
    # `am-acp-shell-linux-x64`. This prevents substring/regex collisions.
    expected="$(grep -F " ${artifact}" "${TMP_DIR}/checksums.sha256" \
      | grep -E " ${artifact}\$" \
      | head -1 \
      | cut -d' ' -f1)"
    if [ -z "$expected" ]; then
      # Fail closed: an artifact absent from the manifest means a partial or
      # poisoned release. Refuse to install it unverified unless --insecure.
      if [ "$INSECURE" = "1" ]; then
        printf "Warning: artifact %s not found in checksums file; installing UNVERIFIED (--insecure)\n" "$artifact" >&2
      else
        printf "Error: artifact %s not found in checksums file; refusing to install unverified.\n" "$artifact" >&2
        printf "       Pass --insecure to override (NOT recommended).\n" >&2
        exit 1
      fi
    else
      if [ "$INSECURE" = "1" ]; then
        printf "Warning: skipping checksum verification for %s (--insecure)\n" "$artifact" >&2
      else
        printf "Verifying checksum...\n"
        verify_checksum "${TMP_DIR}/${artifact}" "$expected"
        printf "Checksum OK\n"
      fi
    fi

    dest="${INSTALL_DIR}/${dest_name}"
    if [ "$OS" = "windows" ]; then
      dest="${INSTALL_DIR}/${dest_name}.exe"
    fi
    cp "${TMP_DIR}/${artifact}" "$dest"
    chmod +x "$dest"

    # macOS: strip the Gatekeeper quarantine bit. Without this, a binary that
    # picked up `com.apple.quarantine` (e.g. via a downloader that sets it, or
    # an ad-hoc signature stripped on the artifact round-trip) is SIGKILLed on
    # first exec (`Killed: 9`, exit 137) on macOS 14+ arm64. Best-effort: xattr
    # may be absent or fail on some filesystems, so don't abort the install.
    if [ "$OS" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
      xattr -dr com.apple.quarantine "$dest" 2>/dev/null || true
    fi

    printf "Installed %s to %s\n" "$dest_name" "$dest"
  }

  install_binary "$AM_ARTIFACT" "am"
  install_binary "$SHELL_ARTIFACT" "am-acp-shell"

  printf "\nInstalled am %s (am + am-acp-shell) to %s\n" "$VERSION" "$INSTALL_DIR"

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
